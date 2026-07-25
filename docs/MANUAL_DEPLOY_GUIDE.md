# Manual deploy guide — Page Tailor

For when a new update ZIP arrives and no one is available to run it through
Claude. Follow this in order.

## 0. Where everything lives

| Thing | Value |
|---|---|
| Canonical working copy | `cellexia-apps/page-tailor-app/Cellexia-page-tailor-app` |
| GitHub | `github.com/mausam-crypto/cellexia-page-tailor` (branch `master`) |
| Render service | `cellexia-page-tailor` → `cellexia-page-tailor.onrender.com` |
| Render database | `cellexia-page-tailor-db` (Postgres, free plan) |
| Shopify Partner org | Cellexia Ltd |
| Client ID | `24912e424a44ae220c00e7e2a070273f` |
| App proxy subpath | `apps/cx/*` — deliberately short and distinct from the AOV app's `cellexia` and the Reviews/Subscriptions apps' longer subpaths. Don't let an update regress this back to `cellexia`. |
| Extra env vars this app needs | `ANTHROPIC_API_KEY` (Claude API key used for page-copy generation), `PAGE_TAILOR_MODEL` (currently `claude-opus-4-8`) |

## 1. Before touching anything

```bash
cd page-tailor-app/Cellexia-page-tailor-app
git status --short      # must be empty
ls shopify.app*.toml     # must show exactly ONE file
```

## 2. Diff against the last real update, not this repo

Same reasoning as every other app in this family: this canonical folder's
files have already had prior fixes applied, so diffing a new ZIP against it
directly will show noise. Keep the previous update ZIP around if you can and
diff the new one against *that* instead:

```bash
diff -rq /path/to/previous-update/... /path/to/new-update/... \
  --exclude=node_modules --exclude=.git --exclude=build --exclude=dist \
  --exclude=.env --exclude=".shopify"
```

Read `UPDATE.md`/`CHANGELOG.md` in the new ZIP fully before touching code.

## 3. Files that will look "changed" but are NOT — never copy these over

- **`app/shopify.server.ts`** — same three-part regression as every app in
  this family: missing `import "dotenv/config"`, missing the
  `process.env.SHOPIFY_APP_URL || process.env.RENDER_EXTERNAL_URL || ""`
  fallback, and `distribution: AppDistribution.AppStore` instead of
  `AppDistribution.SingleMerchant`. Keep this repo's version. (The
  `AppStore`-vs-`SingleMerchant` mistake is exactly what caused a long-lived
  `shopLocales` access-denied bug the first time this app was set up — it's
  not a cosmetic detail.)
- **`package.json`** — keep this repo's `docker-start` (`setup:production`,
  using `prisma db push` against `schema.production.prisma`) rather than the
  export's `setup` (`prisma migrate deploy`, which is SQLite-dialect and
  will fail against this app's Postgres database).
- **`shopify.app.toml`** — never overwrite `client_id`, `application_url`,
  `redirect_urls`, or `[app_proxy]`. This repo's scopes are already correct
  (`read_products,read_translations,read_locales,read_orders`) — Page
  Tailor has not had the invented-scope problem the AOV app has had, but
  verify any new scope actually exists before adding it regardless.
- **`.gitignore`** — must keep the `!.env.example` exception (so the example
  file stays tracked) and must NOT exclude `package-lock.json` (needed for
  `npm ci` inside the Dockerfile). The export has shipped a `.gitignore`
  missing both of these before.

## 4. Files the export tends to omit entirely

- **`extensions/page-tailor/locales/en.default.json`** — this required
  folder/file has been missing from more than one export ZIP. If it's
  missing, recreate it yourself with just `{}` — an empty object is a valid,
  correct default locale file for a theme extension.

## 5. Sanity suite

```bash
npm install
npx prisma generate
npx tsc --noEmit                 # if this app has a typecheck script, use `npm run typecheck` instead
npm run build
npx shopify app build
```

## 6. Deploy

```bash
git add -A
git commit -m "describe what actually changed"
git push origin master           # Render auto-deploys the app server

ls shopify.app*.toml              # re-check: exactly one file
npx shopify app deploy --allow-updates
```

Confirm Render redeployed:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://cellexia-page-tailor.onrender.com/ --max-time 20
```

Should return `200`.

## 7. Safety

The AI-generated page copy always requires human approval before going live
— nothing an update ships should change that gate. If a new release ever
touches the approval/review flow, read that part of the diff especially
carefully before merging.
