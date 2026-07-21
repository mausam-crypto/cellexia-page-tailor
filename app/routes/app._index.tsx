import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Layout,
  Page,
  Spinner,
  Tabs,
  Text,
  TextField,
  Tooltip,
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
  generateForArticle,
} from "../services/variant.server";
import {
  computeExperimentReport,
  refreshExperimentStatus,
} from "../services/experiment.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

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
      productTitle: article.productTitle,
      locale: article.locale,
      localeName: localeNames.get(article.locale) ?? article.locale,
      sourceTitle: article.sourceTitle,
      sourceUrl: article.sourceUrl,
      detectedQuery: article.detectedQuery,
      status: article.status,
      metaMode: article.metaMode,
      reviewedAt: article.reviewedAt ? article.reviewedAt.toISOString() : null,
      errorMessage: article.errorMessage,
      overrideCount: article.overrides.length,
      hasWarnings: article.overrides.some((o) => o.warnings || o.articleClaims),
      variantUrl:
        article.status === "approved" && primaryDomainUrl
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
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const articleId = String(formData.get("articleId") ?? "");

  if (intent === "generate" && articleId) {
    try {
      await generateForArticle(admin, session.shop, articleId);
      return { ok: true, articleId, error: null };
    } catch (error) {
      // Real failures record status "error" + errorMessage on the row; lock
      // rejections do not touch the row, so surface the message here. ok
      // stays true so a client-side "generate all" chain keeps going.
      console.error(`Generation failed for article ${articleId}`, error);
      return {
        ok: true,
        articleId,
        error: error instanceof Error ? error.message : "Generation failed.",
      };
    }
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

  // Sequential "generate all" chain: one article at a time, because each
  // generation takes ~1-2 minutes (two Claude calls).
  const [queue, setQueue] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [totalQueued, setTotalQueued] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [selectedTab, setSelectedTab] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

  // The queue lives in this page's state: closing or leaving the page
  // abandons the not-yet-started articles. Warn before that happens.
  useEffect(() => {
    if (!activeId) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [activeId]);

  const startGeneration = useCallback(
    (ids: string[]) => {
      if (ids.length === 0 || activeId) return;
      setTotalQueued(ids.length);
      setDoneCount(0);
      setQueue(ids.slice(1));
      setActiveId(ids[0]);
      generateFetcher.submit(
        { intent: "generate", articleId: ids[0] },
        { method: "POST" },
      );
    },
    [activeId, generateFetcher],
  );

  useEffect(() => {
    if (generateFetcher.state !== "idle") return;
    const data = generateFetcher.data;
    // Only advance when the response we hold is for the article in flight.
    if (!data || !activeId || data.articleId !== activeId) return;
    if ("error" in data && data.error) {
      shopify.toast.show(String(data.error), { isError: true });
    }
    setDoneCount((count) => count + 1);
    if (queue.length > 0) {
      const [next, ...rest] = queue;
      setQueue(rest);
      setActiveId(next);
      generateFetcher.submit(
        { intent: "generate", articleId: next },
        { method: "POST" },
      );
    } else {
      setActiveId(null);
      if (totalQueued > 1) {
        shopify.toast.show(
          "Generation finished — new variants are live and awaiting your review.",
        );
      }
      setTotalQueued(0);
    }
  }, [generateFetcher, generateFetcher.state, generateFetcher.data, activeId, queue, totalQueued, shopify]);

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

  const pendingIds = articles
    .filter((a) => a.status === "pending")
    .map((a) => a.id);
  const isGenerating = activeId !== null;
  const showProgress = isGenerating && totalQueued > 1;

  const setupSteps = [
    setup.embedActive,
    setup.surfacesConfigured,
    setup.hasArticles,
    setup.hasReviewedAll,
    setup.servingEnabled,
  ];
  const setupDone = setupSteps.every(Boolean);
  const setupDoneCount = setupSteps.filter(Boolean).length;

  const query = searchQuery.trim().toLowerCase();
  const visibleArticles = articles.filter((article) => {
    if (!STATUS_TABS[selectedTab].match(article)) return false;
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
    <IndexTable.Row id={article.id} key={article.id} position={index}>
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
          {statusBadge(article.status, article.reviewedAt, article.errorMessage)}
          {article.metaMode ? <Badge tone="magic">Meta</Badge> : null}
          {article.hasWarnings &&
          article.status === "approved" &&
          !article.reviewedAt ? (
            <Badge tone="warning">Review claims</Badge>
          ) : null}
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          {activeId === article.id ? (
            <Spinner size="small" accessibilityLabel="Generating" />
          ) : null}
          {(article.status === "pending" || article.status === "error") && (
            <Button
              size="slim"
              disabled={isGenerating}
              onClick={() => startGeneration([article.id])}
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
        pendingIds.length > 1
          ? [
              {
                content: "Generate all pending",
                disabled: isGenerating,
                onAction: () => startGeneration(pendingIds),
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

            {showProgress && (
              <InlineStack gap="200" blockAlign="center">
                <Spinner size="small" accessibilityLabel="Generating variants" />
                <Text as="span" variant="bodyMd">
                  Generating {Math.min(doneCount + 1, totalQueued)} of{" "}
                  {totalQueued}… Each article takes a minute or two — keep this
                  page open, leaving pauses the remaining articles.
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
                  </div>
                  <IndexTable
                    resourceName={{ singular: "article", plural: "articles" }}
                    itemCount={visibleArticles.length}
                    selectable={false}
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
