# Page Tailor — setup & operations

## 1. Shopify app setup

### Link the app config

```shell
npm install
npm run shopify -- app config link
```

This attaches `shopify.app.toml` to an app in your Partner organization and fills
in `client_id`. Run it once per clone.

### App proxy

The proxy is already declared in `shopify.app.toml`:

```toml
[app_proxy]
url = "https://example.com/proxy"
subpath = "cx"
prefix = "apps"
```

Storefront requests to `https://<shop>/apps/cx/*` are forwarded to this app at
`/proxy/*` — so the theme embed's fetch to `/apps/cx/variant` lands on
`app/routes/proxy.variant.ts`. During `npm run dev` the CLI rewrites `url` to
your tunnel automatically. For production, set `url` in `shopify.app.toml` to
your hosted app URL (`https://<your-host>/proxy`) yourself, then run
`shopify app deploy` to push the config — deploy pushes what is in the toml, it
does not infer the URL. Shopify signs every proxied request and
`authenticate.public.appProxy` verifies the signature, so the endpoint only
answers for real storefront traffic of the installed shop.

### Scopes

| Scope | Why |
| --- | --- |
| `read_products` | Product copy (`descriptionHtml`) and metafields — Accentuate fields are plain metafields |
| `read_translations` | Localized copy managed by Translate & Adapt (Translations API) |
| `read_locales` | Published shop locales, used to localize base copy and build variant URLs |
| `read_orders` | Experiment tracker only — syncs order totals for the baseline/treatment windows |

No write scopes: the app never modifies products, metafields, orders, or
translations. Variants live only in the app database. Shops that installed
before `read_orders` was added are prompted to re-consent to the new scope.

### Database

SQLite via Prisma. For local development:

```shell
npx prisma migrate dev
```

For production (also run by `npm run setup` / the Docker start command):

```shell
npx prisma migrate deploy
```

### Dev vs deploy

- **Dev:** `npm run dev` (Shopify CLI: tunnel, proxy URL rewrite, env injection,
  hot reload). Install the app on your development store when prompted.
- **Deploy:** `npm run deploy` pushes the app configuration (including the proxy)
  and the theme extension; host the Remix app wherever you like (see the
  `Dockerfile`) with `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`,
  `ANTHROPIC_API_KEY` set.

## 2. Theme embed

1. Online Store -> Themes -> Customize -> **App embeds** -> enable **Page Tailor**.
2. Embed settings:
   - **param_name** — must match the "URL parameter name" in the app's Settings
     page (default `cx`). If they disagree, the embed looks for a parameter the
     app never emits and no variant ever loads.
   - **hide_selectors** — optional comma-separated CSS selectors to hide while the
     variant payload is being fetched, to avoid a flash of the original copy.
   - **max hold** — the longest time (ms) the embed will keep those regions hidden
     waiting for the payload. On timeout or any error the original copy is shown
     unchanged (fail-open).

The embed does nothing at all when the URL has no variant parameter.

## 3. Finding CSS selectors for surfaces

Each enabled surface in Settings needs the CSS selector where that copy renders
on the product page:

1. Open a product page in the storefront, right-click the copy block -> Inspect.
2. Pick the most **stable, specific** container: theme classes like
   `.product__description` (Dawn family) are good; generated/hashed classes
   (`.css-1a2b3c`, `.x7f9k`) will break on the next theme update — avoid them.
   Prefer a class or `id` that names the section.
3. For **Accentuate-rendered sections**, inspect the wrapper the theme section
   renders the metafield into (often a custom section or block with its own
   class). The selector must target the element whose innerHTML/text is the
   metafield content — not a parent that also contains headings or images you
   don't want replaced.
4. `mode` must match the content: `html` surfaces are swapped via innerHTML
   (sanitized server-side), `text` via textContent.
5. **Selector safety:** selectors that target price, reviews/ratings,
   structured data (`itemprop`, `ld+json`), canonical, or metadata/script
   elements are rejected on save and filtered again at serve time — those parts
   of the page are off limits by design.
6. **Metafield types:** only single-line text, multi-line text (and legacy
   `string`) product metafields are offered as surfaces. `rich_text_field` and
   `json` types are excluded — their values are structured JSON, and swapping
   them as strings would corrupt them. Accentuate fields stored as text types
   appear normally.
7. **Adaptation depth (per surface):** each surface can override the shop-wide
   default depth. Light = emphasis/reordering only; Medium = rephrase/extend
   existing sentences; Deep = may additionally add sentences (and a few
   paragraphs/list items) targeted at the reader's specific concern, built
   strictly from claims already on the page. Deep naturally triggers more
   claim-guard flags — that is the guard doing its job; review them promptly
   once the variant is live.
8. **Tagline example (Cellexia theme):** the one-sentence tagline under the
   product name renders in `.pdp__blurb` and has a stable `#persona-tagline`
   hook. Enable its metafield in Settings, set the selector to
   `#persona-tagline`, swap mode Plain text, depth Light — the model adapts it
   only when it genuinely helps, and one sentence in means one sentence out.
9. **Test with the theme preview:** open a live variant URL against the
   theme you're editing and confirm the right block swaps. If the selector
   matches nothing, the page simply renders unchanged — check the selector in
   DevTools with `document.querySelector('...')`.

## 4. Locales

- Articles are created per product **and per language**; generation uses the
  locale's base copy from the Translations API, falling back to primary-locale
  content for untranslated fields.
- Variant URLs use Shopify's subfolder convention: primary locale
  `https://shop.example/products/handle?cx=...`, other locales
  `https://shop.example/fr/products/handle?cx=...`.
- If your shop uses **different international domains** (e.g. `cellexia.fr`
  instead of `/fr/` on the primary domain) or **Shopify Markets
  country-suffixed prefixes** (e.g. `/fr-ca/`), the app still builds plain
  locale-subfolder URLs from the primary domain — adjust the host or prefix of
  the copied URL before pasting it into the article. The variant itself still
  works: the payload is matched by parameter and storefront language, not by
  the URL prefix.
- The proxy checks the requested locale against the article's locale; a variant
  generated for `fr` will not render on the `en` page (fail-open).

## 5. Experiments

The experiment tracker compares a **baseline period** (the last N full UTC days
before the experiment starts; N is 7, 14, 21, or 28) against a **treatment
period** (the next N days) for one product and one language. It is not an A/B
test — only one version of the page is ever live for a market at a time.

### Prerequisites

- **App embed enabled.** View tracking starts the moment the embed is enabled —
  and not before. Enable it well before you want baseline conversion rates, so
  the baseline window has view data too.
- **`read_orders` scope granted** (already-installed shops are prompted to
  re-consent on next admin visit).

### Workflow

Order matters — create the experiment *before* the variants go live:

1. **Create the experiment.** The baseline is the last N full UTC days; the app
   backfills baseline orders from Shopify (apps can read up to 60 days of order
   history, so all allowed windows fit). Backfill can take ~10–30 seconds.
   Treatment starts the day the experiment is created (UTC days).
2. **Approve** the product's variants for that language.
3. Turn **ON** the serving switch in Settings.
4. **Update the article links** to the variant URLs.

### Reading the report

Each metric shows baseline vs treatment with a % change and a significance
figure. Metrics show **"Not enough data"** until minimums are met: 20 orders
for AOV and per-order rates, 200 views in *each* window for conversion rate,
and 5 days for revenue. Conversion rate additionally requires view coverage of
**both** windows — if the embed was enabled after the baseline began, baseline
views are missing and conversion rate cannot be compared.

### Early stop

An early-stop warning means a decline in conversions, AOV, or revenue is larger
than chance would plausibly explain. What to do: **Stop the experiment**, then
**turn serving off** in Settings (or take the product's variants offline) — the
page reverts to the original copy within ~2 minutes.

The bar is deliberately strict (at least 5 treatment days, one-sided p < 0.01,
at least a 5% relative drop) because checking the numbers every day —
sequential testing — inflates false positives. Four guarded metrics are
monitored at once, which also inflates the family-wise false-positive rate
slightly; the strict p < 0.01 threshold budgets for that. Most day-to-day dips
are noise; the warning fires only when the pattern is unlikely to be. Alerts
are computed only from fully synced, completed UTC days — the in-progress day
and unsynced order data can never fire one.

### Limitations

Honestly:

- A period comparison is **not randomized**. Seasonality, promotions, and
  ad-spend changes confound it — keep ad spend steady during the experiment
  for a clean read.
- Days are **UTC**, not shop-local.
- Orders are attributed to a language via the order's **customer locale**;
  orders without one count toward the primary language.
- If the product **handle changes** mid-experiment, view tracking breaks (the
  beacon reports views by handle).

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Variant not showing | Theme embed disabled | Enable the Page Tailor app embed in the theme editor |
| Variant not showing | Selector matches nothing | Re-check the selector in DevTools; see section 3 |
| Variant not showing | Variant taken offline | Only live variants are served; put it back live on the article page |
| Variant not showing | Locale mismatch | The URL's locale prefix must match the article's language |
| Variant not showing | Param name mismatch | Embed `param_name` must equal Settings -> URL parameter name |
| Flash of original copy | Payload arrives after first paint | Add the surface selectors to `hide_selectors` and/or raise **max hold** |
| Generation error: "ANTHROPIC_API_KEY is not set" | Missing env var | Add the key to `.env` and restart |
| Generation error: fetch failed / could not extract text | Article host blocks bots or renders client-side | Open the article, copy its text, and use the paste-content option instead of the URL |
| Generation error: "No copy surfaces with content found" | No enabled surface has content for this product/locale | Enable surfaces in Settings; check the product actually has that description/metafield |
| Variant still live shortly after taking it offline | Proxy responses cache 120s; visitors hold a 120s client cache | Wait ~2–4 minutes; no action needed |
| Edits not visible on the storefront yet | Proxy responses cache 120s | Edits to live variants apply within ~2–4 minutes |
| Old variant URLs stopped working | The product's handle changed (URLs embed the handle) | Re-create the articles for the new handle and update the links (the article links would 404 anyway) |
| Experiment shows no views | App embed not enabled, or enabled after the baseline window began | Enable the embed; views only accrue from that moment — for baseline coverage, enable it at least one full window before creating the experiment |
| Conversion rate says "not enough data" | Missing view coverage for one window, or under 200 views per window | Ensure the embed was on for the whole baseline; otherwise wait for more traffic — other metrics still report |
| Order backfill truncated | Very high volume store — more than 5000 orders in the sync window | The report is based on partial order data; use a shorter baseline window |
