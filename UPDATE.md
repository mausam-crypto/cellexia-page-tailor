# Updating a live Page Tailor deployment

This guide is for updating an already-deployed installation. For first-time
setup, use [INSTALL.md](INSTALL.md).

## What's new in this update (2026-10-21 — briefs, refinements, version history)

This release adds a second way to create variants and a history for every
variant. It **ships one database migration** (`briefs_and_versions`), **no
theme-extension changes, no scope or config changes**.

- **Add briefs.** A new admin page (nav: *Add briefs*). Pick a product, tick
  one or more languages, add as many briefs as you like (name, brief text,
  optional references as pasted text and/or links, optional Advanced fields:
  audience, key message, tone, must say, must avoid). Each brief × language
  becomes its own variant with its own URL, queued for background generation
  immediately and live automatically, like article variants.
- **Free writing with review flags.** Brief-based pages are written to the
  brief, not limited to facts on the page. The claim guard still flags risky
  wording, and claims found in neither the page, the brief, nor the
  references are listed per section as *Unverified claims* (information for
  review; nothing blocks).
- **Refine with a prompt.** On a brief page's review screen: type what
  should change; the model edits the current copy (hand edits included) and
  leaves everything else alone. *Edit brief* and *Start over* complete the
  loop. Refinements run through the same background queue as generations.
- **Version history for every variant** (articles too): each generation,
  refinement, hand edit and restore is kept; any version can be restored
  with one click. Existing variants get a baseline version the first time
  anything changes them.
- **Duplicate** any variant to a fresh URL (brief, copy and history copied).
- **View on storefront** button on the review page.
- Dashboard: *Brief* badge and brief name in the Article column, a *Source*
  filter (Articles / Briefs), a *Source* column in the CSV export.

## What's new in the previous update (2026-09-19 — performance & reliability)

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
   Render). The Prisma client is generated at build time (Dockerfile /
   npm install); the boot command (`npm run docker-start`) runs
   `prisma migrate deploy`, which applies this release's one migration
   (`briefs_and_versions`: new nullable columns on Article and Override, a
   new VariantVersion table, and a one-line backfill that marks pasted
   articles as such). Existing variants and their live copy are untouched.
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
5. Run the brief-feature checklist below once on a development store
   before (or right after) the production deploy.

## Testing the brief feature (2026-10-21 release)

Prerequisites on the test store: theme app embed enabled, serving ON in
Settings, the storefront password removed (or the live-page surfaces
disabled in Settings), `ANTHROPIC_API_KEY` set. Each step says what you
should see; anything else is a bug.

1. **Add briefs** (nav). Pick a product, tick two published languages, add
   brief A (name, English text, one reference link plus a pasted paragraph,
   Advanced: audience + must avoid) and brief B (text written in French, no
   references). Submit. The dashboard shows 4 rows marked *Queued* with a
   *Brief* badge; the *Source* filter set to *Briefs only* shows exactly
   those 4 and *Articles only* hides them.
2. Wait for all 4 to reach *Live — review needed* (a minute or two each).
   Open brief A's French row: the copy is in French, sections the brief
   does not concern are identical to *Original*, any *Unverified claims*
   banner is blue (informational), and there is no "reference could not be
   read" banner (if there is one, the link was unreachable — fine, as long
   as the page still generated).
3. **View on storefront** opens the `?cx=` URL and the tailored copy is
   visible; the clean product URL still shows the normal page.
4. **Refine**: type "Make the tagline mention morning use; leave everything
   else as it is". A *Refining…* banner appears, then only the tagline
   differs from before; the status is back to *review needed*; *Version
   history* shows a *Refined* version with that instruction.
5. **Mark as reviewed**, then hand-edit the Overview text box and *Save
   edits*: live within ~2 minutes, history shows *Edited: Overview*, and
   the *Reviewed* stamp is still there (hand edits do not reset review).
6. **Refine** again with "Shorten the overview": the result builds on the
   hand-edited text (your edit is still visible in it), not on the
   generated text.
7. **Restore** version 1 from the history: a *Restored* version appears,
   the copy equals the first generation, the storefront reflects it within
   ~2 minutes. In a second tab opened before the restore, *Save edits*
   fails with the "copy changed since you loaded this page" message.
8. **Edit brief** (change *Must avoid*), save, then **Start over**: a new
   *Generated* version from the base copy; earlier refinements are gone
   from the live copy but still listed in the history.
9. **Duplicate**: a new row named "… (copy)" with a different `?cx=` value,
   the same copy, the whole history plus a *Duplicated* entry; the original
   is unchanged.
10. Force a refinement failure (temporarily unset `ANTHROPIC_API_KEY` and
    restart, or type an instruction that empties a section such as "delete
    all tagline text"): a *Last refinement failed* banner shows the reason,
    the live copy is unchanged, no new version was added.
11. Dashboard *Export … to CSV*: the file has a *Source* column, the brief
    names in the *Article* column, and the variant URLs. *Generate all
    pending* on a failed brief row re-runs it as a brief (no "article has
    no content" error).
12. Delete one brief variant: its `?cx=` URL falls back to the clean page
    within ~4 minutes and nothing else is affected.

Existing article variants: regenerate one and hand-edit it once. Its
review page now shows a *Version history* with a baseline version
(captured the first time it changed), the regeneration and the edit;
*Restore* works the same way. Nothing else about article variants changes.

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
- Rollback: redeploy the previous server build. The migration only adds
  nullable columns and one new table, which the previous build ignores, so
  the database needs no changes to roll back; brief-based variants created
  on this release would then show as pasted articles in the old UI, so
  take them offline (or delete them) before rolling back.
