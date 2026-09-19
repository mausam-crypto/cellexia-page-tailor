import { useCallback, useState } from "react";
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
  Divider,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getShopLocales,
  getShopLocalesCached,
} from "../services/shopify-data.server";
import { createArticlesForProduct } from "../services/variant.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  // A transient Admin API failure must degrade to an explanatory banner,
  // not replace the whole page with an error boundary. Cached: after the
  // first load this answers without a Shopify round trip (the action below
  // still validates against a fresh fetch).
  try {
    const locales = (
      await getShopLocalesCached(admin, session.shop)
    ).filter((l) => l.published);
    return { locales, localesUnavailable: false };
  } catch {
    return { locales: [], localesUnavailable: true };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const productId = String(formData.get("productId") ?? "").trim();
  const locale = String(formData.get("locale") ?? "").trim();
  const urlsRaw = String(formData.get("urls") ?? "");
  const pastedTitle = String(formData.get("pastedTitle") ?? "");
  const pastedText = String(formData.get("pastedText") ?? "");
  const mode = String(formData.get("mode") ?? "standard");

  if (!productId) return { error: "Select a product first." };
  if (!locale) return { error: "Select a language." };

  const urls = urlsRaw
    .split(/\r?\n/)
    .map((url) => url.trim())
    .filter(Boolean);
  const invalid = urls.find((url) => !url.startsWith("http"));
  if (invalid) {
    return { error: `This does not look like a URL: ${invalid}` };
  }
  if (urls.length === 0 && !pastedText.trim()) {
    return { error: "Add at least one article URL, or paste an article." };
  }

  // The locale must be one of the shop's published locales, or the variant
  // could never match a storefront request. A transient API failure returns
  // an error (form state survives) instead of throwing the page away along
  // with everything the merchant typed or pasted.
  try {
    const locales = await getShopLocales(admin);
    if (!locales.some((l) => l.published && l.locale === locale)) {
      return { error: `"${locale}" is not a published shop language.` };
    }
  } catch {
    return {
      error:
        "Could not verify your shop languages (Shopify API hiccup). Nothing was saved — try again.",
    };
  }

  try {
    await createArticlesForProduct(admin, session.shop, {
      productId,
      locale,
      urls,
      pastedTitle,
      pastedText,
      mode,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Could not add articles.",
    };
  }
  return redirect("/app");
};

export default function NewArticles() {
  const { locales, localesUnavailable } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const defaultLocale =
    locales.find((l) => l.primary)?.locale ?? locales[0]?.locale ?? "en";

  const [product, setProduct] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [locale, setLocale] = useState(defaultLocale);
  const [urls, setUrls] = useState("");
  const [pastedTitle, setPastedTitle] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [mode, setMode] = useState("standard");
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

  const handleSubmit = useCallback(() => {
    if (!product) {
      setClientError("Select a product first.");
      return;
    }
    if (!urls.trim() && !pastedText.trim()) {
      setClientError("Add at least one article URL, or paste an article.");
      return;
    }
    setClientError(null);
    // Hidden form: the picked product travels as plain fields.
    submit(
      {
        productId: product.id,
        productTitle: product.title,
        locale,
        urls,
        pastedTitle,
        pastedText,
        mode,
      },
      { method: "POST" },
    );
  }, [product, locale, urls, pastedTitle, pastedText, mode, submit]);

  const error = clientError ?? actionData?.error;

  return (
    <Page title="Add articles" backAction={{ url: "/app" }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              One variant URL is created per article. Variants go live
              automatically once generated (while serving is on) — you will be
              notified on the dashboard to review each one.
            </Banner>
            {localesUnavailable && (
              <Banner tone="warning" title="Could not load your shop languages">
                Shopify's API did not respond — reload the page to try again.
              </Banner>
            )}
            {error && (
              <Banner tone="critical" title="Cannot add articles">
                {error}
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
                <Select
                  label="Language"
                  options={locales.map((l) => ({
                    label: `${l.name} (${l.locale})`,
                    value: l.locale,
                  }))}
                  value={locale}
                  onChange={setLocale}
                  helpText="The storefront language this article links to. Base copy is read from your Translate & Adapt translations for non-primary languages."
                />
                <TextField
                  label="Article URLs (one per line)"
                  value={urls}
                  onChange={setUrls}
                  multiline={5}
                  autoComplete="off"
                  placeholder={"https://example.com/top-5-vitamin-c-serums\nhttps://example.com/best-retinol-alternatives"}
                  helpText="Each URL becomes its own article entry with its own variant URL."
                />
                <Select
                  label="Adaptation mode"
                  options={[
                    {
                      label: "Standard — re-emphasize within configured depths",
                      value: "standard",
                    },
                    {
                      label:
                        "Subtle intent — conservative + planted concern positioning",
                      value: "subtle",
                    },
                    {
                      label: "Meta mode — deep rewrite + the article's proof elements",
                      value: "meta",
                    },
                    {
                      label: "Ultra custom — deepest intent tailoring, no proof elements",
                      value: "ultra",
                    },
                    {
                      label: "Ultra deep persona — ranked audience desires drive placement",
                      value: "persona",
                    },
                    {
                      label: "Ultra Custom Conversion Max — desires + objections + criteria",
                      value: "max",
                    },
                    {
                      label: "Ultra Custom V2 — the page as the article's sequel",
                      value: "v2",
                    },
                  ]}
                  value={mode}
                  onChange={setMode}
                  helpText="Applies to every article in this batch (changeable per article later). Subtle intent stays as conservative as a light Standard pass but plants a few precise sentences that position the product for the reader's exact concern - naming it only when a brand would naturally say it unprompted (a night cream article yields night-cream copy; a collagen-alternatives article yields 'supports collagen production', never 'collagen alternative'); tune it in Settings. Meta mode pulls the article's study wins, rankings, and statistics into the copy — for Meta (Facebook/Instagram) funnels only. Ultra custom recenters the whole page on the article audience's intent and vocabulary (e.g. face creams for men, night creams), may drop claims irrelevant to that audience, and never pulls proof elements. Ultra deep persona goes further: it builds a ranked list of everything that audience wants to hear and places the top items in the tagline, description, and overview. Conversion Max runs three ranked lists (desires, objections, decision criteria), sequences the page for the reader's awareness stage, answers doubts where they arise, quietly excels on the article's evaluation criteria, and tailors the FAQ tab - all organic, no proof elements. Ultra Custom V2 treats the page as the article's sequel: it confirms every expectation the article set, leads with what the article did not already say, is strongest where the article found the alternatives lacking, answers the questions the article left open, and moderately tightens the page for nearly-sold readers."
                />
                <Divider />
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Or paste one article
                  </Text>
                  <TextField
                    label="Title"
                    value={pastedTitle}
                    onChange={setPastedTitle}
                    autoComplete="off"
                  />
                  <TextField
                    label="Content"
                    value={pastedText}
                    onChange={setPastedText}
                    multiline={8}
                    autoComplete="off"
                    helpText="Use this when the article is not publicly reachable yet."
                  />
                </BlockStack>
                <InlineStack align="end">
                  <Button
                    variant="primary"
                    onClick={handleSubmit}
                    loading={isSubmitting}
                  >
                    Add articles
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
