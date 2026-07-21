import type { CopySurface, SurfaceContent } from "./types";

// Structural type for the admin GraphQL client returned by authenticate.admin.
export interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export interface ProductSummary {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string;
  onlineStoreUrl: string | null;
}

export interface ProductMetafield {
  id: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

export interface MetafieldDefinitionSummary {
  name: string;
  namespace: string;
  key: string;
  type: string;
}

export interface ShopLocale {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
}

async function gql<T>(
  admin: AdminClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const body = (await response.json()) as { data?: T; errors?: unknown };
  if (!body.data) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

export async function getProduct(
  admin: AdminClient,
  productId: string,
): Promise<ProductSummary> {
  const data = await gql<{
    product: {
      id: string;
      handle: string;
      title: string;
      descriptionHtml: string;
      onlineStoreUrl: string | null;
    } | null;
  }>(
    admin,
    `#graphql
      query PageTailorProduct($id: ID!) {
        product(id: $id) {
          id
          handle
          title
          descriptionHtml
          onlineStoreUrl
        }
      }`,
    { id: productId },
  );
  if (!data.product) throw new Error(`Product not found: ${productId}`);
  return data.product;
}

export async function getProductMetafields(
  admin: AdminClient,
  productId: string,
): Promise<ProductMetafield[]> {
  const all: ProductMetafield[] = [];
  let cursor: string | null = null;
  // Accentuate-heavy shops can exceed one page of metafields; paginate.
  do {
    const data: {
      product: {
        metafields: {
          nodes: ProductMetafield[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    } = await gql(
      admin,
      `#graphql
        query PageTailorProductMetafields($id: ID!, $after: String) {
          product(id: $id) {
            metafields(first: 250, after: $after) {
              nodes {
                id
                namespace
                key
                type
                value
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }`,
      { id: productId, after: cursor },
    );
    const page = data.product?.metafields;
    if (!page) break;
    all.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

// All product metafield definitions — this is how Accentuate Custom Fields
// surfaces show up (Accentuate stores its data as regular Shopify metafields).
export async function getProductMetafieldDefinitions(
  admin: AdminClient,
): Promise<MetafieldDefinitionSummary[]> {
  type DefinitionNode = {
    name: string;
    namespace: string;
    key: string;
    type: { name: string };
  };
  const all: DefinitionNode[] = [];
  let cursor: string | null = null;
  do {
    const data: {
      metafieldDefinitions: {
        nodes: DefinitionNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await gql(
      admin,
      `#graphql
        query PageTailorMetafieldDefinitions($after: String) {
          metafieldDefinitions(first: 250, ownerType: PRODUCT, after: $after) {
            nodes {
              name
              namespace
              key
              type {
                name
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }`,
      { after: cursor },
    );
    all.push(...data.metafieldDefinitions.nodes);
    cursor = data.metafieldDefinitions.pageInfo.hasNextPage
      ? data.metafieldDefinitions.pageInfo.endCursor
      : null;
  } while (cursor);
  return all.map((n) => ({
    name: n.name,
    namespace: n.namespace,
    key: n.key,
    type: n.type.name,
  }));
}

export async function getShopLocales(admin: AdminClient): Promise<ShopLocale[]> {
  const data = await gql<{ shopLocales: ShopLocale[] }>(
    admin,
    `#graphql
      query PageTailorShopLocales {
        shopLocales {
          locale
          name
          primary
          published
        }
      }`,
  );
  return data.shopLocales;
}

export async function getPrimaryDomainUrl(admin: AdminClient): Promise<string> {
  const data = await gql<{ shop: { primaryDomain: { url: string } } }>(
    admin,
    `#graphql
      query PageTailorPrimaryDomain {
        shop {
          primaryDomain {
            url
          }
        }
      }`,
  );
  return data.shop.primaryDomain.url;
}

export interface OrderSummary {
  id: string;
  createdAt: string;
  customerLocale: string | null;
  totalPrice: number;
  lines: Array<{ productId: string; quantity: number; lineRevenue: number }>;
}

export interface OrdersWindowResult {
  orders: OrderSummary[];
  truncated: boolean;
  /** createdAt of the last order fetched — resume point when truncated. */
  lastCreatedAt: string | null;
}

/**
 * Orders created in [from, to), paginated. Used by the experiment tracker to
 * backfill baseline metrics and to top up treatment metrics on demand.
 * Shopify grants apps the last 60 days of orders by default, which covers
 * every allowed experiment window.
 */
export async function getOrdersInWindow(
  admin: AdminClient,
  fromISO: string,
  toISO: string,
  maxOrders = 5000,
): Promise<OrdersWindowResult> {
  const orders: OrderSummary[] = [];
  let cursor: string | null = null;
  let truncated = false;
  const search = `created_at:>='${fromISO}' AND created_at:<'${toISO}'`;

  do {
    // Page sizes are chosen to stay well under Shopify's single-query cost
    // cap (~1000 points): 20 orders x (node + 25-line connection) ≈ 560.
    // Orders with >25 distinct products can miss lines for the tracked
    // product — vanishingly rare for this catalog; accepted.
    const data: {
      orders: {
        nodes: Array<{
          id: string;
          createdAt: string;
          test: boolean;
          cancelledAt: string | null;
          customerLocale: string | null;
          totalPriceSet: { shopMoney: { amount: string } };
          lineItems: {
            nodes: Array<{
              quantity: number;
              originalTotalSet: { shopMoney: { amount: string } };
              product: { id: string } | null;
            }>;
          };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await gql(
      admin,
      `#graphql
        query PageTailorOrders($q: String!, $after: String) {
          orders(first: 20, query: $q, after: $after, sortKey: CREATED_AT) {
            nodes {
              id
              createdAt
              test
              cancelledAt
              customerLocale
              totalPriceSet {
                shopMoney {
                  amount
                }
              }
              lineItems(first: 25) {
                nodes {
                  quantity
                  originalTotalSet {
                    shopMoney {
                      amount
                    }
                  }
                  product {
                    id
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }`,
      { q: search, after: cursor },
    );
    for (const node of data.orders.nodes) {
      // Test and cancelled orders would distort every metric equally badly
      // in both windows only if their rate were constant — exclude them.
      if (node.test || node.cancelledAt) continue;
      orders.push({
        id: node.id,
        createdAt: node.createdAt,
        customerLocale: node.customerLocale,
        totalPrice: parseFloat(node.totalPriceSet.shopMoney.amount),
        lines: node.lineItems.nodes
          .filter((l) => l.product !== null)
          .map((l) => ({
            productId: l.product!.id,
            quantity: l.quantity,
            lineRevenue: parseFloat(l.originalTotalSet.shopMoney.amount),
          })),
      });
    }
    if (orders.length >= maxOrders && data.orders.pageInfo.hasNextPage) {
      truncated = true;
      break;
    }
    cursor = data.orders.pageInfo.hasNextPage
      ? data.orders.pageInfo.endCursor
      : null;
  } while (cursor);

  return {
    orders,
    truncated,
    lastCreatedAt: orders.length ? orders[orders.length - 1].createdAt : null,
  };
}

// Translations registered by Translate & Adapt (or any translation app) live
// in Shopify's Translations API. Each resource (product, metafield) exposes
// translated values per locale keyed by field name.
async function getTranslations(
  admin: AdminClient,
  resourceId: string,
  locale: string,
): Promise<Map<string, string>> {
  const data = await gql<{
    translatableResource: {
      translations: Array<{ key: string; value: string | null }>;
    } | null;
  }>(
    admin,
    `#graphql
      query PageTailorTranslations($resourceId: ID!, $locale: String!) {
        translatableResource(resourceId: $resourceId) {
          translations(locale: $locale) {
            key
            value
          }
        }
      }`,
    { resourceId, locale },
  );
  const map = new Map<string, string>();
  for (const t of data.translatableResource?.translations ?? []) {
    if (t.value) map.set(t.key, t.value);
  }
  return map;
}

/**
 * Storefront URLs in a non-primary locale may use a translated product
 * handle (Translate & Adapt can translate handles). The experiment view
 * beacon reports the handle from the URL, so experiments must track the
 * handle for their locale.
 */
export async function getProductHandleForLocale(
  admin: AdminClient,
  productId: string,
  locale: string,
  isPrimaryLocale: boolean,
): Promise<string> {
  const product = await getProduct(admin, productId);
  if (isPrimaryLocale) return product.handle;
  const translations = await getTranslations(admin, productId, locale);
  return translations.get("handle") ?? product.handle;
}

/**
 * Resolve the base copy for each enabled surface, localized for `locale`.
 * Primary-locale content comes straight from the product/metafields; other
 * locales read the Translate & Adapt translations and fall back to the
 * primary content when a field has no translation.
 */
export async function getLocalizedSurfaceContent(
  admin: AdminClient,
  productId: string,
  locale: string,
  surfaces: CopySurface[],
  isPrimaryLocale: boolean,
): Promise<SurfaceContent[]> {
  // A surface without a selector could never be applied on the storefront,
  // so don't spend generation on it.
  const enabled = surfaces.filter((s) => s.enabled && s.selector.trim() !== "");
  if (enabled.length === 0) return [];

  const product = await getProduct(admin, productId);
  const needsMetafields = enabled.some((s) => s.source === "metafield");
  const metafields = needsMetafields
    ? await getProductMetafields(admin, productId)
    : [];

  const productTranslations = isPrimaryLocale
    ? new Map<string, string>()
    : await getTranslations(admin, productId, locale);

  const result: SurfaceContent[] = [];
  for (const surface of enabled) {
    let content = "";
    if (surface.source === "description") {
      content =
        productTranslations.get("body_html") ?? product.descriptionHtml ?? "";
    } else {
      const mf = metafields.find(
        (m) =>
          m.namespace === surface.namespace && m.key === surface.metafieldKey,
      );
      if (!mf) continue;
      content = mf.value ?? "";
      if (!isPrimaryLocale) {
        // Metafields are their own translatable resources, keyed by "value".
        const mfTranslations = await getTranslations(admin, mf.id, locale);
        content = mfTranslations.get("value") ?? content;
      }
    }
    const trimmed = content.trim();
    if (trimmed) result.push({ surface, content: trimmed });
  }
  return result;
}
