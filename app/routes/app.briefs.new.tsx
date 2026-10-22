import { useCallback, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  ChoiceList,
  Collapsible,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getShopLocales,
  getShopLocalesCached,
} from "../services/shopify-data.server";
import { createBriefsForProduct } from "../services/variant.server";
import { enqueueGeneration } from "../services/generation-queue.server";
import { getSettings, saveSettings } from "../services/settings.server";
import {
  illustrationFormData,
  sanitizeIllustrationPlan,
} from "../services/illustrations.server";
import {
  imageModelConfigured,
  typicalCostUsd,
} from "../services/openai-images.server";
import {
  BRIEF_ADVANCED_FIELDS,
  illustrationsAllowed,
  normalizeBriefAdvanced,
  type BriefAdvanced,
  type FormChoiceMemory,
} from "../services/types";
import {
  IllustrationChoice,
  choiceToMemory,
  choiceToSubmission,
  emptyChoice,
  requestRecommendations,
  type ChoiceUpdater,
  type IllustrationChoiceDraft,
} from "../components/IllustrationChoice";

const MAX_NAME_CHARS = 120;
const MAX_BRIEF_CHARS = 20_000;
const MAX_REFERENCES_CHARS = 60_000;
const MAX_ADVANCED_CHARS = 2_000;
// Not a limit: above this many variants in one submit the form warns that
// the uncapped background queue will start them all at once.
const SOFT_VARIANT_CAP = 20;

type BriefInput = {
  name: string;
  text: string;
  references: string;
  advanced: BriefAdvanced;
  /** Raw illustration choices per surface; validated against the shop later. */
  illustrations: unknown;
};

/** Parse the submitted briefs defensively: the client sends JSON, but the
 *  server decides what counts. Returns an error message or the clean list. */
function normalizeBriefInput(raw: string): { briefs: BriefInput[]; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { briefs: [], error: "The briefs could not be read. Reload the page and try again." };
  }
  if (!Array.isArray(parsed)) {
    return { briefs: [], error: "The briefs could not be read. Reload the page and try again." };
  }
  const briefs: BriefInput[] = [];
  for (const [index, item] of parsed.entries()) {
    const r = (typeof item === "object" && item !== null ? item : {}) as Record<
      string,
      unknown
    >;
    const name = String(r.name ?? "").trim();
    const text = String(r.text ?? "").trim();
    const references = String(r.references ?? "").trim();
    const advanced = normalizeBriefAdvanced(r.advanced ?? r);
    // Blank cards (an "Add another brief" left empty) are skipped silently.
    if (!name && !text && !references && Object.keys(advanced).length === 0) {
      continue;
    }
    if (!name) return { briefs: [], error: `Brief ${index + 1} needs a name.` };
    if (!text) return { briefs: [], error: `"${name}" needs the brief text.` };
    if (name.length > MAX_NAME_CHARS) {
      return { briefs: [], error: `Keep the name of "${name.slice(0, 40)}…" under ${MAX_NAME_CHARS} characters.` };
    }
    if (text.length > MAX_BRIEF_CHARS) {
      return { briefs: [], error: `The brief "${name}" is too long (max ${MAX_BRIEF_CHARS.toLocaleString("en-US")} characters).` };
    }
    if (references.length > MAX_REFERENCES_CHARS) {
      return { briefs: [], error: `The references for "${name}" are too long (max ${MAX_REFERENCES_CHARS.toLocaleString("en-US")} characters).` };
    }
    for (const { key, label } of BRIEF_ADVANCED_FIELDS) {
      if ((advanced[key] ?? "").length > MAX_ADVANCED_CHARS) {
        return { briefs: [], error: `"${label}" for "${name}" is too long (max ${MAX_ADVANCED_CHARS.toLocaleString("en-US")} characters).` };
      }
    }
    briefs.push({ name, text, references, advanced, illustrations: r.illustrations });
  }
  if (briefs.length === 0) {
    return { briefs: [], error: "Add at least one brief with a name and text." };
  }
  return { briefs, error: null };
}

/** The brief as the recommender should read it (same shape the generation
 *  composes server-side, plus the pasted references). */
function composeBriefText(brief: {
  name: string;
  text: string;
  references: string;
  audience: string;
  keyMessage: string;
  tone: string;
  mustSay: string;
  mustAvoid: string;
}): string {
  const extras = [
    ["Audience", brief.audience],
    ["Key message", brief.keyMessage],
    ["Tone", brief.tone],
    ["Must say", brief.mustSay],
    ["Must avoid", brief.mustAvoid],
  ]
    .filter(([, v]) => v.trim())
    .map(([k, v]) => `${k}: ${v.trim()}`);
  return [
    brief.name.trim() ? `Campaign: ${brief.name.trim()}` : "",
    brief.text.trim(),
    ...extras,
    brief.references.trim() ? `References:\n${brief.references.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const { templates, images } = await illustrationFormData(session.shop);
  const illustration = {
    surfaces: settings.surfaces
      .filter((s) => s.enabled && s.selector.trim() !== "" && illustrationsAllowed(s))
      .map((s) => ({ key: s.key, label: s.label })),
    templates,
    images,
    lastChoice: settings.illustrations.lastFormChoice.briefs,
    openaiConfigured: imageModelConfigured(),
    costPerImage: typicalCostUsd(settings.illustrations.quality),
  };
  // Same degradation as "Add articles": a transient Admin API failure shows
  // a banner instead of an error boundary. Cached after the first load.
  try {
    const locales = (
      await getShopLocalesCached(admin, session.shop)
    ).filter((l) => l.published);
    return { locales, localesUnavailable: false, illustration };
  } catch {
    return { locales: [], localesUnavailable: true, illustration };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const productId = String(formData.get("productId") ?? "").trim();
  if (!productId) return { error: "Select a product first." };

  let requestedLocales: string[] = [];
  try {
    const parsed = JSON.parse(String(formData.get("locales") ?? "[]"));
    requestedLocales = Array.isArray(parsed)
      ? [...new Set(parsed.map((l) => String(l).trim()).filter(Boolean))]
      : [];
  } catch {
    requestedLocales = [];
  }
  if (requestedLocales.length === 0) return { error: "Tick at least one language." };

  const { briefs, error: briefError } = normalizeBriefInput(
    String(formData.get("briefs") ?? "[]"),
  );
  if (briefError) return { error: briefError };

  // Every locale must be a published shop locale, or the variant could never
  // match a storefront request. A transient API failure returns an error
  // (form state survives) instead of throwing the page away.
  try {
    const locales = await getShopLocales(admin);
    const unknown = requestedLocales.find(
      (locale) => !locales.some((l) => l.published && l.locale === locale),
    );
    if (unknown) return { error: `"${unknown}" is not a published shop language.` };
  } catch {
    return {
      error:
        "Could not verify your shop languages (Shopify API hiccup). Nothing was saved — try again.",
    };
  }

  // Illustration choices: validated against the shop's sections, images and
  // templates; a choice that no longer makes sense is simply dropped.
  const settings = await getSettings(session.shop);
  const allowedKeys = settings.surfaces
    .filter((s) => s.enabled && illustrationsAllowed(s))
    .map((s) => s.key);
  const briefsWithPlans = [];
  for (const brief of briefs) {
    const plan = await sanitizeIllustrationPlan(
      session.shop,
      brief.illustrations,
      allowedKeys,
    );
    briefsWithPlans.push({
      name: brief.name,
      text: brief.text,
      references: brief.references,
      advanced: brief.advanced,
      illustrationPlan: Object.keys(plan).length > 0 ? JSON.stringify(plan) : null,
    });
  }

  let createdIds: string[];
  try {
    createdIds = await createBriefsForProduct(admin, session.shop, {
      productId,
      locales: requestedLocales,
      briefs: briefsWithPlans,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Could not add briefs.",
    };
  }

  // Remember the choice (mode + template or image, never the prompt) as the
  // default for the next form. Best-effort.
  try {
    const memoryRaw = JSON.parse(String(formData.get("illustrationMemory") ?? "{}"));
    if (typeof memoryRaw === "object" && memoryRaw !== null) {
      await saveSettings(session.shop, {
        illustrations: {
          ...settings.illustrations,
          lastFormChoice: {
            ...settings.illustrations.lastFormChoice,
            briefs: memoryRaw as Record<string, FormChoiceMemory>,
          },
        },
      });
    }
  } catch {
    // ignore
  }

  // Briefs need no fetching step, so they go straight into the background
  // queue: the dashboard shows them as Queued and then live.
  await enqueueGeneration(session.shop, createdIds);
  return redirect("/app");
};

type BriefDraft = {
  key: string;
  name: string;
  text: string;
  references: string;
  advancedOpen: boolean;
  audience: string;
  keyMessage: string;
  tone: string;
  mustSay: string;
  mustAvoid: string;
  illustrations: Record<string, IllustrationChoiceDraft>;
};

let draftCounter = 0;
function newDraft(illustrations: Record<string, IllustrationChoiceDraft>): BriefDraft {
  draftCounter += 1;
  return {
    key: `brief-${draftCounter}`,
    name: "",
    text: "",
    references: "",
    advancedOpen: false,
    audience: "",
    keyMessage: "",
    tone: "",
    mustSay: "",
    mustAvoid: "",
    illustrations,
  };
}

export default function NewBriefs() {
  const { locales, localesUnavailable, illustration } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const defaultLocale =
    locales.find((l) => l.primary)?.locale ?? locales[0]?.locale ?? "en";

  const initialIllustrations = useMemo(
    () =>
      Object.fromEntries(
        illustration.surfaces.map((s) => [
          s.key,
          emptyChoice(illustration.lastChoice[s.key], illustration.templates, illustration.images),
        ]),
      ) as Record<string, IllustrationChoiceDraft>,
    [illustration],
  );

  const [product, setProduct] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [selectedLocales, setSelectedLocales] = useState<string[]>([
    defaultLocale,
  ]);
  const [briefs, setBriefs] = useState<BriefDraft[]>(() => [newDraft(initialIllustrations)]);
  const [clientError, setClientError] = useState<string | null>(null);

  const isSubmitting = navigation.state === "submitting";

  const pickProduct = useCallback(async () => {
    const selected = (await shopify.resourcePicker({
      type: "product",
      multiple: false,
    })) as unknown as Array<{ id: string; title: string }> | undefined;
    if (selected && selected.length > 0) {
      setProduct({ id: selected[0].id, title: selected[0].title });
      setClientError(null);
    }
  }, [shopify]);

  const updateBrief = useCallback(
    (key: string, patch: Partial<BriefDraft>) => {
      setBriefs((prev) =>
        prev.map((b) => (b.key === key ? { ...b, ...patch } : b)),
      );
    },
    [],
  );

  const updateIllustration = useCallback(
    (briefKey: string, surfaceKey: string, update: ChoiceUpdater) => {
      setBriefs((prev) =>
        prev.map((b) =>
          b.key === briefKey
            ? {
                ...b,
                illustrations: {
                  ...b.illustrations,
                  [surfaceKey]: update(
                    b.illustrations[surfaceKey] ??
                      emptyChoice(undefined, illustration.templates, illustration.images),
                  ),
                },
              }
            : b,
        ),
      );
    },
    [illustration.images, illustration.templates],
  );

  const addBrief = useCallback(() => {
    setBriefs((prev) => [...prev, newDraft(initialIllustrations)]);
  }, [initialIllustrations]);

  const removeBrief = useCallback((key: string) => {
    setBriefs((prev) => (prev.length > 1 ? prev.filter((b) => b.key !== key) : prev));
  }, []);

  const filledBriefs = briefs.filter((b) => b.name.trim() || b.text.trim());
  const variantCount = filledBriefs.length * selectedLocales.length;

  const handleSubmit = useCallback(() => {
    if (!product) {
      setClientError("Select a product first.");
      return;
    }
    if (selectedLocales.length === 0) {
      setClientError("Tick at least one language.");
      return;
    }
    const incomplete = briefs.find(
      (b) => (b.name.trim() || b.text.trim()) && !(b.name.trim() && b.text.trim()),
    );
    if (incomplete) {
      setClientError("Every brief needs both a name and the brief text.");
      return;
    }
    if (filledBriefs.length === 0) {
      setClientError("Add at least one brief.");
      return;
    }
    setClientError(null);
    const first = filledBriefs[0];
    submit(
      {
        productId: product.id,
        locales: JSON.stringify(selectedLocales),
        briefs: JSON.stringify(
          filledBriefs.map((b) => ({
            name: b.name,
            text: b.text,
            references: b.references,
            advanced: {
              audience: b.audience,
              keyMessage: b.keyMessage,
              tone: b.tone,
              mustSay: b.mustSay,
              mustAvoid: b.mustAvoid,
            },
            illustrations: Object.fromEntries(
              Object.entries(b.illustrations).map(([k, d]) => [k, choiceToSubmission(d)]),
            ),
          })),
        ),
        illustrationMemory: JSON.stringify(
          Object.fromEntries(
            Object.entries(first.illustrations).map(([k, d]) => [k, choiceToMemory(d)]),
          ),
        ),
      },
      { method: "POST" },
    );
  }, [product, selectedLocales, briefs, filledBriefs, submit]);

  const error = clientError ?? actionData?.error;

  return (
    <Page title="Add briefs" backAction={{ url: "/app" }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              Each brief becomes its own version of the product page, with its
              own link, in every language you tick. Generation starts right
              away in the background and the page goes live automatically
              (while serving is on) — you will be notified on the dashboard to
              review it, and you can refine it with further prompts from its
              review page.
            </Banner>
            {localesUnavailable && (
              <Banner tone="warning" title="Could not load your shop languages">
                Shopify's API did not respond — reload the page to try again.
              </Banner>
            )}
            {error && (
              <Banner tone="critical" title="Cannot add briefs">
                {error}
              </Banner>
            )}
            {variantCount > SOFT_VARIANT_CAP && (
              <Banner tone="warning" title={`${variantCount} pages will be generated at once`}>
                They all start in parallel. Very large bursts can hit the
                model's rate limits; anything that fails shows as "Failed" on
                the dashboard and can be retried with one click.
              </Banner>
            )}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Product
                  </Text>
                  <InlineStack gap="300" blockAlign="center">
                    <Button onClick={pickProduct}>
                      {product ? "Change product" : "Select product"}
                    </Button>
                    <Text
                      as="span"
                      variant="bodyMd"
                      tone={product ? undefined : "subdued"}
                    >
                      {product ? product.title : "No product selected"}
                    </Text>
                  </InlineStack>
                </BlockStack>
                <ChoiceList
                  allowMultiple
                  title="Languages"
                  choices={locales.map((l) => ({
                    label: `${l.name} (${l.locale})`,
                    value: l.locale,
                  }))}
                  selected={selectedLocales}
                  onChange={setSelectedLocales}
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  One page per brief and language. Each language's page is
                  written from that language's own base copy (Translate &amp;
                  Adapt for non-primary languages); the brief itself can be in
                  any language.
                </Text>
              </BlockStack>
            </Card>

            {briefs.map((brief, index) => (
              <Card key={brief.key}>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Brief {index + 1}
                    </Text>
                    {briefs.length > 1 && (
                      <Button
                        variant="plain"
                        tone="critical"
                        onClick={() => removeBrief(brief.key)}
                      >
                        Remove
                      </Button>
                    )}
                  </InlineStack>
                  <TextField
                    label="Name"
                    value={brief.name}
                    onChange={(value) => updateBrief(brief.key, { name: value })}
                    autoComplete="off"
                    placeholder="e.g. 500-dalton rule"
                    helpText="Shown on the dashboard and in the exported link list."
                    maxLength={MAX_NAME_CHARS}
                  />
                  <TextField
                    label="Brief"
                    value={brief.text}
                    onChange={(value) => updateBrief(brief.key, { text: value })}
                    multiline={8}
                    autoComplete="off"
                    placeholder={
                      "Centre the page on the 500-dalton rule: explain that molecules under 500 daltons can pass the skin barrier, and that this is why the formula reaches deep wrinkles rather than sitting on the surface. Lead the Science tab with it, add one FAQ about it, keep the rest of the page as it is."
                    }
                    helpText="Describe the angle and what should change. By default each section keeps its shape, length and voice and only the parts your angle needs are rewritten; say so explicitly when you want more (e.g. 'rewrite the Science section from scratch')."
                  />
                  <TextField
                    label="References (optional)"
                    value={brief.references}
                    onChange={(value) =>
                      updateBrief(brief.key, { references: value })
                    }
                    multiline={5}
                    autoComplete="off"
                    placeholder={
                      "Paste the ad copy, a study summary, or notes here.\nhttps://example.com/a-page-to-read"
                    }
                    helpText="Material the page may draw on: pasted text and/or one link per line (links are read when the page is generated). Pasting the ad itself lets the page echo the ad's wording."
                  />
                  <Button
                    variant="plain"
                    disclosure={brief.advancedOpen ? "up" : "down"}
                    onClick={() =>
                      updateBrief(brief.key, { advancedOpen: !brief.advancedOpen })
                    }
                    ariaExpanded={brief.advancedOpen}
                    ariaControls={`advanced-${brief.key}`}
                  >
                    Advanced
                  </Button>
                  <Collapsible
                    open={brief.advancedOpen}
                    id={`advanced-${brief.key}`}
                    transition={{ duration: "150ms", timingFunction: "ease-in-out" }}
                  >
                    <BlockStack gap="300">
                      <Divider />
                      <Text as="p" variant="bodySm" tone="subdued">
                        Optional. Anything you fill in here is added to the
                        brief above.
                      </Text>
                      <TextField
                        label="Audience"
                        value={brief.audience}
                        onChange={(value) => updateBrief(brief.key, { audience: value })}
                        autoComplete="off"
                        placeholder="e.g. women 45+ with deep forehead and frown lines"
                        maxLength={MAX_ADVANCED_CHARS}
                      />
                      <TextField
                        label="Key message"
                        value={brief.keyMessage}
                        onChange={(value) =>
                          updateBrief(brief.key, { keyMessage: value })
                        }
                        autoComplete="off"
                        placeholder="e.g. small enough to reach where wrinkles form"
                        maxLength={MAX_ADVANCED_CHARS}
                      />
                      <TextField
                        label="Tone"
                        value={brief.tone}
                        onChange={(value) => updateBrief(brief.key, { tone: value })}
                        autoComplete="off"
                        placeholder="e.g. calm and scientific, no hype"
                        maxLength={MAX_ADVANCED_CHARS}
                      />
                      <TextField
                        label="Must say"
                        value={brief.mustSay}
                        onChange={(value) => updateBrief(brief.key, { mustSay: value })}
                        multiline={2}
                        autoComplete="off"
                        placeholder="Phrases or facts that must appear"
                        maxLength={MAX_ADVANCED_CHARS}
                      />
                      <TextField
                        label="Must avoid"
                        value={brief.mustAvoid}
                        onChange={(value) =>
                          updateBrief(brief.key, { mustAvoid: value })
                        }
                        multiline={2}
                        autoComplete="off"
                        placeholder="Words, claims or comparisons to stay away from"
                        maxLength={MAX_ADVANCED_CHARS}
                      />
                    </BlockStack>
                  </Collapsible>
                  {illustration.surfaces.length > 0 && (
                    <BlockStack gap="300">
                      <Divider />
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingSm">
                          Illustrations
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Optional. Applies to every language of this brief
                          (a drawn figure is drawn once per language, with its
                          labels in that language). Everything can be changed
                          later on each page's review screen.
                        </Text>
                      </BlockStack>
                      {illustration.surfaces.map((s) => (
                        <IllustrationChoice
                          key={s.key}
                          surfaceKey={s.key}
                          surfaceLabel={s.label}
                          value={
                            brief.illustrations[s.key] ??
                            emptyChoice(undefined, illustration.templates, illustration.images)
                          }
                          onChange={(update) => updateIllustration(brief.key, s.key, update)}
                          templates={illustration.templates}
                          images={illustration.images}
                          locales={selectedLocales}
                          recommend={(surfaceKey) =>
                            requestRecommendations({
                              surfaceKey,
                              locale: selectedLocales[0] ?? defaultLocale,
                              sourceKind: "brief",
                              sourceText: composeBriefText(brief),
                              productTitle: product?.title ?? "",
                            })
                          }
                          openaiConfigured={illustration.openaiConfigured}
                          costPerImage={illustration.costPerImage}
                        />
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            ))}

            <InlineStack align="space-between" blockAlign="center">
              <Button onClick={addBrief}>Add another brief</Button>
              <InlineStack gap="300" blockAlign="center">
                <Text as="span" variant="bodySm" tone="subdued">
                  {variantCount === 0
                    ? "No pages yet"
                    : `${variantCount} page${variantCount === 1 ? "" : "s"} will be created`}
                </Text>
                <Button
                  variant="primary"
                  onClick={handleSubmit}
                  loading={isSubmitting}
                >
                  Add briefs and generate
                </Button>
              </InlineStack>
            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
