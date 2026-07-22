import prisma from "../db.server";
import type { CopySurface, ShopSettingsData } from "./types";

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
];

export function surfaceKeyForMetafield(namespace: string, key: string): string {
  return `mf:${namespace}:${key}`;
}

export async function getSettings(shop: string): Promise<ShopSettingsData> {
  const row = await prisma.shopSettings.findUnique({ where: { shop } });
  if (!row) {
    return {
      paramName: "cx",
      intensity: "light",
      surfaces: DEFAULT_SURFACES,
      servingEnabled: false,
    };
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
  return {
    paramName: row.paramName,
    intensity:
      row.intensity === "medium" || row.intensity === "deep"
        ? row.intensity
        : "light",
    surfaces,
    servingEnabled: row.servingEnabled,
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
    surfaces: data.surfaces ?? current.surfaces,
    servingEnabled: data.servingEnabled ?? current.servingEnabled,
  };
  const fields = {
    paramName: merged.paramName,
    intensity: merged.intensity,
    surfaces: JSON.stringify(merged.surfaces),
    servingEnabled: merged.servingEnabled,
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
