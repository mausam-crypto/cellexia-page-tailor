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
  Checkbox,
  InlineStack,
  Layout,
  List,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getSettings } from "../services/settings.server";
import { getShopLocales } from "../services/shopify-data.server";
import {
  ALLOWED_BASELINE_DAYS,
  createExperiment,
} from "../services/experiment.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const locales = (await getShopLocales(admin)).filter((l) => l.published);
  return { locales, allowedBaselineDays: [...ALLOWED_BASELINE_DAYS] };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const productId = String(formData.get("productId") ?? "").trim();
  const locale = String(formData.get("locale") ?? "").trim();
  const baselineDays = Number.parseInt(
    String(formData.get("baselineDays") ?? ""),
    10,
  );

  if (!productId) return { error: "Select a product first." };
  if (!locale) return { error: "Select a language." };
  if (
    !ALLOWED_BASELINE_DAYS.includes(
      baselineDays as (typeof ALLOWED_BASELINE_DAYS)[number],
    )
  ) {
    return {
      error: `Baseline length must be one of ${ALLOWED_BASELINE_DAYS.join(", ")} days.`,
    };
  }

  const locales = await getShopLocales(admin);
  if (!locales.some((l) => l.published && l.locale === locale)) {
    return { error: `"${locale}" is not a published shop language.` };
  }

  // Baseline-contamination guard: if variants for this product+language are
  // ALREADY serving, the "before" window isn't clean. Require an explicit
  // acknowledgement rather than silently producing a diluted comparison.
  const settings = await getSettings(session.shop);
  if (settings.servingEnabled) {
    const liveArticles = await prisma.article.count({
      where: { shop: session.shop, productId, locale, status: "approved" },
    });
    if (liveArticles > 0 && formData.get("ackContamination") !== "true") {
      return {
        error:
          "Variants for this product and language are already live, so the baseline period would include treated traffic. Unapprove them (or turn serving off) at least one full baseline period before starting — or tick the acknowledgement checkbox to proceed with a contaminated baseline.",
        needsAck: true,
      };
    }
  }

  try {
    const experiment = await createExperiment(admin, session.shop, {
      productId,
      locale,
      baselineDays,
    });
    return redirect(`/app/experiments/${experiment.id}`);
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Could not create the experiment.",
    };
  }
};

export default function NewExperiment() {
  const { locales, allowedBaselineDays } = useLoaderData<typeof loader>();
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
  const [baselineDays, setBaselineDays] = useState("14");
  const [ackContamination, setAckContamination] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  const isSubmitting = navigation.state !== "idle";

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
    setClientError(null);
    submit(
      {
        productId: product.id,
        locale,
        baselineDays,
        ackContamination: String(ackContamination),
      },
      { method: "POST" },
    );
  }, [product, locale, baselineDays, ackContamination, submit]);

  const error = clientError ?? actionData?.error;
  const needsAck =
    actionData && "needsAck" in actionData ? actionData.needsAck : false;

  return (
    <Page title="New experiment" backAction={{ url: "/app/experiments" }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              This is a before/after comparison, not an A/B test. Baseline = the
              last N full days (orders are pulled from Shopify; page views only
              exist for days the app embed was live). Treatment = the next N
              days. Only one version of the page is ever live for your market.
            </Banner>
            {error && (
              <Banner tone="critical" title="Cannot start experiment">
                {error}
              </Banner>
            )}
            {needsAck && (
              <Card>
                <Checkbox
                  label="I understand the baseline includes days when variants were already live, and accept the diluted comparison"
                  checked={ackContamination}
                  onChange={setAckContamination}
                />
              </Card>
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
                  helpText="The storefront language the experiment measures. Orders are attributed to a language via the customer's checkout locale."
                />
                <Select
                  label="Baseline length"
                  options={allowedBaselineDays.map((days) => ({
                    label:
                      days === 14
                        ? `${days} days (recommended)`
                        : `${days} days`,
                    value: String(days),
                  }))}
                  value={baselineDays}
                  onChange={setBaselineDays}
                  helpText="The treatment period is the same length as the baseline. Starting the experiment backfills baseline orders from Shopify and can take up to ~30 seconds."
                />
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Before you start the treatment period
                </Text>
                <List type="number">
                  <List.Item>
                    Approve the variants for this product and language.
                  </List.Item>
                  <List.Item>
                    Turn ON the serving switch in Settings.
                  </List.Item>
                  <List.Item>Update the article links.</List.Item>
                </List>
              </BlockStack>
            </Card>
            <InlineStack align="end">
              <Button
                variant="primary"
                onClick={handleSubmit}
                loading={isSubmitting}
              >
                Start experiment
              </Button>
            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
