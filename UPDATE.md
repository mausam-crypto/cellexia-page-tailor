# Updating a live Page Tailor deployment

This guide is for updating an already-deployed installation. For first-time
setup, use [INSTALL.md](INSTALL.md).

## What's new in this update (live-page surfaces)

- Four new built-in copy surfaces whose original copy is read from the
  rendered storefront page itself, so whole theme tab panels (heading + body)
  are adapted and swapped together with no theme changes:
  Tagline (`#persona-tagline`), Overview (`.persona-overview-target`),
  Benefits (`.persona-benefits-target`), Science (`.persona-science-target`).
  They appear in the app's Settings automatically, pre-filled and enabled.
- The default description selector is now `#persona-description`.
- The theme embed's default anti-flicker hold list now covers all five
  regions (existing embed installs keep their old value - see step 5).
- **No database schema changes in this release.** The boot-time
  `prisma migrate deploy` is a safe no-op.

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
   `prisma generate` + `migrate deploy` automatically - a no-op this release.
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
2. Regenerate one article (Regenerate on its review page). Generation now
   also fetches the live product page to read the tab regions; the variant
   goes live automatically with a "Live - review needed" notice.
3. Open the variant URL: the tagline, description, and the Overview,
   Benefits, and Science tabs should all show adapted copy. Remove the
   `?cx=...` parameter and confirm the normal page renders.

## Behavior notes

- Draft/unpublished products: live-page surfaces are skipped automatically
  (there is no live page to read); the admin-sourced surfaces still generate.
- Password-protected storefronts: generation fails with a clear error while
  the password is on, because the app cannot read the live page regions.
- Rollback: redeploy the previous server build; the database is untouched by
  this release. Variants generated WITH page surfaces stay safe on the old
  build: the description keeps serving, and the tab-region swaps simply stop
  (fail open - visitors see the original tabs) until the new build is
  redeployed.
