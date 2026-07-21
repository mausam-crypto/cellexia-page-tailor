/**
 * Statistics for the experiment tracker: sequential baseline/treatment
 * comparison (NOT A/B). Pure functions, no dependencies.
 *
 * Conventions: "1" is baseline, "2" is treatment. pDecline is the one-sided
 * p-value for the hypothesis that treatment is WORSE (lower) than baseline —
 * that is what the early-stop monitor cares about.
 */

export interface TestResult {
  statistic: number;
  pTwoSided: number;
  /** One-sided p that treatment < baseline */
  pDecline: number;
}

// Abramowitz & Stegun 7.1.26, |error| < 1.5e-7.
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Lanczos approximation.
export function lnGamma(x: number): number {
  // Literals are written as their exact IEEE-754 doubles (the classic
  // Numerical Recipes constants round to these at runtime anyway).
  const g = [
    76.18009172947146, -86.50532032941678, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let ser = 1.000000000190015;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  for (let j = 0; j < 6; j++) ser += g[j] / (x + 1 + j);
  return -tmp + Math.log((2.5066282746310007 * ser) / x);
}

// Continued fraction for the regularized incomplete beta (Numerical Recipes).
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lnGamma(a + b) -
      lnGamma(a) -
      lnGamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** P(T <= t) for Student's t with df degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return NaN;
  const x = df / (df + t * t);
  const p = 0.5 * incompleteBeta(df / 2, 0.5, x);
  return t >= 0 ? 1 - p : p;
}

/**
 * Welch's t-test from aggregates (count, mean, sample variance).
 * "Decline" means mean2 < mean1.
 */
export function welchTest(
  n1: number,
  mean1: number,
  var1: number,
  n2: number,
  mean2: number,
  var2: number,
): TestResult | null {
  if (n1 < 2 || n2 < 2) return null;
  const se2 = var1 / n1 + var2 / n2;
  if (se2 <= 0) return null;
  const t = (mean2 - mean1) / Math.sqrt(se2);
  const df =
    (se2 * se2) /
    ((var1 / n1) ** 2 / (n1 - 1) + (var2 / n2) ** 2 / (n2 - 1));
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return null;
  const cdf = studentTCdf(t, df);
  return {
    statistic: t,
    pTwoSided: 2 * Math.min(cdf, 1 - cdf),
    pDecline: cdf, // P(T <= observed): small when treatment is clearly lower
  };
}

/**
 * Two-proportion z-test (pooled). x = successes, n = trials.
 * "Decline" means x2/n2 < x1/n1.
 */
export function twoProportionTest(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
): TestResult | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  const z = (p2 - p1) / se;
  const cdf = normalCdf(z);
  return {
    statistic: z,
    pTwoSided: 2 * Math.min(cdf, 1 - cdf),
    pDecline: cdf,
  };
}

/**
 * Rate-ratio test for event counts over exposures (e.g. orders per day):
 * z-test on the log rate ratio. "Decline" means rate2 < rate1.
 */
/** P(X <= k) for X ~ Binomial(n, p), summed in log space for stability. */
export function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    const logPmf =
      lnGamma(n + 1) -
      lnGamma(i + 1) -
      lnGamma(n - i + 1) +
      i * Math.log(p) +
      (n - i) * Math.log(1 - p);
    sum += Math.exp(logPmf);
  }
  return Math.min(1, sum);
}

/**
 * Rate comparison via the EXACT conditional binomial test: under equal
 * rates, count2 | (count1+count2) ~ Binomial(total, exposure2/total
 * exposure). Exact at all counts including zero — a total collapse
 * (treatment orders = 0) yields the correct, very small p rather than a
 * conservative approximation. Falls back to the normal z on huge totals
 * where the summation would be slow and the approximation is excellent.
 */
export function rateRatioTest(
  count1: number,
  exposure1: number,
  count2: number,
  exposure2: number,
): TestResult | null {
  if (exposure1 <= 0 || exposure2 <= 0) return null;
  const total = count1 + count2;
  if (total <= 0) return null;
  const pi = exposure2 / (exposure1 + exposure2);

  if (total <= 5000) {
    const pDecline = binomialCdf(count2, total, pi);
    const pIncrease = 1 - binomialCdf(count2 - 1, total, pi);
    const expected = total * pi;
    const sd = Math.sqrt(total * pi * (1 - pi));
    return {
      statistic: sd > 0 ? (count2 - expected) / sd : 0,
      pTwoSided: Math.min(1, 2 * Math.min(pDecline, pIncrease)),
      pDecline,
    };
  }

  // Large-count fallback: z on the log rate ratio (counts here are far from
  // zero, so no continuity issues).
  const logRatio = Math.log(count2 / exposure2 / (count1 / exposure1));
  const se = Math.sqrt(1 / count1 + 1 / count2);
  const z = logRatio / se;
  const cdf = normalCdf(z);
  return {
    statistic: z,
    pTwoSided: 2 * Math.min(cdf, 1 - cdf),
    pDecline: cdf,
  };
}

/** Aggregate a list of values into (n, mean, sample variance). */
export function aggregate(values: number[]): {
  n: number;
  mean: number;
  variance: number;
} {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, variance: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { n, mean, variance: 0 };
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { n, mean, variance };
}

/**
 * Early-stop policy for the sequential monitor. Checking daily inflates
 * false-positive risk, so the bar is deliberately strict: at least 5 elapsed
 * treatment days, metric-specific minimum samples, a one-sided p below 0.01,
 * AND a relative drop of at least 5%.
 */
export const EARLY_STOP = {
  minTreatmentDays: 5,
  pCritical: 0.01,
  pWatch: 0.05,
  minRelativeDrop: 0.05,
} as const;

export function assessDecline(options: {
  baselineValue: number;
  treatmentValue: number;
  pDecline: number | null;
  treatmentDays: number;
  sufficient: boolean;
}): "critical" | "watch" | null {
  const { baselineValue, treatmentValue, pDecline, treatmentDays, sufficient } =
    options;
  if (pDecline === null || !sufficient) return null;
  if (treatmentDays < EARLY_STOP.minTreatmentDays) return null;
  if (baselineValue <= 0) return null;
  const drop = (baselineValue - treatmentValue) / baselineValue;
  if (drop < EARLY_STOP.minRelativeDrop) return null;
  if (pDecline < EARLY_STOP.pCritical) return "critical";
  if (pDecline < EARLY_STOP.pWatch) return "watch";
  return null;
}
