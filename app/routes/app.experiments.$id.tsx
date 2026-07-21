import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getSettings } from "../services/settings.server";
import { getShopLocales } from "../services/shopify-data.server";
import {
  computeExperimentReport,
  EARLY_STOP,
  ensureExperimentOrdersFresh,
  refreshExperimentStatus,
  stopExperiment,
  syncExperimentOrders,
  type MetricComparison,
} from "../services/experiment.server";

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const row = await prisma.experiment.findFirst({
    where: { id: params.id, shop },
  });
  if (!row) {
    throw new Response("Experiment not found", { status: 404 });
  }

  let experiment = await refreshExperimentStatus(row);

  // Opportunistic order sync on view (all statuses — a just-completed or
  // just-stopped experiment still needs its final tail of orders synced).
  // Failures never take the report down.
  const sync = await ensureExperimentOrdersFresh(admin, shop, experiment);
  const syncError = sync.error;
  const syncTruncated = sync.truncated;
  // Re-read: the sync updates lastOrderSyncAt, which the report's staleness
  // gate depends on.
  experiment =
    (await prisma.experiment.findFirst({ where: { id: experiment.id, shop } })) ??
    experiment;

  const [locales, settings] = await Promise.all([
    getShopLocales(admin),
    getSettings(shop),
  ]);
  const primaryLocale = locales.find((l) => l.primary)?.locale ?? "en";
  const report = await computeExperimentReport(shop, experiment, primaryLocale);

  return {
    experiment: {
      id: experiment.id,
      productTitle: experiment.productTitle,
      locale: experiment.locale,
      localeName:
        locales.find((l) => l.locale === experiment.locale)?.name ??
        experiment.locale,
      status: experiment.status,
      baselineStart: dateKey(experiment.baselineStart),
      baselineEnd: dateKey(experiment.baselineEnd),
      treatmentStart: dateKey(experiment.treatmentStart),
      treatmentEnd: dateKey(experiment.treatmentEnd),
      stoppedAt: experiment.stoppedAt ? dateKey(experiment.stoppedAt) : null,
      stopReason: experiment.stopReason,
    },
    report,
    syncError,
    syncTruncated,
    servingEnabled: settings.servingEnabled,
    earlyStop: EARLY_STOP,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const experiment = await prisma.experiment.findFirst({
    where: { id: params.id, shop },
  });
  if (!experiment) {
    throw new Response("Experiment not found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "sync") {
    try {
      await syncExperimentOrders(admin, shop, experiment.id);
      return { ok: true as const, intent, error: null };
    } catch (error) {
      return {
        ok: false as const,
        intent,
        error:
          error instanceof Error ? error.message : "Order sync failed.",
      };
    }
  }

  if (intent === "stop") {
    const reason =
      String(formData.get("reason") ?? "Stopped manually").trim() ||
      "Stopped manually";
    await stopExperiment(shop, experiment.id, reason);
    return { ok: true as const, intent, error: null };
  }

  if (intent === "delete") {
    if (experiment.status === "running") {
      return {
        ok: false as const,
        intent,
        error: "Stop the experiment before deleting it.",
      };
    }
    await prisma.experiment.delete({ where: { id: experiment.id } });
    return redirect("/app/experiments");
  }

  return { ok: false as const, intent, error: "Unknown action." };
};

function statusBadge(status: string) {
  switch (status) {
    case "running":
      return <Badge tone="info">Running</Badge>;
    case "completed":
      return <Badge tone="success">Completed</Badge>;
    case "stopped":
      return <Badge tone="warning">Stopped</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

function formatValue(
  format: MetricComparison["format"],
  value: number | null,
): string {
  if (value === null) return "—";
  if (format === "percent") return `${(value * 100).toFixed(2)}%`;
  return value.toFixed(2);
}

function formatChange(changePct: number | null): string {
  if (changePct === null) return "—";
  const arrow = changePct >= 0 ? "▲" : "▼";
  return `${arrow} ${Math.abs(changePct).toFixed(1)}%`;
}

// The loader serializes the report; metrics arrive with the same shape.
type SerializedMetric = Omit<MetricComparison, "note"> & { note?: string };

function SignificanceCell({ metric }: { metric: SerializedMetric }) {
  if (!metric.sufficient) {
    return (
      <BlockStack gap="050" inlineAlign="start">
        <Badge>Not enough data</Badge>
        {metric.note ? (
          <Text as="span" variant="bodySm" tone="subdued">
            {metric.note}
          </Text>
        ) : null}
      </BlockStack>
    );
  }
  let badge = <Badge>No significant change</Badge>;
  if (
    metric.pTwoSided !== null &&
    metric.pTwoSided < 0.05 &&
    metric.changePct !== null &&
    metric.changePct !== 0
  ) {
    badge =
      metric.changePct > 0 ? (
        <Badge tone="success">Significant</Badge>
      ) : (
        <Badge tone="critical">Significant drop</Badge>
      );
  }
  return (
    <BlockStack gap="050" inlineAlign="start">
      {badge}
      {metric.pTwoSided !== null ? (
        <Text as="span" variant="bodySm" tone="subdued">
          p = {metric.pTwoSided.toPrecision(2)}
        </Text>
      ) : null}
    </BlockStack>
  );
}

export default function ExperimentDetail() {
  const {
    experiment,
    report,
    syncError,
    syncTruncated,
    servingEnabled,
    earlyStop,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const syncFetcher = useFetcher<typeof action>();
  const stopFetcher = useFetcher<typeof action>();

  const isSyncing = syncFetcher.state !== "idle";
  const isStopping = stopFetcher.state !== "idle";

  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [stopReason, setStopReason] = useState("");
  const [showDaily, setShowDaily] = useState(false);

  useEffect(() => {
    if (syncFetcher.state !== "idle" || !syncFetcher.data) return;
    if (syncFetcher.data.ok) {
      shopify.toast.show("Order data refreshed");
    } else {
      shopify.toast.show(syncFetcher.data.error ?? "Order sync failed", {
        isError: true,
      });
    }
  }, [syncFetcher.state, syncFetcher.data, shopify]);

  useEffect(() => {
    if (
      stopFetcher.state === "idle" &&
      stopFetcher.data?.intent === "stop" &&
      stopFetcher.data.ok
    ) {
      setShowStopConfirm(false);
      shopify.toast.show("Experiment stopped");
    }
  }, [stopFetcher.state, stopFetcher.data, shopify]);

  const handleSync = useCallback(() => {
    syncFetcher.submit({ intent: "sync" }, { method: "POST" });
  }, [syncFetcher]);

  const handleConfirmStop = useCallback(() => {
    const payload: Record<string, string> = { intent: "stop" };
    if (stopReason.trim()) payload.reason = stopReason.trim();
    stopFetcher.submit(payload, { method: "POST" });
  }, [stopFetcher, stopReason]);

  const isRunning = experiment.status === "running";

  const secondaryActions = [
    { content: "Refresh data", onAction: handleSync, loading: isSyncing },
    ...(isRunning
      ? [
          {
            content: "Stop experiment",
            destructive: true,
            onAction: () => setShowStopConfirm(true),
          },
        ]
      : [
          {
            content: "Delete",
            destructive: true,
            onAction: () => setShowDeleteConfirm(true),
          },
        ]),
  ];

  const metricRows = report.metrics.map((metric) => [
    <BlockStack gap="050" key={metric.key}>
      <Text as="span" variant="bodyMd">
        {metric.label}
      </Text>
      {metric.sufficient && metric.note ? (
        <Text as="span" variant="bodySm" tone="subdued">
          {metric.note}
        </Text>
      ) : null}
    </BlockStack>,
    formatValue(metric.format, metric.baseline),
    formatValue(metric.format, metric.treatment),
    formatChange(metric.changePct),
    <SignificanceCell metric={metric} key={`${metric.key}-sig`} />,
  ]);

  const dailyRows = report.daily.map((day) => [
    day.dateKey,
    day.window === "baseline" ? "Baseline" : "Treatment",
    day.views,
    day.variantViews,
    day.orders,
    day.units,
    day.revenue.toFixed(2),
  ]);

  const deleteError =
    actionData && !actionData.ok && actionData.intent === "delete"
      ? actionData.error
      : null;

  return (
    <Page
      backAction={{ url: "/app/experiments" }}
      title={experiment.productTitle}
      subtitle={`${experiment.localeName} (${experiment.locale}) · Baseline ${experiment.baselineStart}–${experiment.baselineEnd} vs Treatment ${experiment.treatmentStart}–${experiment.treatmentEnd}`}
      titleMetadata={statusBadge(experiment.status)}
      secondaryActions={secondaryActions}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {syncError && (
              <Banner tone="warning" title="Order data may be stale">
                {syncError}
              </Banner>
            )}
            {syncTruncated && (
              <Banner tone="warning" title="Order sync is catching up">
                Order volume is very high, so the sync fetches in batches.
                Click "Refresh data" again to pull the remaining orders.
              </Banner>
            )}
            {report.orderDataStale && !syncError && (
              <Banner tone="info" title="Order data is still syncing">
                Some recent days are not fully synced yet — drop alerts are
                paused until the data is complete. Use "Refresh data".
              </Banner>
            )}
            {deleteError && (
              <Banner tone="critical" title="Cannot delete">
                {deleteError}
              </Banner>
            )}
            {showDeleteConfirm && !isRunning && (
              <Banner
                tone="critical"
                title="Delete this experiment permanently?"
                action={{
                  content: "Confirm delete",
                  onAction: () => submit({ intent: "delete" }, { method: "POST" }),
                }}
                secondaryAction={{
                  content: "Cancel",
                  onAction: () => setShowDeleteConfirm(false),
                }}
              >
                The report and its collected daily data cannot be recovered.
              </Banner>
            )}
            {experiment.status === "completed" && (
              <Banner
                tone="success"
                title="Experiment complete — final comparison below"
              />
            )}
            {experiment.status === "stopped" && (
              <Banner tone="warning" title="Experiment stopped">
                {experiment.stopReason ?? "Stopped manually"}
                {experiment.stoppedAt ? ` (stopped ${experiment.stoppedAt})` : ""}
              </Banner>
            )}
            {report.alerts.map((alert) => (
              <Banner
                key={alert.metricKey}
                tone={alert.severity === "critical" ? "critical" : "warning"}
                title={
                  alert.severity === "critical"
                    ? "Significant drop detected"
                    : "Trending down"
                }
                action={
                  alert.severity === "critical"
                    ? {
                        content: "Stop experiment",
                        onAction: () => setShowStopConfirm(true),
                      }
                    : undefined
                }
                secondaryAction={
                  alert.severity === "critical"
                    ? {
                        content: "Turn serving off (kill switch)",
                        url: "/app/settings",
                      }
                    : undefined
                }
              >
                {alert.message}
              </Banner>
            ))}
            {isRunning && !servingEnabled && (
              <Banner
                tone="info"
                title="Serving is currently OFF — the treatment period is not actually live"
                action={{ content: "Open Settings", url: "/app/settings" }}
              >
                Turn on the serving switch in Settings for the treatment
                to reach visitors.
              </Banner>
            )}
            {showStopConfirm && isRunning && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Stop this experiment?
                  </Text>
                  <Text as="p" variant="bodyMd">
                    Stopping ends data collection for this experiment. It does
                    not turn variant serving off — use the switch in Settings
                    for that.
                  </Text>
                  <TextField
                    label="Reason (optional)"
                    value={stopReason}
                    onChange={setStopReason}
                    autoComplete="off"
                    placeholder="e.g. Conversion dropped, reverting the page"
                  />
                  <InlineStack gap="300" align="end">
                    <Button
                      onClick={() => setShowStopConfirm(false)}
                      disabled={isStopping}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      tone="critical"
                      onClick={handleConfirmStop}
                      loading={isStopping}
                    >
                      Confirm stop
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Metrics
                  </Text>
                  {isRunning && (
                    <Text as="span" variant="bodyMd" tone="subdued">
                      Treatment day {report.treatmentDaysElapsed} of{" "}
                      {report.baselineDays}
                    </Text>
                  )}
                </InlineStack>
                <DataTable
                  columnContentTypes={[
                    "text",
                    "numeric",
                    "numeric",
                    "numeric",
                    "text",
                  ]}
                  headings={[
                    "Metric",
                    "Baseline",
                    "Treatment",
                    "Change",
                    "Significance",
                  ]}
                  rows={metricRows}
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  Page-view tracking covered {report.viewsCoverage.baselineDays}
                  /{report.baselineDays} baseline days and{" "}
                  {report.viewsCoverage.treatmentDays}/
                  {report.treatmentDaysElapsed} treatment days.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Daily breakdown
                  </Text>
                  <Button
                    variant="plain"
                    disclosure={showDaily ? "up" : "down"}
                    onClick={() => setShowDaily((value) => !value)}
                  >
                    {showDaily ? "Hide" : "Show"}
                  </Button>
                </InlineStack>
                {showDaily && (
                  <DataTable
                    columnContentTypes={[
                      "text",
                      "text",
                      "numeric",
                      "numeric",
                      "numeric",
                      "numeric",
                      "numeric",
                    ]}
                    headings={[
                      "Date",
                      "Window",
                      "Views",
                      "Variant views",
                      "Orders",
                      "Units",
                      "Revenue",
                    ]}
                    rows={dailyRows}
                  />
                )}
              </BlockStack>
            </Card>

            <Card>
              <Text as="p" variant="bodySm" tone="subdued">
                Sequential comparison, not an A/B test — external factors
                (seasonality, promotions, ad-spend changes) can affect
                period-over-period results. The early-stop monitor compensates
                for daily checking with strict thresholds: at least{" "}
                {earlyStop.minTreatmentDays} treatment days, a one-sided p below{" "}
                {earlyStop.pCritical}, and a drop of at least{" "}
                {(earlyStop.minRelativeDrop * 100).toFixed(0)}%. Days are UTC.
              </Text>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
