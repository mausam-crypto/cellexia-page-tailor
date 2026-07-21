# Page Tailor

Per-article product-page copy variants for Cellexia's advertorial funnel.

The marketing team drives AdWords traffic to editorial "top 5" articles that link to
Cellexia product pages. For each article, Page Tailor generates an **approved,
per-article variant** of the product page copy and serves it via a URL parameter
(e.g. `?cx=a7k2m9x4`). One URL per article. The Shopify product itself is **never
modified** — variants live only in the app's database and are swapped in
client-side by a theme app embed.

Every visitor to the same URL sees identical content. There is no user-agent,
referrer, or bot branching anywhere in the pipeline — deterministic per-URL
content, not cloaking. See [docs/compliance.md](docs/compliance.md) for the full
argument.

**Safe by default.** Installing the app changes nothing on the storefront: the
theme app embed ships disabled and the master serving switch in Settings is
OFF until you explicitly turn it on. Once serving is on, generated variants go
live automatically and the app notifies you to review each one
(post-publication review). Turning the switch off again is the kill switch —
all variants stop serving for new visitors within ~2 minutes, and within
~4 minutes for visitors holding a client-side cache.

## How it works

```
Article URL added in admin (per product, per language)
        |
        v
Claude reads the article
  - infers the target search query (with evidence)
  - adapts the enabled copy surfaces (description, Accentuate metafields)
    constrained to RE-EMPHASIZE existing copy -- no new claims allowed
        |
        v
Claim guard (independent model pass + deterministic heuristics)
  flags anything new: percentages, clinical language, guarantees,
  rankings, urgency -> warnings block approval until a human clears them
        |
        v
Human review in the admin UI -> Approve
        |
        v
Variant URL:  https://shop.example/products/handle?cx=<opaque-8-char>
        |
        v
Theme app embed reads the param
  -> fetches JSON from the signed app proxy (/apps/cx/variant)
  -> swaps the designated copy regions client-side (sanitized HTML / text)
  -> on any miss (unknown handle, unapproved, wrong locale, network error):
     FAIL OPEN -- the normal product page renders untouched
```

## Quick start

Prerequisites:

- Node.js `>=20.19` (or `>=22.12`)
- A Shopify Partner account and a development store
- An Anthropic API key (`ANTHROPIC_API_KEY`)

The Shopify CLI is a dev dependency — no global install needed; `npm run dev`
works after `npm install`.

```shell
npm install
npm run shopify -- app config link   # attach shopify.app.toml to your Partner app
npx prisma migrate dev               # create the local SQLite database
cp .env.example .env                 # then fill in ANTHROPIC_API_KEY
npm run dev
```

Then:

1. In the Theme editor, enable the **Page Tailor** app embed (App embeds section).
2. In the app's **Settings** page, enable the copy surfaces you want to adapt and
   set their storefront CSS selectors.

Full setup and operations guide: [docs/setup.md](docs/setup.md).

## Integration notes

**Accentuate Custom Fields.** Accentuate stores its data as plain Shopify product
metafields, so its fields appear automatically in the app's Settings page (the app
lists single-line and multi-line text metafield definitions; `rich_text_field`
and `json` types are excluded because their values are structured JSON). To
adapt an Accentuate-rendered section, enable its metafield in Settings and map
it to the CSS selector where your theme renders it on the product page.

**Translate & Adapt.** Localized copy is read from Shopify's Translations API per
locale — both the product `body_html` and metafield values. A variant for locale X
is generated from the locale-X base copy; any field without a translation falls
back to the primary-locale content. Variant URLs for non-primary locales use the
subfolder convention (`/fr/products/...`).

**Adaptation depths.** Every surface has an adaptation depth (per-surface, with a
shop-wide default): **Light** re-emphasizes and reorders only (≥80% of wording
unchanged); **Medium** rephrases and extends existing sentences; **Deep** may also
add sentences — and a few paragraphs/list items in HTML surfaces — that speak
directly to the reader's specific concern, assembled strictly from claims already
on the page. The claim guard applies identically at
every depth, and its findings are flagged for post-publication review. Typical setup: the one-sentence
**tagline** under the product name runs Light (adapted only when it makes sense),
descriptions run Medium or Deep.

## Team workflow

1. **Add** the list of article URLs for a product, per language (or paste the
   article text if the URL can't be fetched).
2. **Generate** — Claude infers the target query and adapts the enabled surfaces.
3. **Live automatically** — the variant goes live the moment generation
   succeeds (while the master serving switch is on). The dashboard notifies
   you with a "Live — review needed" state.
4. **Review** — read the adapted copy side by side with the original, check any
   claim-guard flags, then **Mark as reviewed** — or **Take offline** with one
   click (stops serving within ~2–4 minutes across proxy + client caches).
   Edits to a live variant apply to the storefront on the same timeline.
5. **Copy URL** — the app builds the full storefront URL for the right locale.
6. **Paste** the URL into the article's CTA link.

## Experiment tracker

Measures the impact of serving variants for one product + language by comparing
a **baseline period** (the N full UTC days before the start) against a
**treatment period** (the next N days). This is explicitly **not an A/B test**:
only one version of the page is ever live for a market at any moment —
sequential periods, by design, for ad compliance.

Metrics tracked, each baseline vs treatment: orders/day, product revenue/day,
average order value, conversion rate (orders ÷ product views), units/day, and
views/day.

**Early-warning monitor.** Statistical tests on the daily numbers detect within
days if conversions, AOV, or revenue drop more than chance would explain. The
thresholds are deliberately strict — at least 5 treatment days, one-sided
p < 0.01, and a relative drop of at least 5% — and a triggered alert shows in
the app with guidance to stop the experiment and turn serving off.

**How views are measured.** An anonymous beacon in the theme embed increments
daily aggregate counters per product/language only — no cookies, no user
identifiers, nothing per-visitor is stored.

The tracker adds the `read_orders` scope (orders are synced on demand from the
Admin API); shops that installed before this addition are prompted to
re-consent to the new scope.

## Documentation

- [INSTALL.md](INSTALL.md) — developer installation guide (dev + production)
- [docs/setup.md](docs/setup.md) — setup, theme embed, selectors, locales, experiments, troubleshooting
- [docs/compliance.md](docs/compliance.md) — why this design keeps ad-account risk low

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key used for generation and the claim guard |
| `PAGE_TAILOR_MODEL` | No | `claude-opus-4-8` | Model used for both passes |

`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `SCOPES` are managed by the Shopify
CLI during `npm run dev`; see [.env.example](.env.example) for manual/production
setups.
