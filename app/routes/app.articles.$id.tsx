import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  List,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { Override as OverrideRow } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getSettings } from "../services/settings.server";
import { refreshFindings } from "../services/generate.server";
import {
  BRIEF_ADVANCED_FIELDS,
  FIGURE_CLAIM_PREFIX,
  illustrationsAllowed,
  normalizeAdaptationMode,
  normalizeBriefAdvanced,
  normalizeSuggestions,
  parseFigureAlternatives,
  parseSurfaceFigureJob,
  type ConversionPlan,
  type FigureAnchor,
  type FigureSuggestion,
  type PersonaPriority,
  type ProofPoint,
  type SubtleInsertion,
  type SubtlePlan,
  type SurfaceSnapshot,
  type V2Plan,
  type V2PlanItem,
} from "../services/types";
import {
  getPrimaryDomainUrlCached,
  getShopLocalesCached,
} from "../services/shopify-data.server";
import {
  ILLUSTRATION_FAILED_PREFIX,
  REFINEMENT_FAILED_PREFIX,
  buildVariantUrl,
  duplicateArticle,
  isGenerationInFlight,
  isQueuedFresh,
  sanitizeAdaptedHtml,
} from "../services/variant.server";
import {
  describeBlocks,
  hasMarker,
  imageSrcsOf,
  insertMarker,
  locateMarker,
  markerValueFor,
  removeMarker,
} from "../services/figure-markup";
import { illustrationFormData } from "../services/illustrations.server";
import {
  imageModelConfigured,
  typicalCostUsd,
} from "../services/openai-images.server";
import {
  IllustrationChoice,
  ImagePickerModal,
  choiceToSubmission,
  emptyChoice,
  requestRecommendations,
  thumbnailUrl,
  type ChoiceImage,
  type ChoiceTemplate,
  type ChoiceUpdater,
  type IllustrationChoiceDraft,
} from "../components/IllustrationChoice";
import {
  buildVersionCreate,
  prepareVersion,
  pruneVersions,
  restoreVersion,
} from "../services/versions.server";
import {
  enqueueGeneration,
  kickGenerationQueue,
} from "../services/generation-queue.server";

/** Freshly queued or actively generating: the copy is about to change.
 *  Stale queue entries (dead worker) stop counting so nothing wedges. */
function isGenerationBusy(article: {
  generatingAt: Date | null;
  queuedAt: Date | null;
}): boolean {
  return isQueuedFresh(article) || isGenerationInFlight(article);
}

function parseJsonStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parsePersonaPriorities(value: string | null): PersonaPriority[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is { point: unknown; importance: unknown } =>
          typeof p === "object" && p !== null,
      )
      .map((p) => {
        const importance: PersonaPriority["importance"] =
          p.importance === "high" || p.importance === "low"
            ? p.importance
            : "medium";
        return { point: String(p.point ?? ""), importance };
      })
      .filter((p) => p.point !== "");
  } catch {
    return [];
  }
}

function parseConversionPlan(value: string | null): ConversionPlan | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    const list = (raw: unknown): PersonaPriority[] =>
      Array.isArray(raw)
        ? raw
            .filter(
              (p): p is { point: unknown; importance: unknown } =>
                typeof p === "object" && p !== null,
            )
            .map((p) => {
              const importance: PersonaPriority["importance"] =
                p.importance === "high" || p.importance === "low"
                  ? p.importance
                  : "medium";
              return { point: String(p.point ?? ""), importance };
            })
            .filter((p) => p.point !== "")
        : [];
    return {
      readerStage: String(parsed.readerStage ?? ""),
      desires: list(parsed.desires),
      objections: list(parsed.objections),
      criteria: list(parsed.criteria),
    };
  } catch {
    return null;
  }
}

function parseV2Plan(value: string | null): V2Plan | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    const list = (raw: unknown): V2PlanItem[] =>
      Array.isArray(raw)
        ? raw
            .filter(
              (p): p is { point: unknown; detail: unknown } =>
                typeof p === "object" && p !== null,
            )
            .map((p) => ({
              point: String(p.point ?? ""),
              detail: String(p.detail ?? ""),
            }))
            .filter((p) => p.point !== "")
        : [];
    return {
      readerStage: String(parsed.readerStage ?? ""),
      compression: String(parsed.compression ?? ""),
      expectations: list(parsed.expectations),
      redundancy: list(parsed.redundancy),
      cededGround: list(parsed.cededGround),
      gaps: list(parsed.gaps),
    };
  } catch {
    return null;
  }
}

function parseSubtlePlan(value: string | null): SubtlePlan | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    const insertions: SubtleInsertion[] = Array.isArray(parsed.insertions)
      ? parsed.insertions
          .filter(
            (
              p,
            ): p is { point: unknown; detail: unknown; verified?: unknown } =>
              typeof p === "object" && p !== null,
          )
          .map((p) => ({
            point: String(p.point ?? ""),
            detail: String(p.detail ?? ""),
            verified: typeof p.verified === "boolean" ? p.verified : undefined,
          }))
          .filter((p) => p.point !== "")
      : [];
    return {
      concern: String(parsed.concern ?? ""),
      termDecision: String(parsed.termDecision ?? ""),
      insertions,
    };
  } catch {
    return null;
  }
}

function parseProofPoints(value: string | null): ProofPoint[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is { claim: unknown; quote: unknown; verified?: unknown } =>
          typeof p === "object" && p !== null,
      )
      .map((p) => ({
        claim: String(p.claim ?? ""),
        quote: String(p.quote ?? ""),
        verified: typeof p.verified === "boolean" ? p.verified : undefined,
      }))
      .filter((p) => p.claim !== "");
  } catch {
    return [];
  }
}

/**
 * Persist adapted_{id}/enabled_{id} fields from a form submission. HTML-mode
 * content is sanitized at write time and findings are recomputed against the
 * edited text — under the mode the stored copy was GENERATED in
 * (generatedMode), not the live toggle, which only affects the next
 * generation. Post-publication model: edits to a live variant serve
 * immediately (no demotion).
 *
 * Returns { changed, findingsChanged } on success or { error } without
 * writing anything when an enabled surface would be left empty (serving an
 * empty override would blank a section of the live page).
 */
async function applyOverrideEdits(
  article: {
    id: string;
    sourceText: string | null;
    generatedMode: string;
  },
  formData: FormData,
): Promise<{ changed: boolean; findingsChanged: boolean; error: string | null }> {
  const overrides = await prisma.override.findMany({
    where: { articleId: article.id },
  });
  const updates = [];
  // The post-edit state of every surface (edited or not), for the version
  // snapshot, plus the labels of the surfaces the merchant touched.
  const nextRows: SurfaceSnapshot[] = [];
  const editedLabels: string[] = [];
  let changed = false;
  let findingsChanged = false;
  for (const o of overrides) {
    const adaptedRaw = formData.get(`adapted_${o.id}`);
    const enabledRaw = formData.get(`enabled_${o.id}`);
    const data: {
      adapted?: string;
      enabled?: boolean;
      warnings?: string | null;
      articleClaims?: string | null;
    } = {};
    if (adaptedRaw !== null || enabledRaw !== null) {
      const willBeEnabled =
        enabledRaw !== null ? enabledRaw === "true" : o.enabled;
      if (enabledRaw !== null) {
        const enabled = enabledRaw === "true";
        if (enabled !== o.enabled) {
          changed = true;
          data.enabled = enabled;
        }
      }
      if (adaptedRaw !== null) {
        let adapted = String(adaptedRaw);
        if (o.mode === "html") {
          // Theme images the region had may stay; a pasted <img> may not.
          adapted = sanitizeAdaptedHtml(adapted, {
            allowedImageSrcs: imageSrcsOf(o.original),
          });
        }
        const visibleText =
          o.mode === "html"
            ? adapted.replace(/<[^>]*>/g, "").trim()
            : adapted.trim();
        if (willBeEnabled && visibleText === "") {
          return {
            changed: false,
            findingsChanged: false,
            error: `"${o.label}" is empty. Untick "Include this surface" instead of clearing its text.`,
          };
        }
        if (adapted !== o.adapted) {
          changed = true;
          data.adapted = adapted;
          const findings = refreshFindings(
            {
              warnings: parseJsonStringArray(o.warnings),
              articleClaims: parseJsonStringArray(o.articleClaims),
            },
            o.original,
            adapted,
            {
              articleText: article.sourceText ?? undefined,
              metaMode: article.generatedMode === "meta",
            },
          );
          data.warnings = findings.warnings.length
            ? JSON.stringify(findings.warnings)
            : null;
          data.articleClaims = findings.articleClaims.length
            ? JSON.stringify(findings.articleClaims)
            : null;
          if (
            data.warnings !== o.warnings ||
            data.articleClaims !== o.articleClaims
          ) {
            findingsChanged = true;
          }
        }
      }
    }
    nextRows.push({
      surfaceKey: o.surfaceKey,
      label: o.label,
      selector: o.selector,
      mode: o.mode,
      original: o.original,
      adapted: data.adapted ?? o.adapted,
      notes: o.notes,
      warnings: data.warnings !== undefined ? data.warnings : o.warnings,
      articleClaims:
        data.articleClaims !== undefined ? data.articleClaims : o.articleClaims,
      unverifiedClaims: o.unverifiedClaims,
      enabled: data.enabled ?? o.enabled,
      figureImageId: o.figureImageId,
      figureCaption: o.figureCaption,
      figureAlt: o.figureAlt,
      figureAlternatives: o.figureAlternatives,
      figureSource: o.figureSource,
    });
    if (data.adapted !== undefined || data.enabled !== undefined) {
      editedLabels.push(o.label);
      updates.push(prisma.override.update({ where: { id: o.id }, data }));
    }
  }
  if (updates.length > 0) {
    // Version history: a hand edit is an event like any other. The
    // snapshot is the post-edit state; the instruction names what moved.
    const { number, previousSnapshot } = await prepareVersion(
      article.id,
      overrides,
    );
    await prisma.$transaction([
      ...updates,
      buildVersionCreate({
        articleId: article.id,
        number,
        kind: "edit",
        instruction: `Edited: ${editedLabels.join(", ")}`,
        snapshot: nextRows,
        previousSnapshot,
      }),
    ]);
    await pruneVersions(article.id);
  }
  return { changed, findingsChanged, error: null };
}

/** Strip the figure's own claim-guard entries from a stored list. */
function withoutFigureClaims(unverified: string | null): string | null {
  const kept = parseJsonStringArray(unverified).filter(
    (w) => !w.startsWith(FIGURE_CLAIM_PREFIX),
  );
  return kept.length > 0 ? JSON.stringify(kept) : null;
}

/**
 * A synchronous figure edit (caption, alt, position, removal): rewrite the
 * one surface, recreate every row (fresh ids, so the stale-copy guard trips
 * for anyone else editing) and record an "edit" version.
 */
async function applyFigureEdit(
  articleId: string,
  surfaceKey: string,
  patch: (o: OverrideRow) => Partial<OverrideRow>,
  instruction: string,
): Promise<{ error: string | null }> {
  const overrides = await prisma.override.findMany({ where: { articleId } });
  const target = overrides.find((o) => o.surfaceKey === surfaceKey);
  if (!target) return { error: "That section is not part of this page." };
  const nextRows = overrides.map((o) => {
    const p = o.surfaceKey === surfaceKey ? patch(o) : {};
    return {
      surfaceKey: o.surfaceKey,
      label: o.label,
      selector: o.selector,
      mode: o.mode,
      original: o.original,
      adapted: p.adapted ?? o.adapted,
      notes: o.notes,
      warnings: o.warnings,
      articleClaims: o.articleClaims,
      unverifiedClaims:
        p.unverifiedClaims !== undefined ? p.unverifiedClaims : o.unverifiedClaims,
      enabled: o.enabled,
      figureImageId: p.figureImageId !== undefined ? p.figureImageId : o.figureImageId,
      figureCaption: p.figureCaption !== undefined ? p.figureCaption : o.figureCaption,
      figureAlt: p.figureAlt !== undefined ? p.figureAlt : o.figureAlt,
      figureAlternatives:
        p.figureAlternatives !== undefined ? p.figureAlternatives : o.figureAlternatives,
      figureSource: p.figureSource !== undefined ? p.figureSource : o.figureSource,
      figureError: o.surfaceKey === surfaceKey ? null : o.figureError,
      figureLastJob: o.figureLastJob,
    };
  });
  const { number, previousSnapshot } = await prepareVersion(articleId, overrides);
  await prisma.$transaction([
    prisma.override.deleteMany({ where: { articleId } }),
    ...nextRows.map((row) => prisma.override.create({ data: { articleId, ...row } })),
    buildVersionCreate({
      articleId,
      number,
      kind: "edit",
      instruction,
      snapshot: nextRows,
      previousSnapshot,
    }),
  ]);
  await pruneVersions(articleId);
  return { error: null };
}

/** Parse the position picker's value ("top", "bottom", "after:2", ...). */
function parseAnchorValue(value: string): FigureAnchor | null {
  if (value === "top" || value === "bottom") return { kind: value };
  const m = /^(before|after):(\d+)$/.exec(value);
  if (m) return { kind: m[1] as "before" | "after", index: Number(m[2]) };
  return null;
}

function anchorValue(anchor: FigureAnchor | null, hasAnyMarker: boolean): string {
  if (!anchor) return hasAnyMarker ? "custom" : "top";
  if (anchor.kind === "top" || anchor.kind === "bottom") return anchor.kind;
  return `${anchor.kind}:${anchor.index}`;
}

/**
 * The review page's edits and "Mark as reviewed" sign-off refer to a specific
 * set of override rows. A regeneration replaces those rows; saving or
 * marking-reviewed against replaced rows would silently sign off copy the
 * reviewer never saw.
 */
async function overridesMatchForm(
  articleId: string,
  formData: FormData,
): Promise<boolean> {
  // Set equality (order-insensitive): the client and server list overrides
  // in different orders, and regeneration always mints entirely new ids, so
  // sorting both sides is sufficient and immune to ordering differences.
  const sent = String(formData.get("overrideIds") ?? "")
    .split(",")
    .filter(Boolean)
    .sort()
    .join(",");
  const current = (
    await prisma.override.findMany({
      where: { articleId },
      select: { id: true },
    })
  )
    .map((o) => o.id)
    .sort()
    .join(",");
  return sent === current;
}

const STALE_COPY_ERROR =
  "The adapted copy changed since you loaded this page (a regeneration finished in the background). Review the new copy, then try again.";
const GENERATING_ERROR =
  "A generation is queued or running for this article. Wait for it to finish before making changes.";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Restart recovery for the background generation queue; no-op when idle.
  kickGenerationQueue();

  const [article, settings, versions] = await Promise.all([
    prisma.article.findFirst({
      where: { id: params.id, shop },
      include: {
        overrides: {
          orderBy: { surfaceKey: "asc" },
          include: {
            figureImage: {
              select: {
                id: true,
                name: true,
                cdnUrl: true,
                width: true,
                height: true,
                templateId: true,
                specificPrompt: true,
                language: true,
              },
            },
          },
        },
      },
    }),
    getSettings(shop),
    // Metadata only: snapshots are large and only Restore needs them.
    prisma.variantVersion.findMany({
      where: { articleId: params.id ?? "" },
      orderBy: { number: "desc" },
      select: {
        number: true,
        kind: true,
        instruction: true,
        modelNotes: true,
        runWarnings: true,
        changedSurfaces: true,
        restoredFrom: true,
        createdAt: true,
      },
    }),
  ]);
  if (!article) {
    throw new Response("Article not found", { status: 404 });
  }
  const refinementFailed =
    article.errorMessage?.startsWith(REFINEMENT_FAILED_PREFIX) ?? false;
  const illustrationFailed =
    article.errorMessage?.startsWith(ILLUSTRATION_FAILED_PREFIX) ?? false;

  // Illustrations: the figure of every surface that allows one, with its
  // alternatives, plus the library and templates for the figure panel.
  const surfacesByKey = new Map(settings.surfaces.map((s) => [s.key, s]));
  const alternativeIds = new Set<string>();
  for (const o of article.overrides) {
    for (const id of parseFigureAlternatives(o.figureAlternatives).images) {
      alternativeIds.add(id);
    }
  }
  const [alternativeImages, formData] = await Promise.all([
    alternativeIds.size > 0
      ? prisma.illustrationImage.findMany({
          where: { id: { in: [...alternativeIds] }, shop },
          select: { id: true, name: true, cdnUrl: true },
        })
      : Promise.resolve([]),
    illustrationFormData(shop),
  ]);
  const alternativeById = new Map(alternativeImages.map((i) => [i.id, i]));

  // The page's core job (review + approve/unapprove, both local-DB actions)
  // must survive a flaky Admin API: degrade to locale codes and hide the
  // variant URL instead of replacing the whole page with an error boundary.
  // Cached: after the first load these answer without a Shopify round trip.
  let locales: Awaited<ReturnType<typeof getShopLocalesCached>> = [];
  let primaryDomainUrl: string | null = null;
  try {
    [locales, primaryDomainUrl] = await Promise.all([
      getShopLocalesCached(admin, shop),
      getPrimaryDomainUrlCached(admin, shop),
    ]);
  } catch {
    // Fall through with defaults; the UI shows a retry hint.
  }
  const primaryLocale = locales.find((l) => l.primary)?.locale ?? "en";
  const localeName =
    locales.find((l) => l.locale === article.locale)?.name ?? article.locale;

  const variantUrl = primaryDomainUrl
    ? buildVariantUrl({
        primaryDomainUrl,
        productHandle: article.productHandle,
        locale: article.locale,
        primaryLocale,
        paramName: settings.paramName,
        variantHandle: article.variantHandle,
      })
    : null;

  return {
    article: {
      id: article.id,
      productTitle: article.productTitle,
      locale: article.locale,
      localeName,
      status: article.status,
      errorMessage: refinementFailed
        ? (article.errorMessage ?? "").slice(REFINEMENT_FAILED_PREFIX.length)
        : illustrationFailed
          ? (article.errorMessage ?? "").slice(ILLUSTRATION_FAILED_PREFIX.length)
          : article.errorMessage,
      refinementFailed,
      illustrationFailed,
      pendingFigureJob: article.pendingFigureJob !== null,
      sourceKind: article.sourceKind,
      briefName: article.briefName,
      briefText: article.briefText,
      briefReferences: article.briefReferences,
      briefAdvanced: normalizeBriefAdvanced(article.briefAdvanced),
      pendingRefinement: article.pendingRefinement,
      sourceUrl: article.sourceUrl,
      sourceTitle: article.sourceTitle,
      detectedQuery: article.detectedQuery,
      mode: article.mode,
      wasApproved: article.wasApproved,
      reviewedAt: article.reviewedAt ? article.reviewedAt.toISOString() : null,
      generationInFlight: isGenerationInFlight(article),
      queued: isQueuedFresh(article),
      updatedAt: article.updatedAt.toISOString(),
    },
    servingEnabled: settings.servingEnabled,
    queryVariants: parseJsonStringArray(article.queryVariants),
    evidence: parseJsonStringArray(article.evidence),
    proofPoints: parseProofPoints(article.proofPoints),
    personaPriorities: parsePersonaPriorities(article.personaPriorities),
    conversionPlan: parseConversionPlan(article.conversionPlan),
    v2Plan: parseV2Plan(article.v2Plan),
    subtlePlan: parseSubtlePlan(article.subtlePlan),
    overrides: article.overrides.map((o) => ({
      id: o.id,
      surfaceKey: o.surfaceKey,
      label: o.label,
      mode: o.mode,
      original: o.original,
      adapted: o.adapted,
      notes: o.notes,
      enabled: o.enabled,
      warnings: parseJsonStringArray(o.warnings),
      articleClaims: parseJsonStringArray(o.articleClaims),
      unverifiedClaims: parseJsonStringArray(o.unverifiedClaims),
      figure: (() => {
        const surface = surfacesByKey.get(o.surfaceKey);
        if (!surface || !illustrationsAllowed(surface)) return null;
        const alternatives = parseFigureAlternatives(o.figureAlternatives);
        return {
          image: o.figureImage
            ? {
                id: o.figureImage.id,
                name: o.figureImage.name,
                url: o.figureImage.cdnUrl,
                width: o.figureImage.width,
                height: o.figureImage.height,
                templateId: o.figureImage.templateId,
                specificPrompt: o.figureImage.specificPrompt,
                language: o.figureImage.language,
              }
            : null,
          caption: o.figureCaption ?? "",
          alt: o.figureAlt ?? "",
          source: o.figureSource,
          error: o.figureError,
          canRetry: parseSurfaceFigureJob(o.figureLastJob) !== null,
          anchor: locateMarker(o.adapted),
          hasMarker: hasMarker(o.adapted),
          blocks: describeBlocks(o.adapted),
          alternatives: {
            images: alternatives.images
              .map((id) => alternativeById.get(id))
              .filter((i): i is NonNullable<typeof i> => i !== undefined)
              .map((i) => ({ id: i.id, name: i.name, url: i.cdnUrl })),
            suggestions: alternatives.suggestions,
          },
        };
      })(),
    })),
    illustration: {
      templates: formData.templates,
      images: formData.images,
      openaiConfigured: imageModelConfigured(),
      costPerImage: typicalCostUsd(settings.illustrations.quality),
    },
    versions: versions.map((v) => ({
      number: v.number,
      kind: v.kind,
      instruction: v.instruction,
      modelNotes: v.modelNotes,
      runWarnings: parseJsonStringArray(v.runWarnings),
      changedSurfaces: parseJsonStringArray(v.changedSurfaces),
      restoredFrom: v.restoredFrom,
      createdAt: v.createdAt.toISOString(),
    })),
    variantUrl,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const article = await prisma.article.findFirst({
    where: { id: params.id, shop },
  });
  if (!article) {
    throw new Response("Article not found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "generate") {
    // Queued server-side: the response returns immediately and generation
    // continues in the background even if the admin leaves the page.
    const { queued } = await enqueueGeneration(shop, [article.id]);
    if (queued === 0) {
      return { ok: false, intent, error: "Already generating or queued." };
    }
    return { ok: true, intent, error: null };
  }

  if (intent === "save") {
    if (isGenerationBusy(article)) {
      return { ok: false, intent, error: GENERATING_ERROR };
    }
    if (!(await overridesMatchForm(article.id, formData))) {
      return { ok: false, intent, error: STALE_COPY_ERROR };
    }
    // Post-publication model: edits to a live variant apply to the
    // storefront immediately (within the ~2 minute proxy cache).
    const result = await applyOverrideEdits(article, formData);
    if (result.error) {
      return { ok: false, intent, error: result.error };
    }
    return {
      ok: true,
      intent,
      live: article.status === "approved",
      findingsChanged: result.findingsChanged,
    };
  }

  if (intent === "refine") {
    if (article.sourceKind !== "brief") {
      return { ok: false, intent, error: "Only brief-based pages can be refined." };
    }
    const instruction = String(formData.get("instruction") ?? "").trim();
    if (!instruction) {
      return { ok: false, intent, error: "Type what should change first." };
    }
    if (instruction.length > 4000) {
      return { ok: false, intent, error: "Keep the instruction under 4,000 characters." };
    }
    if (isGenerationBusy(article)) {
      return { ok: false, intent, error: GENERATING_ERROR };
    }
    // The instruction was written against the copy on screen.
    if (!(await overridesMatchForm(article.id, formData))) {
      return { ok: false, intent, error: STALE_COPY_ERROR };
    }
    const count = await prisma.override.count({
      where: { articleId: article.id },
    });
    if (count === 0) {
      return { ok: false, intent, error: "Generate the page first, then refine it." };
    }
    const { queued } = await enqueueGeneration(shop, [article.id], {
      refinement: instruction,
    });
    if (queued === 0) {
      return { ok: false, intent, error: "Already generating or queued." };
    }
    return { ok: true, intent, error: null };
  }

  if (intent === "saveBrief") {
    if (article.sourceKind !== "brief") {
      return { ok: false, intent, error: "Only brief-based pages have a brief." };
    }
    const name = String(formData.get("name") ?? "").trim();
    const text = String(formData.get("text") ?? "").trim();
    const references = String(formData.get("references") ?? "").trim();
    if (!name) return { ok: false, intent, error: "The brief needs a name." };
    if (!text) return { ok: false, intent, error: "The brief text cannot be empty." };
    if (name.length > 120 || text.length > 20_000 || references.length > 60_000) {
      return { ok: false, intent, error: "The brief, its name or its references are too long." };
    }
    const advancedRaw: Record<string, string> = {};
    for (const { key } of BRIEF_ADVANCED_FIELDS) {
      advancedRaw[key] = String(formData.get(`advanced_${key}`) ?? "").slice(0, 2000);
    }
    const advanced = normalizeBriefAdvanced(advancedRaw);
    await prisma.article.update({
      where: { id: article.id },
      data: {
        briefName: name,
        briefText: text,
        briefReferences: references || null,
        briefAdvanced:
          Object.keys(advanced).length > 0 ? JSON.stringify(advanced) : null,
      },
    });
    return { ok: true, intent, error: null };
  }

  if (intent === "restore") {
    if (isGenerationBusy(article)) {
      return { ok: false, intent, error: GENERATING_ERROR };
    }
    const number = Number(formData.get("version"));
    if (!Number.isInteger(number) || number < 1) {
      return { ok: false, intent, error: "Unknown version." };
    }
    let notice: string | null = null;
    try {
      notice = (await restoreVersion(shop, article.id, number)).notice;
    } catch (error) {
      return {
        ok: false,
        intent,
        error: error instanceof Error ? error.message : "Could not restore that version.",
      };
    }
    return { ok: true, intent, error: null, restored: number, notice };
  }

  // -------------------------------------------------------------------------
  // Illustrations. Synchronous edits (caption, alt, position, remove) rewrite
  // the rows here; anything that needs a model or the image API (pick from
  // the library -> caption written by Claude; draw; retry) goes through the
  // background queue as a figure job, like a refinement.
  // -------------------------------------------------------------------------
  if (
    intent === "figureSave" ||
    intent === "figureRemove" ||
    intent === "figureUseImage" ||
    intent === "figureDraw" ||
    intent === "figureRetry"
  ) {
    if (isGenerationBusy(article)) {
      return { ok: false, intent, error: GENERATING_ERROR };
    }
    if (!(await overridesMatchForm(article.id, formData))) {
      return { ok: false, intent, error: STALE_COPY_ERROR };
    }
    const surfaceKey = String(formData.get("surfaceKey") ?? "");
    const target = await prisma.override.findFirst({
      where: { articleId: article.id, surfaceKey },
    });
    if (!target) {
      return { ok: false, intent, error: "That section is not part of this page." };
    }
    const settings = await getSettings(shop);
    const surface = settings.surfaces.find((s) => s.key === surfaceKey);
    if (!surface || !illustrationsAllowed(surface)) {
      return {
        ok: false,
        intent,
        error: "Illustrations are switched off for this section in Settings.",
      };
    }

    if (intent === "figureSave") {
      if (!target.figureImageId) {
        return { ok: false, intent, error: "This section has no illustration yet." };
      }
      const caption = String(formData.get("caption") ?? "").trim().slice(0, 300);
      const alt = String(formData.get("alt") ?? "").trim().slice(0, 200);
      const anchor = parseAnchorValue(String(formData.get("anchor") ?? "keep"));
      const result = await applyFigureEdit(
        article.id,
        surfaceKey,
        (o) => ({
          figureCaption: caption || null,
          figureAlt: alt || null,
          ...(anchor
            ? { adapted: insertMarker(o.adapted, anchor, markerValueFor(surfaceKey)) }
            : {}),
        }),
        `Edited: ${target.label} illustration`,
      );
      if (result.error) return { ok: false, intent, error: result.error };
      return { ok: true, intent, error: null, live: article.status === "approved" };
    }

    if (intent === "figureRemove") {
      const result = await applyFigureEdit(
        article.id,
        surfaceKey,
        (o) => ({
          adapted: removeMarker(o.adapted),
          figureImageId: null,
          figureCaption: null,
          figureAlt: null,
          figureAlternatives: null,
          figureSource: null,
          unverifiedClaims: withoutFigureClaims(o.unverifiedClaims),
        }),
        `Removed: ${target.label} illustration`,
      );
      if (result.error) return { ok: false, intent, error: result.error };
      return { ok: true, intent, error: null, live: article.status === "approved" };
    }

    if (intent === "figureUseImage") {
      const imageId = String(formData.get("imageId") ?? "");
      const image = await prisma.illustrationImage.findFirst({
        where: { id: imageId, shop },
        select: { id: true },
      });
      if (!image) return { ok: false, intent, error: "That image no longer exists." };
      const { queued } = await enqueueGeneration(shop, [article.id], {
        figureJob: {
          surfaces: { [surfaceKey]: { mode: "library", imageId: image.id } },
          resetReview: false,
        },
      });
      if (queued === 0) return { ok: false, intent, error: "Already generating or queued." };
      return { ok: true, intent, error: null };
    }

    if (intent === "figureDraw") {
      let draws: FigureSuggestion[] = [];
      try {
        draws = normalizeSuggestions(JSON.parse(String(formData.get("draws") ?? "[]")));
      } catch {
        draws = [];
      }
      if (draws.length === 0) {
        return { ok: false, intent, error: "Write a prompt or tick an idea to draw first." };
      }
      const templates = await prisma.illustrationTemplate.findMany({
        where: { shop, id: { in: [...new Set(draws.map((d) => d.templateId))] } },
        select: { id: true },
      });
      const known = new Set(templates.map((t) => t.id));
      draws = draws.filter((d) => known.has(d.templateId));
      if (draws.length === 0) {
        return { ok: false, intent, error: "The chosen template no longer exists." };
      }
      const { queued } = await enqueueGeneration(shop, [article.id], {
        figureJob: { surfaces: { [surfaceKey]: { mode: "draw", draws } }, resetReview: true },
      });
      if (queued === 0) return { ok: false, intent, error: "Already generating or queued." };
      return { ok: true, intent, error: null };
    }

    // figureRetry
    const lastJob = parseSurfaceFigureJob(target.figureLastJob);
    if (!lastJob) {
      return { ok: false, intent, error: "There is nothing to retry for this section." };
    }
    const { queued } = await enqueueGeneration(shop, [article.id], {
      figureJob: { surfaces: { [surfaceKey]: lastJob }, resetReview: true },
    });
    if (queued === 0) return { ok: false, intent, error: "Already generating or queued." };
    return { ok: true, intent, error: null };
  }

  if (intent === "duplicate") {
    let newId: string;
    try {
      newId = await duplicateArticle(shop, article.id);
    } catch (error) {
      return {
        ok: false,
        intent,
        error: error instanceof Error ? error.message : "Could not duplicate.",
      };
    }
    return redirect(`/app/articles/${newId}`);
  }

  if (intent === "setMode") {
    if (article.sourceKind === "brief") {
      return { ok: false, intent, error: "Brief-based pages have no adaptation mode." };
    }
    // Only affects the next generation: the stored (possibly live) copy was
    // produced under the previous mode and keeps serving unchanged.
    const requested = String(formData.get("mode") ?? "standard");
    const nextMode = normalizeAdaptationMode(requested);
    await prisma.article.update({
      where: { id: article.id },
      data: { mode: nextMode },
    });
    return { ok: true, intent, mode: nextMode };
  }

  // Post-publication review model: variants go live automatically after
  // generation; the merchant reviews them afterwards. "markReviewed" records
  // the review; "publish" puts a taken-offline variant back live; "unapprove"
  // (Take offline) stops serving it.
  if (intent === "markReviewed") {
    // This is the model's only human sign-off: it must refer to exactly the
    // copy the reviewer had on screen, so it carries the same guards as save.
    if (isGenerationBusy(article)) {
      return { ok: false, intent, error: GENERATING_ERROR };
    }
    if (!(await overridesMatchForm(article.id, formData))) {
      return { ok: false, intent, error: STALE_COPY_ERROR };
    }
    const updated = await prisma.article.updateMany({
      where: { id: article.id, status: "approved" },
      data: { reviewedAt: new Date() },
    });
    if (updated.count === 0) {
      return { ok: false, intent, error: "Only live variants can be marked reviewed." };
    }
    return { ok: true, intent, error: null };
  }

  if (intent === "publish") {
    if (isGenerationBusy(article)) {
      return { ok: false, intent, error: GENERATING_ERROR };
    }
    const enabledCount = await prisma.override.count({
      where: { articleId: article.id, enabled: true },
    });
    if (enabledCount === 0) {
      return {
        ok: false,
        intent,
        error: "Enable at least one surface before putting this variant live.",
      };
    }
    // Publishing is itself a review: the merchant is looking at the copy.
    const published = await prisma.article.updateMany({
      where: { id: article.id, status: "generated" },
      data: { status: "approved", wasApproved: true, reviewedAt: new Date() },
    });
    if (published.count === 0) {
      return { ok: false, intent, error: "Only offline variants can be put live." };
    }
    return { ok: true, intent, error: null };
  }

  if (intent === "unapprove") {
    // A take-offline during a RUNNING regeneration would be silently
    // reverted by its success write - block that. A merely QUEUED
    // regeneration is different: taking offline cancels it (dequeue), which
    // is exactly what a merchant who just spotted a bad claim wants.
    if (isGenerationInFlight(article)) {
      return { ok: false, intent, error: GENERATING_ERROR };
    }
    if (article.queuedAt !== null) {
      await prisma.article.updateMany({
        where: { id: article.id, queuedAt: { not: null } },
        data: { queuedAt: null },
      });
    }
    const updated = await prisma.article.updateMany({
      where: { id: article.id, status: "approved" },
      data: { status: "generated" },
    });
    if (updated.count === 0) {
      return { ok: false, intent, error: "Only live variants can be taken offline." };
    }
    return { ok: true, intent, error: null };
  }

  if (intent === "delete") {
    await prisma.article.delete({ where: { id: article.id } });
    return redirect("/app");
  }

  return { ok: false, intent, error: "Unknown action." };
};

function statusBadge(status: string, reviewedAt: string | null) {
  switch (status) {
    case "pending":
      return <Badge>Not generated</Badge>;
    case "generated":
      return <Badge tone="warning">Offline</Badge>;
    case "approved":
      return reviewedAt ? (
        <Badge tone="success">Live</Badge>
      ) : (
        <Badge tone="attention">Live — review needed</Badge>
      );
    case "error":
      return <Badge tone="critical">Failed</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

function versionKindBadge(kind: string) {
  switch (kind) {
    case "refine":
      return <Badge tone="magic">Refined</Badge>;
    case "edit":
      return <Badge tone="info">Edited</Badge>;
    case "restore":
      return <Badge tone="attention">Restored</Badge>;
    case "duplicate":
      return <Badge>Duplicated</Badge>;
    case "figure":
      return <Badge tone="magic">Illustrated</Badge>;
    default:
      return <Badge tone="success">Generated</Badge>;
  }
}

type FigureDraft = { caption: string; alt: string; anchor: string };

const URL_LINE = /^https?:\/\/\S+$/i;

export default function ArticleReview() {
  const {
    article,
    servingEnabled,
    queryVariants,
    evidence,
    proofPoints,
    personaPriorities,
    conversionPlan,
    v2Plan,
    subtlePlan,
    overrides,
    illustration,
    versions,
    variantUrl,
  } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const generateFetcher = useFetcher<typeof action>();
  const saveFetcher = useFetcher<typeof action>();
  const figureFetcher = useFetcher<typeof action>();
  const reviewFetcher = useFetcher<typeof action>();
  const modeFetcher = useFetcher<typeof action>();
  const refineFetcher = useFetcher<typeof action>();
  const briefFetcher = useFetcher<typeof action>();
  const restoreFetcher = useFetcher<typeof action>();
  const duplicateFetcher = useFetcher<typeof action>();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [refineText, setRefineText] = useState("");
  const [briefEditing, setBriefEditing] = useState(false);

  const isBrief = article.sourceKind === "brief";

  const makeBriefDraft = useCallback(
    () => ({
      name: article.briefName ?? "",
      text: article.briefText ?? "",
      references: article.briefReferences ?? "",
      audience: article.briefAdvanced.audience ?? "",
      keyMessage: article.briefAdvanced.keyMessage ?? "",
      tone: article.briefAdvanced.tone ?? "",
      mustSay: article.briefAdvanced.mustSay ?? "",
      mustAvoid: article.briefAdvanced.mustAvoid ?? "",
    }),
    [article],
  );
  const [briefDraft, setBriefDraft] = useState(makeBriefDraft);

  // Busy either from this tab (enqueue request in flight) or from the
  // server-side queue/lock reported by the loader.
  const isGenerating =
    generateFetcher.state !== "idle" ||
    refineFetcher.state !== "idle" ||
    article.generationInFlight ||
    article.queued;
  const isFigureActing = figureFetcher.state !== "idle";
  const isRestoring = restoreFetcher.state !== "idle";
  const isReviewActing = reviewFetcher.state !== "idle";
  const overrideIds = overrides.map((o) => o.id).join(",");
  const revalidator = useRevalidator();

  // Poll while the background queue works on this article so the page picks
  // up the new copy (and the review notice) without a manual refresh.
  useEffect(() => {
    if (!article.generationInFlight && !article.queued) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 7000);
    return () => clearInterval(timer);
  }, [article.generationInFlight, article.queued, revalidator]);
  const isSaving = saveFetcher.state !== "idle";
  const reviewError =
    reviewFetcher.state === "idle" &&
    reviewFetcher.data &&
    !reviewFetcher.data.ok &&
    "error" in reviewFetcher.data
      ? reviewFetcher.data.error
      : null;

  const makeDrafts = useCallback(
    () =>
      Object.fromEntries(
        overrides.map((o) => [o.id, { adapted: o.adapted, enabled: o.enabled }]),
      ) as Record<string, { adapted: string; enabled: boolean }>,
    [overrides],
  );

  const [drafts, setDrafts] = useState(makeDrafts);

  // Reset local edits only when the generated copy itself changed. Override
  // rows are deleted and recreated on regeneration, so their ids are a stable
  // key for "same generation": metadata-only updates (meta-mode toggle,
  // status changes — which all bump updatedAt) must not wipe in-progress
  // edits.
  const overridesKey = overrides.map((o) => o.id).join(",");
  useEffect(() => {
    setDrafts(makeDrafts());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.id, overridesKey]);

  // Figure panel drafts (caption, alt, position), keyed like the copy drafts.
  const makeFigureDrafts = useCallback(
    () =>
      Object.fromEntries(
        overrides
          .filter((o) => o.figure)
          .map((o) => [
            o.id,
            {
              caption: o.figure!.caption,
              alt: o.figure!.alt,
              anchor: anchorValue(o.figure!.anchor, o.figure!.hasMarker),
            },
          ]),
      ) as Record<string, FigureDraft>,
    [overrides],
  );
  const [figureDrafts, setFigureDrafts] = useState(makeFigureDrafts);
  useEffect(() => {
    setFigureDrafts(makeFigureDrafts());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.id, overridesKey]);
  const updateFigureDraft = useCallback(
    (id: string, patch: Partial<FigureDraft>) => {
      setFigureDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    },
    [],
  );

  useEffect(() => {
    if (figureFetcher.state !== "idle" || !figureFetcher.data) return;
    const data = figureFetcher.data;
    if (!("intent" in data) || !String(data.intent).startsWith("figure")) return;
    if (!data.ok && "error" in data && data.error) {
      shopify.toast.show(String(data.error), { isError: true });
      return;
    }
    const live = "live" in data ? Boolean(data.live) : false;
    if (data.intent === "figureSave") {
      shopify.toast.show(live ? "Illustration saved — live within ~2 minutes" : "Illustration saved");
    } else if (data.intent === "figureRemove") {
      shopify.toast.show(live ? "Illustration removed — live within ~2 minutes" : "Illustration removed");
    } else if (data.intent === "figureUseImage") {
      shopify.toast.show("Placing the illustration in the background — this page updates when it is done.");
    } else {
      shopify.toast.show("Drawing in the background — this page updates when it is done.");
    }
  }, [figureFetcher.state, figureFetcher.data, shopify]);

  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data?.intent === "save") {
      if (!saveFetcher.data.ok && "error" in saveFetcher.data) {
        shopify.toast.show(String(saveFetcher.data.error), { isError: true });
        return;
      }
      const live =
        "live" in saveFetcher.data ? saveFetcher.data.live : false;
      const findingsChanged =
        "findingsChanged" in saveFetcher.data
          ? saveFetcher.data.findingsChanged
          : false;
      shopify.toast.show(
        live
          ? findingsChanged
            ? "Edits saved and live — they changed the flagged claims, review them below"
            : "Edits saved — live on the storefront within ~2 minutes"
          : "Edits saved",
      );
    }
  }, [saveFetcher.state, saveFetcher.data, shopify]);

  useEffect(() => {
    if (
      generateFetcher.state === "idle" &&
      generateFetcher.data?.intent === "generate" &&
      !generateFetcher.data.ok &&
      "error" in generateFetcher.data &&
      generateFetcher.data.error
    ) {
      shopify.toast.show(String(generateFetcher.data.error), { isError: true });
    }
  }, [generateFetcher.state, generateFetcher.data, shopify]);

  useEffect(() => {
    if (
      modeFetcher.state === "idle" &&
      modeFetcher.data?.intent === "setMode" &&
      "mode" in modeFetcher.data
    ) {
      const label =
        modeFetcher.data.mode === "meta"
          ? "Meta mode"
          : modeFetcher.data.mode === "ultra"
            ? "Ultra custom"
            : modeFetcher.data.mode === "persona"
              ? "Ultra deep persona"
              : modeFetcher.data.mode === "max"
                ? "Ultra Custom Conversion Max"
                : modeFetcher.data.mode === "v2"
                  ? "Ultra Custom V2"
                  : modeFetcher.data.mode === "subtle"
                    ? "Subtle intent"
                    : "Standard";
      shopify.toast.show(
        `Mode set to ${label} — takes effect when you regenerate`,
      );
    }
  }, [modeFetcher.state, modeFetcher.data, shopify]);

  useEffect(() => {
    if (refineFetcher.state === "idle" && refineFetcher.data?.intent === "refine") {
      if (!refineFetcher.data.ok && "error" in refineFetcher.data) {
        shopify.toast.show(String(refineFetcher.data.error), { isError: true });
      } else {
        setRefineText("");
        shopify.toast.show(
          "Refinement started in the background — this page updates when it is done.",
        );
      }
    }
  }, [refineFetcher.state, refineFetcher.data, shopify]);

  useEffect(() => {
    if (briefFetcher.state === "idle" && briefFetcher.data?.intent === "saveBrief") {
      if (!briefFetcher.data.ok && "error" in briefFetcher.data) {
        shopify.toast.show(String(briefFetcher.data.error), { isError: true });
      } else {
        setBriefEditing(false);
        shopify.toast.show(
          "Brief saved — it applies to the next refinement or start over.",
        );
      }
    }
  }, [briefFetcher.state, briefFetcher.data, shopify]);

  useEffect(() => {
    if (restoreFetcher.state === "idle" && restoreFetcher.data?.intent === "restore") {
      if (!restoreFetcher.data.ok && "error" in restoreFetcher.data) {
        shopify.toast.show(String(restoreFetcher.data.error), { isError: true });
      } else {
        const restored =
          "restored" in restoreFetcher.data ? restoreFetcher.data.restored : null;
        const notice =
          "notice" in restoreFetcher.data ? restoreFetcher.data.notice : null;
        shopify.toast.show(
          restored
            ? `Version #${restored} restored — live on the storefront within ~2 minutes`
            : "Version restored",
        );
        if (notice) shopify.toast.show(String(notice), { isError: true });
      }
    }
  }, [restoreFetcher.state, restoreFetcher.data, shopify]);

  useEffect(() => {
    if (
      duplicateFetcher.state === "idle" &&
      duplicateFetcher.data?.intent === "duplicate" &&
      !duplicateFetcher.data.ok &&
      "error" in duplicateFetcher.data
    ) {
      shopify.toast.show(String(duplicateFetcher.data.error), { isError: true });
    }
  }, [duplicateFetcher.state, duplicateFetcher.data, shopify]);

  const updateDraft = useCallback(
    (id: string, patch: Partial<{ adapted: string; enabled: boolean }>) => {
      setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    },
    [],
  );

  const handleRefine = useCallback(() => {
    const instruction = refineText.trim();
    if (!instruction) return;
    // overrideIds: the instruction was written against the copy on screen;
    // the server rejects it if a background run has since replaced the rows.
    refineFetcher.submit(
      { intent: "refine", instruction, overrideIds },
      { method: "POST" },
    );
  }, [refineText, overrideIds, refineFetcher]);

  const handleDuplicate = useCallback(() => {
    duplicateFetcher.submit({ intent: "duplicate" }, { method: "POST" });
  }, [duplicateFetcher]);

  const openBriefEditor = useCallback(() => {
    setBriefDraft(makeBriefDraft());
    setBriefEditing(true);
  }, [makeBriefDraft]);

  const handleSaveBrief = useCallback(() => {
    briefFetcher.submit(
      {
        intent: "saveBrief",
        name: briefDraft.name,
        text: briefDraft.text,
        references: briefDraft.references,
        advanced_audience: briefDraft.audience,
        advanced_keyMessage: briefDraft.keyMessage,
        advanced_tone: briefDraft.tone,
        advanced_mustSay: briefDraft.mustSay,
        advanced_mustAvoid: briefDraft.mustAvoid,
      },
      { method: "POST" },
    );
  }, [briefDraft, briefFetcher]);

  const handleGenerate = useCallback(() => {
    generateFetcher.submit({ intent: "generate" }, { method: "POST" });
  }, [generateFetcher]);

  const submitFigure = useCallback(
    (fields: Record<string, string>) => {
      figureFetcher.submit({ ...fields, overrideIds }, { method: "POST" });
    },
    [figureFetcher, overrideIds],
  );

  const recommendForSurface = useCallback(
    (surfaceKey: string) =>
      requestRecommendations({ surfaceKey, articleId: article.id }),
    [article.id],
  );

  const handleSave = useCallback(() => {
    // overrideIds lets the server reject a save against override rows that a
    // background regeneration has since replaced.
    const payload: Record<string, string> = { intent: "save", overrideIds };
    for (const o of overrides) {
      const draft = drafts[o.id] ?? { adapted: o.adapted, enabled: o.enabled };
      payload[`adapted_${o.id}`] = draft.adapted;
      payload[`enabled_${o.id}`] = String(draft.enabled);
    }
    saveFetcher.submit(payload, { method: "POST" });
  }, [overrides, overrideIds, drafts, saveFetcher]);

  const copyUrl = useCallback(async () => {
    if (!variantUrl) return;
    try {
      await navigator.clipboard.writeText(variantUrl);
      shopify.toast.show("Variant URL copied");
    } catch {
      shopify.toast.show("Could not copy the URL", { isError: true });
    }
  }, [variantUrl, shopify]);

  // Flagged findings drive the urgency of the review notification.
  const hasBlockingWarnings = overrides.some((o) => o.warnings.length > 0);
  const hasFlagged = overrides.some(
    (o) =>
      o.warnings.length > 0 ||
      o.articleClaims.length > 0 ||
      o.unverifiedClaims.length > 0,
  );
  // A refinement works on the SAVED copy and replaces the rows when it
  // lands, which would wipe unsaved typing: ask for a save first.
  const hasUnsavedEdits = overrides.some((o) => {
    const d = drafts[o.id];
    return d !== undefined && (d.adapted !== o.adapted || d.enabled !== o.enabled);
  });
  const latestRunWarnings = versions[0]?.runWarnings ?? [];

  const isLive = article.status === "approved";
  const needsReview = isLive && !article.reviewedAt;

  return (
    <Page
      backAction={{ url: "/app" }}
      title={
        isBrief
          ? `${article.briefName ?? "Brief"} · ${article.productTitle} · ${article.locale}`
          : `${article.productTitle} · ${article.locale}`
      }
      titleMetadata={
        <InlineStack gap="100">
          {statusBadge(article.status, article.reviewedAt)}
          {isBrief && <Badge tone="info">Brief</Badge>}
          {article.mode === "subtle" && (
            <Badge tone="magic">Subtle intent</Badge>
          )}
          {article.mode === "meta" && <Badge tone="magic">Meta mode</Badge>}
          {article.mode === "ultra" && <Badge tone="magic">Ultra custom</Badge>}
          {article.mode === "persona" && (
            <Badge tone="magic">Deep persona</Badge>
          )}
          {article.mode === "max" && (
            <Badge tone="magic">Conversion Max</Badge>
          )}
          {article.mode === "v2" && <Badge tone="magic">Ultra V2</Badge>}
        </InlineStack>
      }
      secondaryActions={[
        {
          content: isBrief ? "Start over" : "Regenerate",
          disabled: isGenerating,
          onAction: handleGenerate,
        },
        {
          content: "Duplicate",
          disabled: isGenerating || duplicateFetcher.state !== "idle",
          onAction: handleDuplicate,
        },
        {
          content: "View on storefront",
          disabled: !variantUrl,
          onAction: () => {
            if (variantUrl) window.open(variantUrl, "_blank", "noopener");
          },
        },
        {
          content: "Delete",
          destructive: true,
          onAction: () => setDeleteModalOpen(true),
        },
      ]}
      actionGroups={isBrief ? undefined : [
        {
          title: `Mode: ${article.mode === "meta" ? "Meta" : article.mode === "ultra" ? "Ultra" : article.mode === "persona" ? "Persona" : article.mode === "max" ? "Max" : article.mode === "v2" ? "V2" : article.mode === "subtle" ? "Subtle" : "Standard"}`,
          actions: (
            [
              "standard",
              "subtle",
              "meta",
              "ultra",
              "persona",
              "max",
              "v2",
            ] as const
          ).map((m) => ({
            content:
              m === "standard"
                ? "Standard"
                : m === "subtle"
                  ? "Subtle intent"
                  : m === "meta"
                    ? "Meta mode"
                    : m === "ultra"
                      ? "Ultra custom"
                      : m === "persona"
                        ? "Ultra deep persona"
                        : m === "max"
                          ? "Ultra Custom Conversion Max"
                          : "Ultra Custom V2",
            disabled:
              article.mode === m ||
              isGenerating ||
              modeFetcher.state !== "idle",
            onAction: () =>
              modeFetcher.submit(
                { intent: "setMode", mode: m },
                { method: "POST" },
              ),
          })),
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {isGenerating &&
              (article.queued && !article.generationInFlight ? (
                <Banner
                  tone="info"
                  title={
                    article.pendingRefinement
                      ? "Queued for refinement"
                      : article.pendingFigureJob
                        ? "Queued for illustration"
                        : "Queued for generation"
                  }
                >
                  {article.pendingRefinement
                    ? `"${article.pendingRefinement}" starts momentarily.`
                    : "Starting momentarily."}{" "}
                  Runs in the background on the server - you can leave this
                  page; it updates automatically.
                </Banner>
              ) : article.pendingFigureJob ? (
                <Banner tone="info" title="Illustrating — this takes a minute or two.">
                  The image is drawn (or picked), placed in its section, and
                  its caption written in the page&apos;s language, in the
                  background on the server. The copy is live as it is; the
                  figure appears when this finishes. You can leave this page;
                  it updates automatically.
                </Banner>
              ) : article.pendingRefinement ? (
                <Banner tone="info" title="Refining — this takes a minute or two.">
                  Applying &ldquo;{article.pendingRefinement}&rdquo; to the
                  current copy, then checking the changed sections. The live
                  copy stays as it is until the refinement succeeds. You can
                  leave this page; it updates automatically.
                </Banner>
              ) : isBrief ? (
                <Banner
                  tone="info"
                  title="Writing the page from the brief — this takes a minute or two."
                >
                  The brief is applied to the page&apos;s copy and the result
                  is checked for unsupported claims, in two model passes
                  running in the background on the server. You can leave this
                  page; it updates automatically when it&apos;s done.
                </Banner>
              ) : (
                <Banner tone="info" title="Generating — this takes a minute or two.">
                  The article is analyzed and the copy adapted in two model
                  passes, running in the background on the server. You can
                  leave this page; this article updates automatically when
                  it's done.
                </Banner>
              ))}
            {article.status === "error" && !isGenerating && (
              <Banner tone="critical" title="Generation failed">
                <BlockStack gap="200">
                  <Text as="p">{article.errorMessage ?? "Unknown error."}</Text>
                  <InlineStack>
                    <Button onClick={handleGenerate}>Retry generate</Button>
                  </InlineStack>
                </BlockStack>
              </Banner>
            )}
            {article.refinementFailed &&
              article.errorMessage &&
              !isGenerating && (
                <Banner tone="warning" title="Last refinement failed">
                  {article.errorMessage} — the copy was left exactly as it
                  was. Rephrase the instruction and try again.
                </Banner>
              )}
            {article.illustrationFailed &&
              article.errorMessage &&
              !isGenerating && (
                <Banner tone="warning" title="Last illustration job failed">
                  {article.errorMessage} — the copy was not touched. Try again
                  from the section&apos;s illustration panel below.
                </Banner>
              )}
            {article.status === "approved" &&
              article.errorMessage &&
              !article.refinementFailed &&
              !article.illustrationFailed &&
              !isGenerating && (
                <Banner
                  tone="warning"
                  title={
                    isBrief ? "Last start over failed" : "Last regeneration failed"
                  }
                >
                  {article.errorMessage} — the variant is still live and
                  serving the previously approved copy.
                </Banner>
              )}
            {latestRunWarnings.length > 0 && !isGenerating && (
              <Banner
                tone="warning"
                title="Some reference material could not be read"
              >
                <List type="bullet">
                  {latestRunWarnings.map((warning, index) => (
                    <List.Item key={index}>{warning}</List.Item>
                  ))}
                </List>
              </Banner>
            )}
            {reviewError && (
              <Banner tone="critical" title="Action failed">
                {String(reviewError)}
              </Banner>
            )}
            {article.status === "generated" && (
              <Banner tone="warning" title="Offline — not serving">
                <BlockStack gap="200">
                  <Text as="p">
                    This variant's URL currently shows the normal product page.
                    Put it back live, or regenerate to create fresh copy
                    (which also goes live automatically).
                  </Text>
                  <InlineStack>
                    <Button
                      variant="primary"
                      loading={isReviewActing}
                      disabled={isGenerating}
                      onClick={() =>
                        reviewFetcher.submit(
                          { intent: "publish" },
                          { method: "POST" },
                        )
                      }
                    >
                      Put live
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Banner>
            )}
            {needsReview && (
              <Banner
                tone={hasBlockingWarnings ? "warning" : "info"}
                title={
                  hasBlockingWarnings
                    ? "Live with flagged claims — review this variant now"
                    : "Live — awaiting your review"
                }
              >
                <BlockStack gap="200">
                  <Text as="p">
                    {hasBlockingWarnings
                      ? "This variant went live automatically after generation and some of its claims were flagged by the guard. Check the flagged items below; take the variant offline if anything is wrong."
                      : hasFlagged
                        ? isBrief
                          ? "This page went live automatically. It makes claims listed below that go beyond the original copy - check that each one holds up before marking it reviewed."
                          : "This variant went live automatically after generation. It includes article-sourced claims listed below - verify the article really supports them."
                        : "This variant went live automatically after generation. Skim the copy below and mark it reviewed."}
                  </Text>
                  <InlineStack gap="200">
                    <Button
                      variant="primary"
                      loading={isReviewActing}
                      disabled={isGenerating}
                      onClick={() =>
                        reviewFetcher.submit(
                          { intent: "markReviewed", overrideIds },
                          { method: "POST" },
                        )
                      }
                    >
                      Mark as reviewed
                    </Button>
                    <Button
                      loading={isReviewActing}
                      disabled={isGenerating}
                      onClick={() =>
                        reviewFetcher.submit(
                          { intent: "unapprove" },
                          { method: "POST" },
                        )
                      }
                    >
                      Take offline
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Banner>
            )}
            {isLive && (
              <Banner
                tone={servingEnabled ? "success" : "warning"}
                title={
                  servingEnabled
                    ? "This variant URL is live"
                    : "Live — but serving is OFF, so this URL currently shows the normal page"
                }
                action={
                  servingEnabled
                    ? undefined
                    : { content: "Turn on serving in Settings", url: "/app/settings" }
                }
              >
                <BlockStack gap="200">
                  {variantUrl ? (
                    <Box
                      padding="200"
                      background="bg-surface-secondary"
                      borderRadius="200"
                      overflowX="scroll"
                    >
                      <pre style={{ margin: 0 }}>
                        <code>{variantUrl}</code>
                      </pre>
                    </Box>
                  ) : (
                    <Text as="p" tone="subdued">
                      The variant URL is temporarily unavailable (Shopify API
                      hiccup) — reload the page to see it.
                    </Text>
                  )}
                  <InlineStack gap="200" blockAlign="center">
                    {variantUrl && <Button onClick={copyUrl}>Copy URL</Button>}
                    <Button
                      loading={isReviewActing}
                      disabled={isGenerating}
                      onClick={() =>
                        reviewFetcher.submit(
                          { intent: "unapprove" },
                          { method: "POST" },
                        )
                      }
                    >
                      Take offline
                    </Button>
                    {article.reviewedAt && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        Reviewed {new Date(article.reviewedAt).toLocaleString()}
                      </Text>
                    )}
                  </InlineStack>
                </BlockStack>
              </Banner>
            )}

            {isBrief ? (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Brief
                    </Text>
                    {!briefEditing && (
                      <Button
                        size="slim"
                        onClick={openBriefEditor}
                        disabled={isGenerating}
                      >
                        Edit brief
                      </Button>
                    )}
                  </InlineStack>
                  {briefEditing ? (
                    <BlockStack gap="300">
                      <TextField
                        label="Name"
                        value={briefDraft.name}
                        onChange={(value) =>
                          setBriefDraft((d) => ({ ...d, name: value }))
                        }
                        autoComplete="off"
                        maxLength={120}
                      />
                      <TextField
                        label="Brief"
                        value={briefDraft.text}
                        onChange={(value) =>
                          setBriefDraft((d) => ({ ...d, text: value }))
                        }
                        multiline={8}
                        autoComplete="off"
                      />
                      <TextField
                        label="References (optional)"
                        value={briefDraft.references}
                        onChange={(value) =>
                          setBriefDraft((d) => ({ ...d, references: value }))
                        }
                        multiline={5}
                        autoComplete="off"
                        helpText="Pasted text and/or one link per line; links are read again on every refinement or start over."
                      />
                      {BRIEF_ADVANCED_FIELDS.map(({ key, label }) => (
                        <TextField
                          key={key}
                          label={label}
                          value={briefDraft[key]}
                          onChange={(value) =>
                            setBriefDraft((d) => ({ ...d, [key]: value }))
                          }
                          multiline={key === "mustSay" || key === "mustAvoid" ? 2 : undefined}
                          autoComplete="off"
                          maxLength={2000}
                        />
                      ))}
                      <Text as="p" variant="bodySm" tone="subdued">
                        Saving the brief changes nothing on the page by itself:
                        it applies to the next refinement, or when you start
                        over.
                      </Text>
                      <InlineStack gap="200" align="end">
                        <Button onClick={() => setBriefEditing(false)}>
                          Cancel
                        </Button>
                        <Button
                          variant="primary"
                          loading={briefFetcher.state !== "idle"}
                          onClick={handleSaveBrief}
                        >
                          Save brief
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  ) : (
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        {article.briefName}
                      </Text>
                      <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {article.briefText}
                      </div>
                      {article.briefReferences && (
                        <BlockStack gap="100">
                          <Text as="h3" variant="headingSm" tone="subdued">
                            References
                          </Text>
                          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                            {article.briefReferences.split(/\r?\n/).map((line, index) =>
                              URL_LINE.test(line.trim()) ? (
                                <div key={index}>
                                  <Link url={line.trim()} target="_blank">
                                    {line.trim()}
                                  </Link>
                                </div>
                              ) : (
                                <div key={index}>{line || " "}</div>
                              ),
                            )}
                          </div>
                        </BlockStack>
                      )}
                      {BRIEF_ADVANCED_FIELDS.some(
                        ({ key }) => article.briefAdvanced[key],
                      ) && (
                        <BlockStack gap="100">
                          {BRIEF_ADVANCED_FIELDS.filter(
                            ({ key }) => article.briefAdvanced[key],
                          ).map(({ key, label }) => (
                            <Text as="p" variant="bodySm" key={key}>
                              <Text as="span" fontWeight="semibold">
                                {label}:{" "}
                              </Text>
                              {article.briefAdvanced[key]}
                            </Text>
                          ))}
                        </BlockStack>
                      )}
                      <Text as="p" tone="subdued" variant="bodySm">
                        Language: {article.localeName} ({article.locale})
                      </Text>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            ) : (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Source
                  </Text>
                  {article.sourceUrl ? (
                    <Link url={article.sourceUrl} target="_blank">
                      {article.sourceTitle ?? article.sourceUrl}
                    </Link>
                  ) : (
                    <Text as="p" variant="bodyMd">
                      {article.sourceTitle
                        ? `${article.sourceTitle} (pasted content)`
                        : "(pasted content)"}
                    </Text>
                  )}
                  <Text as="p" tone="subdued" variant="bodySm">
                    Language: {article.localeName} ({article.locale})
                  </Text>
                </BlockStack>
              </Card>
            )}

            {article.mode === "subtle" && article.status === "pending" && (
              <Banner tone="info" title="Subtle intent article">
                Generation will stay as conservative as a light Standard pass
                but plant a few precise sentences that position the product
                for this article's reader - naming their concern only when a
                brand would naturally print it unprompted, otherwise speaking
                to the underlying need in the brand's own words. Tune the
                dials in Settings. No study results or rankings are pulled.
                The planted sentences appear here for review once it goes
                live.
              </Banner>
            )}
            {article.mode === "meta" && article.status === "pending" && (
              <Banner tone="info" title="Meta mode article">
                Generation will rewrite the page deeply and pull the article's
                specific proof elements (study wins, rankings, statistics) into
                the copy. The variant goes live automatically - review the
                proof elements promptly once it does.
              </Banner>
            )}
            {article.mode === "ultra" && article.status === "pending" && (
              <Banner tone="info" title="Ultra custom article">
                Generation will recenter every surface on the article
                audience's intent and vocabulary, and may remove claims that
                are irrelevant to that audience - without pulling any study
                results or rankings. The variant goes live automatically;
                review it promptly once it does.
              </Banner>
            )}
            {article.mode === "max" && article.status === "pending" && (
              <Banner tone="info" title="Conversion Max article">
                Generation will diagnose the arriving reader, build three
                ranked lists (what they want to hear, their doubts, and the
                criteria the article taught them to judge by), then sequence
                the whole page around them - including the FAQ tab - without
                pulling any study results or rankings. The full plan appears
                here for review once it goes live.
              </Banner>
            )}
            {article.mode === "persona" && article.status === "pending" && (
              <Banner tone="info" title="Ultra deep persona article">
                Generation will identify the product type this article's
                readers are shopping for, build a ranked list of everything
                they want to hear, and place the top items in the tagline,
                description, and overview - the full list appears here for
                review. No study results or rankings are pulled. The variant
                goes live automatically; review it promptly.
              </Banner>
            )}
            {article.mode === "v2" && article.status === "pending" && (
              <Banner tone="info" title="Ultra Custom V2 article">
                Generation will write the page as the article's sequel: it
                confirms every expectation the article set (never contradicts
                one), leads with what the article did not already say,
                becomes strongest on the dimensions where the article found
                the alternatives lacking, answers the questions the article
                left open, and moderately tightens the page for nearly-sold
                readers. The four inventories appear here for review once it
                goes live. No study results or rankings are pulled.
              </Banner>
            )}

            {!isBrief && article.detectedQuery && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Detected search intent
                  </Text>
                  <Text as="p" variant="headingMd">
                    {article.detectedQuery}
                  </Text>
                  {queryVariants.length > 0 && (
                    <InlineStack gap="150" wrap>
                      {queryVariants.map((variant) => (
                        <Badge key={variant}>{variant}</Badge>
                      ))}
                    </InlineStack>
                  )}
                  {evidence.length > 0 && (
                    <BlockStack gap="150">
                      <Text as="h3" variant="headingSm" tone="subdued">
                        Evidence from the article
                      </Text>
                      <List type="bullet">
                        {evidence.map((item, index) => (
                          <List.Item key={index}>{item}</List.Item>
                        ))}
                      </List>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            )}

            {proofPoints.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Proof elements from the article
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    These were woven into the adapted copy. Check each against
                    the article before marking the variant reviewed — the
                    quote is the article's supporting text.
                  </Text>
                  <BlockStack gap="200">
                    {proofPoints.map((point, index) => (
                      <BlockStack gap="050" key={index}>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          {point.claim}
                        </Text>
                        {point.quote && (
                          <Text as="p" tone="subdued" variant="bodySm">
                            “{point.quote}”
                          </Text>
                        )}
                        {point.verified === false && (
                          <Text as="p" tone="critical" variant="bodySm">
                            This quote was not found in the article text —
                            verify it in the article yourself; the variant is
                            already live, so take it offline if it does not
                            hold up.
                          </Text>
                        )}
                      </BlockStack>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            )}

            {personaPriorities.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    What this audience wants to hear (ranked)
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    The generation aimed to cover this list wherever the
                    original copy or the article supports it: top items
                    prominently in the tagline, description, and overview,
                    lower items further down. Items with no grounded support
                    were skipped rather than invented - check the copy against
                    this list before marking the variant reviewed.
                  </Text>
                  <BlockStack gap="150">
                    {personaPriorities.map((priority, index) => (
                      <InlineStack key={index} gap="200" blockAlign="center" wrap={false}>
                        <Badge
                          tone={
                            priority.importance === "high"
                              ? "critical"
                              : priority.importance === "medium"
                                ? "attention"
                                : undefined
                          }
                        >
                          {priority.importance}
                        </Badge>
                        <Text as="span" variant="bodyMd">
                          {priority.point}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            )}

            {conversionPlan && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Conversion plan
                  </Text>
                  {conversionPlan.readerStage && (
                    <Text as="p" variant="bodyMd">
                      <Text as="span" fontWeight="semibold">
                        Arriving reader:{" "}
                      </Text>
                      {conversionPlan.readerStage}
                    </Text>
                  )}
                  <Text as="p" tone="subdued" variant="bodySm">
                    The generation sequenced the page for this reader and
                    covered each list wherever the original copy or the
                    article supports it: top desires lead the tagline,
                    description, and overview; objections are answered where
                    they naturally arise; criteria are excelled at in the
                    page's own wording. Unsupported items were skipped rather
                    than invented - check the copy against these lists.
                  </Text>
                  {(
                    [
                      ["What they want to hear", conversionPlan.desires],
                      ["Their doubts, answered in place", conversionPlan.objections],
                      ["What they judge by", conversionPlan.criteria],
                    ] as const
                  ).map(([title, items]) =>
                    items.length > 0 ? (
                      <BlockStack gap="150" key={title}>
                        <Text as="h3" variant="headingSm" tone="subdued">
                          {title}
                        </Text>
                        {items.map((item, index) => (
                          <InlineStack
                            key={index}
                            gap="200"
                            blockAlign="center"
                            wrap={false}
                          >
                            <Badge
                              tone={
                                item.importance === "high"
                                  ? "critical"
                                  : item.importance === "medium"
                                    ? "attention"
                                    : undefined
                              }
                            >
                              {item.importance}
                            </Badge>
                            <Text as="span" variant="bodyMd">
                              {item.point}
                            </Text>
                          </InlineStack>
                        ))}
                      </BlockStack>
                    ) : null,
                  )}
                </BlockStack>
              </Card>
            )}

            {v2Plan && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Sequel plan (Ultra Custom V2)
                  </Text>
                  {v2Plan.readerStage && (
                    <Text as="p" variant="bodyMd">
                      <Text as="span" fontWeight="semibold">
                        Arriving reader:{" "}
                      </Text>
                      {v2Plan.readerStage}
                    </Text>
                  )}
                  {v2Plan.compression && (
                    <Text as="p" variant="bodyMd">
                      <Text as="span" fontWeight="semibold">
                        Length decision:{" "}
                      </Text>
                      {v2Plan.compression}
                    </Text>
                  )}
                  <Text as="p" tone="subdued" variant="bodySm">
                    The generation wrote the page as this article's sequel:
                    expectations confirmed where the copy or article supports
                    them (never contradicted, silently left out otherwise),
                    already-delivered claims compressed or deepened instead
                    of repeated, ceded-ground themes made load-bearing only
                    where the copy truthfully supports them, and open
                    questions answered where grounded. Check the copy against
                    these lists.
                  </Text>
                  {(
                    [
                      [
                        "Expectations the article set",
                        v2Plan.expectations,
                      ],
                      [
                        "Already covered by the article",
                        v2Plan.redundancy,
                      ],
                      [
                        "Ground the alternatives ceded",
                        v2Plan.cededGround,
                      ],
                      ["Questions the article left open", v2Plan.gaps],
                    ] as const
                  ).map(([title, items]) =>
                    items.length > 0 ? (
                      <BlockStack gap="150" key={title}>
                        <Text as="h3" variant="headingSm" tone="subdued">
                          {title}
                        </Text>
                        {items.map((item, index) => (
                          <BlockStack gap="050" key={index}>
                            <Text as="span" variant="bodyMd">
                              {item.point}
                            </Text>
                            {item.detail && (
                              <Text as="span" variant="bodySm" tone="subdued">
                                {item.detail}
                              </Text>
                            )}
                          </BlockStack>
                        ))}
                      </BlockStack>
                    ) : null,
                  )}
                </BlockStack>
              </Card>
            )}

            {subtlePlan && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Planted positioning (Subtle intent)
                  </Text>
                  {subtlePlan.concern && (
                    <Text as="p" variant="bodyMd">
                      <Text as="span" fontWeight="semibold">
                        Reader&apos;s concern:{" "}
                      </Text>
                      {subtlePlan.concern}
                    </Text>
                  )}
                  {subtlePlan.termDecision && (
                    <Text as="p" variant="bodyMd">
                      <Text as="span" fontWeight="semibold">
                        Unprompted-brand test:{" "}
                      </Text>
                      {subtlePlan.termDecision}
                    </Text>
                  )}
                  <Text as="p" tone="subdued" variant="bodySm">
                    Each sentence the generation reports having planted or
                    edited for the concern, with where it landed and why it
                    should read as copy the brand would have written
                    unprompted. This list is the model&apos;s own report -
                    still check the copy below: if a sentence gives away
                    that the page knows about the article, tighten the
                    dials in Settings and regenerate.
                  </Text>
                  {subtlePlan.insertions.length > 0 ? (
                    <BlockStack gap="150">
                      {subtlePlan.insertions.map((item, index) => (
                        <BlockStack gap="050" key={index}>
                          <Text as="span" variant="bodyMd">
                            {item.point}
                          </Text>
                          {item.detail && (
                            <Text as="span" variant="bodySm" tone="subdued">
                              {item.detail}
                            </Text>
                          )}
                          {item.verified === false && (
                            <Text as="span" variant="bodySm" tone="critical">
                              This sentence was not found in the stored copy
                              - the report may be incomplete or reworded, so
                              review the adapted surfaces themselves.
                            </Text>
                          )}
                        </BlockStack>
                      ))}
                    </BlockStack>
                  ) : (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      The generation reported planting nothing (it judged
                      the sources could not ground the concern). Skim the
                      adapted surfaces below to confirm they are essentially
                      unchanged.
                    </Text>
                  )}
                </BlockStack>
              </Card>
            )}

            {overrides.length === 0 && article.status === "pending" && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Not generated yet
                  </Text>
                  <Text as="p" variant="bodyMd">
                    {isBrief
                      ? "Write the page from the brief. It goes live automatically once generated (while serving is on), and you review and refine it here afterwards."
                      : "Generate the adapted copy for this article. The variant goes live automatically once generated (while serving is on), and you review it here afterwards."}
                  </Text>
                  <InlineStack>
                    <Button
                      variant="primary"
                      onClick={handleGenerate}
                      loading={isGenerating}
                    >
                      Generate
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            {overrides.map((o) => {
              const draft = drafts[o.id] ?? {
                adapted: o.adapted,
                enabled: o.enabled,
              };
              return (
                <Card key={o.id}>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        {o.label}
                      </Text>
                      <Checkbox
                        label="Include this surface"
                        checked={draft.enabled}
                        onChange={(value) =>
                          updateDraft(o.id, { enabled: value })
                        }
                      />
                    </InlineStack>
                    {o.warnings.length > 0 && (
                      <Banner tone="warning" title="Flagged for review">
                        <List type="bullet">
                          {o.warnings.map((warning, index) => (
                            <List.Item key={index}>{warning}</List.Item>
                          ))}
                        </List>
                      </Banner>
                    )}
                    {o.unverifiedClaims.length > 0 && (
                      <Banner tone="info" title="Unverified claims">
                        <BlockStack gap="150">
                          <List type="bullet">
                            {o.unverifiedClaims.map((claim, index) => (
                              <List.Item key={index}>{claim}</List.Item>
                            ))}
                          </List>
                          <Text as="p" variant="bodySm">
                            {isBrief
                              ? "The checker found these in neither the page copy, the brief, nor the references. Check each one before marking the page reviewed; edit or refine the copy if anything does not hold up."
                              : "The checker found these in neither the page copy nor the article. Check each one before marking the page reviewed."}
                            {o.unverifiedClaims.some((c) => c.startsWith(FIGURE_CLAIM_PREFIX))
                              ? ' Items marked "Illustration:" come from the figure\'s caption, alt text and drawing prompt; a chart may show illustrative numbers, which the checker lists here on purpose.'
                              : ""}
                          </Text>
                        </BlockStack>
                      </Banner>
                    )}
                    {o.articleClaims.length > 0 && (
                      <Banner
                        tone="info"
                        title={
                          isBrief
                            ? "New claims from the brief or references"
                            : "New claims grounded in the article"
                        }
                      >
                        <BlockStack gap="150">
                          <List type="bullet">
                            {o.articleClaims.map((claim, index) => (
                              <List.Item key={index}>{claim}</List.Item>
                            ))}
                          </List>
                          <Text as="p" variant="bodySm">
                            {isBrief
                              ? "The original copy does not make these claims; your brief or references do. Marking the page reviewed covers them."
                              : "The original copy does not make these claims — the article does. Verify the article really supports each one; marking the variant reviewed covers them."}
                          </Text>
                        </BlockStack>
                      </Banner>
                    )}
                    <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                      <BlockStack gap="150">
                        <Text as="h3" variant="headingSm" tone="subdued">
                          Original
                        </Text>
                        <div
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                            maxHeight: "20rem",
                            overflowY: "auto",
                            padding: "0.75rem",
                            borderRadius: "0.5rem",
                            background: "var(--p-color-bg-surface-secondary)",
                            fontSize: "0.8125rem",
                          }}
                        >
                          {o.original}
                        </div>
                      </BlockStack>
                      <TextField
                        label="Adapted"
                        value={draft.adapted}
                        onChange={(value) =>
                          updateDraft(o.id, { adapted: value })
                        }
                        multiline={12}
                        autoComplete="off"
                      />
                    </InlineGrid>
                    {o.notes && (
                      <Text as="p" tone="subdued" variant="bodySm">
                        Model notes: {o.notes}
                      </Text>
                    )}
                    {o.figure && (
                      <FigurePanel
                        overrideId={o.id}
                        surfaceKey={o.surfaceKey}
                        surfaceLabel={o.label}
                        locale={article.locale}
                        figure={o.figure}
                        draft={
                          figureDrafts[o.id] ?? {
                            caption: o.figure.caption,
                            alt: o.figure.alt,
                            anchor: anchorValue(o.figure.anchor, o.figure.hasMarker),
                          }
                        }
                        onDraft={(patch) => updateFigureDraft(o.id, patch)}
                        busy={isGenerating || isFigureActing || isSaving}
                        hasUnsavedEdits={hasUnsavedEdits}
                        isLive={isLive}
                        templates={illustration.templates}
                        images={illustration.images}
                        openaiConfigured={illustration.openaiConfigured}
                        costPerImage={illustration.costPerImage}
                        recommend={recommendForSurface}
                        submitFigure={submitFigure}
                      />
                    )}
                  </BlockStack>
                </Card>
              );
            })}

            {overrides.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  {isLive && (
                    <Text as="p" variant="bodySm" tone="subdued" alignment="end">
                      This variant is live: saved edits reach the storefront
                      within about 2 minutes.
                    </Text>
                  )}
                  <InlineStack gap="300" align="end">
                    <Button
                      onClick={handleSave}
                      loading={isSaving}
                      disabled={isGenerating}
                      variant={isLive ? undefined : "primary"}
                    >
                      Save edits
                    </Button>
                    {needsReview && (
                      <Button
                        variant="primary"
                        loading={isReviewActing}
                        disabled={isGenerating}
                        onClick={() =>
                          reviewFetcher.submit(
                            { intent: "markReviewed", overrideIds },
                            { method: "POST" },
                          )
                        }
                      >
                        Mark as reviewed
                      </Button>
                    )}
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            {isBrief && overrides.length > 0 && !isGenerating && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Refine with a prompt
                  </Text>
                  <TextField
                    label="What should change?"
                    labelHidden
                    value={refineText}
                    onChange={setRefineText}
                    multiline={3}
                    autoComplete="off"
                    placeholder="e.g. Shorten the FAQ to the four most relevant questions, and make the Science headline about molecular size"
                    maxLength={4000}
                  />
                  <InlineStack align="space-between" blockAlign="center" gap="300">
                    <Text
                      as="p"
                      variant="bodySm"
                      tone={hasUnsavedEdits ? "caution" : "subdued"}
                    >
                      {hasUnsavedEdits
                        ? "Save your edits first: a refinement works on the saved copy and would discard unsaved typing."
                        : "Only what you ask for changes; everything else stays as it is, hand edits included. The new copy goes live within about 2 minutes and comes back as “Live — review needed”."}
                    </Text>
                    <Button
                      variant="primary"
                      loading={refineFetcher.state !== "idle"}
                      disabled={
                        !refineText.trim() ||
                        isGenerating ||
                        isSaving ||
                        hasUnsavedEdits
                      }
                      onClick={handleRefine}
                    >
                      Refine
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            {versions.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Version history
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Every generation, refinement, edit, illustration and
                    restore is kept. Restoring replaces the live copy (and
                    its illustrations) immediately (storefront within about 2
                    minutes) and keeps the current copy as a new version, so
                    a restore can itself be undone.
                  </Text>
                  <BlockStack gap="200">
                    {versions.map((version, index) => (
                      <Box
                        key={version.number}
                        padding="300"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        <InlineStack
                          align="space-between"
                          blockAlign="start"
                          wrap={false}
                          gap="300"
                        >
                          <BlockStack gap="100">
                            <InlineStack gap="150" blockAlign="center" wrap>
                              <Text as="span" variant="bodyMd" fontWeight="semibold">
                                #{version.number}
                              </Text>
                              {versionKindBadge(version.kind)}
                              {index === 0 && <Badge tone="success">Current</Badge>}
                              <Text as="span" variant="bodySm" tone="subdued">
                                {new Date(version.createdAt).toLocaleString()}
                              </Text>
                            </InlineStack>
                            {version.restoredFrom ? (
                              <Text as="p" variant="bodySm">
                                Restored version #{version.restoredFrom}
                              </Text>
                            ) : null}
                            {version.instruction && (
                              <Text as="p" variant="bodySm">
                                {version.instruction}
                              </Text>
                            )}
                            {version.modelNotes && (
                              <Text as="p" variant="bodySm" tone="subdued">
                                {version.modelNotes.length > 280
                                  ? `${version.modelNotes.slice(0, 280)}…`
                                  : version.modelNotes}
                              </Text>
                            )}
                            {version.changedSurfaces.length > 0 &&
                              version.kind !== "generate" && (
                                <Text as="p" variant="bodySm" tone="subdued">
                                  Changed: {version.changedSurfaces.join(", ")}
                                </Text>
                              )}
                            {version.runWarnings.length > 0 && (
                              <Text as="p" variant="bodySm" tone="caution">
                                {version.runWarnings.length === 1
                                  ? "One reference could not be read."
                                  : `${version.runWarnings.length} references could not be read.`}
                              </Text>
                            )}
                          </BlockStack>
                          {index !== 0 && (
                            <Button
                              size="slim"
                              disabled={isGenerating || isRestoring || isSaving}
                              onClick={() => setRestoreTarget(version.number)}
                            >
                              Restore
                            </Button>
                          )}
                        </InlineStack>
                      </Box>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
      <Modal
        open={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        title={`Restore version #${restoreTarget ?? ""}?`}
        primaryAction={{
          content: "Restore",
          onAction: () => {
            if (restoreTarget !== null) {
              restoreFetcher.submit(
                { intent: "restore", version: String(restoreTarget) },
                { method: "POST" },
              );
            }
            setRestoreTarget(null);
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setRestoreTarget(null) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              The copy from that version replaces the current copy. The
              current copy is kept as a new version, so you can switch back.
            </Text>
            {article.status === "approved" && (
              <Text as="p" tone="caution">
                This variant is live: the restored copy reaches the storefront
                within about 2 minutes.
              </Text>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete this article?"
        primaryAction={{
          content: "Delete article",
          destructive: true,
          onAction: () => {
            setDeleteModalOpen(false);
            submit({ intent: "delete" }, { method: "POST" });
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setDeleteModalOpen(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              The generated copy and any edits cannot be recovered.
            </Text>
            {article.status === "approved" && (
              <Text as="p" tone="critical">
                This variant is live: any ads or articles linking to its URL
                will show the normal product page within about 2 minutes.
              </Text>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Illustration panel of one section
// ---------------------------------------------------------------------------

type FigureView = {
  image: {
    id: string;
    name: string;
    url: string;
    width: number;
    height: number;
    templateId: string | null;
    specificPrompt: string | null;
    language: string | null;
  } | null;
  caption: string;
  alt: string;
  source: string | null;
  error: string | null;
  canRetry: boolean;
  anchor: FigureAnchor | null;
  hasMarker: boolean;
  blocks: Array<{ index: number; tag: string; excerpt: string }>;
  alternatives: {
    images: Array<{ id: string; name: string; url: string }>;
    suggestions: FigureSuggestion[];
  };
};

function FigurePanel(props: {
  overrideId: string;
  surfaceKey: string;
  surfaceLabel: string;
  locale: string;
  figure: FigureView;
  draft: FigureDraft;
  onDraft: (patch: Partial<FigureDraft>) => void;
  busy: boolean;
  hasUnsavedEdits: boolean;
  isLive: boolean;
  templates: ChoiceTemplate[];
  images: ChoiceImage[];
  openaiConfigured: boolean;
  costPerImage: number;
  recommend: (surfaceKey: string) => Promise<FigureSuggestion[]>;
  submitFigure: (fields: Record<string, string>) => void;
}) {
  const { figure, draft, surfaceKey, templates, images } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [drawOpen, setDrawOpen] = useState(false);
  const [drawChoice, setDrawChoice] = useState<IllustrationChoiceDraft>(() => ({
    ...emptyChoice(undefined, templates, images),
    mode: "template",
  }));
  const updateDrawChoice = useCallback(
    (update: ChoiceUpdater) => setDrawChoice((prev) => update(prev)),
    [],
  );

  const positionOptions = [
    { label: "Top of the section", value: "top" },
    ...figure.blocks.flatMap((b) => [
      {
        label: `After block ${b.index + 1} (${b.tag}: ${b.excerpt.slice(0, 50)}${
          b.excerpt.length > 50 ? "…" : ""
        })`,
        value: `after:${b.index}`,
      },
    ]),
    { label: "Bottom of the section", value: "bottom" },
    ...(figure.hasMarker && !figure.anchor
      ? [{ label: "Custom (placed by hand inside a block)", value: "custom" }]
      : []),
  ];

  const figureChanged =
    draft.caption !== figure.caption ||
    draft.alt !== figure.alt ||
    draft.anchor !== anchorValue(figure.anchor, figure.hasMarker);

  // Rows are recreated by every figure job: unsaved copy edits would be lost.
  const jobsBlocked = props.busy || props.hasUnsavedEdits;
  const jobsHint = props.hasUnsavedEdits
    ? "Save your copy edits first: drawing or picking an image replaces the rows and would discard unsaved typing."
    : null;

  const submitDrawChoice = useCallback(() => {
    const submission = choiceToSubmission(drawChoice);
    if (submission.mode === "library") {
      props.submitFigure({ intent: "figureUseImage", surfaceKey, imageId: submission.imageId });
      setDrawOpen(false);
    } else if (submission.mode === "template") {
      props.submitFigure({
        intent: "figureDraw",
        surfaceKey,
        draws: JSON.stringify(submission.draws),
      });
      setDrawOpen(false);
    }
  }, [drawChoice, props, surfaceKey]);

  const drawSubmission = choiceToSubmission(drawChoice);
  const canSubmitDraw =
    (drawSubmission.mode === "library" || drawSubmission.mode === "template") && !jobsBlocked;

  return (
    <Box borderColor="border" borderWidth="025" borderRadius="200" padding="300">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <Text as="h3" variant="headingSm">
            Illustration
          </Text>
          <InlineStack gap="200">
            <Button size="slim" disabled={jobsBlocked} onClick={() => setPickerOpen(true)}>
              Pick from library
            </Button>
            <Button size="slim" disabled={jobsBlocked} onClick={() => setDrawOpen(true)}>
              {figure.image ? "Draw another" : "Draw one"}
            </Button>
            {figure.image?.templateId && figure.image.specificPrompt && (
              <Button
                size="slim"
                disabled={jobsBlocked || !props.openaiConfigured}
                onClick={() =>
                  props.submitFigure({
                    intent: "figureDraw",
                    surfaceKey,
                    draws: JSON.stringify([
                      {
                        templateId: figure.image!.templateId,
                        specificPrompt: figure.image!.specificPrompt,
                        rationale: "Drawn again",
                      },
                    ]),
                  })
                }
              >
                Draw again
              </Button>
            )}
            {figure.image && (
              <Button
                size="slim"
                tone="critical"
                disabled={props.busy}
                onClick={() => props.submitFigure({ intent: "figureRemove", surfaceKey })}
              >
                Remove
              </Button>
            )}
          </InlineStack>
        </InlineStack>
        {jobsHint && (
          <Text as="p" variant="bodySm" tone="caution">
            {jobsHint}
          </Text>
        )}
        {figure.error && (
          <Banner
            tone="warning"
            title={figure.image ? "The last drawing had a problem" : "The illustration could not be made"}
          >
            <BlockStack gap="200">
              <Text as="p">{figure.error}</Text>
              {figure.canRetry && (
                <InlineStack>
                  <Button
                    size="slim"
                    disabled={jobsBlocked}
                    onClick={() => props.submitFigure({ intent: "figureRetry", surfaceKey })}
                  >
                    Try again
                  </Button>
                </InlineStack>
              )}
            </BlockStack>
          </Banner>
        )}
        {figure.image ? (
          <InlineGrid columns={{ xs: 1, md: ["oneThird", "twoThirds"] }} gap="400">
            <BlockStack gap="150">
              <img
                src={thumbnailUrl(figure.image.url, 800)}
                alt={figure.alt}
                style={{ width: "100%", height: "auto", borderRadius: 6, display: "block" }}
              />
              <InlineStack gap="100" wrap>
                <Badge tone={figure.source === "library" ? undefined : "info"}>
                  {figure.source === "library"
                    ? "Library image"
                    : figure.source === "auto"
                      ? "Drawn (Auto)"
                      : "Drawn"}
                </Badge>
                {figure.image.language && figure.image.language !== props.locale && (
                  <Badge tone="attention">{`Labels in ${figure.image.language}`}</Badge>
                )}
              </InlineStack>
              <Text as="span" variant="bodySm" tone="subdued">
                {figure.image.name}
              </Text>
            </BlockStack>
            <BlockStack gap="300">
              <TextField
                label="Caption (shown under the image)"
                value={draft.caption}
                onChange={(caption) => props.onDraft({ caption })}
                multiline={2}
                autoComplete="off"
                maxLength={300}
              />
              <TextField
                label="Alt text (for screen readers)"
                value={draft.alt}
                onChange={(alt) => props.onDraft({ alt })}
                autoComplete="off"
                maxLength={200}
              />
              <Select
                label="Position in the section"
                options={positionOptions}
                value={draft.anchor}
                onChange={(anchor) => props.onDraft({ anchor })}
                helpText={
                  !figure.hasMarker
                    ? "The figure's marker is missing from the adapted copy (removed by hand): it renders at the top until you save a position."
                    : undefined
                }
              />
              <InlineStack align="end" gap="300" blockAlign="center">
                {props.isLive && figureChanged && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    Live within about 2 minutes after saving.
                  </Text>
                )}
                <Button
                  size="slim"
                  variant="primary"
                  disabled={props.busy || !figureChanged}
                  onClick={() =>
                    props.submitFigure({
                      intent: "figureSave",
                      surfaceKey,
                      caption: draft.caption,
                      alt: draft.alt,
                      anchor: draft.anchor === "custom" ? "keep" : draft.anchor,
                    })
                  }
                >
                  Save illustration
                </Button>
              </InlineStack>
            </BlockStack>
          </InlineGrid>
        ) : (
          <Text as="p" variant="bodySm" tone="subdued">
            No illustration in this section. Pick one from the library or draw
            one; Claude places it and writes the caption in the page&apos;s
            language.
          </Text>
        )}
        {(figure.alternatives.images.length > 0 || figure.alternatives.suggestions.length > 0) && (
          <BlockStack gap="200">
            <Text as="h4" variant="headingXs">
              Alternatives
            </Text>
            {figure.alternatives.images.length > 0 && (
              <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
                {figure.alternatives.images.map((alt) => (
                  <BlockStack key={alt.id} gap="100">
                    <img
                      src={thumbnailUrl(alt.url, 400)}
                      alt=""
                      style={{ width: "100%", height: "auto", borderRadius: 6, display: "block" }}
                    />
                    <Button
                      size="slim"
                      disabled={jobsBlocked}
                      onClick={() =>
                        props.submitFigure({ intent: "figureUseImage", surfaceKey, imageId: alt.id })
                      }
                    >
                      Use this
                    </Button>
                  </BlockStack>
                ))}
              </InlineGrid>
            )}
            {figure.alternatives.suggestions.map((s, i) => (
              <Box
                key={`${s.templateId}-${i}`}
                background="bg-surface-secondary"
                borderRadius="200"
                padding="200"
              >
                <InlineStack align="space-between" blockAlign="start" gap="300" wrap={false}>
                  <BlockStack gap="050">
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      {templates.find((t) => t.id === s.templateId)?.name ?? "Template"}
                    </Text>
                    <Text as="span" variant="bodySm">
                      {s.specificPrompt}
                    </Text>
                    {s.rationale && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        {s.rationale}
                      </Text>
                    )}
                  </BlockStack>
                  <Button
                    size="slim"
                    disabled={jobsBlocked || !props.openaiConfigured}
                    onClick={() =>
                      props.submitFigure({
                        intent: "figureDraw",
                        surfaceKey,
                        draws: JSON.stringify([s]),
                      })
                    }
                  >
                    Draw this
                  </Button>
                </InlineStack>
              </Box>
            ))}
          </BlockStack>
        )}
      </BlockStack>
      <ImagePickerModal
        open={pickerOpen}
        images={images}
        onPick={(image) => {
          setPickerOpen(false);
          props.submitFigure({ intent: "figureUseImage", surfaceKey, imageId: image.id });
        }}
        onClose={() => setPickerOpen(false)}
      />
      <Modal
        open={drawOpen}
        onClose={() => setDrawOpen(false)}
        title={`Illustrate: ${props.surfaceLabel}`}
        size="large"
        primaryAction={{
          content:
            drawSubmission.mode === "library"
              ? "Use this image"
              : drawSubmission.mode === "template"
                ? `Draw ${drawSubmission.draws.length === 1 ? "it" : `${drawSubmission.draws.length} images`}`
                : "Draw",
          disabled: !canSubmitDraw,
          onAction: submitDrawChoice,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setDrawOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" variant="bodySm" tone="subdued">
              Recommend reads this page&apos;s source (the brief or the
              article) and the section&apos;s current copy. The first drawn
              image goes live in this section (review needed); the others are
              kept as alternatives.
            </Text>
            <IllustrationChoice
              surfaceKey={surfaceKey}
              surfaceLabel={props.surfaceLabel}
              value={drawChoice}
              onChange={updateDrawChoice}
              templates={templates}
              images={images}
              locales={[props.locale]}
              recommend={props.recommend}
              openaiConfigured={props.openaiConfigured}
              costPerImage={props.costPerImage}
              hideAuto
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Box>
  );
}
