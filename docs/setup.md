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
| `write_products` | Product copy (`descriptionHtml`, title) and metafields to read — Accentuate fields are plain metafields (includes `read_products`) — plus ONE app-owned, storefront-invisible product metafield the app writes: the basket name map of Ingredient focus pages (`$app.cart_titles`, declared in `shopify.app.toml`) |
| `read_translations` | Localized copy managed by Translate & Adapt (Translations API) |
| `read_locales` | Published shop locales, used to localize base copy and build variant URLs |
| `read_orders` | Experiment tracker only — syncs order totals for the baseline/treatment windows |
| `write_files` | Illustrations only — uploaded and drawn images are stored in the store's Files (Shopify CDN) and deleted from there when removed from the library |
| `write_cart_transforms` | Basket rename only — creates (and deletes) the app's Cart Transform function registration when the merchant activates it in Settings (Shopify Plus) |

The app never edits product content, translations or orders; it writes
image files (illustrations) and the app-owned basket name metafield, nothing
else. Variants live only in the app database. Shops that installed before a
scope was added (`read_orders`, `write_files`, `write_products`,
`write_cart_transforms`) are prompted to approve it the next time they open
the app; until then the Image library shows a permission banner, drawings
fail with that message, and the Basket rename card in Settings shows
"Permission needed".

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
   - **Remember variant (days)** — how long a visitor's browser keeps showing
     the variant they last opened when they return to the product page without
     the special link (default 30; 0 turns persistence off).

Without a variant parameter, the embed serves the visitor's remembered
variant if they have one (see "Remember variant" above); visitors with no
stored preference — including all crawlers — get the untouched base page.
Append `?cx=off` to a product URL to clear the memory in your own browser
(useful for QA).

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
10. **Product name (Ingredient focus pages only):** the *Product name*
    surface is disabled by default. To let focus pages rename the product on
    the page (and in the basket, see §9), enable it and set the selector of
    the heading that prints the product name, e.g. `.product__title h1`
    (Dawn family) or the theme's own hook; never the `<title>` tag (it is
    rejected). If the theme has a sticky add-to-cart bar that repeats the
    name, add its selector after a comma. Add the same selector to the
    embed's "Selectors to hold during swap" setting to avoid a flash of the
    old name. Swap mode is always Plain text.

11. **Country of the live page:** live page regions take their original
    copy from the public product page. If the store shows different copy in
    some countries (Shopify Markets), Settings > Copy surfaces > "Read live
    pages as a visitor from" decides which country's version the app reads
    (default United States). Choose a country the store sells to; otherwise
    Shopify falls back to the country of the app's server and the
    generation stops with a message naming both countries.

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
| Variant shows on the CLEAN url while testing | Browser-stored preference from an earlier variant visit | Append `?cx=off` and reload, or use a private window |
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
| "The app needs the Files permission (write_files)" | The shop has not approved the scope added with illustrations | Open the app from the Shopify admin and accept the updated permissions, then *Try again* |
| "OPENAI_API_KEY is not set" / "missing or invalid" | Drawing needs an OpenAI key on the server | Add it to `.env` (or the host's env) and restart; the library and uploads work without it |
| "Your OpenAI organization must complete verification" | OpenAI requires verification for GPT Image models | Verify the organization on platform.openai.com, then *Try again* |
| "The image model declined this prompt" | OpenAI's moderation refused the drawing | Reword the specific prompt (avoid treatment wording, real people), draw again |
| "The monthly illustration budget … is reached" | Settings cap hit | Raise or clear the budget in Settings, or wait for next month; library images still work |
| Figure missing on the storefront | Illustrations switched off for that surface, or the page's copy was restored to a pre-figure version | Tick *Allow illustrations* in Settings; check the figure panel on the review page |
| Figure sits at the top instead of where it was placed | The `<div data-pt-figure>` marker was removed by a hand edit | Set the position in the figure panel and *Save illustration* (this re-inserts the marker) |
| "Shopify is still processing the image" | Shopify had not finished processing the upload within a minute | *Try again* in a minute |

## 7. Briefs, refinements and version history

**Add briefs** (nav) creates variants from a written brief instead of an
article: one product, one or more languages, any number of briefs. Each brief
has a name (shown on the dashboard and in the CSV export), the brief text,
optional references (pasted text and/or one link per line; links are fetched
with the same guarded fetcher as articles and re-read on every run; a link
that cannot be read is reported on the version, never fails the run) and
optional Advanced fields that are folded into the brief. Briefs are queued
for generation as soon as they are added.

On a brief page's review screen:

- **Refine with a prompt** sends one instruction to the model together with
  the brief, the references and the current copy (hand edits included); only
  the sections the instruction concerns change, everything else is kept
  byte-for-byte. The refinement runs in the background queue like a
  generation; the live copy is untouched until it succeeds, and a failed
  refinement shows a "Last refinement failed" banner with the reason. Save
  any hand edits before refining: the Refine button is disabled while there
  is unsaved typing.
- **Edit brief** changes the stored brief for the next refinement or start
  over; it changes nothing on the page by itself.
- **Start over** (the brief page's equivalent of Regenerate) rewrites the page
  from the base copy with the current brief; earlier refinements stay in the
  history.
- **Unverified claims** per section: claims the guard found in neither the
  page copy, the brief, nor the references. Informational.

**Version history** (every variant): each generation, refinement, hand edit
and restore is a version with a snapshot of all sections; the list shows what
produced it and which sections changed. *Restore* replaces the live copy with
that version (storefront within ~2 minutes) and records the restore as a new
version. Variants generated before this feature get a baseline version the
first time anything changes them. The last 50 versions are kept per variant.

**Duplicate** (every variant) creates a new variant with a fresh URL carrying
the same brief, copy, review state and history; the original is untouched.

## 8. Illustrations

Illustrations are figures (an image plus a caption) served inside an adapted
HTML surface: by default the Science and Overview tabs, and any other HTML
surface whose *Allow illustrations* switch is ticked in Settings. The
storefront embed needs no extra setting: the figure is part of the swapped
HTML (`<figure class="pt-figure">`, full width, lazy-loaded, with minimal
styling from the embed; the theme's typography applies to the caption).

**Where images live.** In the store's Files (Shopify CDN), under the
`write_files` scope. The app's Image library holds the coordinates, the
description, tags, the language of any labels inside the image and, for
drawn images, the template, the full prompt, the model, the quality and the
exact cost. Deleting an image removes it from Files too; an image used on a
page (as the live figure or an alternative) or as a template example cannot
be deleted until it is removed there.

**Templates** are reusable drawing styles: a category and a "when to use"
note (what the recommender reads), drawing instructions (sent to the image
model in front of the specific prompt), a preferred shape (landscape 3:2,
square, portrait 2:3) and an optional example image. Eight starters are
seeded once per shop; they can be edited, reset to the starter text, and
archived (not deleted). A shop-wide **house style** text in Settings is
added in front of every template.

**Drawing** uses OpenAI's image model (`OPENAI_API_KEY`; model
`OPENAI_IMAGE_MODEL`, default `gpt-image-2.5-sunburst`) at the quality set in
Settings (default High, about $0.05 per landscape image; Low and Medium are
cheaper but render labels less reliably). The full prompt is: house style +
template instructions + the specific prompt + "every label is written in
<the page's language>". One image is drawn per language page. Words,
labelled diagrams and charts are allowed inside the image; a chart's numbers
come from the specific prompt and may be illustrative (the claim guard lists
them under *Unverified claims* as information).

**Recommend** (creation forms and the review page's *Draw* dialog) asks
Claude for five template + prompt ideas from the brief or the article (and,
on the review page, the section's current copy). Tick the ideas to draw; the
first goes live, the others are kept as alternatives. In *Add articles* the
form's Recommend reads the first URL only; *Auto* reads each article at
generation time.

**Placement and caption.** After the copy is written, Claude chooses where
the figure sits among the section's blocks (top, after a given block,
bottom) and writes a caption (under the image) and an alt text (for screen
readers) in the page's language. The position is a `<div data-pt-figure>`
marker inside the adapted HTML; the review page's figure panel moves it
(*Position* + *Save illustration*). A hand edit that deletes the marker
makes the figure render at the top until a position is saved again.

**What goes live when.** The copy goes live first (as before); the figure
follows one to three minutes later, flagged for review. Drawing or picking
from the review page runs in the same background queue as refinements; the
page shows "Illustrating…" and updates itself. A failed drawing never
touches the copy: the section shows the reason and a *Try again* button.

**Refine / Start over / Restore / Duplicate.** Refine keeps the figure
(and may move it when the instruction asks; captions are edited in the
figure panel, not by Refine). Start over keeps the illustration and
re-places it in the new copy with a fresh caption, drawing nothing. Every
figure change is a version; Restore brings a version's figures back (an
illustration whose image was deleted from the library is dropped with a
notice). Duplicate copies the figures (same library images).

**Budget.** Settings → *Monthly drawing budget*: when the month's spend (sum
of every drawing's recorded cost, UTC month) reaches it, drawing pauses with
a clear message; copy generation and library images are unaffected. The
budget is checked before each drawing, so a batch can overshoot by the
drawings already in flight.

## 9. Ingredient focus pages and the basket rename

**Ingredient focus** (README → *Ingredient focus*) renames the product on the
page through the *Product name* surface (§3, item 10). The **basket rename**
makes the new name follow the item into the basket, the checkout, the order
and its emails, without duplicating the product. It is a Shopify Function
(`extensions/cart-rename`, a Cart Transform with a `lineUpdate` operation)
that Shopify runs only on **Shopify Plus** stores (and development stores).

### How it works

1. On a live focus page whose heading is renamed, the theme embed adds two
   hidden properties to this product's add-to-cart form(s): `_cx` (the
   page's variant code) and `_Original product` (the original name, a
   staff note). Recommendation and quick-add forms for other products are
   never touched.
2. The app keeps, on the product, an app-owned JSON metafield
   (`$app.cart_titles`, "Page Tailor basket titles", read-only in the admin)
   mapping each live focus page's code to its product name. It is rewritten
   whenever a focus page is generated, refined, edited, restored,
   duplicated, deleted, put live or taken offline, and when serving or the
   Product name surface changes in Settings.
3. The function renames any basket line whose `_cx` code is in the map.
   Lines bought on a selling plan (subscriptions) are skipped: Shopify does
   not allow `lineUpdate` there.

The rename applies only while: the basket rename is **Active** in Settings,
serving is **On**, the *Product name* surface is **enabled with a
selector**, and the page is **live**. Taking the page offline (or switching
serving off) removes its entry; baskets already holding the item revert on
their next change. Placed orders keep the title they were placed with.

### Activation (once per store)

1. Deploy: `npm run deploy` pushes the function, the updated scopes and the
   metafield definition (the CLI writes the function's `uid` into
   `extensions/cart-rename/shopify.extension.toml` on the first deploy;
   never re-scaffold that extension or rename its handle afterwards).
2. Open the app once: Shopify asks to approve the updated permissions
   (`write_products`, `write_cart_transforms`). Your staff account needs
   the *Products* and *Store settings/preferences* permissions for the next
   step.
3. Settings → **Basket rename**: press **Activate**. The badge turns
   *Active*. The card tells you when something is missing (permission,
   function not deployed, store not on Plus).
4. Settings → *Product name* surface: enable it and set its selector (§3,
   item 10). Save.

*Deactivate* deletes the registration and clears every product's map;
focus pages keep their new name on the page.

### Store-side edits (theme developer)

Shopify shows the renamed line in the checkout, the thank-you page, the
admin order and the packing slip with no edit. Two templates print the
product's real name unless changed:

- **Theme basket drawer and basket page.** Dawn-family themes print
  `item.product.title`; change it to `item.title` wherever the product name
  is printed. Files: `sections/main-cart-items.liquid`
  (`{{ item.product.title | escape }}` → `{{ item.title | escape }}`),
  `snippets/cart-drawer.liquid` (`{{- item.product.title | escape -}}` →
  `{{- item.title | escape -}}`) and, if present,
  `snippets/cart-notification-product.liquid`. Caveat: on lines that are
  not renamed, `item.title` is "Product - Variant"; a theme that prints the
  variant options separately can guard it:
  `{% if item.title != item.product.title | append: ' - ' | append: item.variant.title %}{{ item.title }}{% else %}{{ item.product.title }}{% endif %}`
  (or check `item.product.has_only_default_variant`). Dawn's cart templates
  already hide properties whose name starts with `_`.
- **Order notification templates** (Settings → Notifications → Order
  confirmation, Shipping confirmation, Shipping update, Order edited, Refund,
  Draft order invoice). Shopify's stock templates contain
  `{% if line.product.title %}{% assign line_title = line.product.title %}{% else %}{% assign line_title = line.title %}{% endif %}`,
  which prints the ORIGINAL name; replace it with
  `{% assign line_title = line.title %}`.
- **Packing slip** (optional; Settings → Shipping and delivery → Packing
  slip template): the default prints `line_item.title` (the new name) and
  no properties. To print the staff note, add inside the line-items loop:
  `{% for p in line_item.properties %}{% if p.first == '_Original product' %}<p>Original product: {{ p.last }}</p>{% endif %}{% endfor %}`.

### Embed setting: JSON add-to-cart

Themes whose add-to-cart button sends JSON to `/cart/add.js` instead of
submitting the product form never carry hidden inputs. If a focus page shows
the new name on the page but the basket keeps the old one even after the
theme edit above, switch on the embed setting **"Basket rename: also tag
JSON add-to-cart requests"** (theme editor → App embeds → Page Tailor). It is
off by default because a global `fetch` wrapper can collide with other
apps' wrappers.

### Troubleshooting

- *Permission needed* in Settings: reload the app in Shopify and approve the
  updated permissions; the badge updates on the next load.
- *Function not deployed*: run `npm run deploy` from the app's folder (the
  deploy must include the `cart-rename` extension), then reload Settings.
- "Access denied" on Activate: the permissions are not approved yet, or
  your staff account lacks the products and preferences permissions.
- The page shows the new name but the basket does not: check the four
  conditions above, the theme edit, then the JSON embed setting. Items added
  from a normal product page are never renamed, by design.
- Subscription lines keep the original name (Shopify limitation).
- Function run logs: Dev Dashboard → your app → Logs, Type = Function.
- The staff note `_Original product` (and `_cx`) show in the admin order and
  in order webhooks; they are hidden at checkout and in notifications.
