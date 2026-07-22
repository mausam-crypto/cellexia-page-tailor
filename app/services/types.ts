// A "copy surface" is one piece of product-page copy the app is allowed to
// adapt: the native product description, a metafield (e.g. an Accentuate
// Custom Fields field), or a live page region ("page") whose original copy
// is read directly from the rendered storefront page - used for theme tab
// panels (Overview/Benefits/Science) where heading and body live in one
// container and must be adapted together.
export type SurfaceSource = "description" | "metafield" | "page";

export type AdaptationDepth = "light" | "medium" | "deep";

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
