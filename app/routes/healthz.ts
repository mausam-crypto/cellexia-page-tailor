/**
 * Unauthenticated liveness probe: the target for the host's health check
 * (set Render's "Health Check Path" to /healthz so deploys only switch
 * over once the server actually serves) and for keep-alive pings (see
 * keep-alive.server.ts). Deliberately touches nothing — no DB, no Shopify —
 * so it is cheap and can only fail when the process itself is down.
 */
export const loader = async () =>
  new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
