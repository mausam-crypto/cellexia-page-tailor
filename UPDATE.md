# Updating a live Page Tailor deployment

This guide is for updating an already-deployed installation. For first-time
setup, use [INSTALL.md](INSTALL.md).

## What's new in this update (2026-10-21 — illustrations)

Brief- and article-based pages can now carry a clinical-style illustration in
the Science and Overview tabs. This release ships **one database migration**
(`illustrations`), **a theme-extension change** (`npm run deploy` required),
**one new access scope** (`write_files`; merchants approve it on their next
visit to the app) and **two new environment variables** (`OPENAI_API_KEY`
for drawing, optional `OPENAI_IMAGE_MODEL`). See README → *Illustrations*
for the feature itself; in short:

- **Image library** (nav): upload illustrations (PNG/JPEG/WebP, stored in
  the store's Shopify Files), describe them, see where each is used, delete
  unused ones. Monthly drawing spend is shown here.
- **Templates** (nav): eight editable starter drawing styles with a
  category and a "when to use" note; add your own; archive unused ones.
- **Creation forms**: per section (Science, Overview) choose none / Auto /
  a library image / a template + prompt, with a one-click *Recommend 5
  ideas*. Per brief in *Add briefs*, per batch in *Add articles*. The last
  choice is remembered as the default.
- **Generation**: the copy is written and goes live first; the figure is
  then drawn (one image per language page, labels in that language), placed
  by Claude with a caption, and goes live flagged for review. Failures never
  block the copy (per-section banner with *Try again*).
- **Review page**: an illustration panel per section: pick from the library,
  draw (with Recommend), draw again, use an alternative, move the figure,
  edit caption and alt text, remove. Figures are part of version history,
  Restore, Duplicate, Refine (kept; moved on request) and Start over (kept).
- **Settings**: drawing quality, monthly budget, house-style text, and a
  per-surface *Allow illustrations* switch.
- **Claim guard**: caption, alt text and drawing prompt are checked and
  listed under *Unverified claims* (information only).

## What's new in the previous update (2026-10-21 — briefs, refinements, version history)

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

## What's new in the update before that (2026-09-19 — performance & reliability)

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
     `npm run shopify -- app config link`. **This release changes the
     scopes line:** in YOUR copy set
     `scopes = "read_products,read_translations,read_locales,read_orders,write_files"`.
   - `.env` - not in the ZIP; keep yours, and add `OPENAI_API_KEY=...` (and
     `write_files` to `SCOPES`, which must match the toml).
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
   Render), with the new environment variables set on the host:
   `OPENAI_API_KEY` (drawing; the app runs without it, drawing is then
   unavailable) and `SCOPES` including `write_files`. The Prisma client is
   generated at build time (Dockerfile / npm install); the boot command
   (`npm run docker-start`) runs `prisma migrate deploy`, which applies this
   release's one migration (`illustrations`: three new tables, nullable
   columns on Article and Override, one defaulted column on ShopSettings).
   Existing variants and their live copy are untouched.
5. **On the host (Render dashboard):** set the service's **Health Check
   Path** to `/healthz`, so deploys only switch over once the new server
   actually serves. While there, check the instance type: on a free
   (sleeping) instance the built-in keep-alive masks spin-down but consumes
   free instance hours; an always-on paid instance is the clean fix (then
   set `PAGE_TAILOR_KEEP_ALIVE=off`). Also confirm a persistent disk backs
   the SQLite file — without one, app data resets on restarts.
6. **Theme extension and scopes: run `npm run deploy`.** The embed gained
   the illustration styling (`.pt-figure`), and the deploy also pushes the
   new `write_files` scope to Shopify. Merchants are prompted to approve the
   updated permissions the next time they open the app; until they do, the
   Image library shows a "Files permission needed" banner and drawings fail
   with that message (copy generation is unaffected). Open the app once
   after deploying and accept.

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
5. Run the illustrations checklist below once on a development store
   before (or right after) the production deploy (the brief-feature
   checklist further down still applies if it was never run).

## Testing the illustrations feature (2026-10-21 release)

Prerequisites on the test store: theme app embed enabled (after
`npm run deploy`), serving ON in Settings, the storefront password removed,
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` set, the app opened once so the
Files permission was approved. Each step says what you should see; anything
else is a bug. Drawings cost a few cents each.

1. **Image library** (nav) loads with no permission banner. Upload a 2 MB
   PNG with a name, a description, two tags and a language: it appears
   with its pixel size, and shows up in Shopify admin → Content → Files. A
   12 MB file and a `.gif` are refused with a clear message.
2. **Templates** (nav) lists eight starters. Edit one's "when to use" and
   save; reload: the edit persists; *Reset to starter text* restores it.
   Archive one: it moves to the Archived list and no longer appears in the
   forms.
3. **Settings**: Science and Overview show *Allow illustrations* ticked by
   default, other surfaces unticked. Set quality High, monthly budget 5,
   a house-style line; save; reload: all kept.
4. **Add briefs**: pick a product, tick two languages, one brief. For
   Science choose *Draw from a template and a prompt*, click *Recommend 5
   ideas* (a few seconds, five ideas with the first ticked), tick a second
   one. For Overview choose *An image from the library* and pick the upload
   from step 1 (a warning says it is tagged with one language but used on
   both). Submit. Dashboard: two rows *Queued*, then *Live — review
   needed*; opening one shows "Illustrating" for a minute or two, then:
   the Science card has a figure captioned in that page's language (two
   drawings, the second under *Alternatives*), the Overview card has the
   library image with a caption; the Image library lists the drawn images
   with template, prompt and cost, and the month's spend went up; the
   version history has ONE *Generated* version (no extra version for the
   figure); *Unverified claims* may list items marked "Illustration:".
5. **Storefront**: the `?cx=` URL shows the figure full width inside the
   Science tab at the chosen spot, with its caption; the clean URL is
   unchanged. Changes below reach the storefront within ~2–4 minutes.
6. **Review page, Science card**: change *Position* to another block and
   *Save illustration*: the storefront moves it; history shows *Edited:
   Science … illustration*. Edit the caption and save. Click *Use this* on
   the alternative: "Placing…", then the other image is live with a new
   caption. *Draw another* → *Recommend* works on the existing copy; tick
   one, *Draw it*: a new drawing goes live, the previous one becomes an
   alternative; the status is back to *review needed*. *Remove*: figure
   and caption gone from the page and the storefront.
7. **Refine** (brief page) with "Shorten the overview": the Overview figure,
   caption and position are unchanged. Refine with "move the Science
   illustration below the second paragraph": it moves, nothing is redrawn,
   no cost added.
8. **Start over**: new copy, the same images re-placed with fresh captions,
   no new drawing cost.
9. **Restore** the first version (before any figure edits), then the latest:
   figures follow each version. Delete an alternative image from the
   library first, then restore a version that used it: the copy restores
   and a message says that illustration was dropped.
10. **Duplicate**: the copy carries both figures; the Image library's *Used
    in* lists both pages.
11. **Delete guard**: the image used on a live page cannot be deleted
    (button disabled, detail page lists the pages); remove it from the page
    first, then delete: it disappears from Shopify Files too.
12. **Failures**: set a wrong `OPENAI_API_KEY`, restart, *Draw again*: the
    copy stays live, the section shows the reason and *Try again*, the
    dashboard row is NOT marked failed. Set the budget to 0.01: a drawing
    shows "budget reached"; a library pick still works. Restore the key and
    budget and *Try again*: it succeeds.
13. **Add articles** with two URLs, Science = Auto, Overview = none: both
    pages generate with a Science figure each, drawn from their own
    article, with four un-drawn suggestions listed under *Alternatives*
    (*Draw this* draws one).
14. **Mark as reviewed** in a tab opened before a drawing finished: "copy
    changed since you loaded this page"; reload; works.
15. Open the dashboard CSV export and the Experiments pages: unchanged.

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
- Rollback: redeploy the previous server build. The migrations only add
  nullable columns and new tables, which the previous build ignores, so
  the database needs no changes to roll back; brief-based variants created
  on the briefs release would then show as pasted articles in the old UI,
  so take them offline (or delete them) before rolling back. Illustrations:
  the previous build does not know the figure marker (its sanitizer strips
  the empty `<div data-pt-figure>`), so illustrated pages simply serve
  without their figures; the images stay in the store's Files.
- Illustrations and languages: a drawn figure's labels are in the language
  of its page, so a brief in three languages draws three images (three
  times the cost). A library image chosen in a creation form is used on
  every language of that brief; swap it per language on the review page.
- Illustration cost: computed from the image model's usage figures per
  drawing (about $0.05 at High quality for a landscape image); the Image
  library and Settings show the month's total. The monthly budget is
  checked before each drawing, so a batch can overshoot it by the drawings
  already in flight.
