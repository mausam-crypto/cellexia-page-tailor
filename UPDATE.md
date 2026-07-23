# Updating a live Page Tailor deployment

This guide is for updating an already-deployed installation. For first-time
setup, use [INSTALL.md](INSTALL.md).

## What's new in this update

- Four new built-in copy surfaces whose original copy is read from the
  rendered storefront page itself, so whole theme tab panels (heading + body)
  are adapted and swapped together with no theme changes:
  Tagline (`#persona-tagline`), Overview (`.persona-overview-target`),
  Benefits (`.persona-benefits-target`), Science (`.persona-science-target`).
  They appear in the app's Settings automatically, pre-filled and enabled.
- The default description selector is now `#persona-description`.
- The theme embed's default anti-flicker hold list now covers all five
  regions (existing embed installs keep their old value - see step 5).
- **Background generation queue.** Generate no longer blocks the browser:
  clicking Generate (or "Generate all pending") queues the work server-side
  and returns immediately. ALL queued articles generate in parallel (no
  concurrency cap), and the work continues even if the admin closes the
  page - the dashboard and review pages poll and update themselves while
  anything is running. "Generate all pending" now also retries failed
  articles. Note: very large batches can exceed Anthropic/Shopify API rate
  limits; calls retry with backoff automatically, and anything that still
  fails shows as "Failed" with one-click retry.
- **Portuguese (and regionless locales generally) fixed.** The shop
  publishes "pt" but the storefront runtime reports "pt-PT" to the embed,
  so Portuguese variants never served. Serving now lets a regionless stored
  locale cover its regional variants (pt covers pt-PT and pt-BR; regional
  locales stay exact). The claim-guard heuristics also gained Portuguese
  patterns, and the copy prompt now pins the original's regional variety
  (European Portuguese stays European Portuguese).
- **Filterable link list + CSV export.** The dashboard list can be
  filtered by product, language, and Meta mode (stackable with the status
  tabs and search). Rows are selectable; "Export ... to CSV" downloads
  either the ticked rows or the whole filtered list as a spreadsheet with
  product, language, article link, variant URL, live state, Meta tag,
  status, detected query, and creation date. Untrusted text is neutralized
  against spreadsheet formula injection.
- **One additive database migration** (generation queue column) runs
  automatically on boot via `prisma migrate deploy` - no manual step, no
  data affected.

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
   Render). The boot command (`npm run docker-start` / `npm run setup`) runs
   `prisma generate` + `migrate deploy` automatically - this release applies
   one additive column; existing data is untouched.
5. **Push the updated theme extension:**

   ```shell
   npm run deploy
   ```

   Then, in the merchant's theme editor (App embeds → Page Tailor), update
   the **"Selectors to hold during swap"** field by hand to:

   ```text
   #persona-tagline,#persona-description,.persona-overview-target,.persona-benefits-target,.persona-science-target
   ```

   (Schema defaults only apply to fresh embed installs; existing installs
   keep the previously saved value, so this one field needs a manual paste.)

## Post-update verification

1. Open the app → Settings: four "live page region" rows are present,
   pre-filled with the selectors above, enabled, swap mode locked to HTML.
2. Queue two or more articles (Generate on each row, or "Generate all
   pending"): the response is instant, both show "Generating…" at the same
   time, and closing the tab does not stop them - reopen the app to see
   them land as "Live - review needed".
3. Open a variant URL: the tagline, description, and the Overview,
   Benefits, and Science tabs should all show adapted copy. Remove the
   `?cx=...` parameter and confirm the normal page renders.
4. Portuguese check: open a live pt variant URL - it must swap now (the
   pt/pt-PT locale mismatch is fixed server-side; no regeneration needed).
5. Dashboard: the filter row (product / language / meta mode) appears above
   the list, rows are tickable, and "Export ... to CSV" downloads a
   spreadsheet of the filtered or selected links.

## Behavior notes

- Draft/unpublished products: live-page surfaces are skipped automatically
  (there is no live page to read); the admin-sourced surfaces still generate.
- Password-protected storefronts: generation fails with a clear error while
  the password is on, because the app cannot read the live page regions.
- Background queue and hosting: the queue lives in the app's server process.
  If the host puts idle services to sleep (e.g. free tiers), queued
  generations pause with the process and resume on the next visit to the
  app. Use an always-on instance for predictable batch generation.
- Rollback: redeploy the previous server build; the added column is ignored
  by older builds and the database needs no changes. Variants generated WITH page surfaces stay safe on the old
  build: the description keeps serving, and the tab-region swaps simply stop
  (fail open - visitors see the original tabs) until the new build is
  redeployed.
