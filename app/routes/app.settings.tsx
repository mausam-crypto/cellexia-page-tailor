import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { load as parseHtml } from "cheerio";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  DEFAULT_SURFACES,
  getSettings,
  saveSettings,
  surfaceKeyForMetafield,
} from "../services/settings.server";
import { unsafeSelectorReason } from "../services/selector-rules";
import { getProductMetafieldDefinitions } from "../services/shopify-data.server";
import type { CopySurface } from "../services/types";

const PARAM_NAME_RE = /^[a-z0-9_]{1,12}$/;

function paramNameError(value: string): string | null {
  if (!PARAM_NAME_RE.test(value)) {
    return "Lowercase letters, digits, and underscores only, up to 12 characters.";
  }
  if (value === "variant") {
    return '"variant" is reserved by Shopify - pick another name.';
  }
  return null;
}

/** Server-side selector syntax check (cheerio throws on invalid selectors). */
function selectorSyntaxError(selector: string): string | null {
  try {
    parseHtml("<div></div>")(selector);
    return null;
  } catch {
    return "This is not a valid CSS selector.";
  }
}

// Long-form / rich types default to HTML swapping; short scalars to text.
function defaultModeForType(type: string): "text" | "html" {
  return /multi_line|rich_text|html/i.test(type) ? "html" : "text";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [settings, approvedCount] = await Promise.all([
    getSettings(session.shop),
    prisma.article.count({
      where: { shop: session.shop, status: "approved" },
    }),
  ]);
  // Metafield definitions come from the Admin API; if it hiccups, still show
  // the page (description surface + previously saved metafield surfaces).
  let allDefinitions: Awaited<ReturnType<typeof getProductMetafieldDefinitions>> = [];
  let metafieldsUnavailable = false;
  try {
    allDefinitions = await getProductMetafieldDefinitions(admin);
  } catch {
    metafieldsUnavailable = true;
  }
  // Only plain-text metafield types can be adapted as copy. rich_text_field
  // and json store structured JSON, and list.* types store arrays — swapping
  // those as strings would corrupt them.
  const definitions = allDefinitions.filter((d) =>
    ["single_line_text_field", "multi_line_text_field", "string"].includes(
      d.type,
    ),
  );

  const existing = new Map(settings.surfaces.map((s) => [s.key, s]));

  // The built-in description surface always comes first; then one row per
  // product metafield definition (this is where Accentuate fields appear).
  const rows: CopySurface[] = [
    existing.get("description") ?? DEFAULT_SURFACES[0],
  ];
  for (const def of definitions) {
    const key = surfaceKeyForMetafield(def.namespace, def.key);
    rows.push(
      existing.get(key) ?? {
        key,
        label: def.name,
        source: "metafield",
        namespace: def.namespace,
        metafieldKey: def.key,
        selector: "",
        mode: defaultModeForType(def.type),
        enabled: false,
      },
    );
  }
  // Keep previously saved surfaces visible even when their metafield
  // definition can't be listed right now (API hiccup or deleted definition):
  // silently dropping them here would erase them on the next save.
  const covered = new Set(rows.map((r) => r.key));
  for (const s of settings.surfaces) {
    if (!covered.has(s.key)) rows.push(s);
  }

  return {
    paramName: settings.paramName,
    intensity: settings.intensity,
    servingEnabled: settings.servingEnabled,
    approvedCount,
    metafieldsUnavailable,
    rows,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const paramName = String(formData.get("paramName") ?? "cx");
  const intensityRaw = String(formData.get("intensity") ?? "light");
  const intensity =
    intensityRaw === "medium" || intensityRaw === "deep"
      ? (intensityRaw as "medium" | "deep")
      : ("light" as const);
  const servingEnabled = formData.get("servingEnabled") === "true";

  let parsed: unknown = [];
  try {
    parsed = JSON.parse(String(formData.get("surfaces") ?? "[]"));
  } catch {
    parsed = [];
  }
  const surfaces: CopySurface[] = (Array.isArray(parsed) ? parsed : [])
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        key: String(r.key ?? ""),
        label: String(r.label ?? "").trim(),
        source:
          r.source === "metafield"
            ? ("metafield" as const)
            : ("description" as const),
        namespace: r.namespace ? String(r.namespace) : undefined,
        metafieldKey: r.metafieldKey ? String(r.metafieldKey) : undefined,
        selector: String(r.selector ?? "").trim(),
        mode: r.mode === "text" ? ("text" as const) : ("html" as const),
        enabled: r.enabled === true || r.enabled === "true",
        depth:
          r.depth === "light" || r.depth === "medium" || r.depth === "deep"
            ? (r.depth as "light" | "medium" | "deep")
            : undefined,
      };
    })
    .filter((s) => s.key);

  // Validate the parameter name instead of silently rewriting it — a value
  // that differs from what the merchant typed would desync from the theme
  // embed setting and kill serving with no visible error.
  const paramError = paramNameError(paramName);
  if (paramError) {
    return {
      ok: false as const,
      error: `URL parameter name "${paramName}": ${paramError}`,
    };
  }

  for (const s of surfaces) {
    if (!s.enabled) continue;
    // An enabled surface without a selector generates copy that can never
    // serve — force an explicit decision instead of a silent no-op.
    if (!s.selector) {
      return {
        ok: false as const,
        error: `"${s.label || s.key}" is enabled but has no CSS selector. Add one or untick "Adapt this surface".`,
      };
    }
    const syntaxError = selectorSyntaxError(s.selector);
    if (syntaxError) {
      return {
        ok: false as const,
        error: `Selector "${s.selector}" (${s.label || s.key}): ${syntaxError}`,
      };
    }
    // Never allow a surface to target metadata, structured data, price, or
    // review elements — this backs the compliance guarantees in docs/.
    const reason = unsafeSelectorReason(s.selector);
    if (reason) {
      return {
        ok: false as const,
        error: `Selector "${s.selector}" (${s.label || s.key}) is not allowed: it ${reason}.`,
      };
    }
  }

  await saveSettings(session.shop, {
    paramName,
    intensity,
    surfaces,
    servingEnabled,
  });
  return { ok: true as const, savedAt: Date.now() };
};

/** Client-side mirror of the server checks so problems show on the field. */
function selectorFieldError(row: CopySurface): string | null {
  const sel = row.selector.trim();
  if (!sel) return row.enabled ? "Required when the surface is enabled" : null;
  const reason = unsafeSelectorReason(sel);
  if (reason) return `Not allowed: ${reason}`;
  if (typeof document !== "undefined") {
    try {
      document.querySelector(sel);
    } catch {
      return "Not a valid CSS selector";
    }
  }
  return null;
}

export default function Settings() {
  const loaderData = useLoaderData<typeof loader>();
  const { metafieldsUnavailable } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [paramName, setParamName] = useState(loaderData.paramName);
  const [intensity, setIntensity] = useState<string>(loaderData.intensity);
  const [servingEnabled, setServingEnabled] = useState(
    loaderData.servingEnabled,
  );
  const [rows, setRows] = useState<CopySurface[]>(loaderData.rows);

  const isSaving = navigation.state === "submitting";

  useEffect(() => {
    if (actionData?.ok) {
      shopify.toast.show("Settings saved");
    }
  }, [actionData, shopify]);

  const saveError = actionData && !actionData.ok ? actionData.error : null;

  const updateRow = useCallback(
    (key: string, patch: Partial<CopySurface>) => {
      setRows((prev) =>
        prev.map((row) => (row.key === key ? { ...row, ...patch } : row)),
      );
    },
    [],
  );

  const handleSave = useCallback(() => {
    submit(
      {
        paramName,
        intensity,
        servingEnabled: String(servingEnabled),
        surfaces: JSON.stringify(rows),
      },
      { method: "POST" },
    );
  }, [paramName, intensity, servingEnabled, rows, submit]);

  return (
    <Page
      title="Settings"
      backAction={{ url: "/app" }}
      primaryAction={{ content: "Save", onAction: handleSave, loading: isSaving }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              Only enabled surfaces with a CSS selector are adapted. Surfaces
              with no content for a given product are skipped automatically.
              Selectors targeting price, reviews, structured data, or metadata
              are rejected. Disabling a surface here also stops it on live
              variants immediately, and changing a surface's swap mode pauses
              it on live variants until you regenerate them.
            </Banner>
            {metafieldsUnavailable && (
              <Banner tone="warning" title="Could not load metafield definitions">
                Shopify's API did not respond, so new metafields are not
                listed. Your saved surfaces are unaffected — reload to retry.
              </Banner>
            )}
            {saveError && (
              <Banner tone="critical" title="Settings not saved">
                {saveError}
              </Banner>
            )}

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Serving
                  </Text>
                  {servingEnabled ? (
                    <Badge tone="success">On</Badge>
                  ) : (
                    <Badge tone="attention">Off</Badge>
                  )}
                </InlineStack>
                <Checkbox
                  label="Serve live variants on the storefront"
                  checked={servingEnabled}
                  onChange={setServingEnabled}
                  helpText="Off by default after install: nothing on your site changes until you turn this on. This is the master gate in front of the automatic go-live: generated variants only actually serve while it is on. Turning it off is the emergency stop — every variant URL renders the normal product page again within ~2 minutes for new visitors (up to ~4 minutes with client-side caches)."
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Variant URLs
                </Text>
                <TextField
                  label="URL parameter name"
                  value={paramName}
                  onChange={setParamName}
                  autoComplete="off"
                  error={paramNameError(paramName) ?? undefined}
                  helpText='URL parameter, e.g. ?cx=… Lowercase letters, digits and underscores only. Must EXACTLY match the "URL parameter name" in the Page Tailor app embed settings in your theme editor — if they differ, variants never appear.'
                />
                {paramName !== loaderData.paramName &&
                  loaderData.approvedCount > 0 && (
                    <Banner tone="warning" title="Changing the parameter breaks existing links">
                      {loaderData.approvedCount} approved article
                      {loaderData.approvedCount === 1 ? " has a" : "s have"}{" "}
                      variant URL{loaderData.approvedCount === 1 ? "" : "s"}{" "}
                      using “{loaderData.paramName}”. After saving, those
                      already-distributed links will show the normal page, and
                      you must update the theme embed setting to match and
                      re-copy every URL.
                    </Banner>
                  )}
                <Select
                  label="Default adaptation depth"
                  options={[
                    { label: "Light — subtle re-emphasis", value: "light" },
                    {
                      label: "Medium — rephrase and extend existing sentences",
                      value: "medium",
                    },
                    {
                      label:
                        "Deep — may add sentences targeted at the reader's concern",
                      value: "deep",
                    },
                  ]}
                  value={intensity}
                  onChange={setIntensity}
                  helpText="Light shifts emphasis only. Medium reworks more wording. Deep may also add sentences so the copy speaks to the reader's specific need. Every variant is claim-guarded at generation and flagged for your review after it goes live. Each surface below can override this default."
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Copy surfaces
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    A surface is one region of product page copy the app may
                    adapt: the native description, or a product metafield
                    (Accentuate Custom Fields appear here as metafields). To
                    find a selector: right-click the section on your product
                    page, choose Inspect, and copy a stable CSS class, e.g.
                    .product__description.
                  </Text>
                </BlockStack>

                {rows.map((row) => (
                  <Box
                    key={row.key}
                    borderColor="border"
                    borderWidth="025"
                    borderRadius="200"
                    padding="300"
                  >
                    <BlockStack gap="300">
                      <InlineStack
                        align="space-between"
                        blockAlign="center"
                        wrap
                      >
                        <BlockStack gap="050">
                          <Text as="h3" variant="headingSm">
                            {row.source === "description"
                              ? "Product description"
                              : row.label || row.metafieldKey}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {row.source === "description"
                              ? "Native product description (body_html)"
                              : `Metafield ${row.namespace}.${row.metafieldKey}`}
                          </Text>
                        </BlockStack>
                        <Checkbox
                          label="Adapt this surface"
                          checked={row.enabled}
                          onChange={(value) =>
                            updateRow(row.key, { enabled: value })
                          }
                        />
                      </InlineStack>
                      <InlineGrid columns={{ xs: 1, md: 4 }} gap="300">
                        <TextField
                          label="Label"
                          value={row.label}
                          onChange={(value) =>
                            updateRow(row.key, { label: value })
                          }
                          autoComplete="off"
                        />
                        <TextField
                          label="CSS selector"
                          value={row.selector}
                          onChange={(value) =>
                            updateRow(row.key, { selector: value })
                          }
                          autoComplete="off"
                          placeholder=".product__description"
                          error={selectorFieldError(row) ?? undefined}
                        />
                        <Select
                          label="Swap mode"
                          options={[
                            { label: "HTML", value: "html" },
                            { label: "Plain text", value: "text" },
                          ]}
                          value={row.mode}
                          onChange={(value) =>
                            updateRow(row.key, {
                              mode: value === "text" ? "text" : "html",
                            })
                          }
                        />
                        <Select
                          label="Adaptation depth"
                          options={[
                            { label: "Default", value: "default" },
                            { label: "Light", value: "light" },
                            { label: "Medium", value: "medium" },
                            { label: "Deep", value: "deep" },
                          ]}
                          value={row.depth ?? "default"}
                          onChange={(value) =>
                            updateRow(row.key, {
                              depth:
                                value === "light" ||
                                value === "medium" ||
                                value === "deep"
                                  ? value
                                  : undefined,
                            })
                          }
                        />
                      </InlineGrid>
                    </BlockStack>
                  </Box>
                ))}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
