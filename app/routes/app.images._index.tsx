import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  MaxPartSizeExceededError,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "@remix-run/node";
import {
  Link as RemixLink,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DropZone,
  InlineGrid,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { thumbnailUrl } from "../components/IllustrationChoice";
import { imageUsage, monthSpend } from "../services/illustrations.server";
import { getSettings } from "../services/settings.server";
import { getShopLocalesCached } from "../services/shopify-data.server";
import {
  FILES_PERMISSION_MESSAGE,
  ShopifyFilesError,
  deleteShopifyFile,
  hasWriteFilesScope,
  uploadImageToShopifyFiles,
} from "../services/shopify-files.server";
import { imageModelConfigured } from "../services/openai-images.server";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;

/** PNG, JPEG or WebP by signature; anything else is refused. */
function sniffImage(bytes: Buffer): { mimeType: string; ext: string } | null {
  if (bytes.length > 12) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return { mimeType: "image/png", ext: "png" };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return { mimeType: "image/jpeg", ext: "jpg" };
    }
    if (
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    ) {
      return { mimeType: "image/webp", ext: "webp" };
    }
  }
  return null;
}

function parseTags(raw: string): string[] {
  return [...new Set(raw.split(",").map((t) => t.trim()).filter(Boolean))].slice(0, 20);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const [images, settings, spent, filesPermission] = await Promise.all([
    prisma.illustrationImage.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { template: { select: { name: true } } },
    }),
    getSettings(shop),
    monthSpend(shop).catch(() => 0),
    hasWriteFilesScope(admin),
  ]);
  const usage = await imageUsage(
    shop,
    images.map((i) => i.id),
  );
  let locales: Array<{ locale: string; name: string }> = [];
  try {
    locales = (await getShopLocalesCached(admin, shop))
      .filter((l) => l.published)
      .map((l) => ({ locale: l.locale, name: l.name }));
  } catch {
    locales = [];
  }
  return {
    images: images.map((i) => {
      const u = usage.get(i.id) ?? { current: 0, alternative: 0, templates: 0 };
      let tags: string[] = [];
      try {
        const parsed = JSON.parse(i.tags);
        tags = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        tags = [];
      }
      return {
        id: i.id,
        kind: i.kind,
        name: i.name,
        cdnUrl: i.cdnUrl,
        language: i.language,
        tags,
        width: i.width,
        height: i.height,
        costUsd: i.costUsd,
        templateName: i.template?.name ?? null,
        createdAt: i.createdAt.toISOString(),
        usedCurrent: u.current,
        usedAlternative: u.alternative,
        usedTemplates: u.templates,
      };
    }),
    spent,
    cap: settings.illustrations.monthlyCapUsd,
    filesPermission,
    permissionMessage: FILES_PERMISSION_MESSAGE,
    openaiConfigured: imageModelConfigured(),
    locales,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await unstable_parseMultipartFormData(
        request,
        unstable_createMemoryUploadHandler({ maxPartSize: MAX_UPLOAD_BYTES }),
      );
    } catch (error) {
      if (error instanceof MaxPartSizeExceededError) {
        return { ok: false as const, intent: "upload", error: "The image is larger than 10 MB. Export a smaller file and try again." };
      }
      return { ok: false as const, intent: "upload", error: "The upload could not be read. Try again." };
    }
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false as const, intent: "upload", error: "Choose an image file first." };
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const sniffed = sniffImage(bytes);
    if (!sniffed) {
      return { ok: false as const, intent: "upload", error: "Only PNG, JPEG and WebP images can be uploaded." };
    }
    const name = String(formData.get("name") ?? "").trim().slice(0, MAX_NAME) ||
      file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, MAX_NAME) ||
      "Illustration";
    const description = String(formData.get("description") ?? "").trim().slice(0, MAX_DESCRIPTION);
    const tags = parseTags(String(formData.get("tags") ?? ""));
    const language = String(formData.get("language") ?? "").trim() || null;
    try {
      const uploaded = await uploadImageToShopifyFiles(admin, {
        bytes,
        mimeType: sniffed.mimeType,
        filename: `page-tailor-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image"}.${sniffed.ext}`,
        alt: description || name,
      });
      await prisma.illustrationImage.create({
        data: {
          shop,
          kind: "upload",
          name,
          description,
          tags: JSON.stringify(tags),
          language,
          shopifyFileId: uploaded.fileId,
          cdnUrl: uploaded.url,
          width: uploaded.width,
          height: uploaded.height,
          mimeType: sniffed.mimeType,
          bytes: bytes.length,
        },
      });
    } catch (error) {
      return {
        ok: false as const,
        intent: "upload",
        error:
          error instanceof ShopifyFilesError && error.permission
            ? FILES_PERMISSION_MESSAGE
            : error instanceof Error
              ? error.message
              : String(error),
      };
    }
    return { ok: true as const, intent: "upload", error: null };
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    const image = await prisma.illustrationImage.findFirst({ where: { id, shop } });
    if (!image) return { ok: false as const, intent, error: "That image no longer exists." };
    const usage = (await imageUsage(shop, [id])).get(id)!;
    if (usage.current + usage.alternative + usage.templates > 0) {
      return {
        ok: false as const,
        intent,
        error: "This image is in use on a page or as a template example. Remove it there first.",
      };
    }
    try {
      await deleteShopifyFile(admin, image.shopifyFileId);
    } catch (error) {
      return {
        ok: false as const,
        intent,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await prisma.illustrationImage.delete({ where: { id } });
    return { ok: true as const, intent, error: null };
  }
  return { ok: false as const, intent, error: "Unknown action." };
};

function money(n: number): string {
  return `$${n.toFixed(n > 0 && n < 0.1 ? 3 : 2)}`;
}

export default function ImageLibrary() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [language, setLanguage] = useState("");
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  const isSubmitting = navigation.state === "submitting";

  useEffect(() => {
    if (!actionData) return;
    if (actionData.ok && actionData.intent === "upload") {
      shopify.toast.show("Image added to the library");
      setFile(null);
      setName("");
      setDescription("");
      setTags("");
    }
    if (actionData.ok && actionData.intent === "delete") {
      shopify.toast.show("Image deleted");
      setDeleting(null);
    }
  }, [actionData, shopify]);

  const handleUpload = useCallback(() => {
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    form.set("name", name);
    form.set("description", description);
    form.set("tags", tags);
    form.set("language", language);
    submit(form, { method: "POST", encType: "multipart/form-data" });
  }, [file, name, description, tags, language, submit]);

  const handleDelete = useCallback(() => {
    if (!deleting) return;
    submit({ intent: "delete", id: deleting.id }, { method: "POST" });
  }, [deleting, submit]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.images.filter((i) => {
      if (kindFilter !== "all" && i.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        i.name.toLowerCase().includes(q) ||
        i.tags.some((t) => t.toLowerCase().includes(q)) ||
        (i.language ?? "").toLowerCase().includes(q) ||
        (i.templateName ?? "").toLowerCase().includes(q)
      );
    });
  }, [data.images, kindFilter, query]);

  const error = actionData && !actionData.ok ? actionData.error : null;

  return (
    <Page
      title="Image library"
      subtitle={`Illustration spend this month: ${money(data.spent)}${
        data.cap !== null ? ` of ${money(data.cap)}` : ""
      }`}
      backAction={{ url: "/app" }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {!data.filesPermission && (
              <Banner tone="warning" title="Files permission needed">
                {data.permissionMessage}
              </Banner>
            )}
            {error && (
              <Banner tone="critical" title="Something went wrong">
                {error}
              </Banner>
            )}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Upload an illustration
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    PNG, JPEG or WebP, up to 10 MB. The file is stored in your
                    store's Files. The description is what Claude reads when it
                    places the image and writes its caption, so say what the
                    picture shows. Images drawn by the app land here too.
                  </Text>
                </BlockStack>
                <DropZone
                  accept="image/png,image/jpeg,image/webp"
                  type="image"
                  allowMultiple={false}
                  onDrop={(_dropped, accepted) => {
                    const chosen = accepted[0] ?? null;
                    setFile(chosen);
                    if (chosen && !name) {
                      setName(chosen.name.replace(/\.[a-z0-9]+$/i, ""));
                    }
                  }}
                >
                  {file ? (
                    <Box padding="400">
                      <InlineStack gap="300" blockAlign="center">
                        <Thumbnail
                          source={URL.createObjectURL(file)}
                          alt=""
                          size="large"
                        />
                        <BlockStack gap="100">
                          <Text as="span" variant="bodyMd">
                            {file.name}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {(file.size / 1024 / 1024).toFixed(2)} MB
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    </Box>
                  ) : (
                    <DropZone.FileUpload actionHint="or drop an image here" />
                  )}
                </DropZone>
                <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                  <TextField
                    label="Name"
                    value={name}
                    onChange={setName}
                    autoComplete="off"
                    maxLength={MAX_NAME}
                  />
                  <Select
                    label="Language of the labels inside the image"
                    options={[
                      { label: "No text, or not specific to a language", value: "" },
                      ...data.locales.map((l) => ({
                        label: `${l.name} (${l.locale})`,
                        value: l.locale,
                      })),
                    ]}
                    value={language}
                    onChange={setLanguage}
                  />
                </InlineGrid>
                <TextField
                  label="What it shows"
                  value={description}
                  onChange={setDescription}
                  multiline={2}
                  autoComplete="off"
                  maxLength={MAX_DESCRIPTION}
                  placeholder="e.g. The 500 Dalton rule: small molecules passing through the skin barrier while larger ones stay on the surface."
                />
                <TextField
                  label="Tags (comma separated)"
                  value={tags}
                  onChange={setTags}
                  autoComplete="off"
                  placeholder="mechanism, barrier, molecule size"
                />
                <InlineStack align="end">
                  <Button
                    variant="primary"
                    onClick={handleUpload}
                    disabled={!file || !data.filesPermission}
                    loading={isSubmitting && navigation.formData?.has("file")}
                  >
                    Upload to the library
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h2" variant="headingMd">
                    {data.images.length === 0
                      ? "No images yet"
                      : `${data.images.length} image${data.images.length === 1 ? "" : "s"}`}
                  </Text>
                  <InlineStack gap="300" blockAlign="center">
                    <Select
                      label="Kind"
                      labelHidden
                      options={[
                        { label: "All images", value: "all" },
                        { label: "Uploaded", value: "upload" },
                        { label: "Drawn by the app", value: "drawn" },
                      ]}
                      value={kindFilter}
                      onChange={setKindFilter}
                    />
                    <TextField
                      label="Search"
                      labelHidden
                      value={query}
                      onChange={setQuery}
                      autoComplete="off"
                      placeholder="Search name, tag, language, template"
                      clearButton
                      onClearButtonClick={() => setQuery("")}
                    />
                  </InlineStack>
                </InlineStack>
                {shown.length === 0 && data.images.length > 0 && (
                  <Text as="p" tone="subdued">
                    No image matches.
                  </Text>
                )}
                {shown.map((image) => {
                  const used = image.usedCurrent + image.usedAlternative + image.usedTemplates;
                  return (
                    <Box
                      key={image.id}
                      borderColor="border"
                      borderWidth="025"
                      borderRadius="200"
                      padding="300"
                    >
                      <InlineGrid columns={{ xs: 1, md: ["oneThird", "twoThirds"] }} gap="300">
                        <RemixLink to={`/app/images/${image.id}`}>
                          <img
                            src={thumbnailUrl(image.cdnUrl, 480)}
                            alt=""
                            style={{ width: "100%", height: "auto", borderRadius: 4, display: "block" }}
                          />
                        </RemixLink>
                        <BlockStack gap="200">
                          <InlineStack align="space-between" blockAlign="start" wrap>
                            <BlockStack gap="100">
                              <RemixLink to={`/app/images/${image.id}`}>
                                <Text as="span" variant="headingSm">
                                  {image.name}
                                </Text>
                              </RemixLink>
                              <InlineStack gap="100" wrap>
                                <Badge tone={image.kind === "drawn" ? "info" : undefined}>
                                  {image.kind === "drawn"
                                    ? `Drawn${image.templateName ? ` · ${image.templateName}` : ""}`
                                    : "Uploaded"}
                                </Badge>
                                {image.language && <Badge>{image.language}</Badge>}
                                {image.tags.map((t) => (
                                  <Badge key={t}>{t}</Badge>
                                ))}
                              </InlineStack>
                            </BlockStack>
                            <Button
                              tone="critical"
                              variant="plain"
                              disabled={used > 0}
                              onClick={() => setDeleting({ id: image.id, name: image.name })}
                            >
                              Delete
                            </Button>
                          </InlineStack>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {image.width} × {image.height}
                            {image.costUsd !== null ? ` · cost ${money(image.costUsd)}` : ""}
                            {" · "}
                            {used === 0
                              ? "not used on any page"
                              : [
                                  image.usedCurrent > 0
                                    ? `live on ${image.usedCurrent} page${image.usedCurrent === 1 ? "" : "s"}`
                                    : null,
                                  image.usedAlternative > 0
                                    ? `alternative on ${image.usedAlternative}`
                                    : null,
                                  image.usedTemplates > 0 ? "template example" : null,
                                ]
                                  .filter(Boolean)
                                  .join(", ")}
                            {" · added "}
                            {new Date(image.createdAt).toLocaleDateString("en-GB")}
                          </Text>
                        </BlockStack>
                      </InlineGrid>
                    </Box>
                  );
                })}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this image?"
        primaryAction={{
          content: "Delete",
          destructive: true,
          onAction: handleDelete,
          loading: isSubmitting && navigation.formData?.get("intent") === "delete",
        }}
        secondaryActions={[{ content: "Keep it", onAction: () => setDeleting(null) }]}
      >
        <Modal.Section>
          <Text as="p">
            "{deleting?.name}" will be removed from the library and from your
            store's Files. This cannot be undone.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
