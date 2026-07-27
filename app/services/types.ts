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
  | "meta"
  | "ultra"
  | "persona"
  | "max"
  | "v2";

export function normalizeAdaptationMode(value: string): AdaptationMode {
  return value === "meta" ||
    value === "ultra" ||
    value === "persona" ||
    value === "max" ||
    value === "v2"
    ? value
    : "standard";
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
}

export interface ShopSettingsData {
  paramName: string;
  /** Shop-wide default adaptation depth (per-surface depth overrides it). */
  intensity: AdaptationDepth;
  surfaces: CopySurface[];
  /** Master switch. False on install: nothing is ever served until the
   *  merchant explicitly turns serving on. */
  servingEnabled: boolean;
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
  adapted: Array<{
    key: string;
    adapted: string;
    notes: string;
  }>;
}

/** Outcome of the claim/heuristic review for one surface. */
export interface ClaimFindings {
  /** Claims supported by neither the original copy nor the article, plus
   *  risky patterns — block approval until the reviewer attests. */
  warnings: string[];
  /** New claims the original copy doesn't make but the article supports —
   *  shown for review and covered by the same attestation. */
  articleClaims: string[];
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
