/**
 * Selector safety rules, shared by server (settings save + payload serving)
 * and client (inline validation in Settings). No server-only imports here.
 *
 * A surface selector must target a specific, named copy container. Selectors
 * that could touch metadata, structured data, price, reviews, or the whole
 * document are rejected — this backs the compliance guarantees in docs/.
 */
export function unsafeSelectorReason(selector: string): string | null {
  const s = selector.toLowerCase().trim();
  if (!s) return null;
  // CSS identifier escapes (e.g. "\73cript" === "script") would bypass every
  // textual check below.
  if (s.includes("\\")) return "contains CSS escape sequences";
  // The universal selector can rewrite arbitrary elements (including inside
  // attribute selectors like [class*=x] the risk/benefit is not worth it).
  if (s.includes("*")) return "contains the universal selector (*)";
  if (/(^|[\s>+~,(])(script|style|meta|link|base|title|iframe|head|html|body|main|template|noscript)(?![\w-])/.test(s)) {
    return "targets a document-level or metadata element";
  }
  if (s.includes(":root")) return "targets the document root";
  if (s.includes("itemprop") || s.includes("ld+json") || s.includes("application/ld")) {
    return "targets structured data (schema.org)";
  }
  if (s.includes("canonical")) return "targets the canonical link";
  // Token-start boundary (letter/digit may not precede) so ".preview" or
  // ".migrating" are not caught by "review"/"rating", while ".price",
  // ".product-price", "[data-review]" still are. No lookbehind: this module
  // also runs in the browser (Settings inline validation).
  if (/(^|[^a-z0-9])price/.test(s)) return "targets price elements";
  if (/(^|[^a-z0-9])(review|rating|stars?(?![\w-]))/.test(s)) {
    return "targets review/rating elements";
  }
  // Every comma-separated part must name a class, id, or attribute — bare
  // element/pseudo selectors ("div", "section", ":first-child") select far
  // too broadly and are almost always a configuration mistake.
  for (const part of s.split(",")) {
    const p = part.trim();
    if (p && !/[.#[]/.test(p)) {
      return "is too broad: use a class (.x) or id (#x) that names the copy container";
    }
  }
  return null;
}
