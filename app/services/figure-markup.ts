import { load as loadHtml } from "cheerio";
import type { FigureAnchor } from "./types";

/**
 * Figure marker: where an illustration renders inside a section's HTML.
 *
 * The stored `adapted` copy of an illustrated surface carries one empty
 * `<div data-pt-figure="…"></div>`; serving replaces it with the real
 * <figure>. The copy-writing models never see an <img>: the marker is
 * inserted by the app (placement pass / review page), the refine prompt is
 * told to keep it in place, and the sanitizer keeps only this attribute.
 * Pure string-in / string-out helpers, shared by the pipeline, serving,
 * versions and the review page.
 */

export const MARKER_ATTR = "data-pt-figure";
export const MARKER_VALUE_RE = /^[a-z0-9-]{1,40}$/;
const MARKER_SELECTOR = `div[${MARKER_ATTR}]`;

/** Marker value for a surface key: "page:science" -> "science". */
export function markerValueFor(surfaceKey: string): string {
  const value = surfaceKey
    .toLowerCase()
    .replace(/^page:/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (value || "figure").slice(0, 40);
}

function parse(html: string) {
  const $ = loadHtml(`<div id="pt-root">${html}</div>`);
  return { $, root: $("#pt-root") };
}

/** One top-level block of a section, as shown to the placement pass and in
 *  the review page's position picker. Markers are not blocks. */
export interface SectionBlock {
  index: number;
  tag: string;
  excerpt: string;
}

export function describeBlocks(html: string): SectionBlock[] {
  const { $, root } = parse(html);
  const blocks: SectionBlock[] = [];
  let index = 0;
  for (const child of root.children().toArray()) {
    const $child = $(child);
    if ($child.is(MARKER_SELECTOR)) continue;
    const tag =
      (($child.prop("tagName") as string | undefined) ?? "").toLowerCase() ||
      "div";
    const text = $child.text().replace(/\s+/g, " ").trim();
    blocks.push({ index: index++, tag, excerpt: text.slice(0, 140) });
  }
  return blocks;
}

/** True when the HTML holds a marker anywhere (direct child or nested). */
export function hasMarker(html: string): boolean {
  if (!html.includes(MARKER_ATTR)) return false;
  return parse(html).root.find(MARKER_SELECTOR).length > 0;
}

/**
 * Where the (first top-level) marker sits among the section's blocks. Null
 * when there is no marker or it is nested inside a block by a hand edit
 * (the figure still renders there; the position picker shows "custom").
 */
export function locateMarker(html: string): FigureAnchor | null {
  const { $, root } = parse(html);
  const children = root.children().toArray();
  let blocksBefore = 0;
  let found = false;
  let totalBlocks = 0;
  for (const child of children) {
    if ($(child).is(MARKER_SELECTOR)) {
      if (!found) found = true;
      continue;
    }
    totalBlocks++;
    if (!found) blocksBefore++;
  }
  if (!found) return null;
  if (blocksBefore === 0) return { kind: "top" };
  if (blocksBefore >= totalBlocks) return { kind: "bottom" };
  return { kind: "after", index: blocksBefore - 1 };
}

/** Strip every marker (used before re-placing, and when a figure is removed). */
export function removeMarker(html: string): string {
  if (!html.includes(MARKER_ATTR)) return html;
  const { root } = parse(html);
  root.find(MARKER_SELECTOR).remove();
  return root.html() ?? "";
}

/** Put exactly one marker at the anchor (any existing marker is removed
 *  first). Out-of-range indexes clamp to the nearest block. */
export function insertMarker(
  html: string,
  anchor: FigureAnchor,
  value: string,
): string {
  const { $, root } = parse(html);
  root.find(MARKER_SELECTOR).remove();
  const safeValue = MARKER_VALUE_RE.test(value) ? value : "figure";
  const marker = `<div ${MARKER_ATTR}="${safeValue}"></div>`;
  const blocks = root.children().toArray();
  if (anchor.kind === "top" || blocks.length === 0) {
    root.prepend(marker);
  } else if (anchor.kind === "bottom") {
    root.append(marker);
  } else {
    const i = Math.max(0, Math.min(anchor.index, blocks.length - 1));
    if (anchor.kind === "before") $(blocks[i]).before(marker);
    else $(blocks[i]).after(marker);
  }
  return root.html() ?? "";
}

/** The src of every <img> in the HTML (used as the sanitizer's allowlist:
 *  images the theme region already had may stay; nothing else may). */
export function imageSrcsOf(html: string): string[] {
  if (!html || !/<img/i.test(html)) return [];
  const { $, root } = parse(html);
  const out = new Set<string>();
  root.find("img[src]").each((_, el) => {
    const src = ($(el).attr("src") ?? "").trim();
    if (src) out.add(src);
  });
  return [...out];
}

export interface FigureRender {
  src: string;
  alt: string;
  width: number;
  height: number;
  caption: string;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The served <figure>: full-width image, lazy-loaded, optional caption. */
export function buildFigureHtml(figure: FigureRender): string {
  const caption = figure.caption.trim();
  const img = `<img src="${escapeAttr(figure.src)}" alt="${escapeAttr(
    figure.alt,
  )}" width="${Math.max(1, Math.round(figure.width))}" height="${Math.max(
    1,
    Math.round(figure.height),
  )}" loading="lazy">`;
  const figcaption = caption ? `<figcaption>${escapeText(caption)}</figcaption>` : "";
  return `<figure class="pt-figure">${img}${figcaption}</figure>`;
}

/** Replace the marker with the figure (top of the section when there is no
 *  marker); any extra markers are dropped. */
export function composeFigure(html: string, figureHtml: string): string {
  const { root } = parse(html);
  const markers = root.find(MARKER_SELECTOR);
  if (markers.length === 0) {
    root.prepend(figureHtml);
  } else {
    markers.first().replaceWith(figureHtml);
    markers.slice(1).remove();
  }
  return root.html() ?? "";
}
