// @ts-check
/**
 * Page Tailor basket rename (Cart Transform function, Shopify Plus).
 *
 * A basket line added from an Ingredient focus page carries a hidden `_cx`
 * property with the page's variant code (set by the theme embed). The app
 * keeps, on the product, an app-owned JSON metafield mapping each live focus
 * page's code to its product name. When a line's code is in the map, the
 * line's title becomes that name; everything else is left alone. No price
 * or image changes. Synchronous and tiny on purpose: it runs on every cart
 * change for every shopper.
 */
const NO_CHANGES = { operations: [] };
const CODE_RE = /^[a-z0-9]{4,16}$/;
const MAX_TITLE = 255;

/**
 * @param {{ cart: { lines: Array<{ id: string, attribute: { value: string | null } | null, sellingPlanAllocation: unknown, merchandise: { __typename: string, product?: { cartTitles: { jsonValue: unknown } | null } } }> } }} input
 * @returns {{ operations: Array<{ lineUpdate: { cartLineId: string, title: string } }> }}
 */
export function run(input) {
  const operations = [];
  const lines = (input && input.cart && input.cart.lines) || [];
  for (const line of lines) {
    const code = line.attribute && line.attribute.value;
    if (!code || !CODE_RE.test(code)) continue;
    // Shopify rejects lineUpdate on lines with a selling plan: skip them
    // rather than fail the whole run.
    if (line.sellingPlanAllocation) continue;
    const merchandise = line.merchandise;
    if (!merchandise || merchandise.__typename !== "ProductVariant") continue;
    const map =
      merchandise.product &&
      merchandise.product.cartTitles &&
      merchandise.product.cartTitles.jsonValue;
    if (!map || typeof map !== "object") continue;
    const title = typeof map[code] === "string" ? map[code].trim() : "";
    if (!title) continue;
    operations.push({
      lineUpdate: { cartLineId: line.id, title: title.slice(0, MAX_TITLE) },
    });
  }
  return operations.length > 0 ? { operations } : NO_CHANGES;
}
