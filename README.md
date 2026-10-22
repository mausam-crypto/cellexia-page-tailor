# Page Tailor

Per-article and per-brief product-page copy variants for Cellexia's funnels.

The marketing team drives AdWords traffic to editorial "top 5" articles that link to
Cellexia product pages. For each article, Page Tailor generates a
**per-article variant** of the product page copy and serves it via a URL parameter
(e.g. `?cx=a7k2m9x4`). One URL per article. For branded campaigns with no
article, a written **brief** does the same job (see [Briefs](#briefs-branded-campaigns)).
The Shopify product itself is **never modified** — variants live only in the
app's database and are swapped in client-side by a theme app embed. (The only
thing the app writes to the store is image files for illustrations, in the
store's Files.)

There is no user-agent,
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
  - adapts the enabled copy surfaces (description, live page regions,
    Accentuate metafields) using only claims the page or the article supports
        |
        v
Claim guard (independent model pass + deterministic heuristics)
  flags anything new: percentages, clinical language, guarantees,
  rankings, urgency -> findings shown for post-publication review
        |
        v
Live automatically -> human review in the admin UI
  (mark reviewed, edit, or take offline; every change is kept as a version)
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
   article text if the URL can't be fetched) — or add **briefs** for a branded
   campaign (see below).
2. **Generate** — Claude infers the target query and adapts the enabled surfaces.
3. **Live automatically** — the variant goes live the moment generation
   succeeds (while the master serving switch is on). The dashboard notifies
   you with a "Live — review needed" state.
4. **Review** — read the adapted copy side by side with the original, check any
   claim-guard flags, then **Mark as reviewed** — or **Take offline** with one
   click (stops serving within ~2–4 minutes across proxy + client caches).
   Edits to a live variant apply to the storefront on the same timeline, and
   every change is kept in the variant's **version history** (one-click
   restore).
5. **Copy URL** — the app builds the full storefront URL for the right locale.
6. **Paste** the URL into the article's CTA link.

## Briefs (branded campaigns)

For branded ads there is no article to feed the tool. **Add briefs** takes a
written brief instead: pick a product, tick one or more languages, and add as
many briefs as you like — each with a name, the brief itself, optional
references (pasted text and/or one link per line) and optional Advanced fields
(audience, key message, tone, must say, must avoid). Each brief × language
becomes its own variant with its own URL, generated in the background and live
automatically, exactly like article variants.

Brief-based pages differ from article-based ones in three ways:

- **Free writing.** The copy is written to the brief; it is not limited to
  facts already on the page. The claim guard still runs: risky wording
  patterns (drug-like words, guarantees, percentages, rankings, urgency) are
  flagged as before, and claims the checker finds in neither the page, the
  brief, nor the references are listed per section as **Unverified claims**.
  Nothing blocks; this is review information.
- **Refine with a prompt.** On the review page, type what should change
  ("shorten the FAQ", "make the Science headline about molecular size"). The
  model edits the current copy — hand edits included — and leaves everything
  else untouched; the result goes live and comes back as "Live — review
  needed". **Edit brief** changes the brief for the next refinement; **Start
  over** rewrites the page from the base copy with the current brief.
- **Default reach.** Unless the brief says otherwise, each region keeps its
  structure, roughly its length (it may grow by about a third) and the brand
  voice, and regions the angle does not concern are left unchanged.

Two features arrived with briefs and apply to every variant, articles
included:

- **Version history.** Each generation, refinement, hand edit and restore is
  kept as a version on the review page. Any version can be restored with one
  click; the current copy is kept as a new version, so a restore can itself
  be undone.
- **Duplicate.** Creates a copy of a variant with a fresh URL — brief, copy and
  history included — so you can iterate on the copy while an ad keeps pointing
  at the original, or spin a sibling angle off a page you like.

## Illustrations (Science and Overview tabs)

Brief- and article-based pages can carry a clinical-style illustration in
the Science and Overview tabs (any other HTML surface can be switched on in
Settings). Three sources:

- **Image library** (nav: *Image library*): upload PNG/JPEG/WebP illustrations
  with a name, a "what it shows" description, tags and the language of any
  labels inside. Files live in the store's own Shopify Files (CDN), which is
  why the app asks for the `write_files` permission. Every image the app draws
  lands here too, with the template, the full prompt and its cost.
- **AI drawing** through OpenAI's image model (`OPENAI_API_KEY`): a
  **template** (reusable drawing style with a category and a "when to use"
  note, nav: *Templates*; eight editable starters are seeded) plus a
  **specific prompt** for the image. Words, labelled figures and scientific
  graphs inside the image are allowed; they are rendered in the page's
  language, so a brief in three languages draws three images.
- **Recommend**: one click proposes five template + prompt ideas from the
  brief or article (and, on the review page, the section's current copy);
  tick the ones to draw.

Choose at creation time, per section (per brief in *Add briefs*; per batch in
*Add articles*): none / **Auto** (Claude recommends and draws the best idea
during generation, keeping the other four as suggestions) / a library image /
a template + prompt. The copy is written first and goes live; the figure is
then drawn (one to three minutes) and goes live with its caption, flagged for
review like the copy. On the review page each section has an illustration
panel: swap for an alternative or a library image, draw again, move the
figure, edit the caption and alt text, remove it, or retry a failed drawing.
Claude places the figure and writes the caption and alt text in the page's
language; the claim guard reads caption, alt and drawing prompt and lists
anything unsupported under *Unverified claims* (information only; a chart may
carry illustrative numbers, by design). Refine keeps the figure (moves it on
request, never redraws); Start over re-places it; Duplicate and version
history carry it. A failed drawing never blocks the copy: the section shows
the reason and a *Try again* button.

Settings: drawing quality (default High, about 5 cents per image), an
optional monthly budget (drawing pauses when reached), a house-style text
added to every prompt, and the per-surface "Allow illustrations" switch.

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
| `PAGE_TAILOR_FIGURE_MODEL` | No | `PAGE_TAILOR_MODEL` | Claude model for the illustration recommender and figure placement |
| `OPENAI_API_KEY` | For drawing | — | OpenAI key for drawing illustrations (library and uploads work without it) |
| `OPENAI_IMAGE_MODEL` | No | `gpt-image-2.5-sunburst` | OpenAI image model |

`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `SCOPES` are managed by the Shopify
CLI during `npm run dev`; see [.env.example](.env.example) for manual/production
setups. Scopes: `read_products`, `read_translations`, `read_locales`,
`read_orders`, and `write_files` (illustrations are stored in the store's
Files; the app writes nothing else to the store).
