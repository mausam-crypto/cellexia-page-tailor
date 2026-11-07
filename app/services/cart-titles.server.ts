/**
 * Basket rename (Ingredient focus pages, Shopify Plus).
 *
 * The app's Cart Transform function renames a cart line whose hidden `_cx`
 * property (set by the theme embed on a focus page) maps, through a product
 * metafield the app maintains, to a live focus page's product name. This
 * module owns that metafield: an app-reserved JSON map
 * `{ "<variant code>": "<product name>" }` on the product.
 *
 * The map follows the page rename exactly: entries exist only while the
 * master serving switch is on, the basket rename is activated, the Product
 * name surface is enabled with a selector (the same gate serving applies to
 * the heading swap) and the page is live. Every sync recomputes the whole
 * map from the database and overwrites, so interleaved syncs converge.
 * A sync never throws: a failure is recorded on the product's focus pages
 * (Article.cartSyncError) and returned as a message for a toast.
 */
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { getSettings } from "./settings.server";
import { gql, type AdminClient } from "./shopify-data.server";
import { TITLE_SURFACE_KEY, type ShopSettingsData } from "./types";
import { cleanProductName } from "./product-name";

export const CART_TITLES_NAMESPACE = "$app";
export const CART_TITLES_KEY = "cart_titles";
// Shopify Functions receive null for any metafield value above 10,000
// bytes; stay well under so the function always sees the map.
const MAX_MAP_BYTES = 9_000;
// Cart line titles are product titles: Shopify caps those at 255.
const MAX_CART_TITLE_CHARS = 255;

/** Whether the basket rename can apply at all for this shop right now:
 *  activated, serving on, and the Product name surface enabled with a
 *  selector in plain-text mode (the heading swap's own gate). */
export function basketRenameGate(settings: ShopSettingsData): {
  active: boolean;
  reason: string | null;
} {
  if (!settings.basketRenameEnabled) {
    return { active: false, reason: "Basket rename is not activated in Settings." };
  }
  if (!settings.servingEnabled) {
    return { active: false, reason: "Serving is switched off in Settings." };
  }
  const title = settings.surfaces.find((s) => s.key === TITLE_SURFACE_KEY);
  if (!title || !title.enabled || title.selector.trim() === "") {
    return {
      active: false,
      reason:
        "The Product name surface is not enabled with a selector in Settings, so the heading keeps the original name and so does the basket.",
    };
  }
  if (title.mode !== "text") {
    return {
      active: false,
      reason: "The Product name surface must use the Plain text swap mode.",
    };
  }
  return { active: true, reason: null };
}

/** The map for one product: every live Ingredient focus page's product
 *  name, keyed by variant code. Empty when the gate is closed. */
export async function computeCartTitleMap(
  shop: string,
  productId: string,
  settings?: ShopSettingsData,
): Promise<{ map: Record<string, string>; truncated: boolean }> {
  const current = settings ?? (await getSettings(shop));
  if (!basketRenameGate(current).active) return { map: {}, truncated: false };
  const articles = await prisma.article.findMany({
    where: { shop, productId, status: "approved", generatedMode: "focus" },
    orderBy: { updatedAt: "desc" },
    select: {
      variantHandle: true,
      overrides: {
        where: { surfaceKey: TITLE_SURFACE_KEY, enabled: true, mode: "text" },
        select: { adapted: true },
      },
    },
  });
  const map: Record<string, string> = {};
  let truncated = false;
  for (const article of articles) {
    const title = cleanProductName(article.overrides[0]?.adapted ?? "").slice(
      0,
      MAX_CART_TITLE_CHARS,
    );
    if (!title) continue;
    const next = { ...map, [article.variantHandle]: title };
    if (JSON.stringify(next).length > MAX_MAP_BYTES) {
      truncated = true;
      break;
    }
    map[article.variantHandle] = title;
  }
  return { map, truncated };
}

async function adminFor(shop: string, admin?: AdminClient): Promise<AdminClient> {
  if (admin) return admin;
  const { admin: client } = await unauthenticated.admin(shop);
  return client as unknown as AdminClient;
}

async function writeMap(
  admin: AdminClient,
  productId: string,
  map: Record<string, string>,
): Promise<void> {
  if (Object.keys(map).length === 0) {
    // No live focus page: remove the metafield so products never carry a
    // stale map (a metafield that does not exist is reported as null, not
    // as an error).
    const data = await gql<{
      metafieldsDelete: {
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(
      admin,
      `#graphql
        mutation PageTailorDeleteCartTitles($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields { ownerId key }
            userErrors { field message }
          }
        }`,
      {
        metafields: [
          { ownerId: productId, namespace: CART_TITLES_NAMESPACE, key: CART_TITLES_KEY },
        ],
      },
    );
    const errors = data.metafieldsDelete.userErrors;
    if (errors.length > 0) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }
    return;
  }
  const data = await gql<{
    metafieldsSet: {
      metafields: Array<{ id: string }> | null;
      userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
    };
  }>(
    admin,
    `#graphql
      mutation PageTailorSetCartTitles($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message code }
        }
      }`,
    {
      metafields: [
        {
          ownerId: productId,
          namespace: CART_TITLES_NAMESPACE,
          key: CART_TITLES_KEY,
          type: "json",
          value: JSON.stringify(map),
        },
      ],
    },
  );
  const errors = data.metafieldsSet.userErrors;
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/access denied|not approved|permission|forbidden/i.test(message)) {
    return `${message} - the app needs the write_products permission: open the app and approve the updated permissions, then retry.`;
  }
  return message;
}

/**
 * Bring one product's basket name map in line with the database. Never
 * throws; returns a message when something went wrong (shown as a toast
 * or banner by the caller) or null when the map is in sync. A no-op while
 * the basket rename has never been activated.
 */
export async function syncCartTitlesForProduct(
  shop: string,
  productId: string,
  admin?: AdminClient,
): Promise<string | null> {
  let message: string | null = null;
  try {
    const settings = await getSettings(shop);
    if (!settings.basketRenameEnabled) return null;
    const { map, truncated } = await computeCartTitleMap(shop, productId, settings);
    await writeMap(await adminFor(shop, admin), productId, map);
    if (truncated) {
      message =
        "This product has more live Ingredient focus pages than the basket name map can hold; the oldest ones keep the original name in the basket.";
      console.warn(`Basket name map truncated for ${productId} (${shop})`);
    }
  } catch (error) {
    message = `The basket name could not be updated: ${describeError(error)}`;
    console.error(`Basket name sync failed for ${productId} (${shop})`, error);
  }
  await prisma.article
    .updateMany({
      where: { shop, productId, generatedMode: "focus" },
      data: { cartSyncError: message },
    })
    .catch(() => {});
  return message;
}

/** Products with at least one Ingredient focus page (live or not: a page
 *  that went offline must have its entry removed too). */
async function focusProductIds(shop: string): Promise<string[]> {
  const rows = await prisma.article.findMany({
    where: { shop, generatedMode: "focus" },
    select: { productId: true },
    distinct: ["productId"],
  });
  return rows.map((r) => r.productId);
}

/** Re-sync every product that has an Ingredient focus page (master switch
 *  toggled, Product name surface changed, basket rename activated). */
export async function syncCartTitlesForShop(
  shop: string,
  admin?: AdminClient,
): Promise<string[]> {
  const warnings: string[] = [];
  const client = await adminFor(shop, admin);
  for (const productId of await focusProductIds(shop)) {
    const warning = await syncCartTitlesForProduct(shop, productId, client);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

/** Deactivation: remove every map regardless of the gate. */
export async function clearCartTitlesForShop(
  shop: string,
  admin: AdminClient,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const productId of await focusProductIds(shop)) {
    try {
      await writeMap(admin, productId, {});
      await prisma.article.updateMany({
        where: { shop, productId, generatedMode: "focus" },
        data: { cartSyncError: null },
      });
    } catch (error) {
      warnings.push(`Could not clear the basket names of ${productId}: ${describeError(error)}`);
    }
  }
  return warnings;
}
