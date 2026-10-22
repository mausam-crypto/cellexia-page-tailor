import { randomInt } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { load as loadHtml } from "cheerio";
import type {
  Article as ArticleRow,
  Override as OverrideRow,
} from "@prisma/client";
import prisma from "../db.server";
import { fetchArticle, fetchPublicHtml } from "./article.server";
import {
  adaptFromBrief,
  analyzeAndAdapt,
  claimGuard,
  heuristicFindings,
  normalizeGeneratedPunctuation,
  refineFromBrief,
} from "./generate.server";
import {
  buildFigureHtml,
  composeFigure,
  hasMarker,
  imageSrcsOf,
  insertMarker,
  locateMarker,
  MARKER_ATTR,
  MARKER_VALUE_RE,
  markerValueFor,
  removeMarker,
} from "./figure-markup";
import { figureJobAfterGeneration, runFigureJob } from "./illustrations.server";
import { getSettings, unsafeSelectorReason } from "./settings.server";
import {
  getLocalizedSurfaceContent,
  getPrimaryDomainUrl,
  getProduct,
  getProductHandleForLocale,
  getShopLocales,
  type AdminClient,
} from "./shopify-data.server";
import {
  BRIEF_ADVANCED_FIELDS,
  illustrationsAllowed,
  normalizeAdaptationMode,
  normalizeBriefAdvanced,
  parseFigureJob,
  parseIllustrationPlan,
  type BriefAdvanced,
  type ClaimFindings,
  type CopySurface,
  type IllustrationPlan,
  type ShopSettingsData,
  type SurfaceContent,
  type SurfaceSnapshot,
  type VariantPayload,
} from "./types";
import {
  buildVersionCreate,
  prepareVersion,
  pruneVersions,
  snapshotOverrides,
} from "./versions.server";

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
  // button: the theme's FAQ accordions use <button> question rows; without
  // it the sanitizer would flatten swapped FAQ markup. Attributes stay
  // restricted to class, so a served button carries no behavior of its own.
  // figure/figcaption: the served illustration; data-pt-figure: its marker.
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    "img",
    "h1",
    "h2",
    "button",
    "figure",
    "figcaption",
  ]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ["src", "alt", "width", "height", "loading"],
    div: [MARKER_ATTR],
    "*": ["class"],
  },
  // Approved copy only ever travels app-db -> storefront; still strip anything
  // executable so a bad generation can never become an XSS vector.
  disallowedTagsMode: "discard",
};

/**
 * Sanitize adapted HTML. Images are allowlisted, not banned: an <img> stays
 * only when its src is one the theme region already had (pass the
 * original's srcs) or, at serve time, the app's own figure URL. So a model
 * or a hand edit can never introduce a picture; the figure marker is kept
 * only with a well-formed value.
 */
export function sanitizeAdaptedHtml(
  html: string,
  options: { allowedImageSrcs?: string[] } = {},
): string {
  const allowed = new Set((options.allowedImageSrcs ?? []).map((s) => s.trim()));
  return sanitizeHtml(html, {
    ...SANITIZE_OPTIONS,
    exclusiveFilter: (frame) => {
      if (frame.tag === "img") {
        return !allowed.has((frame.attribs.src ?? "").trim());
      }
      if (frame.tag === "div" && MARKER_ATTR in frame.attribs) {
        return !MARKER_VALUE_RE.test(frame.attribs[MARKER_ATTR] ?? "");
      }
      return false;
    },
  });
}

/** Prefix on Article.errorMessage when a figure job (drawing/placing an
 *  illustration) failed as a whole; per-surface failures live on the
 *  Override rows instead and never touch the article. */
export const ILLUSTRATION_FAILED_PREFIX = "Illustration failed: ";

function emptyFigureFields() {
  return {
    figureImageId: null as string | null,
    figureCaption: null as string | null,
    figureAlt: null as string | null,
    figureAlternatives: null as string | null,
    figureSource: null as string | null,
  };
}

/** Figure columns of the previous row for the same surface (a regeneration
 *  keeps the illustration; the figure phase then re-places it). */
function carriedFigureFields(
  previousRows: Array<{
    surfaceKey: string;
    figureImageId: string | null;
    figureCaption: string | null;
    figureAlt: string | null;
    figureAlternatives: string | null;
    figureSource: string | null;
  }>,
  surfaceKey: string,
) {
  const prev = previousRows.find((r) => r.surfaceKey === surfaceKey);
  if (!prev?.figureImageId) return emptyFigureFields();
  return {
    figureImageId: prev.figureImageId,
    figureCaption: prev.figureCaption,
    figureAlt: prev.figureAlt,
    figureAlternatives: prev.figureAlternatives,
    figureSource: prev.figureSource,
  };
}

/**
 * Figure phase after a generation from the base copy: draw or place the
 * illustrations the creation form asked for (or keep the ones the variant
 * had), once the copy is live. Takes the generation lock again for its
 * duration (hand edits wait; the review page shows "drawing") and never
 * fails the generation: per-surface problems land on the Override rows, a
 * whole-phase crash on Article.errorMessage.
 */
async function runFigurePhase(
  admin: AdminClient,
  shop: string,
  articleId: string,
  settings: ShopSettingsData,
  plan: IllustrationPlan,
  previousRows: Array<{ surfaceKey: string; figureImageId: string | null }>,
  newRows: Array<{ surfaceKey: string; mode: string }>,
  versionNumber: number,
): Promise<void> {
  const job = figureJobAfterGeneration({
    plan,
    previousRows,
    newRows,
    surfaces: settings.surfaces,
  });
  if (!job) return;
  const claimed = await prisma.article.updateMany({
    where: { id: articleId, generatingAt: null },
    data: { generatingAt: new Date(), pendingFigureJob: JSON.stringify(job) },
  });
  if (claimed.count === 0) return;
  try {
    await runFigureJob(admin, shop, articleId, job, {
      patchVersionNumber: versionNumber,
    });
  } catch (error) {
    console.error(`Figure phase failed for article ${articleId}`, error);
    await prisma.article
      .updateMany({
        where: { id: articleId },
        data: {
          generatingAt: null,
          pendingFigureJob: null,
          errorMessage: `${ILLUSTRATION_FAILED_PREFIX}${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      })
      .catch(() => {});
  }
}

// V2 plan entries are generated copy shown on the review page: apply the
// same dash normalization as every other stored generation output.
function normalizeV2Items(
  items: Array<{ point: string; detail: string }>,
): Array<{ point: string; detail: string }> {
  return items.map((item) => ({
    point: normalizeGeneratedPunctuation(item.point),
    detail: normalizeGeneratedPunctuation(item.detail),
  }));
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
    /** Adaptation mode for every article in this batch; read at generation
     *  time. "standard" | "subtle" | "meta" | "ultra" | "persona" | "max"
     *  | "v2". */
    mode?: string;
    /** Illustration choices for every article in this batch (JSON
     *  IllustrationPlan), applied by the figure phase after generation. */
    illustrationPlan?: string | null;
  },
): Promise<string[]> {
  const product = await getProduct(admin, input.productId);
  const locales = await getShopLocales(admin);
  const localeHandle = await resolveLocaleHandle(
    admin,
    input.productId,
    input.locale,
    locales,
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
          sourceKind: row.sourceUrl ? "article" : "pasted",
          sourceUrl: row.sourceUrl ?? null,
          sourceTitle: row.sourceTitle ?? null,
          sourceText: row.sourceText ?? null,
          mode: normalizeAdaptationMode(input.mode ?? "standard"),
          illustrationPlan: input.illustrationPlan ?? null,
          status: "pending",
          variantHandle: generateVariantHandle(),
        },
      }),
    ),
  );
  return created.map((a) => a.id);
}

/**
 * The storefront embed reports the handle it sees in the URL path, which
 * for non-primary locales is the TRANSLATED handle (Translate & Adapt).
 * Store that same handle, or serving would silently never match.
 */
async function resolveLocaleHandle(
  admin: AdminClient,
  productId: string,
  locale: string,
  locales: Awaited<ReturnType<typeof getShopLocales>>,
): Promise<string> {
  const primary = locales.find((l) => l.primary)?.locale ?? "en";
  const isPrimaryLocale = locale.toLowerCase() === primary.toLowerCase();
  return getProductHandleForLocale(admin, productId, locale, isPrimaryLocale);
}

/**
 * Create brief-sourced variants: one Article row per brief x locale, each
 * with its own variant URL, all "pending" until the queue generates them.
 * One transaction: a mid-batch failure creates nothing.
 */
export async function createBriefsForProduct(
  admin: AdminClient,
  shop: string,
  input: {
    productId: string;
    locales: string[];
    briefs: Array<{
      name: string;
      text: string;
      references?: string;
      advanced?: BriefAdvanced;
      /** JSON IllustrationPlan for this brief (every language of it). */
      illustrationPlan?: string | null;
    }>;
  },
): Promise<string[]> {
  const product = await getProduct(admin, input.productId);
  const locales = await getShopLocales(admin);
  const uniqueLocales = [...new Set(input.locales.map((l) => l.trim()).filter(Boolean))];
  const handles = new Map<string, string>();
  for (const locale of uniqueLocales) {
    handles.set(
      locale,
      await resolveLocaleHandle(admin, input.productId, locale, locales),
    );
  }

  const rows = uniqueLocales.flatMap((locale) =>
    input.briefs.map((brief) => ({ locale, brief })),
  );
  const created = await prisma.$transaction(
    rows.map(({ locale, brief }) => {
      const advanced = normalizeBriefAdvanced(brief.advanced ?? {});
      return prisma.article.create({
        data: {
          shop,
          productId: product.id,
          productHandle: handles.get(locale)!,
          productTitle: product.title,
          locale,
          sourceKind: "brief",
          briefName: brief.name.trim(),
          briefText: brief.text.trim(),
          briefReferences: brief.references?.trim() || null,
          briefAdvanced:
            Object.keys(advanced).length > 0 ? JSON.stringify(advanced) : null,
          illustrationPlan: brief.illustrationPlan ?? null,
          mode: "standard",
          status: "pending",
          variantHandle: generateVariantHandle(),
        },
      });
    }),
  );
  return created.map((a) => a.id);
}

/**
 * Run the full pipeline for one article: fetch/extract the article content,
 * pull the localized base copy, generate the adaptation, run the claim
 * guard, and put the variant live (status "approved", reviewedAt null) - the
 * merchant is then notified to review it post-publication.
 */
// A crashed run must not lock its article forever. Must stay above the
// queue's RUN_TIMEOUT_MS so a live slot's lock can never be claimed as
// stale mid-run.
export const GENERATION_LOCK_STALE_MS = 30 * 60 * 1000;

export async function generateForArticle(
  admin: AdminClient,
  shop: string,
  articleId: string,
  options: { lockAlreadyHeld?: boolean } = {},
): Promise<void> {
  const article = await prisma.article.findFirst({
    where: { id: articleId, shop },
  });
  if (!article) throw new Error("Article not found");

  // In-flight lock: concurrent generations of the same article (second tab,
  // double click, retry while the first is still running) would interleave
  // their override rewrites and let review sign off copy the reviewer never
  // saw. Status is NOT used as the lock so an approved article keeps serving
  // untouched while it regenerates. The background queue claims the lock
  // atomically together with dequeueing and passes lockAlreadyHeld.
  if (!options.lockAlreadyHeld) {
    await acquireGenerationLock(article.id, shop);
  }

  // Brief-sourced variants: a pending refinement edits the CURRENT copy;
  // anything else (first generation, "Start over", a retry) regenerates
  // from the base copy. Decided up front so a failure is recorded under the
  // right label.
  const isBrief = article.sourceKind === "brief";
  // A pending figure job (from the review page) draws or places an
  // illustration without touching the copy at all.
  const figureJob = parseFigureJob(article.pendingFigureJob);
  let runKind: "generate" | "refine" | "figure" = figureJob
    ? "figure"
    : isBrief && (article.pendingRefinement ?? "").trim() !== ""
      ? "refine"
      : "generate";

  try {
    if (runKind === "figure" && figureJob) {
      await runFigureJob(admin, shop, article.id, figureJob);
      return;
    }
    const settings = await getSettings(shop);
    const locales = await getShopLocales(admin);
    const primary = locales.find((l) => l.primary)?.locale ?? "en";
    const isPrimaryLocale =
      article.locale.toLowerCase() === primary.toLowerCase();

    if (isBrief) {
      const existing = await prisma.override.findMany({
        where: { articleId: article.id },
        orderBy: { surfaceKey: "asc" },
      });
      if (runKind === "refine" && existing.length === 0) {
        // A refinement queued against copy that has since disappeared:
        // nothing to refine, so run a plain generation instead.
        runKind = "generate";
      }
      if (runKind === "refine") {
        await runBriefRefinement(
          article,
          existing,
          (article.pendingRefinement ?? "").trim(),
        );
      } else {
        await runBriefPipeline(
          admin,
          article,
          settings,
          primary,
          isPrimaryLocale,
          existing,
        );
      }
      return;
    }

    let title = article.sourceTitle ?? "";
    let text = article.sourceText ?? "";
    if (article.sourceUrl && !text) {
      const extracted = await fetchArticle(article.sourceUrl);
      title = extracted.title || title;
      text = extracted.text;
    }
    if (!text) throw new Error("Article has no content to analyze.");

    const surfaces = await collectBaseSurfaces(
      admin,
      article,
      settings,
      primary,
      isPrimaryLocale,
    );

    const analysis = await analyzeAndAdapt({
      articleTitle: title,
      articleText: text,
      productTitle: article.productTitle,
      locale: article.locale,
      intensity: settings.intensity,
      mode: normalizeAdaptationMode(article.mode),
      subtle: settings.subtle,
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

    // Ultra mode's removal permission must never leave a heading with no
    // body or an empty list on the live page: deterministic backstop on top
    // of the prompt rule. Fails the generation loudly (retryable) instead
    // of serving a visibly broken section.
    if (["ultra", "persona", "max", "v2"].includes(normalizeAdaptationMode(article.mode))) {
      for (const pair of pairs) {
        const surface = surfaces.find((s) => s.surface.key === pair.key);
        if (surface?.surface.mode !== "html") continue;
        const problem = emptySectionProblem(pair.adapted);
        if (problem) {
          throw new Error(
            `The adaptation left ${problem} in "${surface.surface.label}". Retry the generation.`,
          );
        }
      }
    }

    // The FAQ tab's accordions only function if the adapted HTML keeps the
    // theme's exact class names (the embed re-binds clicks via
    // .accordion__group / .accordion__copy). Deterministic backstop on top
    // of the prompt rule, in EVERY mode, for any surface whose original
    // markup contained accordion groups.
    for (const pair of pairs) {
      const surface = surfaces.find((s) => s.surface.key === pair.key);
      if (surface?.surface.mode !== "html") continue;
      const problem = accordionMarkupProblem(pair.original, pair.adapted);
      if (problem) {
        throw new Error(
          `The adaptation produced ${problem} in "${surface.surface.label}". Retry the generation.`,
        );
      }
    }

    const guard = await claimGuard(
      pairs,
      text,
      normalizeAdaptationMode(article.mode),
    );

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

    // Stored (dash-normalized, sanitized) adapted content per surface,
    // computed once: written to the overrides below and used to verify the
    // subtle plan's reported insertions against what actually got stored.
    const storedAdapted = new Map(
      pairs.map((pair) => {
        const surface = surfaces.find((s) => s.surface.key === pair.key)!;
        const dashFree = normalizeGeneratedPunctuation(pair.adapted);
        return [
          pair.key,
          surface.surface.mode === "html"
            ? sanitizeAdaptedHtml(dashFree, {
                allowedImageSrcs: imageSrcsOf(pair.original),
              })
            : dashFree,
        ] as const;
      }),
    );

    // The copy this generation replaces: the "before" for version history,
    // and the source of any illustration the variant already had.
    const previousRows = await prisma.override.findMany({
      where: { articleId: article.id },
    });

    // Subtle-mode insertions are shown to the reviewer as "the sentence
    // exactly as it appears in the adapted copy" — same trust posture as
    // proof-point quotes: verify each deterministically instead of trusting
    // the model's self-report, and flag any we can't find.
    const adaptedCorpus = normalizeForMatch(
      [...storedAdapted.values()]
        .map((content) => content.replace(/<[^>]*>/g, " "))
        .join(" "),
    );

    const overrideRows: SurfaceSnapshot[] = pairs.map((pair) => {
      const surface = surfaces.find((s) => s.surface.key === pair.key)!;
      const adaptedContent = storedAdapted.get(pair.key)!;
      const guardFindings = guard.get(pair.key);
      const heuristics = heuristicFindings(pair.original, adaptedContent, {
        articleText: text,
        // Proof-token downgrades are a Meta-mode-only affordance.
        metaMode: article.mode === "meta",
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
      return {
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
        unverifiedClaims: null,
        enabled: true,
        ...carriedFigureFields(previousRows, pair.key),
      };
    });

    // Version history: the copy this generation replaces becomes the
    // "before" (a baseline is created lazily for pre-history articles) and
    // the new copy is recorded as the next version in the same transaction.
    const { number: versionNumber, previousSnapshot } = await prepareVersion(
      article.id,
      previousRows,
    );

    await prisma.$transaction([
      prisma.override.deleteMany({ where: { articleId: article.id } }),
      ...overrideRows.map((row) =>
        prisma.override.create({ data: { articleId: article.id, ...row } }),
      ),
      buildVersionCreate({
        articleId: article.id,
        number: versionNumber,
        kind: "generate",
        snapshot: overrideRows,
        previousSnapshot,
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
          personaPriorities: analysis.personaPriorities.length
            ? JSON.stringify(
                analysis.personaPriorities.map((priority) => ({
                  ...priority,
                  point: normalizeGeneratedPunctuation(priority.point),
                })),
              )
            : null,
          conversionPlan: analysis.conversionPlan
            ? JSON.stringify({
                readerStage: normalizeGeneratedPunctuation(
                  analysis.conversionPlan.readerStage,
                ),
                desires: analysis.conversionPlan.desires.map((d) => ({
                  ...d,
                  point: normalizeGeneratedPunctuation(d.point),
                })),
                objections: analysis.conversionPlan.objections.map((d) => ({
                  ...d,
                  point: normalizeGeneratedPunctuation(d.point),
                })),
                criteria: analysis.conversionPlan.criteria.map((d) => ({
                  ...d,
                  point: normalizeGeneratedPunctuation(d.point),
                })),
              })
            : null,
          v2Plan: analysis.v2Plan
            ? JSON.stringify({
                readerStage: normalizeGeneratedPunctuation(
                  analysis.v2Plan.readerStage,
                ),
                compression: normalizeGeneratedPunctuation(
                  analysis.v2Plan.compression,
                ),
                expectations: normalizeV2Items(analysis.v2Plan.expectations),
                redundancy: normalizeV2Items(analysis.v2Plan.redundancy),
                cededGround: normalizeV2Items(analysis.v2Plan.cededGround),
                gaps: normalizeV2Items(analysis.v2Plan.gaps),
              })
            : null,
          subtlePlan: analysis.subtlePlan
            ? JSON.stringify({
                concern: normalizeGeneratedPunctuation(
                  analysis.subtlePlan.concern,
                ),
                termDecision: normalizeGeneratedPunctuation(
                  analysis.subtlePlan.termDecision,
                ),
                insertions: normalizeV2Items(
                  analysis.subtlePlan.insertions,
                ).map((item) => ({
                  ...item,
                  verified:
                    normalizeForMatch(item.point) !== "" &&
                    adaptedCorpus.includes(normalizeForMatch(item.point)),
                })),
              })
            : null,
          generatedMode: normalizeAdaptationMode(article.mode),
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
          pendingFigureJob: null,
        },
      }),
    ]);
    await pruneVersions(article.id);
    await runFigurePhase(
      admin,
      shop,
      article.id,
      settings,
      parseIllustrationPlan(article.illustrationPlan),
      previousRows,
      overrideRows.map((r) => ({ surfaceKey: r.surfaceKey, mode: r.mode })),
      versionNumber,
    );
  } catch (error) {
    await recordGenerationFailure(article.id, error, runKind);
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

/**
 * A regionless stored locale ("pt") serves every regional variant the
 * storefront runtime may report for it ("pt-PT", "pt-BR"): shops publish
 * language-level locales while request.locale.iso_code can carry a region.
 * Region-specific stored locales stay exact. Depends only on the URL and
 * the database, so same URL still always means same content.
 */
export function servedLocaleMatches(
  articleLocale: string,
  requestLocale: string,
): boolean {
  const stored = articleLocale.toLowerCase();
  const requested = requestLocale.toLowerCase();
  return (
    stored === requested ||
    (!stored.includes("-") && requested.startsWith(`${stored}-`))
  );
}

/**
 * Detects visibly broken structures Ultra mode's removal permission could
 * produce: a heading with no content before the next heading (or the end),
 * or an empty list. Returns a human-readable description or null. Flat
 * sibling structures only, which is what the copy surfaces use; any parse
 * trouble returns null (never blocks generation by itself).
 */
export function emptySectionProblem(html: string): string | null {
  try {
    const $ = loadHtml(`<div id="pt-root">${html}</div>`);
    const root = $("#pt-root");
    for (const list of root.find("ul, ol").toArray()) {
      if ($(list).find("li").toArray().every((li) => $(li).text().trim() === "")) {
        return "an empty list";
      }
    }
    // A "heading block" is a bare h1-h6 OR a wrapper whose entire text is a
    // single nested heading (the theme's <div class="tab__heading"><h2>…
    // pattern). Everything else counts as section body.
    const isHeadingBlock = (el: unknown): boolean => {
      const $el = $(el as never);
      const tag = ($el.prop("tagName") as string | undefined)?.toLowerCase() ?? "";
      if (/^h[1-6]$/.test(tag)) return true;
      const nested = $el.find("h1, h2, h3, h4, h5, h6").first();
      return nested.length > 0 && $el.text().trim() === nested.text().trim();
    };
    const children = root.children().toArray();
    for (let i = 0; i < children.length; i++) {
      if (!isHeadingBlock(children[i])) continue;
      let hasBody = false;
      for (let j = i + 1; j < children.length; j++) {
        if (isHeadingBlock(children[j])) break;
        // An illustration marker is content: a heading followed by the
        // figure is not a heading with nothing beneath it.
        if ($(children[j]).is(`div[${MARKER_ATTR}]`)) {
          hasBody = true;
          break;
        }
        if ($(children[j]).text().trim() !== "") {
          hasBody = true;
          break;
        }
      }
      if (!hasBody) {
        return `a heading with no content beneath it ("${$(children[i]).text().trim().slice(0, 60)}")`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The theme's FAQ accordions only work when the adapted HTML keeps the
 * exact class names the storefront scripts and styles key on
 * (.accordion__group with a <button> question row and an .accordion__copy
 * answer). Checked only when the ORIGINAL markup contained accordion
 * groups; returns a human-readable description or null. Any parse trouble
 * returns null (never blocks generation by itself).
 */
export function accordionMarkupProblem(
  originalHtml: string,
  adaptedHtml: string,
): string | null {
  try {
    const $orig = loadHtml(`<div id="pt-root">${originalHtml}</div>`);
    if ($orig("#pt-root").find(".accordion__group").length === 0) return null;
    const $ = loadHtml(`<div id="pt-root">${adaptedHtml}</div>`);
    const groups = $("#pt-root").find(".accordion__group").toArray();
    if (groups.length === 0) {
      return "question-and-answer content without the original accordion markup (no .accordion__group)";
    }
    for (const group of groups) {
      if ($(group).find("button").length === 0) {
        return "an accordion group without a <button> question row";
      }
      if ($(group).find(".accordion__copy").length === 0) {
        return "an accordion group without an answer element (.accordion__copy)";
      }
    }
    return null;
  } catch {
    return null;
  }
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

// A queue entry that has waited implausibly long (dead worker slot, crashed
// process without recovery) stops counting as "busy" so the admin UI and
// action guards never wedge on it; the queue itself still picks it up
// whenever a slot frees.
export const QUEUED_STALE_MS = 30 * 60 * 1000;

/** True while the article is freshly queued for background generation. */
export function isQueuedFresh(article: { queuedAt: Date | null }): boolean {
  return (
    article.queuedAt !== null &&
    Date.now() - article.queuedAt.getTime() < QUEUED_STALE_MS
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
    include: { overrides: { include: { figureImage: true } } },
  });
  if (!article) return null;
  if (locale && !servedLocaleMatches(article.locale, locale)) {
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
      if (surface.mode !== "html") {
        return {
          selector: surface.selector,
          mode: "text" as const,
          content: o.adapted,
        };
      }
      // Theme images the region already had may stay; nothing else may.
      const originalSrcs = imageSrcsOf(o.original);
      let html = sanitizeAdaptedHtml(o.adapted, { allowedImageSrcs: originalSrcs });
      if (o.figureImage && illustrationsAllowed(surface)) {
        // The illustration replaces its marker (or leads the section when a
        // hand edit removed the marker); the result is sanitized again with
        // the figure's own URL allowed.
        const figure = buildFigureHtml({
          src: o.figureImage.cdnUrl,
          alt: o.figureAlt ?? "",
          width: o.figureImage.width,
          height: o.figureImage.height,
          caption: o.figureCaption ?? "",
        });
        html = sanitizeAdaptedHtml(composeFigure(html, figure), {
          allowedImageSrcs: [...originalSrcs, o.figureImage.cdnUrl],
        });
      } else {
        html = removeMarker(html);
      }
      return {
        selector: surface.selector,
        mode: "html" as const,
        content: html,
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

// ---------------------------------------------------------------------------
// Pipeline pieces shared by the article and brief paths
// ---------------------------------------------------------------------------

/** Take the in-flight generation lock, or throw when a live lock is held. */
async function acquireGenerationLock(
  articleId: string,
  shop: string,
): Promise<void> {
  const lock = await prisma.article.updateMany({
    where: {
      id: articleId,
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
}

/** Prefix on Article.errorMessage when the failed run was a refinement, so
 *  the review page can title the banner accordingly. */
export const REFINEMENT_FAILED_PREFIX = "Refinement failed: ";

/**
 * Record a failed run. A failed regeneration must not take down a live
 * variant: guard on the status AT FAILURE TIME, not the row read at entry
 * (generation takes minutes and the article can be approved while it runs).
 * The two guarded writes are mutually exclusive on status, so whichever
 * matches applies. A failed refinement never changes status at all: the
 * live copy was not touched, so the variant keeps whatever state it had.
 */
async function recordGenerationFailure(
  articleId: string,
  error: unknown,
  kind: "generate" | "refine" | "figure",
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (kind === "figure") {
    // The copy was never touched: keep the status, say what failed.
    await prisma.article.updateMany({
      where: { id: articleId },
      data: {
        errorMessage: `${ILLUSTRATION_FAILED_PREFIX}${message}`,
        generatingAt: null,
        pendingFigureJob: null,
      },
    });
    return;
  }
  if (kind === "refine") {
    await prisma.article.updateMany({
      where: { id: articleId },
      data: {
        errorMessage: `${REFINEMENT_FAILED_PREFIX}${message}`,
        generatingAt: null,
        pendingRefinement: null,
        pendingFigureJob: null,
      },
    });
    return;
  }
  await prisma.article.updateMany({
    where: { id: articleId, status: { not: "approved" } },
    data: {
      status: "error",
      errorMessage: message,
      generatingAt: null,
      pendingRefinement: null,
      pendingFigureJob: null,
    },
  });
  await prisma.article.updateMany({
    where: { id: articleId, status: "approved" },
    data: {
      errorMessage: message,
      generatingAt: null,
      pendingRefinement: null,
      pendingFigureJob: null,
    },
  });
}

/**
 * Base copy for every enabled surface: admin-sourced surfaces (description,
 * metafields) from the Admin API, live-page regions from the rendered
 * storefront page.
 */
async function collectBaseSurfaces(
  admin: AdminClient,
  article: { productId: string; productHandle: string; locale: string },
  settings: ShopSettingsData,
  primary: string,
  isPrimaryLocale: boolean,
): Promise<SurfaceContent[]> {
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
  return surfaces;
}

// ---------------------------------------------------------------------------
// Brief-sourced variants
// ---------------------------------------------------------------------------

const MAX_REFERENCE_URLS = 10;
const MAX_REFERENCE_CHARS = 80_000;

/** Split the references box into URL lines and pasted text. A line that is
 *  exactly one http(s) URL is a link to read; everything else is pasted
 *  material. */
export function splitBriefReferences(raw: string | null | undefined): {
  urls: string[];
  pasted: string;
} {
  const urls: string[] = [];
  const pastedLines: string[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^https?:\/\/\S+$/i.test(trimmed)) urls.push(trimmed);
    else pastedLines.push(line);
  }
  return { urls, pasted: pastedLines.join("\n").trim() };
}

/** The brief as the model receives it: the free text followed by the
 *  non-empty advanced fields as labelled lines. */
export function composeBriefForModel(article: {
  briefText: string | null;
  briefAdvanced: string | null;
}): string {
  const advanced = normalizeBriefAdvanced(article.briefAdvanced);
  const extras = BRIEF_ADVANCED_FIELDS.filter(({ key }) => advanced[key]).map(
    ({ key, label }) => `${label}: ${advanced[key]}`,
  );
  const text = (article.briefText ?? "").trim();
  return [text, ...(extras.length > 0 ? ["", ...extras] : [])].join("\n").trim();
}

/**
 * Read the reference material: pasted text as-is, URLs through the guarded
 * article fetcher. A link that cannot be read never fails the run - it is
 * reported on the version so the reviewer knows it was skipped.
 */
async function resolveBriefReferences(
  raw: string | null,
): Promise<{ referencesText: string; runWarnings: string[] }> {
  const { urls, pasted } = splitBriefReferences(raw);
  const runWarnings: string[] = [];
  const blocks: string[] = [];
  if (pasted) blocks.push(`<reference source="pasted">\n${pasted}\n</reference>`);
  if (urls.length > MAX_REFERENCE_URLS) {
    runWarnings.push(
      `Only the first ${MAX_REFERENCE_URLS} reference links were read (${urls.length} given).`,
    );
  }
  for (const url of urls.slice(0, MAX_REFERENCE_URLS)) {
    try {
      const extracted = await fetchArticle(url);
      blocks.push(
        `<reference source="${url.replace(/"/g, "%22")}" title="${extracted.title.replace(/"/g, "'")}">\n${extracted.text}\n</reference>`,
      );
    } catch (error) {
      runWarnings.push(
        `Could not read reference ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  let referencesText = blocks.join("\n\n");
  if (referencesText.length > MAX_REFERENCE_CHARS) {
    referencesText = referencesText.slice(0, MAX_REFERENCE_CHARS);
    runWarnings.push(
      `The reference material was cut at ${MAX_REFERENCE_CHARS.toLocaleString("en-US")} characters.`,
    );
  }
  return { referencesText, runWarnings };
}

function findingsJson(list: string[] | undefined): string | null {
  return list && list.length > 0 ? JSON.stringify([...new Set(list)]) : null;
}

/**
 * Brief-sourced generation: base copy -> one adaptation pass to the brief ->
 * structural backstops -> claim guard against the brief and references ->
 * live, with the result recorded as a new version. Mirrors the article
 * pipeline's safety rails; the structural checks run unconditionally
 * because a brief may ask for removals.
 */
async function runBriefPipeline(
  admin: AdminClient,
  article: ArticleRow,
  settings: ShopSettingsData,
  primary: string,
  isPrimaryLocale: boolean,
  existing: OverrideRow[],
): Promise<void> {
  const brief = composeBriefForModel(article);
  if (!brief) {
    throw new Error("This brief is empty. Edit the brief, then start over.");
  }
  const surfaces = await collectBaseSurfaces(
    admin,
    article,
    settings,
    primary,
    isPrimaryLocale,
  );
  const { referencesText, runWarnings } = await resolveBriefReferences(
    article.briefReferences,
  );

  const result = await adaptFromBrief({
    productTitle: article.productTitle,
    locale: article.locale,
    briefName: article.briefName ?? "",
    brief,
    referencesText,
    surfaces,
  });

  const missing = surfaces.filter(
    (s) => !result.adapted.some((a) => a.key === s.surface.key),
  );
  if (missing.length > 0) {
    throw new Error(
      `Generation did not return these surfaces: ${missing
        .map((m) => m.surface.key)
        .join(", ")}. Retry the generation.`,
    );
  }
  const pairs = result.adapted
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

  for (const pair of pairs) {
    const surface = surfaces.find((s) => s.surface.key === pair.key);
    if (surface?.surface.mode !== "html") continue;
    const empty = emptySectionProblem(pair.adapted);
    if (empty) {
      throw new Error(
        `The adaptation left ${empty} in "${surface.surface.label}". Retry the generation.`,
      );
    }
    const accordion = accordionMarkupProblem(pair.original, pair.adapted);
    if (accordion) {
      throw new Error(
        `The adaptation produced ${accordion} in "${surface.surface.label}". Retry the generation.`,
      );
    }
  }

  const sourceText = [brief, referencesText].filter(Boolean).join("\n\n");
  const guard = await claimGuard(pairs, sourceText, "standard", {
    source: "brief",
  });
  const guardMissing = pairs.filter((p) => !guard.has(p.key));
  if (guardMissing.length > 0) {
    throw new Error(
      `The claim guard did not return these surfaces: ${guardMissing
        .map((p) => p.key)
        .join(", ")}. Retry the generation.`,
    );
  }

  const overrideRows: SurfaceSnapshot[] = pairs.map((pair) => {
    const surface = surfaces.find((s) => s.surface.key === pair.key)!;
    const dashFree = normalizeGeneratedPunctuation(pair.adapted);
    const adaptedContent =
      surface.surface.mode === "html"
        ? sanitizeAdaptedHtml(dashFree, {
            allowedImageSrcs: imageSrcsOf(pair.original),
          })
        : dashFree;
    const visibleText =
      surface.surface.mode === "html"
        ? adaptedContent.replace(/<[^>]*>/g, "").trim()
        : adaptedContent.trim();
    if (visibleText === "") {
      throw new Error(
        `The adaptation left "${surface.surface.label}" empty. Retry the generation.`,
      );
    }
    const guardFindings = guard.get(pair.key);
    const heuristics = heuristicFindings(pair.original, adaptedContent, {
      metaMode: false,
    });
    const notes = result.adapted.find((a) => a.key === pair.key)?.notes;
    return {
      surfaceKey: pair.key,
      label: surface.surface.label,
      selector: surface.surface.selector,
      mode: surface.surface.mode,
      original: pair.original,
      adapted: adaptedContent,
      notes: notes?.trim() ? normalizeGeneratedPunctuation(notes) : null,
      warnings: findingsJson(heuristics.warnings),
      articleClaims: findingsJson([
        ...(guardFindings?.articleClaims ?? []),
        ...heuristics.articleClaims,
      ]),
      unverifiedClaims: findingsJson(guardFindings?.warnings),
      enabled: true,
      ...carriedFigureFields(existing, pair.key),
    };
  });

  const { number, previousSnapshot } = await prepareVersion(article.id, existing);
  await prisma.$transaction([
    prisma.override.deleteMany({ where: { articleId: article.id } }),
    ...overrideRows.map((row) =>
      prisma.override.create({ data: { articleId: article.id, ...row } }),
    ),
    buildVersionCreate({
      articleId: article.id,
      number,
      kind: "generate",
      snapshot: overrideRows,
      previousSnapshot,
      modelNotes: result.summary || null,
      runWarnings,
    }),
    prisma.article.update({
      where: { id: article.id },
      data: {
        generatedMode: "standard",
        // Post-publication review model, same as articles: live at once,
        // reviewedAt reset so the merchant is notified to read the copy.
        status: "approved",
        wasApproved: true,
        reviewedAt: null,
        errorMessage: null,
        generatingAt: null,
        pendingRefinement: null,
        pendingFigureJob: null,
      },
    }),
  ]);
  await pruneVersions(article.id);
  await runFigurePhase(
    admin,
    article.shop,
    article.id,
    settings,
    parseIllustrationPlan(article.illustrationPlan),
    existing,
    overrideRows.map((r) => ({ surfaceKey: r.surfaceKey, mode: r.mode })),
    number,
  );
}

/**
 * Refinement of a brief-sourced variant: apply one instruction to the
 * CURRENT copy (hand edits included). Untouched surfaces keep their stored
 * copy and findings byte-for-byte; changed surfaces go through the same
 * sanitizing, structural and claim checks as a generation. Any failure
 * leaves the live copy exactly as it was.
 */
async function runBriefRefinement(
  article: ArticleRow,
  existing: OverrideRow[],
  instruction: string,
): Promise<void> {
  const brief = composeBriefForModel(article);
  const { referencesText, runWarnings } = await resolveBriefReferences(
    article.briefReferences,
  );

  // Earlier instructions still in force: every refinement since the last
  // full generation or restore (either of those starts a fresh chain).
  const versions = await prisma.variantVersion.findMany({
    where: { articleId: article.id },
    orderBy: { number: "asc" },
    select: { number: true, kind: true, instruction: true },
  });
  const chainStart =
    [...versions]
      .reverse()
      .find((v) => v.kind === "generate" || v.kind === "restore")?.number ?? 0;
  const previousInstructions = versions
    .filter((v) => v.number > chainStart && v.kind === "refine" && v.instruction)
    .map((v) => v.instruction as string);

  const result = await refineFromBrief({
    productTitle: article.productTitle,
    locale: article.locale,
    briefName: article.briefName ?? "",
    brief,
    referencesText,
    surfaces: existing.map((o) => ({
      key: o.surfaceKey,
      label: o.label,
      mode: o.mode,
      original: o.original,
      current: o.adapted,
    })),
    previousInstructions,
    instruction,
  });

  const byKey = new Map(result.surfaces.map((r) => [r.key, r]));
  const missing = existing.filter((o) => !byKey.has(o.surfaceKey));
  if (missing.length > 0) {
    throw new Error(
      `The refinement did not return these surfaces: ${missing
        .map((m) => m.surfaceKey)
        .join(", ")}. Retry.`,
    );
  }

  // First pass: decide what actually changed and validate it.
  const changes = new Map<
    string,
    { rawAdapted: string; adaptedContent: string; notes: string | null }
  >();
  for (const o of existing) {
    const r = byKey.get(o.surfaceKey)!;
    if (r.unchanged || r.adapted.trim() === "" || r.adapted === o.adapted) {
      continue;
    }
    const dashFree = normalizeGeneratedPunctuation(r.adapted);
    let adaptedContent =
      o.mode === "html"
        ? sanitizeAdaptedHtml(dashFree, { allowedImageSrcs: imageSrcsOf(o.original) })
        : dashFree;
    // Deterministic backstop for the prompt's marker rule: the illustration
    // marker survives every refinement, at its previous spot when the model
    // dropped it.
    if (o.mode === "html" && o.figureImageId && hasMarker(o.adapted) && !hasMarker(adaptedContent)) {
      adaptedContent = insertMarker(
        adaptedContent,
        locateMarker(o.adapted) ?? { kind: "top" },
        markerValueFor(o.surfaceKey),
      );
    }
    if (adaptedContent === o.adapted) continue;
    const visibleText =
      o.mode === "html"
        ? adaptedContent.replace(/<[^>]*>/g, "").trim()
        : adaptedContent.trim();
    if (visibleText === "") {
      throw new Error(
        `The refinement left "${o.label}" empty. Untick "Include this surface" instead, or rephrase the instruction.`,
      );
    }
    if (o.mode === "html") {
      const empty = emptySectionProblem(adaptedContent);
      if (empty) {
        throw new Error(
          `The refinement left ${empty} in "${o.label}". Rephrase the instruction and retry.`,
        );
      }
      const accordion = accordionMarkupProblem(o.original, adaptedContent);
      if (accordion) {
        throw new Error(
          `The refinement produced ${accordion} in "${o.label}". Rephrase the instruction and retry.`,
        );
      }
    }
    changes.set(o.surfaceKey, {
      rawAdapted: r.adapted,
      adaptedContent,
      notes: r.notes?.trim() ? normalizeGeneratedPunctuation(r.notes) : null,
    });
  }

  // Claim guard on the changed surfaces only; untouched ones keep their
  // stored findings.
  let guard = new Map<string, ClaimFindings>();
  if (changes.size > 0) {
    const changedPairs = existing
      .filter((o) => changes.has(o.surfaceKey))
      .map((o) => ({
        key: o.surfaceKey,
        original: o.original,
        adapted: changes.get(o.surfaceKey)!.rawAdapted,
      }));
    const sourceText = [brief, referencesText].filter(Boolean).join("\n\n");
    guard = await claimGuard(changedPairs, sourceText, "standard", {
      source: "brief",
    });
    const guardMissing = changedPairs.filter((p) => !guard.has(p.key));
    if (guardMissing.length > 0) {
      throw new Error(
        `The claim guard did not return these surfaces: ${guardMissing
          .map((p) => p.key)
          .join(", ")}. Retry.`,
      );
    }
  }

  const nextRows: SurfaceSnapshot[] = existing.map((o) => {
    const base: SurfaceSnapshot = {
      surfaceKey: o.surfaceKey,
      label: o.label,
      selector: o.selector,
      mode: o.mode,
      original: o.original,
      adapted: o.adapted,
      notes: o.notes,
      warnings: o.warnings,
      articleClaims: o.articleClaims,
      unverifiedClaims: o.unverifiedClaims,
      enabled: o.enabled,
      figureImageId: o.figureImageId,
      figureCaption: o.figureCaption,
      figureAlt: o.figureAlt,
      figureAlternatives: o.figureAlternatives,
      figureSource: o.figureSource,
    };
    const change = changes.get(o.surfaceKey);
    if (!change) return base;
    const heuristics = heuristicFindings(o.original, change.adaptedContent, {
      metaMode: false,
    });
    const g = guard.get(o.surfaceKey);
    return {
      ...base,
      adapted: change.adaptedContent,
      notes: change.notes ?? o.notes,
      warnings: findingsJson(heuristics.warnings),
      articleClaims: findingsJson([
        ...(g?.articleClaims ?? []),
        ...heuristics.articleClaims,
      ]),
      unverifiedClaims: findingsJson(g?.warnings),
    };
  });

  const { number, previousSnapshot } = await prepareVersion(article.id, existing);
  await prisma.$transaction([
    // Fresh ids on purpose: the review page's stale-copy guard keys on them.
    prisma.override.deleteMany({ where: { articleId: article.id } }),
    ...nextRows.map((row) =>
      prisma.override.create({ data: { articleId: article.id, ...row } }),
    ),
    buildVersionCreate({
      articleId: article.id,
      number,
      kind: "refine",
      instruction,
      snapshot: nextRows,
      previousSnapshot,
      modelNotes: result.summary || null,
      runWarnings,
    }),
    prisma.article.update({
      where: { id: article.id },
      data: {
        // New model-written copy is live and unread: notify for review.
        // A refinement that changed nothing leaves the review stamp alone.
        ...(changes.size > 0 ? { reviewedAt: null } : {}),
        errorMessage: null,
        generatingAt: null,
        pendingRefinement: null,
        pendingFigureJob: null,
      },
    }),
  ]);
  await pruneVersions(article.id);
}

/**
 * Copy a variant (any source kind) to a new one with its own URL: the brief,
 * the current copy, the review state and the whole version history travel
 * with it, plus a "duplicate" marker version. The original is untouched.
 */
export async function duplicateArticle(
  shop: string,
  articleId: string,
): Promise<string> {
  const source = await prisma.article.findFirst({
    where: { id: articleId, shop },
    include: { overrides: true, versions: { orderBy: { number: "asc" } } },
  });
  if (!source) throw new Error("Article not found");
  if (isQueuedFresh(source) || isGenerationInFlight(source)) {
    throw new Error(
      "A generation is queued or running for this variant. Wait for it to finish before duplicating.",
    );
  }
  const snapshot = snapshotOverrides(source.overrides);
  const label = source.briefName ?? source.sourceTitle ?? source.variantHandle;
  const lastNumber = source.versions.at(-1)?.number ?? 0;
  // A copy with no copy to serve starts "pending"; a failed source with
  // stored copy starts offline rather than carrying the failure over.
  const status =
    snapshot.length === 0
      ? "pending"
      : source.status === "error"
        ? "generated"
        : source.status;

  const created = await prisma.$transaction(async (tx) => {
    const copy = await tx.article.create({
      data: {
        shop,
        productId: source.productId,
        productHandle: source.productHandle,
        productTitle: source.productTitle,
        locale: source.locale,
        sourceKind: source.sourceKind,
        sourceUrl: source.sourceUrl,
        sourceTitle: source.sourceTitle,
        sourceText: source.sourceText,
        briefName: source.briefName ? `${source.briefName} (copy)` : null,
        briefText: source.briefText,
        briefReferences: source.briefReferences,
        briefAdvanced: source.briefAdvanced,
        detectedQuery: source.detectedQuery,
        queryVariants: source.queryVariants,
        evidence: source.evidence,
        proofPoints: source.proofPoints,
        personaPriorities: source.personaPriorities,
        conversionPlan: source.conversionPlan,
        v2Plan: source.v2Plan,
        subtlePlan: source.subtlePlan,
        illustrationPlan: source.illustrationPlan,
        mode: source.mode,
        generatedMode: source.generatedMode,
        status,
        wasApproved: status === "approved" ? true : source.wasApproved,
        reviewedAt: snapshot.length > 0 ? source.reviewedAt : null,
        variantHandle: generateVariantHandle(),
      },
    });
    if (snapshot.length > 0) {
      await tx.override.createMany({
        data: snapshot.map((s) => ({ articleId: copy.id, ...s })),
      });
    }
    if (source.versions.length > 0) {
      await tx.variantVersion.createMany({
        data: source.versions.map((v) => ({
          articleId: copy.id,
          number: v.number,
          kind: v.kind,
          instruction: v.instruction,
          surfaces: v.surfaces,
          modelNotes: v.modelNotes,
          runWarnings: v.runWarnings,
          changedSurfaces: v.changedSurfaces,
          restoredFrom: v.restoredFrom,
          createdAt: v.createdAt,
        })),
      });
    }
    await tx.variantVersion.create({
      data: {
        articleId: copy.id,
        number: lastNumber + 1,
        kind: "duplicate",
        instruction: `Duplicated from ${label}`,
        surfaces: JSON.stringify(snapshot),
        changedSurfaces: "[]",
      },
    });
    return copy;
  });
  return created.id;
}
