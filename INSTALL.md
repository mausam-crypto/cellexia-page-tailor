# Page Tailor — developer installation guide

This is a complete, self-contained Shopify app (Remix + TypeScript). Read
[README.md](README.md) first for what the app does; this file is the
step-by-step to get it running in development and then in production.

**The golden rule of this app:** installing it must change nothing on the
storefront. The theme embed ships disabled and the master serving switch in
the app's Settings starts OFF. Note: once serving is ON, generated variants
go live automatically and the merchant is notified to review them
(post-publication review model) — the serving switch is the one gate in
front of that. Don't "fix" any of this — it's the product requirement.

---

## 0. Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js | `>=20.19` or `>=22.12` (Node 23 works too — a known Vite/Node-23.2 CSS issue is already worked around in the code) |
| Shopify Partner account | With access to the store (or a development store for testing first) |
| Anthropic API key | From <https://platform.claude.com> — used for copy generation and the claim guard |
| npm | The Shopify CLI is a local dev dependency — **no global install needed** |

## 1. Local development setup

```shell
unzip page-tailor-app.zip && cd shopify-app-product-page-customiser
npm install

# Attach the config to a Shopify app in the Partner org.
# When prompted, choose "Create a new app" (or select the existing one).
# This fills in client_id in shopify.app.toml.
npm run shopify -- app config link

# Local SQLite database
npx prisma migrate dev

# Environment
cp .env.example .env    # then edit .env and set ANTHROPIC_API_KEY
```

Start the dev server:

```shell
npm run dev
```

The CLI opens a tunnel, rewrites the app URL and the app proxy URL
automatically, and prompts you to install the app on the store. Approve the
scope grant (`read_products`, `read_translations`, `read_locales`,
`read_orders` — all read-only; the app never writes to the store).

## 2. One-time store configuration

1. **Theme embed:** Online Store → Themes → Customize → App embeds → enable
   **Page Tailor**. (View tracking for experiments starts only from this
   moment — enable it early even if you won't serve variants yet.)
2. **App Settings page:**
   - Enable the copy surfaces to adapt (product description + any Accentuate
     metafields) and set the CSS selector where each renders in the theme —
     see [docs/setup.md](docs/setup.md) §3 for how to find selectors.
   - Leave the **serving switch OFF** until the team wants variants live —
     once it is on, every successful generation serves immediately.
3. Optional but recommended for search-crawler parity: the `robots.txt.liquid`
   snippet in [docs/compliance.md](docs/compliance.md).

## 3. Smoke-test the full flow (dev store)

1. Settings → turn the serving switch ON (dev store only).
2. Articles → Add articles → pick a product, choose a language, paste one
   article URL (or its text) → Generate. On success the variant goes live
   automatically and the dashboard shows "Live — review needed".
3. Open the article's review page: check the side-by-side copy and any
   flagged claims, then click **Mark as reviewed** (the badge flips to
   "Live"). Also verify **Take offline** works and "Put live" restores it.
4. Open the variant URL shown on the article page — the mapped copy regions
   should swap. Remove the `?cx=...` parameter — the page must render the
   normal copy. Turn serving OFF — within ~2–4 minutes the variant URL must
   render normal copy again.

## 4. Production deployment

The app is a standard Remix server. A `Dockerfile` is included; any Node host
works.

1. **Host the server** with these environment variables:
   - `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` (from the Partner dashboard →
     the app → Client credentials)
   - `SHOPIFY_APP_URL` = `https://<your-host>`
   - `SCOPES=read_products,read_translations,read_locales,read_orders`
   - `ANTHROPIC_API_KEY` (and optionally `PAGE_TAILOR_MODEL`)
2. **Database:** the Prisma datasource is SQLite (`prisma/dev.sqlite`). In
   production either mount a persistent volume for the SQLite file, or switch
   the datasource in `prisma/schema.prisma` to Postgres/MySQL and re-run
   migrations. On boot run `npm run setup` (prisma generate + migrate deploy)
   — the Docker start command already does.
3. **Update `shopify.app.toml`:** set `application_url` to
   `https://<your-host>` and `[app_proxy] url` to `https://<your-host>/proxy`
   (deploy pushes what is in the toml — it does not infer URLs).
4. **Push config + theme extension:**

   ```shell
   npm run deploy
   ```

5. Re-check section 2 on the production store (embed, settings, serving
   switch) and section 3's smoke test.

## 5. Things to know before touching the code

- **Never add user-agent, referrer, bot, or randomized branching** to the
  theme embed or proxy routes. Same URL → same content for every visitor is
  the app's core compliance guarantee ([docs/compliance.md](docs/compliance.md)).
- The serving switch, the generation lock, and the review-state guards are
  enforced **server-side**; the experiment early-stop thresholds live in
  `app/services/stats.server.ts`. Don't weaken them casually.
- Shopify API version is pinned to `2026-04` in three places that must stay in
  sync: `app/shopify.server.ts`, `shopify.app.toml` (webhooks), `.graphqlrc.ts`.
- `@shopify/shopify-app-session-storage-prisma` must stay ≥9 (matches the
  `@shopify/shopify-api` v13 used by `shopify-app-remix` 4.2).
- Polaris CSS is imported as a side-effect (not `?url`) on purpose — the
  `?url` form breaks SSR builds on Node ≥23.2.

## 6. Troubleshooting

See the table in [docs/setup.md](docs/setup.md) §6. First checks for "nothing
happens on the storefront": app embed enabled? variant live (not taken offline)? serving
switch ON? embed `param_name` matches Settings? selector actually matches an
element?
