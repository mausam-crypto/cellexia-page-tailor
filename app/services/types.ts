// A "copy surface" is one piece of product-page copy the app is allowed to
// adapt: the native product description, a metafield (e.g. an Accentuate
// Custom Fields field), or a live page region ("page") whose original copy
// is read directly from the rendered storefront page - used for theme tab
// panels (Overview/Benefits/Science) where heading and body live in one
// container and must be adapted together.
export type SurfaceSource = "description" | "metafield" | "page";

export type AdaptationDepth = "light" | "medium" | "deep";

/**
 * Per-article adaptation mode:
 * - standard: intent re-emphasis within the configured depths.
 * - subtle: "Subtle intent" - standard's conservatism (structure preserved,
 *   most wording identical) plus a small budget of planted sentences that
 *   position the product for the reader's specific concern. Each planted
 *   term passes the "unprompted-brand test": natural product vocabulary
 *   ("night cream") may be adopted outright, article-side jargon ("collagen
 *   alternative") never appears - the copy speaks to the underlying need
 *   instead. Tuned by ShopSettings.subtle dials; no proof elements,
 *   Google-safe.
 * - meta: deepest rewrite plus the article's proof elements (study wins,
 *   rankings, statistics), for Meta paid-social funnels.
 * - ultra: deepest intent/use-case tailoring - recenters every surface on
 *   the article audience's intent and vocabulary, may remove irrelevant
 *   claims, but never pulls proof elements or references the article.
 * - persona: Ultra's rules plus an explicit method - identify the product
 *   type the article's readers seek, build a ranked list of everything
 *   that shopper wants to hear, and place items across the page by
 *   importance (top 1-3 lead the tagline, description, and overview).
 * - max: "Ultra Custom Conversion Max" - diagnoses the arriving reader's
 *   awareness stage and runs THREE ranked lists (desires, objections,
 *   decision criteria) to sequence the page, answer doubts preemptively,
 *   excel organically on the article's evaluation rubric, and tailor the
 *   FAQ surface. Same posture as ultra: no proof elements, Google-safe.
 * - v2: "Ultra Custom V2" - treats the page as the article's sequel: four
 *   article-derived inventories (expectations to confirm, claims the
 *   article already delivered, ground the article's alternatives ceded,
 *   buying questions the article left open) drive a zero-dissonance,
 *   lead-with-the-delta rewrite with moderate stage-matched compression.
 *   Same posture as ultra: no proof elements, Google-safe.
 */
export type AdaptationMode =
  | "standard"
  | "subtle"
  | "meta"
  | "ultra"
  | "persona"
  | "max"
  | "v2";

export function normalizeAdaptationMode(value: string): AdaptationMode {
  return value === "subtle" ||
    value === "meta" ||
    value === "ultra" ||
    value === "persona" ||
    value === "max" ||
    value === "v2"
    ? value
    : "standard";
}

/**
 * Subtle-intent mode dials, stored per shop and read at generation time so
 * the mode can be refined from Settings without code changes. Every field
 * feeds a specific sentence of the adaptation prompt.
 */
export interface SubtleModeSettings {
  /** Max NEW sentences planted per touched surface. */
  insertionsPerSurface: 1 | 2 | 3;
  /** How many surfaces may carry the concern: focused = the 1-2 most
   *  natural homes; balanced = typically 2-3; broad = wherever plausible. */
  coverage: "focused" | "balanced" | "broad";
  /** Unprompted-brand test bias: auto = per-term test; adjacent = never
   *  print the concern's own name; direct = prefer the verbatim term
   *  whenever grounded and not clear article jargon. */
  explicitness: "auto" | "adjacent" | "direct";
  /** Short surfaces (<~200 chars): never touch, rephrase toward the
   *  underlying benefit without naming the concern, or full (may name it
   *  when the test allows). */
  taglineTouch: "never" | "rephrase" | "full";
  /** Min % of wording kept identical per touched surface, outside the
   *  planted sentences. */
  preservationFloor: 90 | 80 | 70;
  /** Whether a planted sentence may be a new sibling <p>/<li> (true) or
   *  must fold into an existing element's flow (false). */
  allowNewBlocks: boolean;
}

export const DEFAULT_SUBTLE_SETTINGS: SubtleModeSettings = {
  insertionsPerSurface: 1,
  coverage: "focused",
  explicitness: "auto",
  taglineTouch: "never",
  preservationFloor: 90,
  allowNewBlocks: false,
};

/** Parse a stored/submitted subtle-settings value; anything malformed or
 *  missing falls back field-by-field to the conservative defaults. */
export function normalizeSubtleSettings(raw: unknown): SubtleModeSettings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const insertions = Number(r.insertionsPerSurface);
  const floor = Number(r.preservationFloor);
  return {
    insertionsPerSurface:
      insertions === 2 || insertions === 3 ? insertions : 1,
    coverage:
      r.coverage === "balanced" || r.coverage === "broad"
        ? r.coverage
        : "focused",
    explicitness:
      r.explicitness === "adjacent" || r.explicitness === "direct"
        ? r.explicitness
        : "auto",
    taglineTouch:
      r.taglineTouch === "rephrase" || r.taglineTouch === "full"
        ? r.taglineTouch
        : "never",
    preservationFloor: floor === 80 || floor === 70 ? floor : 90,
    allowNewBlocks: r.allowNewBlocks === true || r.allowNewBlocks === "true",
  };
}

/** One ranked persona desire (deep-persona mode). */
export interface PersonaPriority {
  /** What this audience wants to know or hear */
  point: string;
  importance: "high" | "medium" | "low";
}

/** Conversion-max mode: the full plan the generation executed. */
export interface ConversionPlan {
  /** One-two sentence diagnosis of the arriving reader's awareness stage
   *  and what the page must establish first. */
  readerStage: string;
  /** Everything this reader wants to hear, ranked. */
  desires: PersonaPriority[];
  /** Doubts the article plants or implies, ranked by purchase-blocking risk. */
  objections: PersonaPriority[];
  /** The evaluation rubric the article teaches, ranked by its emphasis. */
  criteria: PersonaPriority[];
}

/** One entry in an Ultra Custom V2 inventory. */
export interface V2PlanItem {
  /** The item itself (an expectation, delivered claim, ceded-ground theme,
   *  or open question). */
  point: string;
  /** What the rewrite did with it (where confirmed/answered, how demoted
   *  or deepened, or why it was left out). */
  detail: string;
}

/** Ultra Custom V2 mode: the four article-derived inventories plus the
 *  reader diagnosis and length decision the generation executed. */
export interface V2Plan {
  /** One-two sentence diagnosis of the arriving reader's awareness stage. */
  readerStage: string;
  /** The length decision: what was tightened or expanded and why. */
  compression: string;
  /** Expectations the article created about THIS product. */
  expectations: V2PlanItem[];
  /** Claims about this product the article already delivered. */
  redundancy: V2PlanItem[];
  /** Dimensions where the article found the alternatives lacking. */
  cededGround: V2PlanItem[];
  /** Buying questions the article leaves unanswered. */
  gaps: V2PlanItem[];
}

/** One planted (or concern-edited) sentence reported by subtle mode. */
export interface SubtleInsertion extends V2PlanItem {
  /** Set at generation time: whether the reported sentence was actually
   *  found in the stored adapted copy (whitespace/case-insensitive, tags
   *  stripped). False means the model's report could not be verified and
   *  the copy must be checked by hand. */
  verified?: boolean;
}

/** Subtle-intent mode: what the generation planted and why, shown as a
 *  review card so the dials can be evaluated against real output. */
export interface SubtlePlan {
  /** The single product need the arriving reader is shopping to satisfy. */
  concern: string;
  /** Unprompted-brand test outcome: whether the concern's own name may
   *  appear in copy, and the phrasing chosen instead when it may not. */
  termDecision: string;
  /** Each planted or edited sentence (point) with the surface it landed in
   *  and its plausibility/grounding rationale (detail). */
  insertions: SubtleInsertion[];
}

export interface CopySurface {
  /** Stable key, e.g. "description" or "mf:accentuate:science_section" */
  key: string;
  /** Human label shown in the admin UI */
  label: string;
  source: SurfaceSource;
  /** Metafield coordinates when source === "metafield" */
  namespace?: string;
  metafieldKey?: string;
  /** CSS selector where this surface renders in the storefront theme */
  selector: string;
  /** "html" surfaces are swapped via innerHTML (sanitized), "text" via textContent */
  mode: "text" | "html";
  enabled: boolean;
  /**
   * Per-surface adaptation depth; falls back to the shop-wide intensity.
   * light = emphasis/reordering only; medium = rephrase/extend existing
   * sentences; deep = may also add sentences (and, for html surfaces, a few
   * paragraphs/list items) that speak to the reader's specific concern —
   * always assembled exclusively from claims already present in the copy.
   */
  depth?: AdaptationDepth;
  /**
   * Whether this surface may carry an illustration (html surfaces only).
   * Undefined = the built-in default: on for the Science and Overview tabs,
   * off everywhere else. See illustrationsAllowed().
   */
  illustrations?: boolean;
}

/** Surfaces that allow illustrations unless the merchant says otherwise. */
export const DEFAULT_ILLUSTRATION_SURFACES: ReadonlySet<string> = new Set([
  "page:science",
  "page:overview",
]);

/** Whether a surface may carry an illustration: the merchant's explicit
 *  switch, else the built-in default. Never for text surfaces. */
export function illustrationsAllowed(surface: CopySurface): boolean {
  if (surface.mode !== "html") return false;
  if (typeof surface.illustrations === "boolean") return surface.illustrations;
  return DEFAULT_ILLUSTRATION_SURFACES.has(surface.key);
}

export interface ShopSettingsData {
  paramName: string;
  /** Shop-wide default adaptation depth (per-surface depth overrides it). */
  intensity: AdaptationDepth;
  /** Subtle-intent mode dials; read at generation time. */
  subtle: SubtleModeSettings;
  surfaces: CopySurface[];
  /** Master switch. False on install: nothing is ever served until the
   *  merchant explicitly turns serving on. */
  servingEnabled: boolean;
  /** Illustration settings: drawing quality, monthly cap, house style,
   *  remembered creation-form choices. */
  illustrations: IllustrationSettings;
}

/** Base copy for one surface, already localized for the target locale. */
export interface SurfaceContent {
  surface: CopySurface;
  content: string;
}

/** One specific proof element pulled from the article in meta mode. */
export interface ProofPoint {
  /** The proof element as used on the page, e.g. "Ranked #1 of 5 serums tested" */
  claim: string;
  /** Short verbatim article quote that supports it */
  quote: string;
  /** Set at generation time: whether the quote was actually found in the
   *  extracted article text (whitespace/case-insensitive). False means the
   *  model's quote could not be verified and must be checked by hand. */
  verified?: boolean;
}

export interface ArticleAnalysis {
  detectedQuery: string;
  queryVariants: string[];
  evidence: string[];
  /** Meta mode: article proof elements woven into the copy. Empty otherwise. */
  proofPoints: ProofPoint[];
  /** Deep-persona mode: the ranked desire list that drove placement. */
  personaPriorities: PersonaPriority[];
  /** Conversion-max mode: reader stage + three ranked lists. Null otherwise. */
  conversionPlan: ConversionPlan | null;
  /** Ultra Custom V2 mode: the four inventories + diagnosis. Null otherwise. */
  v2Plan: V2Plan | null;
  /** Subtle-intent mode: concern, term decision, insertions. Null otherwise. */
  subtlePlan: SubtlePlan | null;
  adapted: Array<{
    key: string;
    adapted: string;
    notes: string;
  }>;
}

/** Outcome of the claim/heuristic review for one surface. */
export interface ClaimFindings {
  /** Claims supported by neither the original copy nor the article, plus
   *  risky patterns — shown as "Flagged for review" (post-publication
   *  model: nothing blocks). For brief-sourced variants the model guard's
   *  unsupported claims are stored separately as unverifiedClaims. */
  warnings: string[];
  /** New claims the original copy doesn't make but the article (or, for
   *  briefs, the brief/references) supports — shown for review. */
  articleClaims: string[];
}

/** How a variant's source was supplied. "brief" variants have no article:
 *  the merchant's campaign brief drives the copy. */
export type SourceKind = "article" | "pasted" | "brief";

export function normalizeSourceKind(value: string | null | undefined): SourceKind {
  return value === "brief" || value === "pasted" ? value : "article";
}

/** Optional structured fields of a brief ("Advanced" section). Every field
 *  is folded into the brief text the model receives. */
export interface BriefAdvanced {
  audience?: string;
  keyMessage?: string;
  tone?: string;
  mustSay?: string;
  mustAvoid?: string;
}

export const BRIEF_ADVANCED_FIELDS: Array<{
  key: keyof BriefAdvanced;
  label: string;
}> = [
  { key: "audience", label: "Audience" },
  { key: "keyMessage", label: "Key message" },
  { key: "tone", label: "Tone" },
  { key: "mustSay", label: "Must say" },
  { key: "mustAvoid", label: "Must avoid" },
];

/** Parse a stored/submitted advanced-fields value; anything malformed is
 *  dropped field by field, and empty strings are omitted. */
export function normalizeBriefAdvanced(raw: unknown): BriefAdvanced {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = {};
    }
  }
  const r = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const out: BriefAdvanced = {};
  for (const { key } of BRIEF_ADVANCED_FIELDS) {
    const v = r[key];
    if (typeof v === "string" && v.trim() !== "") out[key] = v.trim();
  }
  return out;
}

/** What produced a VariantVersion row. "figure": an illustration was drawn,
 *  picked, or placed from the review page without touching the copy. */
export type VersionKind =
  | "generate"
  | "refine"
  | "edit"
  | "restore"
  | "duplicate"
  | "figure";

export function normalizeVersionKind(value: string): VersionKind {
  return value === "refine" ||
    value === "edit" ||
    value === "restore" ||
    value === "duplicate" ||
    value === "figure"
    ? value
    : "generate";
}

/** One surface as stored in a VariantVersion snapshot: an Override row
 *  minus its ids, JSON columns kept as the raw strings so a restore is a
 *  straight copy. */
export interface SurfaceSnapshot {
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
  /** Illustration state (all null for snapshots taken before illustrations
   *  existed). The figure's position is the marker inside `adapted`. */
  figureImageId: string | null;
  figureCaption: string | null;
  figureAlt: string | null;
  figureAlternatives: string | null;
  figureSource: string | null;
}

export interface GuardWarning {
  surfaceKey: string;
  warnings: string[];
}

/** JSON payload served by the app proxy and applied by the theme embed. */
export interface VariantPayload {
  v: string;
  locale: string;
  ops: Array<{
    selector: string;
    mode: "text" | "html";
    content: string;
  }>;
}

// ---------------------------------------------------------------------------
// Illustrations
// ---------------------------------------------------------------------------

/** Preferred shape of a drawing; maps onto the image model's sizes. */
export type IllustrationShape = "landscape" | "square" | "portrait";

export function normalizeIllustrationShape(value: unknown): IllustrationShape {
  return value === "square" || value === "portrait" ? value : "landscape";
}

/** Image-model quality tier (cost rises with each step). */
export type IllustrationQuality = "low" | "medium" | "high" | "xhigh";

export function normalizeIllustrationQuality(value: unknown): IllustrationQuality {
  return value === "low" || value === "medium" || value === "xhigh"
    ? value
    : "high";
}

/** What the creation forms remember per section from the last submission
 *  (mode and the template or library image, never the specific prompt). */
export interface FormChoiceMemory {
  mode: "none" | "auto" | "library" | "template";
  templateId?: string;
  imageId?: string;
}

export interface IllustrationSettings {
  quality: IllustrationQuality;
  /** Monthly spending cap in USD; null = no cap. Drawing pauses when the
   *  month's spend reaches it; copy still generates. */
  monthlyCapUsd: number | null;
  /** Shop-wide style text prepended to every drawing prompt. */
  houseStyle: string;
  lastFormChoice: {
    briefs: Record<string, FormChoiceMemory>;
    articles: Record<string, FormChoiceMemory>;
  };
}

export const DEFAULT_ILLUSTRATION_SETTINGS: IllustrationSettings = {
  quality: "high",
  monthlyCapUsd: null,
  houseStyle: "",
  lastFormChoice: { briefs: {}, articles: {} },
};

function normalizeFormChoices(raw: unknown): Record<string, FormChoiceMemory> {
  const out: Record<string, FormChoiceMemory> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const mode =
      v.mode === "auto" || v.mode === "library" || v.mode === "template"
        ? v.mode
        : "none";
    const memory: FormChoiceMemory = { mode };
    if (typeof v.templateId === "string" && v.templateId) {
      memory.templateId = v.templateId;
    }
    if (typeof v.imageId === "string" && v.imageId) memory.imageId = v.imageId;
    out[key] = memory;
  }
  return out;
}

/** Parse a stored/submitted illustration-settings value; anything malformed
 *  falls back field by field to the defaults. */
export function normalizeIllustrationSettings(raw: unknown): IllustrationSettings {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = {};
    }
  }
  const r = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const cap = Number(r.monthlyCapUsd);
  const choices = (
    typeof r.lastFormChoice === "object" && r.lastFormChoice !== null
      ? r.lastFormChoice
      : {}
  ) as Record<string, unknown>;
  return {
    quality: normalizeIllustrationQuality(r.quality),
    monthlyCapUsd: Number.isFinite(cap) && cap > 0 ? Math.round(cap * 100) / 100 : null,
    houseStyle: typeof r.houseStyle === "string" ? r.houseStyle.trim() : "",
    lastFormChoice: {
      briefs: normalizeFormChoices(choices.briefs),
      articles: normalizeFormChoices(choices.articles),
    },
  };
}

/** One recommendation: a template plus the specific prompt for the image. */
export interface FigureSuggestion {
  templateId: string;
  specificPrompt: string;
  rationale: string;
}

/** Illustration choice for one surface, made in a creation form. */
export type SurfaceIllustrationChoice =
  | { mode: "none" }
  | { mode: "auto" }
  | { mode: "library"; imageId: string }
  | { mode: "template"; draws: FigureSuggestion[] };

/** Per surface key, the choice made when the variant was created. */
export type IllustrationPlan = Record<string, SurfaceIllustrationChoice>;

/** Where the figure sits among the section's top-level blocks. */
export type FigureAnchor =
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "before" | "after"; index: number };

/** One surface's share of a figure job. "keep" re-places the existing
 *  figure in freshly generated copy (new caption, new position). */
export type SurfaceFigureJob =
  | { mode: "library"; imageId: string }
  | { mode: "draw"; draws: FigureSuggestion[] }
  | { mode: "auto" }
  | { mode: "keep" };

/** A background figure job: per surface what to draw or place. */
export interface FigureJob {
  surfaces: Record<string, SurfaceFigureJob>;
  /** Reset the review stamp when new model-drawn content lands. */
  resetReview?: boolean;
}

/** Stored on Override.figureAlternatives: the other drawn images and the
 *  recommendations that were not drawn. */
export interface FigureAlternatives {
  images: string[];
  suggestions: FigureSuggestion[];
}

function normalizeSuggestion(raw: unknown): FigureSuggestion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const templateId = typeof r.templateId === "string" ? r.templateId.trim() : "";
  const specificPrompt =
    typeof r.specificPrompt === "string" ? r.specificPrompt.trim() : "";
  if (!templateId || !specificPrompt) return null;
  return {
    templateId,
    specificPrompt,
    rationale: typeof r.rationale === "string" ? r.rationale.trim() : "",
  };
}

export function normalizeSuggestions(raw: unknown): FigureSuggestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeSuggestion)
    .filter((s): s is FigureSuggestion => s !== null)
    .slice(0, 5);
}

/** Parse a stored or submitted per-surface choice; malformed = none. */
export function normalizeSurfaceChoice(raw: unknown): SurfaceIllustrationChoice {
  if (typeof raw !== "object" || raw === null) return { mode: "none" };
  const r = raw as Record<string, unknown>;
  if (r.mode === "auto") return { mode: "auto" };
  if (r.mode === "library" && typeof r.imageId === "string" && r.imageId) {
    return { mode: "library", imageId: r.imageId };
  }
  if (r.mode === "template") {
    const draws = normalizeSuggestions(r.draws);
    if (draws.length > 0) return { mode: "template", draws };
  }
  return { mode: "none" };
}

export function parseIllustrationPlan(json: string | null | undefined): IllustrationPlan {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: IllustrationPlan = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const choice = normalizeSurfaceChoice(value);
      if (choice.mode !== "none") out[key] = choice;
    }
    return out;
  } catch {
    return {};
  }
}

export function parseFigureAlternatives(
  json: string | null | undefined,
): FigureAlternatives {
  if (!json) return { images: [], suggestions: [] };
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const images = Array.isArray(parsed.images)
      ? parsed.images.filter((i): i is string => typeof i === "string" && i !== "")
      : [];
    return { images, suggestions: normalizeSuggestions(parsed.suggestions) };
  } catch {
    return { images: [], suggestions: [] };
  }
}

function normalizeSurfaceFigureJob(raw: unknown): SurfaceFigureJob | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.mode === "auto") return { mode: "auto" };
  if (r.mode === "keep") return { mode: "keep" };
  if (r.mode === "library" && typeof r.imageId === "string" && r.imageId) {
    return { mode: "library", imageId: r.imageId };
  }
  if (r.mode === "draw") {
    const draws = normalizeSuggestions(r.draws);
    if (draws.length > 0) return { mode: "draw", draws };
  }
  return null;
}

export function parseFigureJob(json: string | null | undefined): FigureJob | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const surfacesRaw =
      typeof parsed.surfaces === "object" && parsed.surfaces !== null
        ? (parsed.surfaces as Record<string, unknown>)
        : {};
    const surfaces: Record<string, SurfaceFigureJob> = {};
    for (const [key, value] of Object.entries(surfacesRaw)) {
      const job = normalizeSurfaceFigureJob(value);
      if (job) surfaces[key] = job;
    }
    if (Object.keys(surfaces).length === 0) return null;
    return { surfaces, resetReview: parsed.resetReview === true };
  } catch {
    return null;
  }
}

export function parseSurfaceFigureJob(
  json: string | null | undefined,
): SurfaceFigureJob | null {
  if (!json) return null;
  try {
    return normalizeSurfaceFigureJob(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Prefix of the claim-guard entries that come from a figure's caption, alt
 *  text and drawing prompt (stored in Override.unverifiedClaims). */
export const FIGURE_CLAIM_PREFIX = "Illustration: ";
