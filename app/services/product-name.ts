/**
 * The product name surface (Ingredient focus pages) is one line of plain
 * text that ends up in a heading, in the basket and on the order. Shared by
 * the generation pipeline, the review page's hand edits and the basket map.
 * No server-only imports: the review page may validate on the client too.
 */
export const PRODUCT_NAME_MAX_CHARS = 120;

/** Markup stripped, whitespace collapsed, surrounding quotes removed. */
export function cleanProductName(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
    .trim();
}

/** Why a cleaned product name cannot be used, or null when it can. */
export function productNameProblem(name: string): string | null {
  if (name === "") return "is empty";
  if (name.length > PRODUCT_NAME_MAX_CHARS) {
    return `is longer than ${PRODUCT_NAME_MAX_CHARS} characters`;
  }
  return null;
}

/**
 * The brand is normally the first word of the original name; a new name
 * that drops it is allowed (the merchant can edit it) but worth a warning.
 */
export function brandWordMissing(originalName: string, newName: string): boolean {
  const first = cleanProductName(originalName).split(" ")[0] ?? "";
  if (first.length < 2) return false;
  return !cleanProductName(newName).toLowerCase().includes(first.toLowerCase());
}
