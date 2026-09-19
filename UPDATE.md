# Updating a live Page Tailor deployment

This guide is for updating an already-deployed installation. For first-time
setup, use [INSTALL.md](INSTALL.md).

## What's new in this update (2026-09-19 — performance & reliability)

This is a server-only performance release. No new features, **no database
migrations, no theme-extension changes, no scope or config changes** — the
admin just opens and navigates much faster and stops dying on slow hosts.

- **Faster page navigation.** Every admin page used to pay 1-2 Shopify
  Admin API round trips per click for answers that change ~never (shop
  languages, primary domain, metafield definitions). These are now cached
  per shop (10-minute TTL, refreshed in the background, last good value
  served through Admin API hiccups), so after the first load, pages answer
  from the local database.
- **Much faster cold starts.** The Prisma client is now generated when the
  image is built (Dockerfile / npm install) instead of on every boot; the
  boot command (`npm run docker-start`) only runs `prisma migrate deploy`.
  This removes tens of seconds from every restart.
- **Keep-alive against host spin-down.** Hosts that sleep idle services
  (e.g. Render free instances) caused the ~60s "app not loading" waits and
  killed queued generations mid-run. In production the server now pings its
  own new unauthenticated `/healthz` endpoint every 10 minutes to stay
  warm. Disable with `PAGE_TAILOR_KEEP_ALIVE=off` (do so on always-on paid
  instances, where it is pointless). Also point the host's health check at
  `/healthz` so deploys only switch over once the server actually serves.
- **"App never loads" fixes.** The server-side render was hard-aborted
  after 6 seconds, which turned a slow render on a small or just-woken
  instance into a dead page — the window is now 21s. And SQLite now runs in
  WAL journal mode (set automatically on boot, persistent), so a background
  generation writing no longer locks every admin page read out of the
  database ("database is locked" stalls).
- **Misc:** the dashboard's per-experiment alert checks run in parallel;
  the article review page loads its DB reads in parallel.

## Update steps

1. **Keep your environment-specific files.** The ZIP intentionally ships
   placeholders for these - do NOT let them overwrite your live versions:
   - `shopify.app.toml` - keep yours (it has the real `client_id`,
     `application_url`, `[auth] redirect_urls`, `[app_proxy] url`). If you
     overwrite it by accident, re-add those four values or run
     `npm run shopify -- app config link`.
   - `.env` - not in the ZIP; keep yours.
   - The production SQLite database volume - untouched by this update.
2. **Replace the code.** Unzip over your working copy (everything except the
   files above is safe to replace wholesale), or diff-and-merge if you have
   local changes.
3. **Install and verify locally:**

   ```shell
   npm ci
   npx tsc --noEmit
   npm run build
   ```

4. **Redeploy the server** the same way it was first deployed (e.g. push to
   Render). The Prisma client is now generated at build time (Dockerfile /
   npm install); the boot command (`npm run docker-start`) only runs
   `prisma migrate deploy`, which keeps cold starts short. This release
   ships no new migrations, so that step is a fast no-op; existing data is
   untouched.
5. **On the host (Render dashboard):** set the service's **Health Check
   Path** to `/healthz`, so deploys only switch over once the new server
   actually serves. While there, check the instance type: on a free
   (sleeping) instance the built-in keep-alive masks spin-down but consumes
   free instance hours; an always-on paid instance is the clean fix (then
   set `PAGE_TAILOR_KEEP_ALIVE=off`). Also confirm a persistent disk backs
   the SQLite file — without one, app data resets on restarts.
6. **Theme extension: nothing to do.** This release changes no extension
   files, so `npm run deploy` is not needed (running it anyway is harmless).

## Post-update verification

1. `https://<your-host>/healthz` in a plain browser tab returns `ok`
   instantly.
2. Open the app from Shopify Admin: it should render promptly. Click
   between Articles → Add articles → Settings → Experiments and back —
   after the first visit of each page, navigation should feel instant
   (loaders no longer wait on Shopify lookups).
3. Leave the app untouched for 20+ minutes, then open it again: no ~60s
   dead wait (the keep-alive held the instance warm).
4. Queue a generation and, while it runs, click around the admin: pages
   keep loading normally (WAL mode - reads no longer block on the
   generation's writes).

## Behavior notes

- Draft/unpublished products: live-page surfaces are skipped automatically
  (there is no live page to read); the admin-sourced surfaces still generate.
- Password-protected storefronts: generation fails with a clear error while
  the password is on, because the app cannot read the live page regions.
- Background queue and hosting: the queue lives in the app's server process.
  If the host puts idle services to sleep (e.g. free tiers), queued
  generations pause with the process and resume on the next visit to the
  app. The server now self-pings `/healthz` every 10 minutes in production
  to keep such hosts awake (disable with `PAGE_TAILOR_KEEP_ALIVE=off`);
  an always-on instance is still the most reliable option for batch
  generation.
- Rollback: redeploy the previous server build; this release adds no
  migrations, so the database needs no changes either way. (The database
  file stays in WAL journal mode, which older builds read and write
  normally.)
