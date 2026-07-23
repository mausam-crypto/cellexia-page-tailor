import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Spinner,
  Tabs,
  Text,
  TextField,
  Tooltip,
  useIndexResourceState,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getSettings } from "../services/settings.server";
import {
  getPrimaryDomainUrl,
  getShopLocales,
} from "../services/shopify-data.server";
import {
  buildVariantUrl,
  isGenerationInFlight,
  isQueuedFresh,
} from "../services/variant.server";
import {
  enqueueGeneration,
  kickGenerationQueue,
} from "../services/generation-queue.server";
import {
  computeExperimentReport,
  refreshExperimentStatus,
} from "../services/experiment.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Restart recovery: if a previous process died with queued articles, this
  // nudges the background worker back to life. No-op when idle.
  kickGenerationQueue();

  const [articles, settings, runningExperiments, beaconRows] =
    await Promise.all([
      prisma.article.findMany({
        where: { shop },
        orderBy: { createdAt: "desc" },
        include: {
          overrides: { select: { warnings: true, articleClaims: true } },
        },
      }),
      getSettings(shop),
      prisma.experiment.findMany({ where: { shop, status: "running" } }),
      // Any beacon row proves the theme app embed is enabled and firing.
      prisma.dailyStat.count({ where: { shop } }),
    ]);

  // The dashboard's core job is listing articles from the local DB; a flaky
  // Admin API must degrade it (no locale names, no URLs), never break it.
  let locales: Awaited<ReturnType<typeof getShopLocales>> = [];
  let primaryDomainUrl: string | null = null;
  try {
    [locales, primaryDomainUrl] = await Promise.all([
      getShopLocales(admin),
      getPrimaryDomainUrl(admin),
    ]);
  } catch {
    // Fall through with defaults.
  }
  const primaryLocale = locales.find((l) => l.primary)?.locale ?? "en";
  const localeNames = new Map(locales.map((l) => [l.locale, l.name]));

  // Surface critical experiment alerts on the home page from ALREADY-SYNCED
  // local data only. Order syncing hits the Admin API with potentially many
  // paged calls and belongs on the Experiments pages, not on every home-page
  // load; computeExperimentReport suppresses alerts on stale data anyway.
  const criticalExperiments: Array<{
    id: string;
    productTitle: string;
    locale: string;
  }> = [];
  for (const row of runningExperiments) {
    // Any failure here must degrade to "no banner", never a broken home page.
    try {
      const experiment = await refreshExperimentStatus(row);
      if (experiment.status !== "running") continue;
      const report = await computeExperimentReport(shop, experiment, primaryLocale);
      if (report.alerts.some((a) => a.severity === "critical")) {
        criticalExperiments.push({
          id: experiment.id,
          productTitle: experiment.productTitle,
          locale: experiment.locale,
        });
      }
    } catch {
      // Skip this experiment; the Experiments pages surface sync problems.
    }
  }

  const surfacesConfigured = settings.surfaces.some(
    (s) => s.enabled && s.selector.trim() !== "",
  );
  const hasApproved = articles.some((a) => a.status === "approved");
  // The review notification: live variants nobody has looked at yet, split
  // by whether the claim guard flagged anything (drives urgency).
  const unreviewed = articles.filter(
    (a) => a.status === "approved" && !a.reviewedAt,
  );
  const unreviewedFlagged = unreviewed.filter((a) =>
    a.overrides.some((o) => o.warnings),
  ).length;

  return {
    criticalExperiments,
    servingEnabled: settings.servingEnabled,
    hasApproved,
    needsReviewCount: unreviewed.length,
    needsReviewFlaggedCount: unreviewedFlagged,
    setup: {
      embedActive: beaconRows > 0,
      surfacesConfigured,
      hasArticles: articles.length > 0,
      // "Review your live variants" is only done once a variant is live AND
      // nothing is awaiting review (auto-publish alone is not a review).
      hasReviewedAll: hasApproved && unreviewed.length === 0,
      servingEnabled: settings.servingEnabled,
      themeEditorUrl: `https://${shop}/admin/themes/current/editor?context=apps`,
    },
    articles: articles.map((article) => ({
      id: article.id,
      productId: article.productId,
      productTitle: article.productTitle,
      locale: article.locale,
      localeName: localeNames.get(article.locale) ?? article.locale,
      sourceTitle: article.sourceTitle,
      sourceUrl: article.sourceUrl,
      detectedQuery: article.detectedQuery,
      status: article.status,
      metaMode: article.metaMode,
      reviewedAt: article.reviewedAt ? article.reviewedAt.toISOString() : null,
      createdAt: article.createdAt.toISOString(),
      queued: isQueuedFresh(article),
      generating: isGenerationInFlight(article),
      errorMessage: article.errorMessage,
      overrideCount: article.overrides.length,
      hasWarnings: article.overrides.some((o) => o.warnings || o.articleClaims),
      // Every article has its unique URL from the moment it is created; the
      // export lists them all and marks which are currently live. The UI's
      // Copy URL button still only shows for live rows.
      variantUrl: primaryDomainUrl
        ? buildVariantUrl({
            primaryDomainUrl,
            productHandle: article.productHandle,
            locale: article.locale,
            primaryLocale,
            paramName: settings.paramName,
            variantHandle: article.variantHandle,
          })
        : null,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const articleId = String(formData.get("articleId") ?? "");

  // Generation is queued server-side and runs in the background: the
  // response returns immediately and the work continues even if the admin
  // closes the page. Several articles generate in parallel.
  if (intent === "generate" && articleId) {
    const { queued } = await enqueueGeneration(session.shop, [articleId]);
    return {
      ok: true,
      articleId,
      queued,
      error: queued === 0 ? "Already generating or queued." : null,
    };
  }

  if (intent === "generateAll") {
    const pending = await prisma.article.findMany({
      where: { shop: session.shop, status: { in: ["pending", "error"] } },
      select: { id: true },
    });
    const { queued } = await enqueueGeneration(
      session.shop,
      pending.map((a) => a.id),
    );
    return {
      ok: true,
      articleId: null,
      queued,
      error:
        queued === 0
          ? "Nothing to queue - these articles are already queued or generating."
          : null,
    };
  }

  if (intent === "delete" && articleId) {
    await prisma.article.deleteMany({
      where: { id: articleId, shop: session.shop },
    });
    return { ok: true, articleId };
  }

  return { ok: false, articleId };
};

function statusBadge(
  status: string,
  reviewedAt: string | null,
  errorMessage: string | null,
) {
  switch (status) {
    case "pending":
      return <Badge>Not generated</Badge>;
    case "generated":
      return <Badge tone="warning">Offline</Badge>;
    case "approved":
      return reviewedAt ? (
        <Badge tone="success">Live</Badge>
      ) : (
        <Badge tone="attention">Live — review needed</Badge>
      );
    case "error":
      return errorMessage ? (
        <Tooltip content={errorMessage}>
          <Badge tone="critical">Failed</Badge>
        </Tooltip>
      ) : (
        <Badge tone="critical">Failed</Badge>
      );
    default:
      return <Badge>{status}</Badge>;
  }
}

function SetupStep(props: {
  done: boolean;
  title: string;
  detail: string;
  action?: { content: string; onAction: () => void };
}) {
  return (
    <InlineStack gap="300" blockAlign="start" wrap={false}>
      <div style={{ flexShrink: 0, marginTop: "0.1rem" }}>
        {props.done ? (
          <Badge tone="success">Done</Badge>
        ) : (
          <Badge tone="attention">To do</Badge>
        )}
      </div>
      <BlockStack gap="050">
        <Text as="p" variant="bodyMd" fontWeight="semibold">
          {props.title}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {props.detail}
        </Text>
        {!props.done && props.action && (
          <div>
            <Button size="slim" onClick={props.action.onAction}>
              {props.action.content}
            </Button>
          </div>
        )}
      </BlockStack>
    </InlineStack>
  );
}

type ArticleRow = {
  id: string;
  productId: string;
  productTitle: string;
  locale: string;
  localeName: string;
  sourceTitle: string | null;
  sourceUrl: string | null;
  detectedQuery: string | null;
  status: string;
  metaMode: boolean;
  reviewedAt: string | null;
  createdAt: string;
  queued: boolean;
  generating: boolean;
  variantUrl: string | null;
};

/** Plain-text status for the spreadsheet (mirrors the badges). */
function statusTextFor(article: ArticleRow): string {
  if (article.generating) return "Generating";
  if (article.queued) return "Queued";
  switch (article.status) {
    case "approved":
      return article.reviewedAt ? "Live" : "Live - review needed";
    case "generated":
      return "Offline";
    case "pending":
      return "Not generated";
    case "error":
      return "Failed";
    default:
      return article.status;
  }
}

function csvEscape(value: string | null | undefined): string {
  const raw = value ?? "";
  // Neutralize spreadsheet formula injection (CWE-1236): titles and queries
  // come from scraped third-party pages, and Excel executes cells starting
  // with = + - @ as formulas. A leading apostrophe forces plain text.
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildLinksCsv(rows: ArticleRow[], servingEnabled: boolean): string {
  const header = [
    "Product",
    "Language",
    "Article",
    "Original article URL",
    "Variant page URL",
    "Currently live",
    "Meta mode",
    "Status",
    "Detected query",
    "Created",
  ];
  const lines = rows.map((a) =>
    [
      a.productTitle,
      a.localeName,
      a.sourceTitle ?? (a.sourceUrl ? "" : "Pasted article"),
      a.sourceUrl ?? "",
      a.variantUrl ?? "",
      a.status === "approved"
        ? servingEnabled
          ? "Yes"
          : "No (serving switched off)"
        : "No",
      a.metaMode ? "Yes" : "No",
      statusTextFor(a),
      a.detectedQuery ?? "",
      a.createdAt.slice(0, 10),
    ]
      .map(csvEscape)
      .join(","),
  );
  // UTF-8 BOM so Excel opens accented product names and non-Latin copy
  // correctly.
  return "\uFEFF" + [header.map(csvEscape).join(","), ...lines].join("\n");
}

function downloadCsv(csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `page-tailor-links-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const STATUS_TABS = [
  { id: "all", content: "All", match: () => true },
  {
    id: "review",
    content: "Needs review",
    match: (a: { status: string; reviewedAt: string | null }) =>
      a.status === "approved" && !a.reviewedAt,
  },
  {
    id: "live",
    content: "Live",
    match: (a: { status: string; reviewedAt: string | null }) =>
      a.status === "approved",
  },
  {
    id: "offline",
    content: "Offline",
    match: (a: { status: string; reviewedAt: string | null }) =>
      a.status === "generated",
  },
  {
    id: "pending",
    content: "Not generated",
    match: (a: { status: string; reviewedAt: string | null }) =>
      a.status === "pending",
  },
  {
    id: "error",
    content: "Failed",
    match: (a: { status: string; reviewedAt: string | null }) =>
      a.status === "error",
  },
] as const;

export default function Index() {
  const {
    articles,
    criticalExperiments,
    servingEnabled,
    hasApproved,
    needsReviewCount,
    needsReviewFlaggedCount,
    setup,
  } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const generateFetcher = useFetcher<typeof action>();

  const [selectedTab, setSelectedTab] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [productFilter, setProductFilter] = useState("all");
  const [localeFilter, setLocaleFilter] = useState("all");
  const [metaFilter, setMetaFilter] = useState("all");
  const revalidator = useRevalidator();

  const queuedCount = articles.filter((a) => a.queued).length;
  const generatingCount = articles.filter((a) => a.generating).length;
  const busyCount = queuedCount + generatingCount;

  // Generation runs in a server-side background queue; poll while anything
  // is queued or running so badges and the review notification stay fresh
  // without the merchant doing anything.
  useEffect(() => {
    if (busyCount === 0) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 7000);
    return () => clearInterval(timer);
  }, [busyCount, revalidator]);

  useEffect(() => {
    if (generateFetcher.state !== "idle" || !generateFetcher.data) return;
    const data = generateFetcher.data;
    if ("error" in data && data.error) {
      shopify.toast.show(String(data.error), { isError: true });
    } else if ("queued" in data && typeof data.queued === "number" && data.queued > 0) {
      shopify.toast.show(
        data.queued === 1
          ? "Generation started in the background — you can leave this page."
          : `${data.queued} generations started in the background — you can leave this page.`,
      );
    }
  }, [generateFetcher.state, generateFetcher.data, shopify]);

  const copyUrl = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        shopify.toast.show("Variant URL copied");
      } catch {
        shopify.toast.show("Could not copy the URL", { isError: true });
      }
    },
    [shopify],
  );

  const generatableCount = articles.filter(
    (a) => (a.status === "pending" || a.status === "error") && !a.queued && !a.generating,
  ).length;

  const setupSteps = [
    setup.embedActive,
    setup.surfacesConfigured,
    setup.hasArticles,
    setup.hasReviewedAll,
    setup.servingEnabled,
  ];
  const setupDone = setupSteps.every(Boolean);
  const setupDoneCount = setupSteps.filter(Boolean).length;

  // Filter options are derived from the articles that exist, so the
  // dropdowns never offer a choice that matches nothing.
  const productOptions = [
    { label: "All products", value: "all" },
    ...[...new Map(articles.map((a) => [a.productId, a.productTitle]))].map(
      ([value, label]) => ({ label, value }),
    ),
  ];
  const localeOptions = [
    { label: "All languages", value: "all" },
    ...[...new Map(articles.map((a) => [a.locale, a.localeName]))].map(
      ([value, label]) => ({ label: `${label} (${value})`, value }),
    ),
  ];
  const metaOptions = [
    { label: "Meta + standard", value: "all" },
    { label: "Meta mode only", value: "meta" },
    { label: "Standard only", value: "standard" },
  ];

  // All filters stack: status tab, product, language, meta mode, and search.
  const query = searchQuery.trim().toLowerCase();
  const visibleArticles = articles.filter((article) => {
    if (!STATUS_TABS[selectedTab].match(article)) return false;
    if (productFilter !== "all" && article.productId !== productFilter) return false;
    if (localeFilter !== "all" && article.locale !== localeFilter) return false;
    if (metaFilter === "meta" && !article.metaMode) return false;
    if (metaFilter === "standard" && article.metaMode) return false;
    if (!query) return true;
    return [
      article.productTitle,
      article.sourceTitle ?? "",
      article.sourceUrl ?? "",
      article.detectedQuery ?? "",
      article.localeName,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  const {
    selectedResources,
    allResourcesSelected,
    handleSelectionChange,
    clearSelection,
  } = useIndexResourceState(visibleArticles);

  // useIndexResourceState never prunes ids when rows are filtered away or
  // vanish on a polling revalidation, so derive the EFFECTIVE selection
  // (ticked AND currently visible) once and use it everywhere - counts,
  // header, and the export-all trigger - or the numbers drift apart and a
  // stale invisible selection could wedge the export button.
  const visibleIds = new Set(visibleArticles.map((a) => a.id));
  const selectedVisible = selectedResources.filter((id) => visibleIds.has(id));

  // Export honors the ticked rows when any are visible under the current
  // filters, otherwise the whole filtered list.
  const exportRows =
    selectedVisible.length > 0
      ? visibleArticles.filter((a) => selectedVisible.includes(a.id))
      : visibleArticles;
  const handleExport = () => {
    if (exportRows.length === 0) return;
    downloadCsv(buildLinksCsv(exportRows, servingEnabled));
    shopify.toast.show(
      `Exported ${exportRows.length} link${exportRows.length === 1 ? "" : "s"} to CSV`,
    );
    clearSelection();
  };
  const tabs = STATUS_TABS.map((tab) => {
    const count =
      tab.id === "all"
        ? articles.length
        : articles.filter((a) => tab.match(a)).length;
    return { id: tab.id, content: `${tab.content} (${count})` };
  });

  const emptyState = (
    <Card>
      <EmptyState
        heading="Tailor product pages to your articles"
        action={{ content: "Add articles", url: "/app/articles/new" }}
        image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
      >
        <p>
          Add article URLs for a product and language and generate an adapted
          version of the product page copy for each article. Variants go live
          automatically and you are notified to review them; copy each variant
          URL into its article. Your Shopify product is never modified.
        </p>
      </EmptyState>
    </Card>
  );

  const rows = visibleArticles.map((article, index) => (
    <IndexTable.Row
      id={article.id}
      key={article.id}
      position={index}
      selected={selectedResources.includes(article.id)}
    >
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {article.productTitle}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{article.localeName}</IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" truncate>
          {article.sourceTitle ?? article.sourceUrl ?? "Pasted"}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" truncate>
          {article.detectedQuery ?? "—"}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="100" blockAlign="center" wrap={false}>
          {article.generating ? (
            <Badge tone="info">Generating…</Badge>
          ) : article.queued ? (
            <Badge tone="info">Queued</Badge>
          ) : (
            statusBadge(article.status, article.reviewedAt, article.errorMessage)
          )}
          {article.metaMode ? <Badge tone="magic">Meta</Badge> : null}
          {article.hasWarnings &&
          article.status === "approved" &&
          !article.reviewedAt &&
          !article.generating &&
          !article.queued ? (
            <Badge tone="warning">Review claims</Badge>
          ) : null}
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          {article.generating ? (
            <Spinner size="small" accessibilityLabel="Generating" />
          ) : null}
          {(article.status === "pending" || article.status === "error") &&
            !article.queued &&
            !article.generating && (
              <Button
                size="slim"
                onClick={() =>
                  generateFetcher.submit(
                    { intent: "generate", articleId: article.id },
                    { method: "POST" },
                  )
                }
              >
                Generate
              </Button>
            )}
          <Button size="slim" url={`/app/articles/${article.id}`}>
            Review
          </Button>
          {article.status === "approved" && article.variantUrl && (
            <Button size="slim" onClick={() => copyUrl(article.variantUrl!)}>
              Copy URL
            </Button>
          )}
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="Page Tailor"
      primaryAction={{ content: "Add articles", url: "/app/articles/new" }}
      secondaryActions={
        generatableCount > 1
          ? [
              {
                content: `Generate all pending (${generatableCount})`,
                onAction: () =>
                  generateFetcher.submit(
                    { intent: "generateAll" },
                    { method: "POST" },
                  ),
              },
            ]
          : undefined
      }
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {criticalExperiments.map((experiment) => (
              <Banner
                key={experiment.id}
                tone="critical"
                title={`Experiment alert: significant drop detected for ${experiment.productTitle} (${experiment.locale})`}
                action={{
                  content: "Review experiment",
                  url: `/app/experiments/${experiment.id}`,
                }}
              />
            ))}

            {needsReviewCount > 0 && (
              <Banner
                tone={needsReviewFlaggedCount > 0 ? "warning" : "info"}
                title={
                  needsReviewFlaggedCount > 0
                    ? `${needsReviewCount} live variant${needsReviewCount === 1 ? "" : "s"} await${needsReviewCount === 1 ? "s" : ""} review — ${needsReviewFlaggedCount} with flagged claims`
                    : `${needsReviewCount} live variant${needsReviewCount === 1 ? " awaits" : "s await"} your review`
                }
              >
                These variants went live automatically after generation. Open
                each one, check the copy and any flagged claims, and mark it
                reviewed (or take it offline).
              </Banner>
            )}

            {hasApproved && !servingEnabled && (
              <Banner
                tone="warning"
                title="Serving is OFF — your live variant URLs currently show the normal product page"
                action={{ content: "Turn on in Settings", url: "/app/settings" }}
              >
                Nothing changes on your storefront until you switch on serving
                in Settings.
              </Banner>
            )}

            {!setupDone && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Set up Page Tailor
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {setupDoneCount} of 5 done
                    </Text>
                  </InlineStack>
                  <BlockStack gap="300">
                    <SetupStep
                      done={setup.embedActive}
                      title="1. Enable the Page Tailor app embed in your theme"
                      detail="Online Store → Themes → Customize → App embeds → turn on Page Tailor, then Save. This step is marked done automatically once the embed records its first storefront visit."
                      action={{
                        content: "Open theme editor",
                        onAction: () => window.open(setup.themeEditorUrl, "_top"),
                      }}
                    />
                    <SetupStep
                      done={setup.surfacesConfigured}
                      title="2. Configure which parts of the page can be adapted"
                      detail="In Settings, enable at least one copy surface and give it the CSS selector where it appears on your product page."
                      action={{
                        content: "Open Settings",
                        onAction: () => navigate("/app/settings"),
                      }}
                    />
                    <SetupStep
                      done={setup.hasArticles}
                      title="3. Add your article URLs and generate"
                      detail="Each article gets its own tailored version of the product page and its own link."
                      action={{
                        content: "Add articles",
                        onAction: () => navigate("/app/articles/new"),
                      }}
                    />
                    <SetupStep
                      done={setup.hasReviewedAll}
                      title="4. Review your live variants"
                      detail="Generated variants go live automatically (while serving is on) and appear here as “Live — review needed”. Open each one, check the copy and flagged claims, and mark it reviewed or take it offline."
                    />
                    <SetupStep
                      done={setup.servingEnabled}
                      title="5. Turn on serving"
                      detail="The master switch in Settings. Until it is on, every variant URL shows the normal page — flip it when you are ready to go live."
                      action={{
                        content: "Open Settings",
                        onAction: () => navigate("/app/settings"),
                      }}
                    />
                  </BlockStack>
                </BlockStack>
              </Card>
            )}

            {busyCount > 0 && (
              <InlineStack gap="200" blockAlign="center">
                <Spinner size="small" accessibilityLabel="Generating variants" />
                <Text as="span" variant="bodyMd">
                  {generatingCount > 0
                    ? `Generating ${generatingCount} article${generatingCount === 1 ? "" : "s"}${queuedCount > 0 ? `, ${queuedCount} queued` : ""}`
                    : `${queuedCount} article${queuedCount === 1 ? "" : "s"} queued`}
                  {" — runs in the background, you can leave this page. New"}
                  {" variants go live automatically and appear here for review."}
                </Text>
              </InlineStack>
            )}
            {articles.length === 0 ? (
              emptyState
            ) : (
              <Card padding="0">
                <Tabs
                  tabs={tabs}
                  selected={selectedTab}
                  onSelect={setSelectedTab}
                >
                  <div style={{ padding: "0.5rem 1rem" }}>
                    <BlockStack gap="200">
                      <InlineGrid columns={{ xs: 1, md: 4 }} gap="200">
                        <TextField
                          label="Search articles"
                          labelHidden
                          placeholder="Search by product, article, or query"
                          value={searchQuery}
                          onChange={setSearchQuery}
                          autoComplete="off"
                          clearButton
                          onClearButtonClick={() => setSearchQuery("")}
                        />
                        <Select
                          label="Product"
                          labelHidden
                          options={productOptions}
                          value={productFilter}
                          onChange={setProductFilter}
                        />
                        <Select
                          label="Language"
                          labelHidden
                          options={localeOptions}
                          value={localeFilter}
                          onChange={setLocaleFilter}
                        />
                        <Select
                          label="Meta mode"
                          labelHidden
                          options={metaOptions}
                          value={metaFilter}
                          onChange={setMetaFilter}
                        />
                      </InlineGrid>
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="span" variant="bodySm" tone="subdued">
                          {selectedVisible.length > 0
                            ? `${selectedVisible.length} selected for export`
                            : `${visibleArticles.length} link${visibleArticles.length === 1 ? "" : "s"} match the current filters`}
                        </Text>
                        <Button
                          size="slim"
                          disabled={exportRows.length === 0}
                          onClick={handleExport}
                        >
                          {selectedVisible.length > 0
                            ? `Export selected (${exportRows.length}) to CSV`
                            : `Export all filtered (${exportRows.length}) to CSV`}
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </div>
                  <IndexTable
                    resourceName={{ singular: "article", plural: "articles" }}
                    itemCount={visibleArticles.length}
                    selectable
                    selectedItemsCount={
                      allResourcesSelected ? "All" : selectedVisible.length
                    }
                    onSelectionChange={handleSelectionChange}
                    headings={[
                      { title: "Product" },
                      { title: "Language" },
                      { title: "Article" },
                      { title: "Detected query" },
                      { title: "Status" },
                      { title: "Actions" },
                    ]}
                  >
                    {rows}
                  </IndexTable>
                </Tabs>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
