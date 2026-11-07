/**
 * Basket rename activation (Ingredient focus pages, Shopify Plus).
 *
 * The app ships a Cart Transform function (`extensions/cart-rename`). A
 * store runs it only once a cart transform has been created for it, which
 * is an explicit merchant action in Settings: it needs the store on Plus,
 * the two new permissions approved, the function deployed, and (outside
 * the app) the theme developer's template edits. Nothing here is automatic.
 */
import { getSettings, saveSettings } from "./settings.server";
import { gql, type AdminClient } from "./shopify-data.server";
import { clearCartTitlesForShop, syncCartTitlesForShop } from "./cart-titles.server";

/** The function handle in extensions/cart-rename/shopify.extension.toml. */
export const CART_RENAME_FUNCTION_HANDLE = "cart-rename";
export const BASKET_RENAME_SCOPES = ["write_cart_transforms", "write_products"];

export interface BasketRenameStatus {
  /** Activated in Settings (a cart transform exists for this app). */
  enabled: boolean;
  cartTransformId: string | null;
  /** Which of the needed permissions the merchant has not approved yet. */
  missingScopes: string[];
  /** The function is deployed to Shopify (visible to the Admin API). */
  deployed: boolean;
  /** Plus (or a development store); null when the plan could not be read. */
  plus: boolean | null;
  /** The last activation or sync error recorded in Settings. */
  error: string | null;
}

interface StatusData {
  currentAppInstallation: { accessScopes: Array<{ handle: string }> };
  shop: { plan: { shopifyPlus: boolean; partnerDevelopment: boolean } };
  cartTransforms: { nodes: Array<{ id: string; functionId: string }> };
  shopifyFunctions: { nodes: Array<{ id: string; title: string; apiType: string }> };
}

async function readStatus(admin: AdminClient): Promise<StatusData> {
  return gql<StatusData>(
    admin,
    `#graphql
      query PageTailorBasketRenameStatus {
        currentAppInstallation {
          accessScopes {
            handle
          }
        }
        shop {
          plan {
            shopifyPlus
            partnerDevelopment
          }
        }
        cartTransforms(first: 5) {
          nodes {
            id
            functionId
          }
        }
        shopifyFunctions(first: 10, apiType: "cart_transform") {
          nodes {
            id
            title
            apiType
          }
        }
      }`,
  );
}

/** What the Settings card shows. Never throws: an Admin API hiccup leaves
 *  the unknowns null/empty and the merchant retries. */
export async function basketRenameStatus(
  admin: AdminClient,
  shop: string,
): Promise<BasketRenameStatus> {
  const settings = await getSettings(shop);
  const base: BasketRenameStatus = {
    enabled: settings.basketRenameEnabled,
    cartTransformId: settings.cartTransformId,
    missingScopes: [],
    deployed: false,
    plus: null,
    error: settings.basketRenameError,
  };
  try {
    const data = await readStatus(admin);
    const granted = new Set(data.currentAppInstallation.accessScopes.map((s) => s.handle));
    return {
      ...base,
      missingScopes: BASKET_RENAME_SCOPES.filter((s) => !granted.has(s)),
      deployed: data.shopifyFunctions.nodes.length > 0,
      plus: data.shop.plan.shopifyPlus || data.shop.plan.partnerDevelopment,
    };
  } catch (error) {
    console.error(`Basket rename status failed for ${shop}`, error);
    return base;
  }
}

function userErrorMessage(
  errors: Array<{ message: string; code?: string | null }>,
): string {
  return errors
    .map((e) => {
      switch (e.code) {
        case "FUNCTION_NOT_FOUND":
          return "The basket rename function is not deployed yet: run `npm run deploy` first, then try again.";
        case "CUSTOM_APP_FUNCTION_NOT_ELIGIBLE":
          return "This store is not eligible for cart transforms (Shopify Plus or a development store is required).";
        default:
          return e.message;
      }
    })
    .join(" ");
}

/**
 * Create the cart transform (idempotent: an existing one is adopted), save
 * the activation, then write every product's basket name map.
 */
export async function activateBasketRename(
  admin: AdminClient,
  shop: string,
): Promise<{ ok: boolean; message: string; warnings: string[] }> {
  const status = await basketRenameStatus(admin, shop);
  if (status.missingScopes.length > 0) {
    const message = `The app needs the ${status.missingScopes.join(" and ")} permission${
      status.missingScopes.length > 1 ? "s" : ""
    } first. Reload the app in Shopify to approve the updated permissions, then try again.`;
    await saveSettings(shop, { basketRenameError: message });
    return { ok: false, message, warnings: [] };
  }
  if (!status.deployed) {
    const message =
      "The basket rename function is not deployed to Shopify yet: run `npm run deploy` from the app's folder, then try again.";
    await saveSettings(shop, { basketRenameError: message });
    return { ok: false, message, warnings: [] };
  }
  try {
    let cartTransformId: string | null = null;
    const data = await gql<{
      cartTransformCreate: {
        cartTransform: { id: string } | null;
        userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
      };
    }>(
      admin,
      `#graphql
        mutation PageTailorCartTransformCreate($handle: String!) {
          cartTransformCreate(functionHandle: $handle, blockOnFailure: false) {
            cartTransform {
              id
            }
            userErrors {
              field
              message
              code
            }
          }
        }`,
      { handle: CART_RENAME_FUNCTION_HANDLE },
    );
    const errors = data.cartTransformCreate.userErrors;
    const alreadyThere = errors.some(
      (e) => e.code === "FUNCTION_ALREADY_REGISTERED" || e.code === "MAXIMUM_CART_TRANSFORMS",
    );
    if (errors.length > 0 && !alreadyThere) {
      throw new Error(userErrorMessage(errors));
    }
    cartTransformId = data.cartTransformCreate.cartTransform?.id ?? null;
    if (!cartTransformId) {
      // Adopted an existing transform: find its id.
      const existing = await readStatus(admin);
      cartTransformId = existing.cartTransforms.nodes[0]?.id ?? null;
    }
    await saveSettings(shop, {
      basketRenameEnabled: true,
      cartTransformId,
      basketRenameError: null,
    });
    const warnings = await syncCartTitlesForShop(shop, admin);
    return {
      ok: true,
      message:
        status.plus === false
          ? "Basket rename activated. This store does not look like a Shopify Plus store: Shopify will ignore the rename until it is."
          : "Basket rename activated.",
      warnings,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = /access denied|not approved|permission|forbidden/i.test(raw)
      ? `${raw} Approve the app's updated permissions (reload the app in Shopify), and make sure your staff account has the products and preferences permissions.`
      : raw;
    await saveSettings(shop, { basketRenameError: message });
    return { ok: false, message, warnings: [] };
  }
}

/** Delete the cart transform and clear every product's basket name map. */
export async function deactivateBasketRename(
  admin: AdminClient,
  shop: string,
): Promise<{ ok: boolean; message: string; warnings: string[] }> {
  const settings = await getSettings(shop);
  const warnings: string[] = [];
  try {
    let id = settings.cartTransformId;
    if (!id) {
      const existing = await readStatus(admin);
      id = existing.cartTransforms.nodes[0]?.id ?? null;
    }
    if (id) {
      const data = await gql<{
        cartTransformDelete: {
          deletedId: string | null;
          userErrors: Array<{ message: string; code: string | null }>;
        };
      }>(
        admin,
        `#graphql
          mutation PageTailorCartTransformDelete($id: ID!) {
            cartTransformDelete(id: $id) {
              deletedId
              userErrors {
                message
                code
              }
            }
          }`,
        { id },
      );
      const errors = data.cartTransformDelete.userErrors.filter(
        (e) => e.code !== "NOT_FOUND",
      );
      if (errors.length > 0) throw new Error(userErrorMessage(errors));
    }
    warnings.push(...(await clearCartTitlesForShop(shop, admin)));
    await saveSettings(shop, {
      basketRenameEnabled: false,
      cartTransformId: null,
      basketRenameError: null,
    });
    return { ok: true, message: "Basket rename deactivated.", warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveSettings(shop, { basketRenameError: message });
    return { ok: false, message, warnings };
  }
}
