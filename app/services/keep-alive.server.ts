/**
 * Self keep-alive for hosts that spin idle services down (e.g. Render's
 * free instances sleep after ~15 idle minutes and take up to a minute to
 * wake — the admin then looks broken until the server is back, and an
 * instance stopped mid-generation kills the in-process queue's work).
 * A request through the public URL every 10 minutes counts as inbound
 * traffic and keeps the instance warm.
 *
 * On an always-on (paid) instance the pings are pointless but harmless;
 * set PAGE_TAILOR_KEEP_ALIVE=off to disable them explicitly.
 */

const PING_INTERVAL_MS = 10 * 60 * 1000;

// globalThis-guarded so dev-mode module reloads never start a second timer.
const store = globalThis as typeof globalThis & {
  __pageTailorKeepAlive?: boolean;
};

export function startKeepAlive(): void {
  if (store.__pageTailorKeepAlive) return;
  const appUrl =
    process.env.SHOPIFY_APP_URL || process.env.RENDER_EXTERNAL_URL || "";
  if (
    process.env.NODE_ENV !== "production" ||
    process.env.PAGE_TAILOR_KEEP_ALIVE === "off" ||
    !appUrl.startsWith("https://")
  ) {
    return;
  }
  store.__pageTailorKeepAlive = true;

  let target: string;
  try {
    target = new URL("/healthz", appUrl).toString();
  } catch {
    return;
  }
  const timer = setInterval(() => {
    // A failed ping must never take anything down; the next one retries.
    fetch(target).catch(() => {});
  }, PING_INTERVAL_MS);
  // Never keep the process alive just for the pinger.
  if (typeof timer.unref === "function") timer.unref();
}
