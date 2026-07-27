# Why this design keeps ad-account risk low

For the marketing team. This explains the design decisions in Page Tailor that
keep the variant layer on the right side of Google Ads and Search policies.

## Deterministic serving, with visitor-side persistence

**Server side, nothing has changed:** the app proxy answers from the database
keyed on the variant code alone (`app/routes/proxy.variant.ts`). There is no
user-agent, referrer, or bot detection anywhere in the pipeline, and the
server sets no cookies and stores nothing per visitor.

**Client side, at the merchant's explicit direction (2026-07-23), the embed
remembers a visitor's variant.** When someone opens a variant URL, the embed
stores that code in the visitor's own browser (per product and language,
default 30 days, configurable in the theme embed, resettable with
`?cx=off`, deliberately not gated on a consent banner). On later visits to
the clean product URL, the embed re-requests that same variant. The logic is
identical for every visitor: anyone without a stored code — every first-time
visitor, every crawler, every ad reviewer — always gets the base page on
clean URLs, and there is still no crawler detection of any kind.

This is the same category as mainstream personalization and A/B tools
(cookie-persisted variants on clean URLs), which is standard practice — not
**cloaking**, which requires detecting crawlers and treating them specially.
It is, however, a step down from the previous "same URL, same content for
absolutely everyone" posture: the clean URL now varies with the visitor's
own prior navigation. The `?cx=` landing URLs used in ads behave identically
to before. One caveat completes the parity story: Shopify's default
`robots.txt` blocks the payload endpoint for crawlers, so apply the
robots.txt recommendation below.

## Canonical URL untouched

Shopify canonicalizes product pages with query parameters to the clean product
URL (`<link rel="canonical">` points to `/products/handle`). Variant URLs
therefore create no duplicate-content surface and no index-spam surface: to
search engines, `?cx=a7k2m9x4` is the same page as the product page they already
know.

## Opaque parameter values

Variant handles are 8 random characters from a confusion-free alphabet
(`?cx=a7k2m9x4`). No keywords in the URL means no keyword-stuffing signal, and
neither crawlers nor competitors can read intent out of the URL or enumerate
which queries you are targeting. The parameter name itself is short and
meaningless, and can never collide with Shopify's own `variant` parameter.

## Claim grounding

Generation is hard-constrained to **claims grounded in sources the brand
controls**: the model may reframe, reorder, and re-phrase what the product page
already says, and it may add or edit claims **only when the source article
itself clearly supports them** (and no more strongly than the article states
them) so the page matches the reader's query and intent. It remains forbidden
from inventing claims supported by neither source, and from adding drug-like
language, guarantees, urgency, or price language regardless of what the article
says. In standard mode, proof-element language — statistics, study results,
clinical endorsements, rankings, awards, press references — stays off-limits
even when the article contains it; that is reserved for Meta mode (below).

That constraint is then verified, not trusted:

- An **independent claim-guard pass** (language-agnostic, model-based — the
  primary gate) compares each adapted surface against the original copy *and*
  the article. Claims supported by neither (or stated more strongly than the
  article) become blocking warnings; claims the article does support are listed
  separately as **article-sourced claims** for the reviewer to verify.
- **Deterministic heuristics** additionally flag new percentages, clinical or
  professional-endorsement language ("clinically proven", "dermatologist
  tested"), drug-like efficacy words (treat/cure/heal), guarantees, rankings and
  press references, and urgency/scarcity phrasing — in English plus common
  French/German/Spanish/Italian/Portuguese equivalents.

Blocking warnings and article-sourced claims are surfaced prominently in the
review notification (see the post-publication review section below) and drive
its urgency. Manual edits re-run the heuristics and re-sanitize HTML at save
time.

## Meta mode

Meta mode is a **per-batch opt-in** for articles that run as Meta
(Facebook/Instagram) paid-social campaigns rather than Google Ads. It exists so
the landing page can confirm the article's promise exactly: generation may
rewrite surfaces much more deeply (ignoring the configured depth), and it
extracts the article's **specific proof elements** — study wins, test results,
rankings, statistics, awards — and weaves them into the copy, phrased no more
strongly than the article itself. Every proof element used is reported with a
verbatim supporting quote from the article and shown on the review page; each
quote is deterministically checked against the extracted article text, and a
quote that cannot be found is flagged so the reviewer knows to verify it by
hand.

In Meta mode the proof-element heuristics downgrade to informational
article-sourced notes **only when the flagged text appears verbatim in the
article**; drug-like language, guarantees, and urgency remain blocking
warnings. Everything else is unchanged: deterministic server-side serving (same
variant code, same content), untouched canonical, opaque parameters, server-side sanitization, the
post-publication review notification, and the master serving switch.

## Ultra custom mode

Ultra custom is the third adaptation mode (added 2026-07-25): the deepest
intent tailoring, **without** Meta mode's proof elements. Generation
identifies the article audience's intent and use case ("face creams for
men", "night creams"), recenters every surface on that intent and its
vocabulary, may reorder and reprioritize freely, and — uniquely to this
mode — may **remove** existing claims or list items that are irrelevant to
that audience. It never pulls statistics, study results, rankings, awards,
endorsements, or press references from the article, and never mentions the
article. Claim grounding still applies to everything it writes (original
copy or article support, stated no more strongly than the article), the
guard passes run identically, and the proof-element heuristics treat Ultra
exactly like standard mode: any proof-token language becomes a blocking
warning. Because it adds no proof language, Ultra custom stays inside the
Google-funnel posture and is safe on Google Ads traffic.

**Ultra deep persona** (added 2026-07-26) is a variant of Ultra custom with
an explicit method: identify the product type the article's readers are
shopping for, build a ranked list of everything that shopper wants to hear,
and place items across the page by importance (the top 1-3 lead the
tagline, description, and overview; the full ranked list is shown on the
review page). Same rules and posture as Ultra custom: claim grounding
applies, irrelevant claims may be removed, proof elements are forbidden and
blocked by the guard, and it is safe on Google Ads traffic.

**Ultra Custom Conversion Max** (added 2026-07-26) combines the intent
family's strongest levers in one mode: it diagnoses the arriving reader's
awareness stage, builds three ranked lists (what they want to hear, the
doubts the article planted, and the evaluation criteria the article
taught), then sequences the whole page around them - desires placed by
importance, objections answered organically where they arise, criteria
excelled at in the page's own reworded terminology, and the FAQ tab
re-targeted to the reader's likely next questions (factual/policy answers
never altered). The full plan is stored and shown on the review page.
Reframing is deliberately aggressive (a merchant-directed choice,
2026-07-26): the generation treats skipping a desire or criterion as a
last resort and actively reframes existing features, ingredients, or
benefits into the reader's terms even when the wording differs
completely. The floor beneath that aggressiveness is unchanged: a
product fact stated in neither the original copy nor the article may
never be asserted, however plausible it sounds. Same posture as Ultra
custom: claim grounding, no proof elements (blocked by the guard), no
article references or comparison framing, safe on Google Ads traffic.

**Ultra Custom V2** (added 2026-07-26) writes the page as the article's
sequel, from four article-derived inventories shown on the review page:
expectations the article created (each confirmed where the copy or
article supports it, never contradicted, silently omitted otherwise);
claims the article already delivered (compressed or deepened rather than
repeated); dimensions where the article found the alternative products
lacking (the page becomes strongest there, wherever the existing copy
truthfully supports it - recorded as themes, with competitors never
named, alluded to, or compared against); and buying questions the
article left open (answered where grounded, with factual usage, safety,
shipping, and policy answers in the FAQ never altered or trimmed away). It also applies moderate
stage-matched length control: for nearly-sold readers it may trim
content irrelevant to the article's intent by up to about a quarter per
surface, never more. The same assertion-level hard cap as Conversion
Max applies verbatim: no product fact stated in neither source is ever
asserted. Same posture as Ultra custom: claim grounding, no proof
elements (blocked by the guard), no article references or comparison
framing, safe on Google Ads traffic.

Deliberately out of scope for the Google-funnel posture: **do not use Meta mode
on URLs that receive Google Ads traffic.** Article-referencing proof language
("ranked #1 of 5 tested") on a Google-funnel landing page reintroduces exactly
the unsubstantiated-ranking surface the standard mode is designed to avoid. The
mode is set when the batch is created (and can be flipped per article before
regeneration), so keeping the two funnels separate is an operational rule the
team owns.

Price, reviews, ratings, and structured data are never touched. This is
enforced, not just promised: CSS selectors targeting price, review/rating,
`itemprop`/`ld+json` structured data, canonical, or metadata/script elements
are **rejected when Settings are saved and filtered again when payloads are
served** — as are document-level selectors (`body`, `main`, `html`, `:root`,
the universal selector `*`, and CSS escape sequences), and any selector that
does not name a specific class, id, or attribute. The theme embed applies the
same spirit to its anti-flicker hold list: selectors that look like price,
cart, form, or review elements are ignored client-side even if typed into the
theme setting. Serving additionally intersects each variant's stored surfaces
with the **currently enabled** surfaces in Settings, so disabling a surface
stops it on every live variant immediately, and empty content is never served
(a blank swap could visibly damage the page).

## Post-publication review (notification model)

**This replaced the original pre-publication approval gate at the merchant's
explicit direction (2026-07-21).** A successful generation puts the variant
live immediately; the admin then notifies the merchant to review it — a
dashboard banner and a "Live — review needed" state on every unreviewed
variant, with flagged claims escalating the notification's urgency. The
reviewer marks each variant reviewed (recorded with a timestamp) or takes it
offline with one click.

What this means for the risk posture, stated plainly: AI-generated copy —
including copy the claim guard has flagged — can serve to real visitors before
any human has read it. The review is a detection-and-correction loop, not a
prevention gate. The safeguards that remain in front of the automatic go-live:

- The **master serving switch** (off by default on install) — nothing serves
  anywhere until the merchant turns it on, and it remains the emergency stop.
- The **claim-grounding generation rules and both guard passes** still run on
  every generation; findings are stored and surfaced, they just no longer
  block.
- **Deterministic safety rails** are unconditional: server-side HTML
  sanitization, the hardened selector rules, the empty-content filter, and the
  never-touch list (price, reviews, structured data, canonical, metadata).

Taking a variant offline stops serving within about two minutes for new
visitors (proxy responses cache for 120 seconds) and up to about four minutes
for visitors holding the 120-second client-side cache on top — the URL then
renders the normal product page. Editing a live variant applies to the
storefront on the same timeline. A *failed* regeneration never takes a live
variant down.

Recommended operating practice given this model: keep review latency short
(review the dashboard after every generation batch), and treat the flagged-
claims notification as same-day work — the longer a flagged variant serves
unreviewed, the more the compliance argument above erodes.

## Measurement

The experiment tracker never splits traffic. It compares **sequential
periods** — a baseline window, then a treatment window — so there is no
randomization and no A/B variant assignment. (A market can have several
article URLs, each with its own approved variant of the same product page —
but any given variant URL always renders one deterministic version, clean
URLs render the base page for anyone without a browser-stored preference, and
the experiment measures the treatment period as a whole against the baseline.)

The view beacon logic is **identical for every visitor** and the server
stores only daily aggregate counters per product and language — no user
identifiers, nothing per-visitor server-side. The variant flag it reports
covers both arrivals via a variant URL and return visits carried by the
browser-stored preference, so experiment conversion rates count persisted
visitors correctly.

And serving is **off by default** on install — the theme embed ships disabled
and the master serving switch starts OFF — so nothing on the
storefront changes until it is explicitly enabled.

## robots.txt — recommended

Shopify's default `robots.txt` disallows `/apps/*`, which includes the app proxy
path the theme embed fetches. Users still see adapted copy (the embed runs
regardless), but a JS-rendering crawler that honors robots.txt would not fetch
the payload and would see the base copy. For full crawler/user parity, allow
the proxy path — this is **recommended**, not optional. Add a
`robots.txt.liquid` template to the theme with:

```liquid
{% for group in robots.default_groups %}
  {{- group.user_agent }}
  {%- if group.user_agent.value == '*' %}
Allow: /apps/cx/variant
  {%- endif %}
  {%- for rule in group.rules -%}
    {{ rule }}
  {%- endfor -%}
  {%- if group.sitemap != blank %}
    {{ group.sitemap }}
  {%- endif %}
{% endfor %}
```

(If you change the proxy subpath, adjust the `Allow` line to match.)

## Scope of this argument

The page-variant layer is designed to be policy-safe, but Google evaluates the
whole funnel, and the articles themselves are the larger surface. Advertorial
listicles should carry appropriate advertising disclosure under local rules
(FTC/ASA-style "ad"/"sponsored" labeling) and avoid unsubstantiated review or
ranking claims. That lives in the articles, outside this app.
