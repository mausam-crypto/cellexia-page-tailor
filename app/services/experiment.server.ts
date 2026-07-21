import type { Experiment } from "@prisma/client";
import prisma from "../db.server";
import {
  getOrdersInWindow,
  getProduct,
  getProductHandleForLocale,
  getShopLocales,
  type AdminClient,
} from "./shopify-data.server";
import {
  aggregate,
  assessDecline,
  rateRatioTest,
  twoProportionTest,
  welchTest,
  EARLY_STOP,
} from "./stats.server";

export const ALLOWED_BASELINE_DAYS = [7, 14, 21, 28] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function dateKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcMidnight(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/** All UTC date keys in [start, end). */
function dateKeysBetween(start: Date, end: Date): string[] {
  const keys: string[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    keys.push(dateKeyOf(new Date(t)));
  }
  return keys;
}

/**
 * Create a sequential experiment: baseline = the N full UTC days before
 * today, treatment = today plus the following N-1 days. This is a
 * before/after comparison — only one version of the page is ever live for
 * the market, which is the point (no A/B split).
 */
export async function createExperiment(
  admin: AdminClient,
  shop: string,
  input: { productId: string; locale: string; baselineDays: number },
): Promise<Experiment> {
  const baselineDays = ALLOWED_BASELINE_DAYS.includes(
    input.baselineDays as (typeof ALLOWED_BASELINE_DAYS)[number],
  )
    ? input.baselineDays
    : 14;

  const existing = await prisma.experiment.findFirst({
    where: {
      shop,
      productId: input.productId,
      locale: input.locale,
      status: "running",
    },
  });
  if (existing) {
    throw new Error(
      "There is already a running experiment for this product and language. Stop it before starting another.",
    );
  }

  const product = await getProduct(admin, input.productId);
  // The beacon reports the handle from the storefront URL, which for
  // non-primary locales can be a translated handle — track that one.
  const locales = await getShopLocales(admin);
  const primary = locales.find((l) => l.primary)?.locale ?? input.locale;
  const localeHandle = await getProductHandleForLocale(
    admin,
    product.id,
    input.locale,
    primary.toLowerCase() === input.locale.toLowerCase(),
  );

  const treatmentStart = utcMidnight(new Date());
  const baselineStart = new Date(
    treatmentStart.getTime() - baselineDays * DAY_MS,
  );
  const treatmentEnd = new Date(
    treatmentStart.getTime() + baselineDays * DAY_MS,
  );

  const experiment = await prisma.experiment.create({
    data: {
      shop,
      productId: product.id,
      productHandle: localeHandle,
      productTitle: product.title,
      locale: input.locale,
      baselineStart,
      baselineEnd: treatmentStart,
      treatmentStart,
      treatmentEnd,
    },
  });

  try {
    await syncExperimentOrders(admin, shop, experiment.id);
  } catch (error) {
    // Don't leave a half-created experiment behind a "could not create"
    // error — the retry would then hit the duplicate-running check.
    await prisma.experiment.delete({ where: { id: experiment.id } });
    throw error;
  }
  return experiment;
}

/**
 * Sync order data if it is stale, unless the relevant window is already
 * fully synced. Never throws — a sync failure is reported, and the caller
 * shows stale data with a warning instead of crashing.
 */
export async function ensureExperimentOrdersFresh(
  admin: AdminClient,
  shop: string,
  experiment: Experiment,
): Promise<{ truncated: boolean; error: string | null }> {
  const effectiveEnd =
    experiment.stoppedAt && experiment.stoppedAt < experiment.treatmentEnd
      ? experiment.stoppedAt
      : experiment.treatmentEnd;
  const fullySynced =
    experiment.lastOrderSyncAt !== null &&
    experiment.lastOrderSyncAt >= effectiveEnd;
  const fresh =
    experiment.lastOrderSyncAt !== null &&
    Date.now() - experiment.lastOrderSyncAt.getTime() < 30 * 60 * 1000;
  if (fullySynced || fresh) return { truncated: false, error: null };
  try {
    const result = await syncExperimentOrders(admin, shop, experiment.id);
    return { truncated: result.truncated, error: null };
  } catch (error) {
    return {
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Pull order data for the experiment window from the Admin API into the
 * local OrderLine table. Incremental after the first run (small overlap to
 * absorb clock skew); safe to call often.
 */
export async function syncExperimentOrders(
  admin: AdminClient,
  shop: string,
  experimentId: string,
): Promise<{ truncated: boolean }> {
  const experiment = await prisma.experiment.findFirst({
    where: { id: experimentId, shop },
  });
  if (!experiment) throw new Error("Experiment not found");

  const now = new Date();
  const effectiveEnd =
    experiment.stoppedAt && experiment.stoppedAt < experiment.treatmentEnd
      ? experiment.stoppedAt
      : experiment.treatmentEnd;
  const from = experiment.lastOrderSyncAt
    ? new Date(experiment.lastOrderSyncAt.getTime() - 60 * 60 * 1000)
    : experiment.baselineStart;
  const to = now < effectiveEnd ? now : effectiveEnd;
  if (from >= to) return { truncated: false };

  const { orders, truncated, lastCreatedAt } = await getOrdersInWindow(
    admin,
    from.toISOString(),
    to.toISOString(),
  );

  const writes = [];
  for (const order of orders) {
    const lines = order.lines.filter(
      (l) => l.productId === experiment.productId,
    );
    if (lines.length === 0) continue;
    const units = lines.reduce((a, l) => a + l.quantity, 0);
    const lineRevenue = lines.reduce((a, l) => a + l.lineRevenue, 0);
    const row = {
      shop,
      orderId: order.id,
      productId: experiment.productId,
      dateKey: dateKeyOf(new Date(order.createdAt)),
      units,
      lineRevenue,
      orderTotal: order.totalPrice,
      customerLocale: order.customerLocale?.toLowerCase() ?? null,
    };
    writes.push(
      prisma.orderLine.upsert({
        where: {
          orderId_productId: {
            orderId: order.id,
            productId: experiment.productId,
          },
        },
        create: row,
        update: row,
      }),
    );
  }
  // When the fetch was truncated, only mark data as synced up to the last
  // order actually retrieved — the next sync resumes there instead of
  // silently skipping everything past the cap.
  const syncedThrough =
    truncated && lastCreatedAt ? new Date(lastCreatedAt) : to;
  writes.push(
    prisma.experiment.update({
      where: { id: experiment.id },
      data: { lastOrderSyncAt: syncedThrough },
    }),
  );
  await prisma.$transaction(writes);
  return { truncated };
}

export interface MetricComparison {
  key: string;
  label: string;
  format: "number" | "currency" | "percent";
  baseline: number | null;
  treatment: number | null;
  changePct: number | null;
  pDecline: number | null;
  pTwoSided: number | null;
  guarded: boolean;
  sufficient: boolean;
  note?: string;
}

export interface ExperimentAlert {
  metricKey: string;
  severity: "critical" | "watch";
  message: string;
}

export interface DailyRow {
  dateKey: string;
  window: "baseline" | "treatment";
  views: number;
  variantViews: number;
  orders: number;
  units: number;
  revenue: number;
}

export interface ExperimentReport {
  baselineDays: number;
  /** Completed (full) UTC treatment days — the in-progress day is excluded
   *  from every statistic so partial days never read as drops. */
  treatmentDaysElapsed: number;
  metrics: MetricComparison[];
  alerts: ExperimentAlert[];
  daily: DailyRow[];
  viewsCoverage: { baselineDays: number; treatmentDays: number };
  /** True when order data does not cover all assessed days; alerts are
   *  suppressed in that state rather than fired on missing data. */
  orderDataStale: boolean;
}

function localeMatches(experimentLocale: string, candidate: string | null, primaryLocale: string): boolean {
  const target = experimentLocale.toLowerCase();
  const value = (candidate ?? primaryLocale).toLowerCase();
  return value === target || value.startsWith(`${target}-`);
}

/**
 * Compute the baseline/treatment comparison. Orders are attributed to the
 * experiment's language via the order's customer locale (orders without one
 * count toward the primary locale). Views come from the beacon and only
 * exist for days after the app embed went live — coverage is reported so
 * missing view data is visible rather than silently skewing rates.
 */
export async function computeExperimentReport(
  shop: string,
  experiment: Experiment,
  primaryLocale: string,
): Promise<ExperimentReport> {
  const now = new Date();
  const baselineKeys = dateKeysBetween(
    experiment.baselineStart,
    experiment.treatmentStart,
  );
  const treatmentAllKeys = dateKeysBetween(
    experiment.treatmentStart,
    experiment.treatmentEnd,
  );
  const todayKey = dateKeyOf(now);
  // Only COMPLETED UTC days count: including the in-progress day would bias
  // every per-day treatment rate downward (a phantom "drop" each morning).
  // A stopped experiment is clamped at the stop day (also excluded — the
  // variant was only live for part of it).
  const stopKey = experiment.stoppedAt ? dateKeyOf(experiment.stoppedAt) : null;
  const treatmentKeys = treatmentAllKeys.filter(
    (k) => k < todayKey && (stopKey === null || k < stopKey),
  );
  const baselineDays = baselineKeys.length;
  const treatmentDaysElapsed = treatmentKeys.length;

  // Order data is "fresh" when the sync covers every assessed (completed)
  // day. Alerts computed over unsynced days would read missing data as a
  // catastrophic drop — suppressed instead.
  const effectiveEnd =
    experiment.stoppedAt && experiment.stoppedAt < experiment.treatmentEnd
      ? experiment.stoppedAt
      : experiment.treatmentEnd;
  const orderDataStale =
    experiment.lastOrderSyncAt === null ||
    (experiment.lastOrderSyncAt < effectiveEnd &&
      dateKeyOf(experiment.lastOrderSyncAt) < todayKey);

  const [dailyStats, orderLines] = await Promise.all([
    prisma.dailyStat.findMany({
      where: {
        shop,
        productHandle: experiment.productHandle,
        dateKey: { gte: baselineKeys[0] ?? todayKey, lte: todayKey },
      },
    }),
    prisma.orderLine.findMany({
      where: {
        shop,
        productId: experiment.productId,
        dateKey: { gte: baselineKeys[0] ?? todayKey, lte: todayKey },
      },
    }),
  ]);

  const localeStats = dailyStats.filter((s) =>
    localeMatches(experiment.locale, s.locale, s.locale),
  );
  const localeOrders = orderLines.filter((o) =>
    localeMatches(experiment.locale, o.customerLocale, primaryLocale),
  );

  const inWindow = (keys: string[], dateKey: string) => keys.includes(dateKey);

  const daily: DailyRow[] = [...baselineKeys, ...treatmentKeys].map((key) => {
    const window = inWindow(baselineKeys, key) ? "baseline" : "treatment";
    const stats = localeStats.filter((s) => s.dateKey === key);
    const orders = localeOrders.filter((o) => o.dateKey === key);
    return {
      dateKey: key,
      window,
      views: stats.reduce((a, s) => a + s.views, 0),
      variantViews: stats.reduce((a, s) => a + s.variantViews, 0),
      orders: orders.length,
      units: orders.reduce((a, o) => a + o.units, 0),
      revenue: orders.reduce((a, o) => a + o.lineRevenue, 0),
    };
  });

  const base = daily.filter((d) => d.window === "baseline");
  const treat = daily.filter((d) => d.window === "treatment");

  const baseViews = base.reduce((a, d) => a + d.views, 0);
  const treatViews = treat.reduce((a, d) => a + d.views, 0);
  const baseOrderRows = localeOrders.filter((o) =>
    inWindow(baselineKeys, o.dateKey),
  );
  const treatOrderRows = localeOrders.filter((o) =>
    inWindow(treatmentKeys, o.dateKey),
  );
  const baseOrders = baseOrderRows.length;
  const treatOrders = treatOrderRows.length;
  const baseRevenue = base.reduce((a, d) => a + d.revenue, 0);
  const treatRevenue = treat.reduce((a, d) => a + d.revenue, 0);

  const baseDaysWithViews = base.filter((d) => d.views > 0).length;
  const treatDaysWithViews = treat.filter((d) => d.views > 0).length;

  const metrics: MetricComparison[] = [];
  const alerts: ExperimentAlert[] = [];

  const pct = (b: number, t: number): number | null =>
    b > 0 ? ((t - b) / b) * 100 : null;

  const pushMetric = (m: MetricComparison) => {
    metrics.push(m);
    if (
      m.guarded &&
      m.baseline !== null &&
      m.treatment !== null &&
      experiment.status === "running" &&
      !orderDataStale
    ) {
      const severity = assessDecline({
        baselineValue: m.baseline,
        treatmentValue: m.treatment,
        pDecline: m.pDecline,
        treatmentDays: treatmentDaysElapsed,
        sufficient: m.sufficient,
      });
      if (severity) {
        alerts.push({
          metricKey: m.key,
          severity,
          message:
            severity === "critical"
              ? `${m.label} dropped ${Math.abs(m.changePct ?? 0).toFixed(1)}% vs baseline (one-sided p=${m.pDecline?.toPrecision(2)}). A drop this large is very unlikely to be random — consider stopping the experiment and turning serving off.`
              : `${m.label} is trending down (${Math.abs(m.changePct ?? 0).toFixed(1)}%, one-sided p=${m.pDecline?.toPrecision(2)}). Not conclusive yet — keep watching.`,
        });
      }
    }
  };

  // Orders per day (guarded, rate-ratio test)
  {
    const test = rateRatioTest(
      baseOrders,
      baselineDays,
      treatOrders,
      Math.max(treatmentDaysElapsed, 1),
    );
    pushMetric({
      key: "ordersPerDay",
      label: "Orders per day",
      format: "number",
      baseline: baselineDays > 0 ? baseOrders / baselineDays : null,
      treatment:
        treatmentDaysElapsed > 0 ? treatOrders / treatmentDaysElapsed : null,
      changePct:
        baselineDays > 0 && treatmentDaysElapsed > 0
          ? pct(baseOrders / baselineDays, treatOrders / treatmentDaysElapsed)
          : null,
      pDecline: test?.pDecline ?? null,
      pTwoSided: test?.pTwoSided ?? null,
      guarded: true,
      sufficient: baseOrders >= 20 && treatmentDaysElapsed >= 1,
      note:
        baseOrders < 20
          ? "Needs at least 20 baseline orders for reliable testing."
          : undefined,
    });
  }

  // Revenue per day (guarded, Welch on daily revenue)
  {
    const aggB = aggregate(base.map((d) => d.revenue));
    const aggT = aggregate(treat.map((d) => d.revenue));
    const test = welchTest(
      aggB.n,
      aggB.mean,
      aggB.variance,
      aggT.n,
      aggT.mean,
      aggT.variance,
    );
    pushMetric({
      key: "revenuePerDay",
      label: "Product revenue per day",
      format: "currency",
      baseline: baselineDays > 0 ? baseRevenue / baselineDays : null,
      treatment:
        treatmentDaysElapsed > 0 ? treatRevenue / treatmentDaysElapsed : null,
      changePct:
        baselineDays > 0 && treatmentDaysElapsed > 0
          ? pct(baseRevenue / baselineDays, treatRevenue / treatmentDaysElapsed)
          : null,
      pDecline: test?.pDecline ?? null,
      pTwoSided: test?.pTwoSided ?? null,
      guarded: true,
      sufficient: aggB.n >= 5 && aggT.n >= 5,
    });
  }

  // Average order value (guarded, Welch over order totals)
  {
    const aggB = aggregate(baseOrderRows.map((o) => o.orderTotal));
    const aggT = aggregate(treatOrderRows.map((o) => o.orderTotal));
    const test = welchTest(
      aggB.n,
      aggB.mean,
      aggB.variance,
      aggT.n,
      aggT.mean,
      aggT.variance,
    );
    pushMetric({
      key: "aov",
      label: "Average order value",
      format: "currency",
      baseline: aggB.n > 0 ? aggB.mean : null,
      treatment: aggT.n > 0 ? aggT.mean : null,
      changePct: aggB.n > 0 && aggT.n > 0 ? pct(aggB.mean, aggT.mean) : null,
      pDecline: test?.pDecline ?? null,
      pTwoSided: test?.pTwoSided ?? null,
      guarded: true,
      sufficient: aggB.n >= 20 && aggT.n >= 20,
      note:
        aggB.n < 20 || aggT.n < 20
          ? "Needs at least 20 orders in each window."
          : undefined,
    });
  }

  // Conversion rate: orders / product page views. To avoid a coverage
  // mismatch (orders exist for every day; beacon views only for days after
  // the embed went live), BOTH numerator and denominator are restricted to
  // view-covered days in each window.
  {
    const coveredBase = base.filter((d) => d.views > 0);
    const coveredTreat = treat.filter((d) => d.views > 0);
    const cbViews = coveredBase.reduce((a, d) => a + d.views, 0);
    const cbOrders = coveredBase.reduce((a, d) => a + d.orders, 0);
    const ctViews = coveredTreat.reduce((a, d) => a + d.views, 0);
    const ctOrders = coveredTreat.reduce((a, d) => a + d.orders, 0);
    const coverageOk =
      baseDaysWithViews >= Math.max(1, Math.floor(baselineDays * 0.8)) &&
      treatDaysWithViews >= Math.max(1, Math.floor(treatmentDaysElapsed * 0.8));
    const test =
      cbViews > 0 && ctViews > 0
        ? twoProportionTest(cbOrders, cbViews, ctOrders, ctViews)
        : null;
    pushMetric({
      key: "conversionRate",
      label: "Conversion rate (orders / product views, view-covered days)",
      format: "percent",
      baseline: cbViews > 0 ? cbOrders / cbViews : null,
      treatment: ctViews > 0 ? ctOrders / ctViews : null,
      changePct:
        cbViews > 0 && ctViews > 0
          ? pct(cbOrders / cbViews, ctOrders / ctViews)
          : null,
      pDecline: test?.pDecline ?? null,
      pTwoSided: test?.pTwoSided ?? null,
      guarded: true,
      sufficient: coverageOk && cbViews >= 200 && ctViews >= 200,
      note: !coverageOk
        ? "View tracking did not cover enough of both windows (the beacon only counts views after the app embed went live)."
        : cbViews < 200 || ctViews < 200
          ? "Needs at least 200 views in each window."
          : undefined,
    });
  }

  // Units per day (informational)
  {
    const baseUnits = base.reduce((a, d) => a + d.units, 0);
    const treatUnits = treat.reduce((a, d) => a + d.units, 0);
    const test = rateRatioTest(
      baseUnits,
      baselineDays,
      treatUnits,
      Math.max(treatmentDaysElapsed, 1),
    );
    pushMetric({
      key: "unitsPerDay",
      label: "Units sold per day",
      format: "number",
      baseline: baselineDays > 0 ? baseUnits / baselineDays : null,
      treatment:
        treatmentDaysElapsed > 0 ? treatUnits / treatmentDaysElapsed : null,
      changePct:
        baselineDays > 0 && treatmentDaysElapsed > 0
          ? pct(baseUnits / baselineDays, treatUnits / treatmentDaysElapsed)
          : null,
      pDecline: test?.pDecline ?? null,
      pTwoSided: test?.pTwoSided ?? null,
      guarded: false,
      sufficient: baseUnits >= 20,
    });
  }

  // Product page views per day (informational — traffic tracks ad spend)
  {
    const test = rateRatioTest(
      baseViews,
      baselineDays,
      treatViews,
      Math.max(treatmentDaysElapsed, 1),
    );
    pushMetric({
      key: "viewsPerDay",
      label: "Product views per day",
      format: "number",
      baseline: baselineDays > 0 ? baseViews / baselineDays : null,
      treatment:
        treatmentDaysElapsed > 0 ? treatViews / treatmentDaysElapsed : null,
      changePct:
        baseViews > 0 && treatViews > 0
          ? pct(baseViews / baselineDays, treatViews / treatmentDaysElapsed)
          : null,
      pDecline: test?.pDecline ?? null,
      pTwoSided: test?.pTwoSided ?? null,
      guarded: false,
      sufficient: baseViews > 0 && treatViews > 0,
      note: "Traffic volume mostly reflects ad spend, not page copy — informational only.",
    });
  }

  return {
    baselineDays,
    treatmentDaysElapsed,
    metrics,
    alerts,
    daily,
    viewsCoverage: {
      baselineDays: baseDaysWithViews,
      treatmentDays: treatDaysWithViews,
    },
    orderDataStale,
  };
}

/** Lazily flip running experiments past their end date to completed. */
export async function refreshExperimentStatus(
  experiment: Experiment,
): Promise<Experiment> {
  if (
    experiment.status === "running" &&
    new Date() >= experiment.treatmentEnd
  ) {
    return prisma.experiment.update({
      where: { id: experiment.id },
      data: { status: "completed" },
    });
  }
  return experiment;
}

export async function stopExperiment(
  shop: string,
  experimentId: string,
  reason: string,
): Promise<void> {
  await prisma.experiment.updateMany({
    where: { id: experimentId, shop, status: "running" },
    data: { status: "stopped", stoppedAt: new Date(), stopReason: reason },
  });
}

export { EARLY_STOP };
