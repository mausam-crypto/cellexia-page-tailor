import { randomBytes } from "node:crypto";
import { gql, type AdminClient } from "./shopify-data.server";

/**
 * Illustrations live in the store's own Files (Shopify CDN): fast for
 * visitors, independent of the app server, and free. Needs the write_files
 * scope. Upload = staged upload target -> POST the bytes -> fileCreate ->
 * poll until Shopify has processed the image and knows its URL and size.
 */

export const FILES_PERMISSION_MESSAGE =
  "The app needs the Files permission (write_files). Open Page Tailor from the Shopify admin and approve the updated permissions, then try again.";

export class ShopifyFilesError extends Error {
  readonly permission: boolean;
  constructor(message: string, permission = false) {
    super(message);
    this.name = "ShopifyFilesError";
    this.permission = permission;
  }
}

function isAccessDenied(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /ACCESS_DENIED|access denied|write_files/i.test(text);
}

function wrap(error: unknown, context: string): ShopifyFilesError {
  if (error instanceof ShopifyFilesError) return error;
  if (isAccessDenied(error)) return new ShopifyFilesError(FILES_PERMISSION_MESSAGE, true);
  return new ShopifyFilesError(
    `${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export interface UploadedImage {
  fileId: string;
  url: string;
  width: number;
  height: number;
}

const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 60_000;

/** Upload image bytes to the store's Files and wait until they are served. */
export async function uploadImageToShopifyFiles(
  admin: AdminClient,
  input: {
    bytes: Buffer;
    mimeType: string;
    filename: string;
    alt: string;
    /** Fallback size when Shopify reports none (should not happen for READY images). */
    width?: number;
    height?: number;
  },
): Promise<UploadedImage> {
  // 1. Staged upload target.
  let target: { url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> };
  try {
    const staged = await gql<{
      stagedUploadsCreate: {
        stagedTargets: Array<{
          url: string;
          resourceUrl: string;
          parameters: Array<{ name: string; value: string }>;
        }>;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(
      admin,
      `#graphql
        mutation PageTailorStagedUpload($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters {
                name
                value
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        input: [
          {
            filename: input.filename,
            mimeType: input.mimeType,
            resource: "IMAGE",
            httpMethod: "POST",
            fileSize: String(input.bytes.length),
          },
        ],
      },
    );
    const errors = staged.stagedUploadsCreate.userErrors;
    if (errors.length > 0) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }
    const first = staged.stagedUploadsCreate.stagedTargets[0];
    if (!first) throw new Error("Shopify returned no upload target.");
    target = first;
  } catch (error) {
    throw wrap(error, "Could not prepare the upload to Shopify Files");
  }

  // 2. POST the bytes as multipart/form-data. The body is assembled by hand
  //    as one Buffer: every staged parameter first, the file part last.
  const boundary = `----PageTailor${randomBytes(12).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const p of target.parameters) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`,
        "utf8",
      ),
    );
  }
  const safeFilename = input.filename.replace(/["\r\n]/g, "_");
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
      "utf8",
    ),
  );
  parts.push(input.bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  const body = Buffer.concat(parts);
  try {
    const response = await fetch(target.url, {
      method: "POST",
      body,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    if (!response.ok) {
      throw new Error(`upload target answered HTTP ${response.status}`);
    }
  } catch (error) {
    throw wrap(error, "Could not upload the image bytes to Shopify");
  }

  // 3. Register the file.
  let fileId: string;
  try {
    const created = await gql<{
      fileCreate: {
        files: Array<{ id: string; fileStatus: string }>;
        userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
      };
    }>(
      admin,
      `#graphql
        mutation PageTailorFileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files {
              id
              fileStatus
            }
            userErrors {
              field
              message
              code
            }
          }
        }`,
      {
        files: [
          {
            originalSource: target.resourceUrl,
            contentType: "IMAGE",
            filename: input.filename,
            alt: input.alt.slice(0, 512),
            duplicateResolutionMode: "APPEND_UUID",
          },
        ],
      },
    );
    const errors = created.fileCreate.userErrors;
    if (errors.length > 0) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }
    const file = created.fileCreate.files[0];
    if (!file?.id) throw new Error("Shopify returned no file id.");
    fileId = file.id;
  } catch (error) {
    throw wrap(error, "Could not register the image in Shopify Files");
  }

  // 4. Wait for processing (UPLOADED -> PROCESSING -> READY | FAILED).
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    let node: {
      fileStatus: string;
      fileErrors: Array<{ code: string; message: string; details: string | null }>;
      image: { url: string; width: number | null; height: number | null } | null;
    } | null;
    try {
      const data = await gql<{ node: typeof node }>(
        admin,
        `#graphql
          query PageTailorFileStatus($id: ID!) {
            node(id: $id) {
              ... on MediaImage {
                fileStatus
                fileErrors {
                  code
                  message
                  details
                }
                image {
                  url
                  width
                  height
                }
              }
            }
          }`,
        { id: fileId },
      );
      node = data.node;
    } catch (error) {
      throw wrap(error, "Could not check the uploaded image");
    }
    if (node?.fileStatus === "READY" && node.image?.url) {
      return {
        fileId,
        url: node.image.url,
        width: node.image.width ?? input.width ?? 0,
        height: node.image.height ?? input.height ?? 0,
      };
    }
    if (node?.fileStatus === "FAILED") {
      const reason = node.fileErrors.map((e) => e.message || e.code).join("; ");
      throw new ShopifyFilesError(
        `Shopify could not process the image${reason ? `: ${reason}` : ""}.`,
      );
    }
    if (Date.now() > deadline) {
      throw new ShopifyFilesError(
        "Shopify is still processing the image. Wait a minute, then try again.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Delete a file from Shopify Files; a file that is already gone counts as deleted. */
export async function deleteShopifyFile(
  admin: AdminClient,
  fileId: string,
): Promise<void> {
  try {
    const data = await gql<{
      fileDelete: {
        deletedFileIds: string[];
        userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
      };
    }>(
      admin,
      `#graphql
        mutation PageTailorFileDelete($ids: [ID!]!) {
          fileDelete(fileIds: $ids) {
            deletedFileIds
            userErrors {
              field
              message
              code
            }
          }
        }`,
      { ids: [fileId] },
    );
    const errors = data.fileDelete.userErrors.filter(
      (e) => e.code !== "FILE_DOES_NOT_EXIST" && !/not found|does not exist/i.test(e.message),
    );
    if (errors.length > 0) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }
  } catch (error) {
    throw wrap(error, "Could not delete the file from Shopify Files");
  }
}

/** Whether the shop has granted the write_files scope to this app. */
export async function hasWriteFilesScope(admin: AdminClient): Promise<boolean> {
  try {
    const data = await gql<{
      currentAppInstallation: { accessScopes: Array<{ handle: string }> };
    }>(
      admin,
      `#graphql
        query PageTailorAccessScopes {
          currentAppInstallation {
            accessScopes {
              handle
            }
          }
        }`,
    );
    return data.currentAppInstallation.accessScopes.some(
      (s) => s.handle === "write_files",
    );
  } catch {
    // Unknown: let the first upload surface the real error.
    return true;
  }
}

/** True when a Shopify file still exists (used to flag broken library entries). */
export async function shopifyFileExists(
  admin: AdminClient,
  fileId: string,
): Promise<boolean> {
  try {
    const data = await gql<{ node: { id: string } | null }>(
      admin,
      `#graphql
        query PageTailorFileExists($id: ID!) {
          node(id: $id) {
            id
          }
        }`,
      { id: fileId },
    );
    return data.node !== null;
  } catch {
    return true;
  }
}
