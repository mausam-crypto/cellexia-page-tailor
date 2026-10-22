import prisma from "../db.server";
import { removeMarker } from "./figure-markup";
import {
  parseFigureAlternatives,
  type SurfaceSnapshot,
  type VersionKind,
} from "./types";

/**
 * Version history for a variant's copy.
 *
 * `Override` rows stay the live copy that serving reads. Every event that
 * replaces or edits them (generation, refinement, hand edit, restore,
 * duplicate) also appends a `VariantVersion` row holding a full snapshot of
 * every surface right AFTER the event, so any earlier state can be restored
 * with one click. Callers that write overrides inside an array-form
 * `prisma.$transaction` call `prepareVersion` first (outside the
 * transaction) and push `buildVersionCreate(...)` into the same transaction.
 */

/** Versions kept per variant; older ones are pruned best-effort after each
 *  write. A 7-surface snapshot is typically 10-40 KB. */
export const MAX_VERSIONS_PER_ARTICLE = 50;

export type OverrideLike = {
  surfaceKey: string;
  label: string;
  selector: string;
  mode: string;
  original: string;
  adapted: string;
  notes: string | null;
  warnings: string | null;
  articleClaims: string | null;
  unverifiedClaims: string | null;
  enabled: boolean;
  figureImageId?: string | null;
  figureCaption?: string | null;
  figureAlt?: string | null;
  figureAlternatives?: string | null;
  figureSource?: string | null;
};

/** Snapshot override rows (sorted by surface key so two snapshots of the
 *  same state are byte-identical). */
export function snapshotOverrides(rows: OverrideLike[]): SurfaceSnapshot[] {
  return [...rows]
    .sort((a, b) => a.surfaceKey.localeCompare(b.surfaceKey))
    .map((o) => ({
      surfaceKey: o.surfaceKey,
      label: o.label,
      selector: o.selector,
      mode: o.mode,
      original: o.original,
      adapted: o.adapted,
      notes: o.notes ?? null,
      warnings: o.warnings ?? null,
      articleClaims: o.articleClaims ?? null,
      unverifiedClaims: o.unverifiedClaims ?? null,
      enabled: o.enabled,
      figureImageId: o.figureImageId ?? null,
      figureCaption: o.figureCaption ?? null,
      figureAlt: o.figureAlt ?? null,
      figureAlternatives: o.figureAlternatives ?? null,
      figureSource: o.figureSource ?? null,
    }));
}

/** Parse a stored snapshot defensively; malformed entries are dropped. */
export function parseSnapshot(json: string | null): SurfaceSnapshot[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is Record<string, unknown> => typeof s === "object" && s !== null,
      )
      .map((s) => ({
        surfaceKey: String(s.surfaceKey ?? ""),
        label: String(s.label ?? ""),
        selector: String(s.selector ?? ""),
        mode: s.mode === "text" ? "text" : "html",
        original: String(s.original ?? ""),
        adapted: String(s.adapted ?? ""),
        notes: typeof s.notes === "string" ? s.notes : null,
        warnings: typeof s.warnings === "string" ? s.warnings : null,
        articleClaims:
          typeof s.articleClaims === "string" ? s.articleClaims : null,
        unverifiedClaims:
          typeof s.unverifiedClaims === "string" ? s.unverifiedClaims : null,
        enabled: s.enabled !== false,
        figureImageId:
          typeof s.figureImageId === "string" && s.figureImageId !== ""
            ? s.figureImageId
            : null,
        figureCaption: typeof s.figureCaption === "string" ? s.figureCaption : null,
        figureAlt: typeof s.figureAlt === "string" ? s.figureAlt : null,
        figureAlternatives:
          typeof s.figureAlternatives === "string" ? s.figureAlternatives : null,
        figureSource: typeof s.figureSource === "string" ? s.figureSource : null,
      }))
      .filter((s) => s.surfaceKey !== "");
  } catch {
    return [];
  }
}

/** Labels of the surfaces whose served copy (text or enabled flag) differs
 *  between two snapshots. Everything counts as changed against no previous
 *  snapshot. */
export function changedSurfaceLabels(
  previous: SurfaceSnapshot[] | null,
  next: SurfaceSnapshot[],
): string[] {
  if (!previous) return next.map((s) => s.label);
  const prevByKey = new Map(previous.map((s) => [s.surfaceKey, s]));
  const labels: string[] = [];
  for (const s of next) {
    const p = prevByKey.get(s.surfaceKey);
    if (
      !p ||
      p.adapted !== s.adapted ||
      p.enabled !== s.enabled ||
      (p.figureImageId ?? null) !== (s.figureImageId ?? null) ||
      (p.figureCaption ?? null) !== (s.figureCaption ?? null) ||
      (p.figureAlt ?? null) !== (s.figureAlt ?? null)
    ) {
      labels.push(s.label);
    }
    prevByKey.delete(s.surfaceKey);
  }
  for (const removed of prevByKey.values()) labels.push(removed.label);
  return labels;
}

/**
 * Reserve the next version number for an article and return the snapshot of
 * the copy about to be replaced. Articles generated before version history
 * existed get a lazily created baseline (version 1 = the copy as it is now)
 * the first time anything changes them, so there is always a "before" to
 * restore to. Call OUTSIDE the writing transaction; the generation lock (or,
 * for hand edits, the unique [articleId, number] index) rules out two
 * writers reserving the same number.
 */
export async function prepareVersion(
  articleId: string,
  currentRows: OverrideLike[],
): Promise<{ number: number; previousSnapshot: SurfaceSnapshot[] | null }> {
  const latest = await prisma.variantVersion.findFirst({
    where: { articleId },
    orderBy: { number: "desc" },
    select: { number: true, surfaces: true },
  });
  const current = currentRows.length > 0 ? snapshotOverrides(currentRows) : null;
  if (latest) {
    return {
      number: latest.number + 1,
      previousSnapshot: current ?? parseSnapshot(latest.surfaces),
    };
  }
  if (!current) return { number: 1, previousSnapshot: null };
  await prisma.variantVersion.create({
    data: {
      articleId,
      number: 1,
      kind: "generate",
      surfaces: JSON.stringify(current),
      modelNotes: "Copy as it was when version history was introduced.",
      changedSurfaces: JSON.stringify(current.map((s) => s.label)),
    },
  });
  return { number: 2, previousSnapshot: current };
}

/** The `variantVersion.create` operation for one event, ready to be pushed
 *  into an array-form transaction alongside the override writes. */
export function buildVersionCreate(input: {
  articleId: string;
  number: number;
  kind: VersionKind;
  snapshot: SurfaceSnapshot[];
  previousSnapshot: SurfaceSnapshot[] | null;
  instruction?: string | null;
  modelNotes?: string | null;
  runWarnings?: string[];
  restoredFrom?: number | null;
}) {
  const snapshot = [...input.snapshot].sort((a, b) =>
    a.surfaceKey.localeCompare(b.surfaceKey),
  );
  return prisma.variantVersion.create({
    data: {
      articleId: input.articleId,
      number: input.number,
      kind: input.kind,
      instruction: input.instruction ?? null,
      surfaces: JSON.stringify(snapshot),
      modelNotes: input.modelNotes ?? null,
      runWarnings:
        input.runWarnings && input.runWarnings.length > 0
          ? JSON.stringify(input.runWarnings)
          : null,
      changedSurfaces: JSON.stringify(
        changedSurfaceLabels(input.previousSnapshot, snapshot),
      ),
      restoredFrom: input.restoredFrom ?? null,
    },
  });
}

/** Drop versions beyond the cap (oldest first). Best-effort: a failure here
 *  must never fail the write that preceded it. */
export async function pruneVersions(articleId: string): Promise<void> {
  try {
    const latest = await prisma.variantVersion.findFirst({
      where: { articleId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    if (!latest || latest.number <= MAX_VERSIONS_PER_ARTICLE) return;
    await prisma.variantVersion.deleteMany({
      where: {
        articleId,
        number: { lte: latest.number - MAX_VERSIONS_PER_ARTICLE },
      },
    });
  } catch (error) {
    console.error(`Could not prune versions for article ${articleId}`, error);
  }
}

/**
 * Make a stored version the live copy again: the current Override rows are
 * replaced by the snapshot (fresh ids, so the review page's stale-copy guard
 * trips for anyone still editing the old rows) and the event is recorded as
 * a new "restore" version, so a restore can itself be undone. Status, the
 * review stamp, and wasApproved are left alone: restoring is the merchant's
 * own deliberate choice of copy, not a new generation to review.
 */
export async function restoreVersion(
  shop: string,
  articleId: string,
  number: number,
): Promise<{ restoredFrom: number; newNumber: number; notice: string | null }> {
  const article = await prisma.article.findFirst({
    where: { id: articleId, shop },
    include: { overrides: true },
  });
  if (!article) throw new Error("Article not found");
  const version = await prisma.variantVersion.findUnique({
    where: { articleId_number: { articleId, number } },
  });
  if (!version) throw new Error("That version no longer exists.");
  const snapshot = parseSnapshot(version.surfaces);
  if (snapshot.length === 0) {
    throw new Error("That version holds no copy to restore.");
  }
  // An illustration whose library image has since been deleted cannot come
  // back: the figure is dropped from that surface (the copy still restores)
  // and the caller is told.
  let notice: string | null = null;
  const wantedImages = new Set<string>();
  for (const s of snapshot) {
    if (s.figureImageId) wantedImages.add(s.figureImageId);
    for (const id of parseFigureAlternatives(s.figureAlternatives).images) {
      wantedImages.add(id);
    }
  }
  if (wantedImages.size > 0) {
    const existing = await prisma.illustrationImage.findMany({
      where: { id: { in: [...wantedImages] }, shop },
      select: { id: true },
    });
    const ok = new Set(existing.map((e) => e.id));
    for (const s of snapshot) {
      const alternatives = parseFigureAlternatives(s.figureAlternatives);
      const keptImages = alternatives.images.filter((id) => ok.has(id));
      if (keptImages.length !== alternatives.images.length) {
        s.figureAlternatives = JSON.stringify({
          images: keptImages,
          suggestions: alternatives.suggestions,
        });
      }
      if (s.figureImageId && !ok.has(s.figureImageId)) {
        s.figureImageId = null;
        s.figureCaption = null;
        s.figureAlt = null;
        s.figureSource = null;
        s.adapted = removeMarker(s.adapted);
        notice = `The illustration of "${s.label}" in that version is no longer in the image library, so it was not restored.`;
      }
    }
  }
  const { number: newNumber, previousSnapshot } = await prepareVersion(
    articleId,
    article.overrides,
  );
  if (number === newNumber - 1) {
    throw new Error("That is already the current version.");
  }
  await prisma.$transaction([
    prisma.override.deleteMany({ where: { articleId } }),
    prisma.override.createMany({
      data: snapshot.map((s) => ({ articleId, ...s })),
    }),
    buildVersionCreate({
      articleId,
      number: newNumber,
      kind: "restore",
      snapshot,
      previousSnapshot,
      restoredFrom: number,
    }),
  ]);
  await pruneVersions(articleId);
  return { restoredFrom: number, newNumber, notice };
}
