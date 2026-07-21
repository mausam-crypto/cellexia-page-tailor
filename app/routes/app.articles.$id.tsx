import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useSubmit } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  List,
  Modal,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getSettings } from "../services/settings.server";
import { refreshFindings } from "../services/generate.server";
import type { ProofPoint } from "../services/types";
import {
  getPrimaryDomainUrl,
  getShopLocales,
} from "../services/shopify-data.server";
import {
  buildVariantUrl,
  generateForArticle,
  isGenerationInFlight,
  sanitizeAdaptedHtml,
} from "../services/variant.server";

function parseJsonStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseProofPoints(value: string | null): ProofPoint[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is { claim: unknown; quote: unknown; verified?: unknown } =>
          typeof p === "object" && p !== null,
      )
      .map((p) => ({
        claim: String(p.claim ?? ""),
        quote: String(p.quote ?? ""),
        verified: typeof p.verified === "boolean" ? p.verified : undefined,
      }))
      .filter((p) => p.claim !== "");
  } catch {
    return [];
  }
}

/**
 * Persist adapted_{id}/enabled_{id} fields from a form submission. HTML-mode
 * content is sanitized at write time and findings are recomputed against the
 * edited text — under the mode the stored copy was GENERATED in
 * (generatedMetaMode), not the live toggle, which only affects the next
 * generation. Post-publication model: edits to a live variant serve
 * immediately (no demotion).
 *
 * Returns { changed, findingsChanged } on success or { error } without
 * writing anything when an enabled surface would be left empty (serving an
 * empty override would blank a section of the live page).
 */
async function applyOverrideEdits(
  article: {
    id: string;
    sourceText: string | null;
    generatedMetaMode: boolean;
  },
  formData: FormData,
): Promise<{ changed: boolean; findingsChanged: boolean; error: string | null }> {
  const overrides = await prisma.override.findMany({
    where: { articleId: article.id },
  });
  const updates = [];
  let changed = false;
  let findingsChanged = false;
  for (const o of overrides) {
    const adaptedRaw = formData.get(`adapted_${o.id}`);
    const enabledRaw = formData.get(`enabled_${o.id}`);
    if (adaptedRaw === null && enabledRaw === null) continue;
    const data: {
      adapted?: string;
      enabled?: boolean;
      warnings?: string | null;
      articleClaims?: string | null;
    } = {};
    const willBeEnabled = enabledRaw !== null ? enabledRaw === "true" : o.enabled;
    if (enabledRaw !== null) {
      const enabled = enabledRaw === "true";
      if (enabled !== o.enabled) changed = true;
      data.enabled = enabled;
    }
    if (adaptedRaw !== null) {
      let adapted = String(adaptedRaw);
      if (o.mode === "html") adapted = sanitizeAdaptedHtml(adapted);
      const visibleText =
        o.mode === "html" ? adapted.replace(/<[^>]*>/g, "").trim() : adapted.trim();
      if (willBeEnabled && visibleText === "") {
        return {
          changed: false,
          findingsChanged: false,
          error: `"${o.label}" is empty. Untick "Include this surface" instead of clearing its text.`,
        };
      }
      if (adapted !== o.adapted) {
        changed = true;
        data.adapted = adapted;
        const findings = refreshFindings(
          {
            warnings: parseJsonStringArray(o.warnings),
            articleClaims: parseJsonStringArray(o.articleClaims),
          },
          o.original,
          adapted,
          {
            articleText: article.sourceText ?? undefined,
            metaMode: article.generatedMetaMode,
          },
        );
        data.warnings = findings.warnings.length
          ? JSON.stringify(findings.warnings)
          : null;
        data.articleClaims = findings.articleClaims.length
          ? JSON.stringify(findings.articleClaims)
          : null;
        if (
          data.warnings !== o.warnings ||
          data.articleClaims !== o.articleClaims
        ) {
          findingsChanged = true;
        }
      }
    }
    if (Object.keys(data).length > 0) {
      updates.push(prisma.override.update({ where: { id: o.id }, data }));
    }
  }
  if (updates.length > 0) {
    await prisma.$transaction(updates);
  }
  return { changed, findingsChanged, error: null };
}

/**
 * The review page's edits and "Mark as reviewed" sign-off refer to a specific
 * set of override rows. A regeneration replaces those rows; saving or
 * marking-reviewed against replaced rows would silently sign off copy the
 * reviewer never saw.
 */
async function overridesMatchForm(
  articleId: string,
  formData: FormData,
): Promise<boolean> {
  // Set equality (order-insensitive): the client and server list overrides
  // in different orders, and regeneration always mints entirely new ids, so
  // sorting both sides is sufficient and immune to ordering differences.
  const sent = String(formData.get("overrideIds") ?? "")
    .split(",")
    .filter(Boolean)
    .sort()
    .join(",");
  const current = (
    await prisma.override.findMany({
      where: { articleId },
      select: { id: true },
    })
  )
    .map((o) => o.id)
    .sort()
    .join(",");
  return sent === current;
}

const STALE_COPY_ERROR =
  "The adapted copy changed since you loaded this page (a regeneration finished in the background). Review the new copy, then try again.";
const GENERATING_ERROR =
  "A generation is running for this article. Wait for it to finish before making changes.";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const article = await prisma.article.findFirst({
    where: { id: params.id, shop },
    include: { overrides: { orderBy: { surfaceKey: "asc" } } },
  });
  if (!article) {
    throw new Response("Article not found", { status: 404 });
  }

  const settings = await getSettings(shop);

  // The page's core job (review + approve/unapprove, both local-DB actions)
  // must survive a flaky Admin API: degrade to locale codes and hide the
  // variant URL instead of replacing the whole page with an error boundary.
  let locales: Awaited<ReturnType<typeof getShopLocales>> = [];
  let primaryDomainUrl: string | null = null;
  try {
    [locales, primaryDomainUrl] = await Promise.all([
      getShopLocales(admin),
      getPrimaryDomainUrl(admin),
    ]);
  } catch {
    // Fall through with defaults; the UI shows a retry hint.
  }
  const primaryLocale = locales.find((l) => l.primary)?.locale ?? "en";
  const localeName =
    locales.find((l) => l.locale === article.locale)?.name ?? article.locale;

  const variantUrl = primaryDomainUrl
    ? buildVariantUrl({
        primaryDomainUrl,
        productHandle: article.productHandle,
        locale: article.locale,
        primaryLocale,
        paramName: settings.paramName,
        variantHandle: article.variantHandle,
      })
    : null;

  return {
    article: {
      id: article.id,
      productTitle: article.productTitle,
      locale: article.locale,
      localeName,
      status: article.status,
      errorMessage: article.errorMessage,
      sourceUrl: article.sourceUrl,
      sourceTitle: article.sourceTitle,
      detectedQuery: article.detectedQuery,
      metaMode: article.metaMode,
      wasApproved: article.wasApproved,
      reviewedAt: article.reviewedAt ? article.reviewedAt.toISOString() : null,
      generationInFlight: isGenerationInFlight(article),
      updatedAt: article.updatedAt.toISOString(),
    },
    servingEnabled: settings.servingEnabled,
    queryVariants: parseJsonStringArray(article.queryVariants),
    evidence: parseJsonStringArray(article.evidence),
    proofPoints: parseProofPoints(article.proofPoints),
    overrides: article.overrides.map((o) => ({
      id: o.id,
      surfaceKey: o.surfaceKey,
      label: o.label,
      mode: o.mode,
      original: o.original,
      adapted: o.adapted,
      notes: o.notes,
      enabled: o.enabled,
      warnings: parseJsonStringArray(o.warnings),
      articleClaims: parseJsonStringArray(o.articleClaims),
    })),
    variantUrl,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const article = await prisma.article.findFirst({
    where: { id: params.id, shop },
  });
  if (!article) {
    throw new Response("Article not found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "generate") {
    try {
      await generateForArticle(admin, shop, article.id);
      return { ok: true, intent, error: null };
    } catch (error) {
      // Status "error" + errorMessage are recorded on the row by the service
      // for real generation failures; lock rejections only need the message.
      console.error(`Generation failed for article ${article.id}`, error);
      return {
        ok: false,
        intent,
        error: error instanceof Error ? error.message : "Generation failed.",
      };
    }
  }

  if (intent === "save") {
    if (isGenerationInFlight(article)) {
      return { ok: false, intent, error: GENERATING_ERROR };
    }
    if (!(await overridesMatchForm(article.id, formData))) {
      return { ok: false, intent, error: STALE_COPY_ERROR };
    }
    // Post-publication model: edits to a live variant apply to the
    // storefront immediately (within the ~2 minute proxy cache).
    const result = await applyOverrideEdits(article, formData);
    if (result.error) {
      return { ok: false, intent, error: result.error };
    }
    return {
      ok: true,
      intent,
      live: article.status === "approved",
      findingsChanged: result.findingsChanged,
    };
  }

  if (intent === "toggleMeta") {
    // Only affects the next generation: the stored (possibly approved) copy
    // was produced under the previous mode and keeps serving unchanged.
    await prisma.article.update({
      where: { id: article.id },
      data: { metaMode: !article.metaMode },
    });
    return { ok: true, intent, metaMode: !article.metaMode };
  }

  // Post-publication review model: variants go live automatically after
  // generation; the merchant reviews them afterwards. "markReviewed" records
  // the review; "publish" puts a taken-offline variant back live; "unapprove"
  // (Take offline) stops serving it.
  if (intent === "markReviewed") {
    // This is the model's only human sign-off: it must refer to exactly the
    // copy the reviewer had on screen, so it carries the same guards as save.
    if (isGenerationInFlight(article)) {
      return { ok: false, intent, error: GENERATING_ERROR };
    }
    if (!(await overridesMatchForm(article.id, formData))) {
      return { ok: false, intent, error: STALE_COPY_ERROR };
    }
    const updated = await prisma.article.updateMany({
      where: { id: article.id, status: "approved" },
      data: { reviewedAt: new Date() },
    });
    if (updated.count === 0) {
      return { ok: false, intent, error: "Only live variants can be marked reviewed." };
    }
    return { ok: true, intent, error: null };
  }

  if (intent === "publish") {
    if (isGenerationInFlight(article)) {
      return { ok: false, intent, error: GENERATING_ERROR };
    }
    const enabledCount = await prisma.override.count({
      where: { articleId: article.id, enabled: true },
    });
    if (enabledCount === 0) {
      return {
        ok: false,
        intent,
        error: "Enable at least one surface before putting this variant live.",
      };
    }
    // Publishing is itself a review: the merchant is looking at the copy.
    const published = await prisma.article.updateMany({
      where: { id: article.id, status: "generated" },
      data: { status: "approved", wasApproved: true, reviewedAt: new Date() },
    });
    if (published.count === 0) {
      return { ok: false, intent, error: "Only offline variants can be put live." };
    }
    return { ok: true, intent, error: null };
  }

  if (intent === "unapprove") {
    // A take-offline during a regeneration would be silently reverted by the
    // generation's success write (which puts the article live) - block it
    // while the lock is held rather than losing the merchant's intent.
    if (isGenerationInFlight(article)) {
      return { ok: false, intent, error: GENERATING_ERROR };
    }
    const updated = await prisma.article.updateMany({
      where: { id: article.id, status: "approved" },
      data: { status: "generated" },
    });
    if (updated.count === 0) {
      return { ok: false, intent, error: "Only live variants can be taken offline." };
    }
    return { ok: true, intent, error: null };
  }

  if (intent === "delete") {
    await prisma.article.delete({ where: { id: article.id } });
    return redirect("/app");
  }

  return { ok: false, intent, error: "Unknown action." };
};

function statusBadge(status: string, reviewedAt: string | null) {
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
      return <Badge tone="critical">Failed</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

export default function ArticleReview() {
  const {
    article,
    servingEnabled,
    queryVariants,
    evidence,
    proofPoints,
    overrides,
    variantUrl,
  } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const generateFetcher = useFetcher<typeof action>();
  const saveFetcher = useFetcher<typeof action>();
  const reviewFetcher = useFetcher<typeof action>();
  const metaFetcher = useFetcher<typeof action>();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  // Generating either from this tab (fetcher in flight) or from anywhere
  // else (server-side lock reported by the loader).
  const isGenerating =
    generateFetcher.state !== "idle" || article.generationInFlight;
  const isReviewActing = reviewFetcher.state !== "idle";
  const overrideIds = overrides.map((o) => o.id).join(",");
  const isSaving = saveFetcher.state !== "idle";
  const reviewError =
    reviewFetcher.state === "idle" &&
    reviewFetcher.data &&
    !reviewFetcher.data.ok &&
    "error" in reviewFetcher.data
      ? reviewFetcher.data.error
      : null;

  const makeDrafts = useCallback(
    () =>
      Object.fromEntries(
        overrides.map((o) => [o.id, { adapted: o.adapted, enabled: o.enabled }]),
      ) as Record<string, { adapted: string; enabled: boolean }>,
    [overrides],
  );

  const [drafts, setDrafts] = useState(makeDrafts);

  // Reset local edits only when the generated copy itself changed. Override
  // rows are deleted and recreated on regeneration, so their ids are a stable
  // key for "same generation": metadata-only updates (meta-mode toggle,
  // status changes — which all bump updatedAt) must not wipe in-progress
  // edits.
  const overridesKey = overrides.map((o) => o.id).join(",");
  useEffect(() => {
    setDrafts(makeDrafts());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.id, overridesKey]);

  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data?.intent === "save") {
      if (!saveFetcher.data.ok && "error" in saveFetcher.data) {
        shopify.toast.show(String(saveFetcher.data.error), { isError: true });
        return;
      }
      const live =
        "live" in saveFetcher.data ? saveFetcher.data.live : false;
      const findingsChanged =
        "findingsChanged" in saveFetcher.data
          ? saveFetcher.data.findingsChanged
          : false;
      shopify.toast.show(
        live
          ? findingsChanged
            ? "Edits saved and live — they changed the flagged claims, review them below"
            : "Edits saved — live on the storefront within ~2 minutes"
          : "Edits saved",
      );
    }
  }, [saveFetcher.state, saveFetcher.data, shopify]);

  useEffect(() => {
    if (
      generateFetcher.state === "idle" &&
      generateFetcher.data?.intent === "generate" &&
      !generateFetcher.data.ok &&
      "error" in generateFetcher.data &&
      generateFetcher.data.error
    ) {
      shopify.toast.show(String(generateFetcher.data.error), { isError: true });
    }
  }, [generateFetcher.state, generateFetcher.data, shopify]);

  useEffect(() => {
    if (
      metaFetcher.state === "idle" &&
      metaFetcher.data?.intent === "toggleMeta" &&
      "metaMode" in metaFetcher.data
    ) {
      shopify.toast.show(
        metaFetcher.data.metaMode
          ? "Meta mode on — takes effect when you regenerate"
          : "Meta mode off — takes effect when you regenerate",
      );
    }
  }, [metaFetcher.state, metaFetcher.data, shopify]);

  const updateDraft = useCallback(
    (id: string, patch: Partial<{ adapted: string; enabled: boolean }>) => {
      setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    },
    [],
  );

  const handleGenerate = useCallback(() => {
    generateFetcher.submit({ intent: "generate" }, { method: "POST" });
  }, [generateFetcher]);

  const handleSave = useCallback(() => {
    // overrideIds lets the server reject a save against override rows that a
    // background regeneration has since replaced.
    const payload: Record<string, string> = { intent: "save", overrideIds };
    for (const o of overrides) {
      const draft = drafts[o.id] ?? { adapted: o.adapted, enabled: o.enabled };
      payload[`adapted_${o.id}`] = draft.adapted;
      payload[`enabled_${o.id}`] = String(draft.enabled);
    }
    saveFetcher.submit(payload, { method: "POST" });
  }, [overrides, overrideIds, drafts, saveFetcher]);

  const copyUrl = useCallback(async () => {
    if (!variantUrl) return;
    try {
      await navigator.clipboard.writeText(variantUrl);
      shopify.toast.show("Variant URL copied");
    } catch {
      shopify.toast.show("Could not copy the URL", { isError: true });
    }
  }, [variantUrl, shopify]);

  // Flagged findings drive the urgency of the review notification.
  const hasBlockingWarnings = overrides.some((o) => o.warnings.length > 0);
  const hasFlagged = overrides.some(
    (o) => o.warnings.length > 0 || o.articleClaims.length > 0,
  );

  const isLive = article.status === "approved";
  const needsReview = isLive && !article.reviewedAt;

  return (
    <Page
      backAction={{ url: "/app" }}
      title={`${article.productTitle} · ${article.locale}`}
      titleMetadata={
        <InlineStack gap="100">
          {statusBadge(article.status, article.reviewedAt)}
          {article.metaMode && <Badge tone="magic">Meta mode</Badge>}
        </InlineStack>
      }
      secondaryActions={[
        {
          content: article.metaMode ? "Meta mode: on" : "Meta mode: off",
          disabled: isGenerating || metaFetcher.state !== "idle",
          onAction: () =>
            metaFetcher.submit({ intent: "toggleMeta" }, { method: "POST" }),
        },
        {
          content: "Regenerate",
          disabled: isGenerating,
          onAction: handleGenerate,
        },
        {
          content: "Delete",
          destructive: true,
          onAction: () => setDeleteModalOpen(true),
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {isGenerating && (
              <Banner tone="info" title="Generating — this takes a minute or two.">
                The article is analyzed and the copy adapted in two model
                passes. Keep this page open.
              </Banner>
            )}
            {article.status === "error" && !isGenerating && (
              <Banner tone="critical" title="Generation failed">
                <BlockStack gap="200">
                  <Text as="p">{article.errorMessage ?? "Unknown error."}</Text>
                  <InlineStack>
                    <Button onClick={handleGenerate}>Retry generate</Button>
                  </InlineStack>
                </BlockStack>
              </Banner>
            )}
            {article.status === "approved" &&
              article.errorMessage &&
              !isGenerating && (
                <Banner tone="warning" title="Last regeneration failed">
                  {article.errorMessage} — the variant is still live and
                  serving the previously approved copy.
                </Banner>
              )}
            {reviewError && (
              <Banner tone="critical" title="Action failed">
                {String(reviewError)}
              </Banner>
            )}
            {article.status === "generated" && (
              <Banner tone="warning" title="Offline — not serving">
                <BlockStack gap="200">
                  <Text as="p">
                    This variant's URL currently shows the normal product page.
                    Put it back live, or regenerate to create fresh copy
                    (which also goes live automatically).
                  </Text>
                  <InlineStack>
                    <Button
                      variant="primary"
                      loading={isReviewActing}
                      disabled={isGenerating}
                      onClick={() =>
                        reviewFetcher.submit(
                          { intent: "publish" },
                          { method: "POST" },
                        )
                      }
                    >
                      Put live
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Banner>
            )}
            {needsReview && (
              <Banner
                tone={hasBlockingWarnings ? "warning" : "info"}
                title={
                  hasBlockingWarnings
                    ? "Live with flagged claims — review this variant now"
                    : "Live — awaiting your review"
                }
              >
                <BlockStack gap="200">
                  <Text as="p">
                    {hasBlockingWarnings
                      ? "This variant went live automatically after generation and some of its claims were flagged by the guard. Check the flagged items below; take the variant offline if anything is wrong."
                      : hasFlagged
                        ? "This variant went live automatically after generation. It includes article-sourced claims listed below - verify the article really supports them."
                        : "This variant went live automatically after generation. Skim the copy below and mark it reviewed."}
                  </Text>
                  <InlineStack gap="200">
                    <Button
                      variant="primary"
                      loading={isReviewActing}
                      disabled={isGenerating}
                      onClick={() =>
                        reviewFetcher.submit(
                          { intent: "markReviewed", overrideIds },
                          { method: "POST" },
                        )
                      }
                    >
                      Mark as reviewed
                    </Button>
                    <Button
                      loading={isReviewActing}
                      disabled={isGenerating}
                      onClick={() =>
                        reviewFetcher.submit(
                          { intent: "unapprove" },
                          { method: "POST" },
                        )
                      }
                    >
                      Take offline
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Banner>
            )}
            {isLive && (
              <Banner
                tone={servingEnabled ? "success" : "warning"}
                title={
                  servingEnabled
                    ? "This variant URL is live"
                    : "Live — but serving is OFF, so this URL currently shows the normal page"
                }
                action={
                  servingEnabled
                    ? undefined
                    : { content: "Turn on serving in Settings", url: "/app/settings" }
                }
              >
                <BlockStack gap="200">
                  {variantUrl ? (
                    <Box
                      padding="200"
                      background="bg-surface-secondary"
                      borderRadius="200"
                      overflowX="scroll"
                    >
                      <pre style={{ margin: 0 }}>
                        <code>{variantUrl}</code>
                      </pre>
                    </Box>
                  ) : (
                    <Text as="p" tone="subdued">
                      The variant URL is temporarily unavailable (Shopify API
                      hiccup) — reload the page to see it.
                    </Text>
                  )}
                  <InlineStack gap="200" blockAlign="center">
                    {variantUrl && <Button onClick={copyUrl}>Copy URL</Button>}
                    <Button
                      loading={isReviewActing}
                      disabled={isGenerating}
                      onClick={() =>
                        reviewFetcher.submit(
                          { intent: "unapprove" },
                          { method: "POST" },
                        )
                      }
                    >
                      Take offline
                    </Button>
                    {article.reviewedAt && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        Reviewed {new Date(article.reviewedAt).toLocaleString()}
                      </Text>
                    )}
                  </InlineStack>
                </BlockStack>
              </Banner>
            )}

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Source
                </Text>
                {article.sourceUrl ? (
                  <Link url={article.sourceUrl} target="_blank">
                    {article.sourceTitle ?? article.sourceUrl}
                  </Link>
                ) : (
                  <Text as="p" variant="bodyMd">
                    {article.sourceTitle
                      ? `${article.sourceTitle} (pasted content)`
                      : "(pasted content)"}
                  </Text>
                )}
                <Text as="p" tone="subdued" variant="bodySm">
                  Language: {article.localeName} ({article.locale})
                </Text>
              </BlockStack>
            </Card>

            {article.metaMode && article.status === "pending" && (
              <Banner tone="info" title="Meta mode article">
                Generation will rewrite the page deeply and pull the article's
                specific proof elements (study wins, rankings, statistics) into
                the copy. The variant goes live automatically - review the
                proof elements promptly once it does.
              </Banner>
            )}

            {article.detectedQuery && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Detected search intent
                  </Text>
                  <Text as="p" variant="headingMd">
                    {article.detectedQuery}
                  </Text>
                  {queryVariants.length > 0 && (
                    <InlineStack gap="150" wrap>
                      {queryVariants.map((variant) => (
                        <Badge key={variant}>{variant}</Badge>
                      ))}
                    </InlineStack>
                  )}
                  {evidence.length > 0 && (
                    <BlockStack gap="150">
                      <Text as="h3" variant="headingSm" tone="subdued">
                        Evidence from the article
                      </Text>
                      <List type="bullet">
                        {evidence.map((item, index) => (
                          <List.Item key={index}>{item}</List.Item>
                        ))}
                      </List>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            )}

            {proofPoints.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Proof elements from the article
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    These were woven into the adapted copy. Check each against
                    the article before marking the variant reviewed — the
                    quote is the article's supporting text.
                  </Text>
                  <BlockStack gap="200">
                    {proofPoints.map((point, index) => (
                      <BlockStack gap="050" key={index}>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          {point.claim}
                        </Text>
                        {point.quote && (
                          <Text as="p" tone="subdued" variant="bodySm">
                            “{point.quote}”
                          </Text>
                        )}
                        {point.verified === false && (
                          <Text as="p" tone="critical" variant="bodySm">
                            This quote was not found in the article text —
                            verify it in the article yourself; the variant is
                            already live, so take it offline if it does not
                            hold up.
                          </Text>
                        )}
                      </BlockStack>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            )}

            {overrides.length === 0 && article.status === "pending" && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Not generated yet
                  </Text>
                  <Text as="p" variant="bodyMd">
                    Generate the adapted copy for this article. The variant
                    goes live automatically once generated (while serving is
                    on), and you review it here afterwards.
                  </Text>
                  <InlineStack>
                    <Button
                      variant="primary"
                      onClick={handleGenerate}
                      loading={isGenerating}
                    >
                      Generate
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            {overrides.map((o) => {
              const draft = drafts[o.id] ?? {
                adapted: o.adapted,
                enabled: o.enabled,
              };
              return (
                <Card key={o.id}>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        {o.label}
                      </Text>
                      <Checkbox
                        label="Include this surface"
                        checked={draft.enabled}
                        onChange={(value) =>
                          updateDraft(o.id, { enabled: value })
                        }
                      />
                    </InlineStack>
                    {o.warnings.length > 0 && (
                      <Banner tone="warning" title="Flagged for review">
                        <List type="bullet">
                          {o.warnings.map((warning, index) => (
                            <List.Item key={index}>{warning}</List.Item>
                          ))}
                        </List>
                      </Banner>
                    )}
                    {o.articleClaims.length > 0 && (
                      <Banner
                        tone="info"
                        title="New claims grounded in the article"
                      >
                        <BlockStack gap="150">
                          <List type="bullet">
                            {o.articleClaims.map((claim, index) => (
                              <List.Item key={index}>{claim}</List.Item>
                            ))}
                          </List>
                          <Text as="p" variant="bodySm">
                            The original copy does not make these claims — the
                            article does. Verify the article really supports
                            each one; marking the variant reviewed covers them.
                          </Text>
                        </BlockStack>
                      </Banner>
                    )}
                    <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                      <BlockStack gap="150">
                        <Text as="h3" variant="headingSm" tone="subdued">
                          Original
                        </Text>
                        <div
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                            maxHeight: "20rem",
                            overflowY: "auto",
                            padding: "0.75rem",
                            borderRadius: "0.5rem",
                            background: "var(--p-color-bg-surface-secondary)",
                            fontSize: "0.8125rem",
                          }}
                        >
                          {o.original}
                        </div>
                      </BlockStack>
                      <TextField
                        label="Adapted"
                        value={draft.adapted}
                        onChange={(value) =>
                          updateDraft(o.id, { adapted: value })
                        }
                        multiline={12}
                        autoComplete="off"
                      />
                    </InlineGrid>
                    {o.notes && (
                      <Text as="p" tone="subdued" variant="bodySm">
                        Model notes: {o.notes}
                      </Text>
                    )}
                  </BlockStack>
                </Card>
              );
            })}

            {overrides.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  {isLive && (
                    <Text as="p" variant="bodySm" tone="subdued" alignment="end">
                      This variant is live: saved edits reach the storefront
                      within about 2 minutes.
                    </Text>
                  )}
                  <InlineStack gap="300" align="end">
                    <Button
                      onClick={handleSave}
                      loading={isSaving}
                      disabled={isGenerating}
                      variant={isLive ? undefined : "primary"}
                    >
                      Save edits
                    </Button>
                    {needsReview && (
                      <Button
                        variant="primary"
                        loading={isReviewActing}
                        disabled={isGenerating}
                        onClick={() =>
                          reviewFetcher.submit(
                            { intent: "markReviewed", overrideIds },
                            { method: "POST" },
                          )
                        }
                      >
                        Mark as reviewed
                      </Button>
                    )}
                  </InlineStack>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete this article?"
        primaryAction={{
          content: "Delete article",
          destructive: true,
          onAction: () => {
            setDeleteModalOpen(false);
            submit({ intent: "delete" }, { method: "POST" });
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setDeleteModalOpen(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              The generated copy and any edits cannot be recovered.
            </Text>
            {article.status === "approved" && (
              <Text as="p" tone="critical">
                This variant is live: any ads or articles linking to its URL
                will show the normal product page within about 2 minutes.
              </Text>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
