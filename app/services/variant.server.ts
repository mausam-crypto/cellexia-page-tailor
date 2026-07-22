import { randomInt } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { load as loadHtml } from "cheerio";
import prisma from "../db.server";
import { fetchArticle, fetchPublicHtml } from "./article.server";
import {
  analyzeAndAdapt,
  claimGuard,
  heuristicFindings,
  normalizeGeneratedPunctuation,
} from "./generate.server";
import { getSettings, unsafeSelectorReason } from "./settings.server";
import {
  getLocalizedSurfaceContent,
  getPrimaryDomainUrl,
  getProduct,
  getProductHandleForLocale,
  getShopLocales,
  type AdminClient,
} from "./shopify-data.server";
import type { CopySurface, SurfaceContent, VariantPayload } from "./types";

// Opaque, keyword-free slug for the public URL. Deliberately meaningless so
// the parameter carries no query intent to crawlers or competitors.
const HANDLE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function generateVariantHandle(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += HANDLE_ALPHABET[randomInt(HANDLE_ALPHABET.length)];
  }
  return out;
}

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2"]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ["src", "alt", "width", "height", "loading"],
    "*": ["class"],
  },
  // Approved copy only ever travels app-db -> storefront; still strip anything
  // executable so a bad generation can never become an XSS vector.
  disallowedTagsMode: "discard",
};

export function sanitizeAdaptedHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

export async function createArticlesForProduct(
  admin: AdminClient,
  shop: string,
  input: {
    productId: string;
    locale: string;
    urls: string[];
    pastedTitle?: string;
    pastedText?: string;
    /** Applies to every article in this batch; read at generation time. */
    metaMode?: boolean;
  },
): Promise<string[]> {
  const product = await getProduct(admin, input.productId);

  // The storefront embed reports the handle it sees in the URL path, which
  // for non-primary locales is the TRANSLATED handle (Translate & Adapt).
  // Store that same handle, or serving would silently never match.
  const locales = await getShopLocales(admin);
  const primary = locales.find((l) => l.primary)?.locale ?? "en";
  const isPrimaryLocale =
    input.locale.toLowerCase() === primary.toLowerCase();
  const localeHandle = await getProductHandleForLocale(
    admin,
    input.productId,
    input.locale,
    isPrimaryLocale,
  );

  const rows: Array<{ sourceUrl?: string; sourceTitle?: string; sourceText?: string }> =
    input.urls.map((url) => ({ sourceUrl: url }));
  if (input.pastedText?.trim()) {
    rows.push({
      sourceTitle: input.pastedTitle?.trim() || "Pasted article",
      sourceText: input.pastedText.trim(),
    });
  }

  // One transaction: a mid-batch failure creates nothing, so a retry can
  // never produce duplicate rows for the earlier URLs.
  const created = await prisma.$transaction(
    rows.map((row) =>
      prisma.article.create({
        data: {
          shop,
          productId: product.id,
          productHandle: localeHandle,
          productTitle: product.title,
          locale: input.locale,
          sourceUrl: row.sourceUrl ?? null,
          sourceTitle: row.sourceTitle ?? null,
          sourceText: row.sourceText ?? null,
          metaMode: input.metaMode ?? false,
          status: "pending",
          variantHandle: generateVariantHandle(),
        },
      }),
    ),
  );
  return created.map((a) => a.id);
}

/**
 * Run the full pipeline for one article: fetch/extract the article content,
 * pull the localized base copy, generate the adaptation, run the claim
 * guard, and put the variant live (status "approved", reviewedAt null) - the
 * merchant is then notified to review it post-publication.
 */
// A crashed run must not lock its article forever.
const GENERATION_LOCK_STALE_MS = 15 * 60 * 1000;

export async function generateForArticle(
  admin: AdminClient,
  shop: string,
  articleId: string,
): Promise<void> {
  const article = await prisma.article.findFirst({
    where: { id: articleId, shop },
  });
  if (!article) throw new Error("Article not found");

  // In-flight lock: concurrent generations of the same article (second tab,
  // double click, retry while the first is still running) would interleave
  // their override rewrites and let approval attest copy the reviewer never
  // saw. Status is NOT used as the lock so an approved article keeps serving
  // untouched while it regenerates.
  const lock = await prisma.article.updateMany({
    where: {
      id: article.id,
      shop,
      OR: [
        { generatingAt: null },
        { generatingAt: { lt: new Date(Date.now() - GENERATION_LOCK_STALE_MS) } },
      ],
    },
    data: { generatingAt: new Date() },
  });
  if (lock.count === 0) {
    throw new Error(
      "A generation is already running for this article. Wait for it to finish.",
    );
  }

  try {
    const settings = await getSettings(shop);
    const locales = await getShopLocales(admin);
    const primary = locales.find((l) => l.primary)?.locale ?? "en";
    const isPrimaryLocale =
      article.locale.toLowerCase() === primary.toLowerCase();

    let title = article.sourceTitle ?? "";
    let text = article.sourceText ?? "";
    if (article.sourceUrl && !text) {
      const extracted = await fetchArticle(article.sourceUrl);
      title = extracted.title || title;
      text = extracted.text;
    }
    if (!text) throw new Error("Article has no content to analyze.");

    // Admin-sourced surfaces (description, metafields) come from the Admin
    // API; live-page surfaces are read from the rendered storefront page.
    const adminSurfaces = settings.surfaces.filter((s) => s.source !== "page");
    const pageSurfaces = settings.surfaces.filter(
      (s) => s.source === "page" && s.enabled && s.selector.trim() !== "",
    );

    const surfaces = await getLocalizedSurfaceContent(
      admin,
      article.productId,
      article.locale,
      adminSurfaces,
      isPrimaryLocale,
    );
    if (pageSurfaces.length > 0) {
      surfaces.push(
        ...(await getPageSurfaceContent(admin, article, primary, pageSurfaces)),
      );
    }
    if (surfaces.length === 0) {
      throw new Error(
        "No copy surfaces with content found for this product/locale. Check Settings.",
      );
    }

    const analysis = await analyzeAndAdapt({
      articleTitle: title,
      articleText: text,
      productTitle: article.productTitle,
      locale: article.locale,
      intensity: settings.intensity,
      metaMode: article.metaMode,
      surfaces,
    });

    // Every requested surface must come back with a matching key — a silent
    // mismatch would otherwise drop a surface (or its warnings) unnoticed.
    const missing = surfaces.filter(
      (s) => !analysis.adapted.some((a) => a.key === s.surface.key),
    );
    if (missing.length > 0) {
      throw new Error(
        `Generation did not return these surfaces: ${missing
          .map((m) => m.surface.key)
          .join(", ")}. Retry the generation.`,
      );
    }

    const pairs = analysis.adapted
      .map((a) => {
        const base = surfaces.find((s) => s.surface.key === a.key);
        return base
          ? { key: a.key, original: base.content, adapted: a.adapted }
          : null;
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    if (pairs.length === 0) {
      throw new Error("Generation produced no usable surfaces. Retry.");
    }

    const guard = await claimGuard(pairs, text);

    // Same completeness rule as the adaptation pass: a surface the guard
    // silently skipped would be stored with no findings and become approvable
    // without attestation — the exact gate the guard exists to hold. This also
    // blunts prompt-injection via the article: a response manipulated into
    // dropping surfaces fails the generation instead of neutering the guard.
    const guardMissing = pairs.filter((p) => !guard.has(p.key));
    if (guardMissing.length > 0) {
      throw new Error(
        `The claim guard did not return these surfaces: ${guardMissing
          .map((p) => p.key)
          .join(", ")}. Retry the generation.`,
      );
    }

    // Proof-point quotes are shown to the reviewer as the article's verbatim
    // supporting text — verify that deterministically instead of trusting the
    // model, and mark any quote we can't find so the UI can say so.
    const normalizedArticle = normalizeForMatch(text);
    const proofPoints = analysis.proofPoints.map((p) => ({
      ...p,
      // Claims are generated copy (punctuation-normalized); quotes must stay
      // verbatim article text or the verification below would be meaningless.
      claim: normalizeGeneratedPunctuation(p.claim),
      verified:
        normalizeForMatch(p.quote) !== "" &&
        normalizedArticle.includes(normalizeForMatch(p.quote)),
    }));

    await prisma.$transaction([
      prisma.override.deleteMany({ where: { articleId: article.id } }),
      ...pairs.map((pair) => {
        const surface = surfaces.find((s) => s.surface.key === pair.key)!;
        const dashFree = normalizeGeneratedPunctuation(pair.adapted);
        const adaptedContent =
          surface.surface.mode === "html"
            ? sanitizeAdaptedHtml(dashFree)
            : dashFree;
        const guardFindings = guard.get(pair.key);
        const heuristics = heuristicFindings(pair.original, adaptedContent, {
          articleText: text,
          metaMode: article.metaMode,
        });
        const warnings = [
          ...(guardFindings?.warnings ?? []),
          ...heuristics.warnings,
        ];
        const articleClaims = [
          ...(guardFindings?.articleClaims ?? []),
          ...heuristics.articleClaims,
        ];
        const notes = analysis.adapted.find((a) => a.key === pair.key)?.notes;
        return prisma.override.create({
          data: {
            articleId: article.id,
            surfaceKey: pair.key,
            label: surface.surface.label,
            selector: surface.surface.selector,
            mode: surface.surface.mode,
            original: pair.original,
            adapted: adaptedContent,
            notes: notes ?? null,
            warnings: warnings.length ? JSON.stringify(warnings) : null,
            articleClaims: articleClaims.length
              ? JSON.stringify(articleClaims)
              : null,
          },
        });
      }),
      prisma.article.update({
        where: { id: article.id },
        data: {
          sourceTitle: title || null,
          sourceText: text,
          detectedQuery: analysis.detectedQuery,
          queryVariants: JSON.stringify(analysis.queryVariants),
          evidence: JSON.stringify(analysis.evidence),
          proofPoints: proofPoints.length ? JSON.stringify(proofPoints) : null,
          generatedMetaMode: article.metaMode,
          // Post-publication review model: a successful generation goes live
          // immediately (served only while the master serving switch is on)
          // and resets reviewedAt so the merchant is notified to review the
          // new copy. Generation is always an explicit merchant action, so
          // this applies to offline articles being regenerated too.
          status: "approved",
          wasApproved: true,
          reviewedAt: null,
          errorMessage: null,
          generatingAt: null,
        },
      }),
    ]);
  } catch (error) {
    // A failed regeneration must not take down a live variant. Guard on the
    // status AT FAILURE TIME, not the row read at entry: generation takes
    // minutes and the article can be approved while it runs. The two guarded
    // writes are mutually exclusive on status, so whichever matches applies.
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    await prisma.article.updateMany({
      where: { id: article.id, status: { not: "approved" } },
      data: { status: "error", errorMessage, generatingAt: null },
    });
    await prisma.article.updateMany({
      where: { id: article.id, status: "approved" },
      data: { errorMessage, generatingAt: null },
    });
    throw error;
  }
}

/**
 * Original copy for live-page surfaces: fetch the rendered storefront
 * product page (locale-aware URL) and extract each configured region's
 * inner HTML - heading and body together, exactly as the visitor sees it,
 * so the whole container can be adapted and swapped as one unit without
 * theme changes. Regions that don't exist on the page are skipped, like
 * empty metafield surfaces.
 */
async function getPageSurfaceContent(
  admin: AdminClient,
  article: { productId: string; productHandle: string; locale: string },
  primaryLocale: string,
  pageSurfaces: CopySurface[],
): Promise<SurfaceContent[]> {
  // A draft or unpublished product has no live page: nothing to read, and
  // nothing these surfaces could ever swap. Skip them so pre-launch variant
  // prep keeps working on the admin-sourced surfaces.
  const product = await getProduct(admin, article.productId);
  if (!product.onlineStoreUrl) return [];

  const primaryDomainUrl = await getPrimaryDomainUrl(admin);
  const base = primaryDomainUrl.replace(/\/$/, "");
  const isPrimary =
    article.locale.toLowerCase() === primaryLocale.toLowerCase();
  const prefix = isPrimary ? "" : `/${article.locale.toLowerCase()}`;
  const url = `${base}${prefix}/products/${article.productHandle}`;

  let html: string;
  try {
    html = await fetchPublicHtml(url);
  } catch (error) {
    // Loud failure: silently generating without the configured tab surfaces
    // would look like success while leaving the tabs unadapted.
    throw new Error(
      `Could not read the live product page (${url}) for the live-page surfaces: ${
        error instanceof Error ? error.message : String(error)
      }. Retry, or disable the live-page surfaces in Settings.`,
    );
  }

  const $ = loadHtml(html);
  const result: SurfaceContent[] = [];
  let matchedRegions = 0;
  for (const surface of pageSurfaces) {
    let content = "";
    try {
      const el = $(surface.selector).first();
      if (el.length) {
        matchedRegions++;
        const clone = el.clone();
        clone.find("script, style, noscript").remove();
        content =
          surface.mode === "html"
            ? (clone.html() ?? "").trim()
            : clone.text().replace(/\s+/g, " ").trim();
      }
    } catch {
      content = "";
    }
    if (content) result.push({ surface, content });
  }
  // A page with NONE of the configured regions is almost never the right
  // page: password-protected storefronts and bot interstitials return 200
  // with a page that matches nothing. Silently generating without every tab
  // surface would look like success while leaving the tabs unadapted.
  if (matchedRegions === 0) {
    throw new Error(
      `None of the configured live-page regions were found at ${url}. If the store is password-protected, retry after removing the password; if your theme does not have these regions, disable the live-page surfaces in Settings.`,
    );
  }
  return result;
}

/** True while a non-stale generation lock is held for the article. */
export function isGenerationInFlight(article: {
  generatingAt: Date | null;
}): boolean {
  return (
    article.generatingAt !== null &&
    Date.now() - article.generatingAt.getTime() < GENERATION_LOCK_STALE_MS
  );
}

// Whitespace/case/typographic-quote-insensitive matching for proof-point
// quote verification against the extracted article text.
function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the shareable URL the team pastes into the article. Non-primary
 * locales use Shopify's default subfolder structure (/fr/products/...).
 */
export function buildVariantUrl(options: {
  primaryDomainUrl: string;
  productHandle: string;
  locale: string;
  primaryLocale: string;
  paramName: string;
  variantHandle: string;
}): string {
  const base = options.primaryDomainUrl.replace(/\/$/, "");
  const isPrimary =
    options.locale.toLowerCase() === options.primaryLocale.toLowerCase();
  const prefix = isPrimary ? "" : `/${options.locale.toLowerCase()}`;
  return `${base}${prefix}/products/${options.productHandle}?${options.paramName}=${options.variantHandle}`;
}

/**
 * The storefront payload for one approved variant. Returns null when the
 * handle is unknown, unapproved, or requested for the wrong product/locale —
 * the theme embed fails open to the normal page in every one of those cases.
 */
export async function getVariantPayload(
  shop: string,
  productHandle: string,
  variantHandle: string,
  locale: string,
): Promise<VariantPayload | null> {
  // Master switch: a fresh install serves nothing, ever, until the merchant
  // explicitly enables serving in Settings. Also the emergency stop.
  const settings = await getSettings(shop);
  if (!settings.servingEnabled) return null;

  const article = await prisma.article.findFirst({
    where: {
      shop,
      variantHandle,
      productHandle,
      status: "approved",
    },
    include: { overrides: true },
  });
  if (!article) return null;
  if (locale && article.locale.toLowerCase() !== locale.toLowerCase()) {
    return null;
  }

  // Overrides snapshot selector/mode at generation time; the merchant's
  // CURRENT settings win at serve time, so disabling a surface (or fixing
  // its selector after a theme change) takes effect on live variants
  // immediately - which is what the Settings page promises.
  const currentSurfaces = new Map(
    settings.surfaces
      .filter((s) => s.enabled && s.selector.trim() !== "")
      .map((s) => [s.key, s]),
  );

  const ops = article.overrides
    .filter(
      (o) =>
        o.enabled &&
        currentSurfaces.has(o.surfaceKey) &&
        // The stored content was generated and sanitized under the snapshot
        // mode. If the merchant has since flipped the surface's swap mode,
        // serving it would render raw HTML as text (or vice versa) - drop
        // the op (fail open) until a regeneration re-snapshots the mode.
        currentSurfaces.get(o.surfaceKey)!.mode === o.mode,
    )
    .map((o) => {
      const surface = currentSurfaces.get(o.surfaceKey)!;
      return {
        selector: surface.selector,
        mode: surface.mode === "html" ? ("html" as const) : ("text" as const),
        content:
          surface.mode === "html" ? sanitizeAdaptedHtml(o.adapted) : o.adapted,
      };
    })
    .filter(
      (op) =>
        // Defense in depth: never serve an op aimed at metadata, structured
        // data, price, or review elements, even if one slipped into the DB.
        unsafeSelectorReason(op.selector) === null &&
        // An empty payload would blank a section of the live page - the one
        // way a served op could visibly damage the storefront.
        (op.mode === "html"
          ? op.content.replace(/<[^>]*>/g, "").trim() !== ""
          : op.content.trim() !== ""),
    );
  if (ops.length === 0) return null;

  return { v: variantHandle, locale: article.locale, ops };
}
