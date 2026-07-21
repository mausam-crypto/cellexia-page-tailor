import prisma from "../db.server";
import type { CopySurface, ShopSettingsData } from "./types";

export { unsafeSelectorReason } from "./selector-rules";

// Sensible default: adapt only the native product description, mapped to the
// Dawn-family selector. Merchants add Accentuate surfaces in Settings.
export const DEFAULT_SURFACES: CopySurface[] = [
  {
    key: "description",
    label: "Product description",
    source: "description",
    selector: ".product__description",
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
