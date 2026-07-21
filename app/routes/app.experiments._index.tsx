import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  EmptyState,
  IndexTable,
  Layout,
  Page,
  Text,
  Tooltip,
} from "@shopify/polaris";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  computeExperimentReport,
  ensureExperimentOrdersFresh,
  refreshExperimentStatus,
} from "../services/experiment.server";
import { getShopLocales } from "../services/shopify-data.server";

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const [rows, locales] = await Promise.all([
    prisma.experiment.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
    }),
    getShopLocales(admin),
  ]);
  const primaryLocale = locales.find((l) => l.primary)?.locale ?? "en";
  const localeNames = new Map(locales.map((l) => [l.locale, l.name]));

  const experiments = await Promise.all(
    rows.map(async (row) => {
      const experiment = await refreshExperimentStatus(row);
      const baselineDays = Math.round(
        (experiment.baselineEnd.getTime() - experiment.baselineStart.getTime()) /
          DAY_MS,
      );

      // Only running experiments can alert. Sync order data first (30-min
      // gate inside the helper) so alerts are never computed on stale data;
      // any failure degrades to "no alert", never a crashed page.
      let treatmentDaysElapsed: number | null = null;
      let alertSeverity: "critical" | "watch" | null = null;
      if (experiment.status === "running") {
        try {
          await ensureExperimentOrdersFresh(admin, shop, experiment);
          const fresh =
            (await prisma.experiment.findFirst({
              where: { id: experiment.id, shop },
            })) ?? experiment;
          const report = await computeExperimentReport(
            shop,
            fresh,
            primaryLocale,
          );
          treatmentDaysElapsed = report.treatmentDaysElapsed;
          alertSeverity = report.alerts.some((a) => a.severity === "critical")
            ? "critical"
            : report.alerts.some((a) => a.severity === "watch")
              ? "watch"
              : null;
        } catch {
          // Leave alertSeverity null — the detail page surfaces sync issues.
        }
      }

      return {
        id: experiment.id,
        productTitle: experiment.productTitle,
        locale: experiment.locale,
        localeName: localeNames.get(experiment.locale) ?? experiment.locale,
        status: experiment.status,
        baselineDays,
        treatmentDaysElapsed,
        alertSeverity,
        stopReason: experiment.stopReason,
        baselineStart: dateKey(experiment.baselineStart),
        treatmentEnd: dateKey(experiment.treatmentEnd),
      };
    }),
  );

  return { experiments };
};

function statusBadge(status: string, stopReason: string | null) {
  switch (status) {
    case "running":
      return <Badge tone="info">Running</Badge>;
    case "completed":
      return <Badge tone="success">Completed</Badge>;
    case "stopped":
      return (
        <Tooltip content={stopReason ?? "Stopped"}>
          <Badge tone="warning">Stopped</Badge>
        </Tooltip>
      );
    default:
      return <Badge>{status}</Badge>;
  }
}

export default function ExperimentsIndex() {
  const { experiments } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const criticalExperiment = experiments.find(
    (e) => e.status === "running" && e.alertSeverity === "critical",
  );

  const emptyState = (
    <Card>
      <EmptyState
        heading="Check that a page change did not hurt sales"
        action={{ content: "New experiment", url: "/app/experiments/new" }}
        image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
      >
        <p>
          An experiment compares a baseline period (the full days before you
          switch a product page on for a market) against the treatment period
          that follows, for one product and language. It is a sequential
          before/after comparison — never an A/B test: only one version of the
          page is ever live for a market. Create one before turning on dynamic
          copy for a market, so you have a baseline to compare against.
        </p>
      </EmptyState>
    </Card>
  );

  const rows = experiments.map((experiment, index) => (
    <IndexTable.Row
      id={experiment.id}
      key={experiment.id}
      position={index}
      onClick={() => navigate(`/app/experiments/${experiment.id}`)}
    >
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {experiment.productTitle}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{experiment.localeName}</IndexTable.Cell>
      <IndexTable.Cell>
        {statusBadge(experiment.status, experiment.stopReason)}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <BlockStack gap="050">
          <Text as="span" variant="bodyMd">
            {experiment.baselineStart} → {experiment.treatmentEnd}
          </Text>
          {experiment.status === "running" &&
          experiment.treatmentDaysElapsed !== null ? (
            <Text as="span" variant="bodySm" tone="subdued">
              day {experiment.treatmentDaysElapsed} of {experiment.baselineDays}
            </Text>
          ) : null}
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {experiment.alertSeverity === "critical" ? (
          <Badge tone="critical">Drop detected</Badge>
        ) : experiment.alertSeverity === "watch" ? (
          <Badge tone="warning">Watch</Badge>
        ) : (
          <Text as="span" variant="bodyMd" tone="subdued">
            —
          </Text>
        )}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="Experiments"
      primaryAction={{ content: "New experiment", url: "/app/experiments/new" }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {criticalExperiment && (
              <Banner
                tone="critical"
                title="A running experiment shows a significant drop — review it now"
                action={{
                  content: `Review ${criticalExperiment.productTitle}`,
                  url: `/app/experiments/${criticalExperiment.id}`,
                }}
              />
            )}
            {experiments.length === 0 ? (
              emptyState
            ) : (
              <Card padding="0">
                <IndexTable
                  resourceName={{
                    singular: "experiment",
                    plural: "experiments",
                  }}
                  itemCount={experiments.length}
                  selectable={false}
                  headings={[
                    { title: "Product" },
                    { title: "Language" },
                    { title: "Status" },
                    { title: "Period" },
                    { title: "Alert" },
                  ]}
                >
                  {rows}
                </IndexTable>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
