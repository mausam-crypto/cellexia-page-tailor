import prisma from "../db.server";
import type { CopySurface, ShopSettingsData } from "./types";
import {
  DEFAULT_ILLUSTRATION_SETTINGS,
  DEFAULT_SUBTLE_SETTINGS,
  TITLE_SURFACE_KEY,
  normalizeIllustrationSettings,
  normalizeSubtleSettings,
} from "./types";

export { unsafeSelectorReason } from "./selector-rules";

// Defaults are tuned to the Cellexia theme (persona-* hooks). The
// description falls back to the Dawn-family class as a second selector
// would not be expressible, so merchants on other themes adjust in Settings.
export const DEFAULT_SURFACES: CopySurface[] = [
  {
    key: "description",
    label: "Product description",
    source: "description",
    selector: "#persona-description",
    mode: "html",
    enabled: true,
  },
];

// Live page regions: whole theme tab panels (heading + body in one
// container). Original copy is read from the rendered storefront page at
// generation time, so the full container can be swapped without any theme
// change. Pre-filled for the Cellexia theme.
export const PAGE_SURFACES: CopySurface[] = [
  {
    key: "page:tagline",
    label: "Tagline under product name (live page region)",
    source: "page",
    selector: "#persona-tagline",
    mode: "html",
    enabled: true,
  },
  {
    key: "page:overview",
    label: "Overview tab (live page region)",
    source: "page",
    selector: ".persona-overview-target",
    mode: "html",
    enabled: true,
  },
  {
    key: "page:benefits",
    label: "Benefits tab (live page region)",
    source: "page",
    selector: ".persona-benefits-target",
    mode: "html",
    enabled: true,
  },
  {
    key: "page:science",
    label: "Science tab (live page region)",
    source: "page",
    selector: ".persona-science-target",
    mode: "html",
    enabled: true,
  },
  {
    key: "page:faqs",
    label: "FAQs tab (live page region)",
    source: "page",
    selector: '.tab[data-id="faqs"] .tab__inner',
    mode: "html",
    enabled: true,
  },
];

// The product name. Plain text from the Admin API product title (translated
// per locale), generated ONLY by Ingredient focus pages and served only when
// the merchant enables it here with a selector; the basket rename keys on
// the same gate. Disabled by default: renaming the product is a deliberate
// choice, and the selector depends on the theme.
export const TITLE_SURFACE: CopySurface = {
  key: TITLE_SURFACE_KEY,
  label: "Product name (title)",
  source: "title",
  selector: "",
  mode: "text",
  enabled: false,
};

export function surfaceKeyForMetafield(namespace: string, key: string): string {
  return `mf:${namespace}:${key}`;
}

export async function getSettings(shop: string): Promise<ShopSettingsData> {
  const row = await prisma.shopSettings.findUnique({ where: { shop } });
  if (!row) {
    return {
      paramName: "cx",
      intensity: "light",
      subtle: DEFAULT_SUBTLE_SETTINGS,
      surfaces: [...DEFAULT_SURFACES, TITLE_SURFACE],
      servingEnabled: false,
      illustrations: DEFAULT_ILLUSTRATION_SETTINGS,
      basketRenameEnabled: false,
      cartTransformId: null,
      basketRenameError: null,
    };
  }
  let subtleRaw: unknown = {};
  try {
    subtleRaw = JSON.parse(row.subtleSettings);
  } catch {
    subtleRaw = {};
  }
  let surfaces: CopySurface[] = [];
  try {
    surfaces = JSON.parse(row.surfaces);
  } catch {
    surfaces = [];
  }
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    surfaces = DEFAULT_SURFACES;
  }
  // Built-in live-page surfaces exist even for shops whose settings were
  // saved before the feature shipped: append any that are missing so they
  // show up in Settings and are picked up by generation and serving.
  const keys = new Set(surfaces.map((s) => s.key));
  for (const pageSurface of PAGE_SURFACES) {
    if (!keys.has(pageSurface.key)) surfaces = [...surfaces, pageSurface];
  }
  if (!keys.has(TITLE_SURFACE.key)) surfaces = [...surfaces, TITLE_SURFACE];
  return {
    paramName: row.paramName,
    intensity:
      row.intensity === "medium" || row.intensity === "deep"
        ? row.intensity
        : "light",
    subtle: normalizeSubtleSettings(subtleRaw),
    surfaces,
    servingEnabled: row.servingEnabled,
    illustrations: normalizeIllustrationSettings(row.illustrationSettings),
    basketRenameEnabled: row.basketRenameEnabled,
    cartTransformId: row.cartTransformId,
    basketRenameError: row.basketRenameError,
  };
}

export async function saveSettings(
  shop: string,
  data: Partial<ShopSettingsData>,
): Promise<void> {
  const current = await getSettings(shop);
  const merged: ShopSettingsData = {
    paramName: sanitizeParamName(data.paramName ?? current.paramName),
    intensity: data.intensity ?? current.intensity,
    subtle: data.subtle ? normalizeSubtleSettings(data.subtle) : current.subtle,
    surfaces: data.surfaces ?? current.surfaces,
    servingEnabled: data.servingEnabled ?? current.servingEnabled,
    illustrations: data.illustrations
      ? normalizeIllustrationSettings(data.illustrations)
      : current.illustrations,
    basketRenameEnabled: data.basketRenameEnabled ?? current.basketRenameEnabled,
    cartTransformId:
      data.cartTransformId !== undefined
        ? data.cartTransformId
        : current.cartTransformId,
    basketRenameError:
      data.basketRenameError !== undefined
        ? data.basketRenameError
        : current.basketRenameError,
  };
  const fields = {
    paramName: merged.paramName,
    intensity: merged.intensity,
    subtleSettings: JSON.stringify(merged.subtle),
    surfaces: JSON.stringify(merged.surfaces),
    servingEnabled: merged.servingEnabled,
    illustrationSettings: JSON.stringify(merged.illustrations),
    basketRenameEnabled: merged.basketRenameEnabled,
    cartTransformId: merged.cartTransformId,
    basketRenameError: merged.basketRenameError,
  };
  await prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, ...fields },
    update: fields,
  });
}

// The public URL parameter. Must never collide with Shopify's own `variant`
// param and stays short/opaque so URLs carry no keyword signal.
function sanitizeParamName(name: string): string {
  const cleaned = (name || "cx").toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!cleaned || cleaned === "variant") return "cx";
  return cleaned.slice(0, 12);
}
