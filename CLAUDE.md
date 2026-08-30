# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Security TODOs

### 🔴 HIGH — do first
- [x] ~~Rotate Supabase anon key~~ — **deliberately dropped 2026-07-29, do not re-open without cause.** The key is a *publishable* browser-side identifier, hardcoded at `inspection-site/index.html:312` and deployed to CloudFront by design — the public inspection site cannot query without it. It is in git history because it was always meant to be public. The real defect was anon's grant on the `inspections` base table, fixed below. Rotating would swap one public identifier for another while requiring three coordinated redeploys (S3 site, macOS DMG, `LIA_CONFIG_JSON` CI secret). Revisit only if the Supabase project shows abnormal API volume.
- [x] ~~🔴 **`inspections` is readable by anon on the live database.**~~ — **CLOSED 2026-08-24.** The migrations were applied via Route B (`docs/APPLY-MIGRATIONS.md`) and the `REVOKE` in `supabase/02_inspections.sql` finally took effect. Verified from outside with the publishable key after the fact: `GET /rest/v1/inspections` now returns **401 `42501`**, while `ladder_inspections_public` still serves all 1,724 rows. This had been recorded as applied on 2026-07-29 and was not; it is now actually in effect. `supabase/test/run-reset.sh` asserts it stays fixed.
- [x] ~~`inspections` policies were `USING (true)` / `WITH CHECK (true)` for every authenticated user~~ — any tech could read and overwrite any other company's records. `supabase/04_inspections_v2.sql` replaces them with account-scoped policies and removes the INSERT/UPDATE grants entirely; `record_inspection()` (SECURITY DEFINER) is the only write path. **Applied to the live DB 2026-08-24.**
- [x] ~~Add max-length check on `workOrderId`~~ — the field is now required and capped at 64 chars in `electron/index.html`, and normalized server-side by `wo_key()`.
- [ ] `config.json` is bundled as plaintext in the DMG (`extraResources`) — consider storing the anon key in macOS Keychain via `keytar` or prompting on first launch

### 🟡 MEDIUM
- [x] ~~Add path validation to `csv:parse` and `inspections:parse-csv` IPC handlers~~ — both now go through `resolveCsvPath()` in `electron/main.cjs`: realpath (so symlinks are resolved before the extension check), `.csv` extension, regular-file check, 50 MB cap. Note the original suggestion to "constrain to expected directories" was **not** implemented — users legitimately open CSVs from Downloads, Desktop, external drives and network shares, so a directory allowlist would break normal use without adding much.
- [x] ~~Fix IPC listener accumulation~~ — `electron/preload.cjs` routes every `onX` through an `on()` helper that clears the channel first, so re-binding can't stack listeners. Note: `ipcRenderer.once()` (the original suggestion) would have been a bug — the renderer binds at module scope and reuses handlers across runs, so a one-shot listener would leave the second automation run with no completion handler.
- [x] ~~Escape `res.error` before inserting into `innerHTML`~~ — now `esc(res.error)` at `electron/index.html:1320`

### 🔵 LOW
- [ ] Add Content Security Policy to the Electron renderer window (`session.defaultSession.webRequest` or `<meta>` tag in `electron/index.html`)
- [ ] Add SRI hashes to CDN scripts in `field-app/index.html` and `inspection-site/index.html` (`integrity="sha384-..."`)
- [ ] `inspection-site/index.html:536` writes `${r.notes}` into `innerHTML` unescaped. The data comes from authenticated techs so it is not public-facing injection, but a note containing markup would still render as markup on the public certificate. `fp-site/index.html` escapes everything through `esc()`; the ladder site should do the same. **Requires an S3 redeploy to take effect.**
- [ ] Consider storing JWT session (`~/Library/Application Support/Lia/lia-auth.json`) in macOS Keychain via `keytar` instead of plaintext JSON

## Migration state

The live database carries **01–17** as of 2026-08-30. Before writing any bundle
for it, check what is actually live rather than trusting this file:
`git ls-files supabase/*.sql` shows what pre-dates the current branch, and the
REST schema shows what the database has. A bundle that starts part-way up the
range dies on a dependency — 14's RLS policy calls `is_developer()`, defined in
13 — and leaves a half-applied database. Rehearse with
`./supabase/test/run-apply.sh`, which applies a bundle over an already-migrated
database twice and checks all seven migrations end to end.

## Release targets

| Product | Channel | Identifier | Notes |
|---------|---------|-----------|-------|
| Lia Field (iOS) | TestFlight → App Store | ASC app `6778643426`, bundle `com.mobileappdevelopmentgroup.liafield` | Internal beta group `e459ff67-f6f5-490b-9ce3-c07d55a527ab` |
| Lia Field (Android) | Play internal testing | `com.mobileappdevelopmentgroup.liafield` | Signed with `~/.android-keystores/lia-field-release.keystore` |
| Lia Office (macOS) | Direct download (DMG) | — | `npm run electron:build` |
| Lia Office (Windows) | Direct download (NSIS) | — | Built in CI — `.github/workflows/build-windows.yml`. **Not** shipped via Microsoft Store. |

Privacy policy (required by both stores): <https://lia.mobileappdevelopmentgroup.com/privacy.html>,
source at `inspection-site/privacy.html`. It covers **Lia Field only**; Lia Office is a separate
data model and is not in scope.

⚠️ **Before shipping any build that syncs**, both stores' data declarations must be updated in the
same submission — they currently say "no data collected". See `docs/STORE-DATA-DECLARATIONS.md`
for exactly what to tick. Shipping against a stale declaration can pull the listing.

The Windows build needs a `LIA_CONFIG_JSON` repo secret (the full body of `config.json`, which is
gitignored). Signing is optional until a certificate exists: add `WINDOWS_CERT_BASE64` and
`WINDOWS_CERT_PASSWORD` and builds sign automatically.

## Commands

```bash
npm run typecheck          # TypeScript type-check (no emit)
npm run electron:dev       # Build runner then launch the Electron app in dev mode
npm run electron:build     # Build runner + package macOS DMG → dist/
npm run build:runner       # Build src/electron-runner.ts → dist/electron-runner.cjs only
npm run start              # Run the CLI entry point directly (tsx, bypasses Electron)
npm run codegen            # Launch Playwright codegen against bsiwebapp.com

npm test                   # Pure TypeScript units (src/**/*.test.ts)
npm run test:field         # Field app, driven in a real browser
npm run test:desktop       # Electron renderer screens, driven in a real browser
npm run test:sql           # Migrations against a throwaway local Postgres
npm run check:www          # Fails if a Capacitor bundle is behind field-app/
npm run sync:www           # Bring the three Capacitor bundles up to date
npm run capture:help       # Regenerate the manual's screenshots from the live app
```

`test:sql` needs a local Postgres (`brew services start postgresql@16`); it drops
and rebuilds a scratch database each run and never touches Supabase.

## Architecture

This project ships three separate products from one repo:

- **Lia Office** — macOS Electron app (`electron/`, `src/`). Automates importing ladder CSVs into the BSI work-order web app using Playwright.
- **Lia Field** — PWA (`field-app/`). Hosted on GitHub Pages. Purely static; no build step.
- **Ladder Inspection Site** — static site (`inspection-site/index.html`). Deployed to S3/CloudFront.

### Lia Office process model

Electron's main process (`electron/main.cjs`, CommonJS) forks a child process running `dist/electron-runner.cjs` for every automation run. The child is the compiled output of `src/electron-runner.ts`, which is bundled by esbuild (`npm run build:runner`). Communication is over stdio: the child writes newline-delimited JSON events (`log`, `diff`, `complete`, `error`, `paused`, `resumed`, `waiting-for-ready`) to stdout; the parent sends control signals (`ready`, `choice`, `pause`, `resume`) to the child's stdin. The renderer talks to main over Electron IPC (`ipcMain.handle` / `ipcMain.on`), and main relays child events to the renderer via `webContents.send`.

```
Renderer (index.html)
  ↕ contextBridge / IPC
electron/main.cjs          ← Supabase auth, credits, file dialogs, CSV parse
  ↕ fork + stdio JSON
dist/electron-runner.cjs   ← built from src/electron-runner.ts
  ↕ function calls
src/runner.ts              ← orchestrates the full import flow
src/automation.ts          ← Playwright page interactions with bsiwebapp.com
src/csv-parser.ts          ← PapaParse wrapper
src/reporter.ts            ← RunSummary builder + JSON log writer
```

### BSI automation quirks

BSI uses jQuery event handlers, so standard Playwright `selectOption()` bypasses them. All `<select>` fields must be driven via `evaluate()` — set `selectedIndex` in JS, then fire both a native `change` event and a jQuery `$(el).trigger('change')`. See `keyboardSelectDropdown()` in `src/automation.ts`.

Serial number lookup has two paths: **existing** (BSI auto-populates from its DB — only fill empty fields) and **new/not-found** (all fields blank — must be filled via `fillNewSerialFields()`). The "Type" dropdown triggers an AJAX call that populates the "Length" options, so the code waits for `#LadderLength` to have more than one option before proceeding.

### Idempotent re-runs (diff mode)

Before importing, the runner scrapes all existing `#box-N` elements from the work order (`scrapeWorkOrderBoxes`), diffs them against the CSV (`diffCsvVsWorkOrder`), then presents the user with a choice: add everything, add missing boxes only, or cancel. Part-level deduplication also runs inside `addPartsToBox` — it reads the box's existing part rows and skips any CSV part that fuzzy-matches a part already there.

### Supabase

`config.json` (not committed; see `config.example.json`) holds the Supabase URL and anon key. The main process lazily creates a single `createClient` instance. Credits are consumed via the `consume_credit` RPC before the automation child is forked. After a successful run, inspections are auto-inserted into the `inspections` table (upsert on `serial_num, inspection_date`). Sessions are persisted to `~/Library/Application Support/Lia/lia-auth.json`.

SQL migrations live in `supabase/` and are safe to re-run (idempotent). Run `01_licensing.sql` first, then `02_inspections.sql`. See `supabase/README.md` for the full order; `supabase/build-combined.sh` concatenates them into one paste-able script.

### Fall protection checklists

A checklist belongs to the **equipment type**, not the manufacturer or model —
`supabase/11_fp_equipment_types.sql` seeds the fourteen standard types with the
pass/fail parameters each one carries. Manufacturer, model, lot number and date
of manufacture are recorded *about* an item; they do not select its questions. A
model may be given its own list, which overrides its type's.

Publishing writes a new version and an inspection pins the one it was performed
against, so editing a checklist never rewrites an issued certificate.

Two checks are yes/no questions and one of those is **inverted** — "has the
impact indicator been activated?" fails on *Yes*. So each check carries
`answer_style` (`pass_fail` | `yes_no`) and `pass_answer`, and the tech's raw
`answer` is stored beside the derived `result`. `record_fp_inspection` reads
`answer_style`/`pass_answer` **from the template rather than the payload**, and
refuses a record with an unanswered required check — the overall assessment is
computed server-side and is not settable by a client.

The device-side copy of the catalogue is `field-app/js/fp-types.js`, generated
from the same table as the SQL seed; `field-app/test/fp-types.test.mjs` fails if
the two drift.

### Tag hyperlinks

Tags come in two shapes and both must work. Ours carry a certificate URL plus a
text record with the serial. The customer's existing gear carries a serial
printed on the tag and a **link into somebody else's system** — no serial we
know, no certificate code. `field-app/js/tag-link.js` handles the second kind.

An item is identified four ways, all indexed: serial, hardware uid, certificate
ref, and now the tag's link (`assets.tag_url`). A link is dispatched straight to
the link index and never run through the others — `tagKey()` strips a URL down to
whichever letters happen to be hex, which can collide with a real uid and return
the **wrong item's** record.

Nothing may be pre-filled into the serial field except a serial a tech could read
off the item. A hardware uid and a URL identify the *tag*, not the equipment.

**A fetched sheet is never an inspection.** It lands in `fp_external_records`,
stamped with its source URL, shown as *claimed — unverified*, never on a
certificate and never able to satisfy a due date. Fetching is https-only and
host-allowlisted (`docs.google.com` and our own domain by default), because a URL
off a tag is attacker-controlled input.

The real sheets are **forms on a grid**, not header-row tables: labels scattered
across eight columns with values sometimes to the right and sometimes on the line
below. `field-app/test/fixtures/tag-sheet-v1.csv` is a real one, and the parser is
tested against it rather than against an invented layout. These links are
**version 1** — expect other formats, which is why unmapped columns are kept
verbatim and shown rather than dropped.

### Help and support

The field app carries its own manual (`field-app/js/help.js`) and a ticket
thread with the developer (`field-app/js/support.js`, UI in `help-ui.js`).

The screenshots in the walkthroughs are **generated**, not drawn:
`npm run capture:help` drives the real app, rings the element by CSS selector,
and shoots the viewport. A hand-placed callout drifts the moment a button moves;
this one cannot, and the tool exits non-zero when a selector stops matching.
`field-app/test/help.test.mjs` fails if a topic references a picture that is not
on disk.

Tickets ride the ordinary upload queue, keyed by a client-side id so a retry
returns the original ticket rather than filing a second one. The queue now has
three classes of entry (see `sendOne`/`drain` in `sync.js`): inspections **block**
on failure, `fp_external`/`fp_tag_link` are **optional** (stepped aside, dropped
after 3 tries), and support traffic is **deferrable** (stepped aside, never
dropped). A ticket must never be what strands a day of inspections, and must
never be silently lost after the tech was told it would send.

The app never says "sent" until the server has it. Until then it says *waiting*,
because a tech told "sent" in a basement stops reporting things when nothing
comes of it.

The developer's inbox is in Lia Office, gated on `users.is_developer` — see
`supabase/README.md` for how to set it. The gate is server-side in every RPC;
hiding the card is presentation only.

### Certificate view tracking

Certificates are read by people outside the company, and until `14` there was no
way to tell whether the tags were being used at all. `record_certificate_view()`
is anon-executable and stores **no IP address** — a /24 (or /48) prefix, the
hour, and a coarse label resolved *at insert time* from `known_networks`, which a
lead maintains on the Certificate Views screen in Lia Office.

Hits from Lia Field and Lia Office are not recorded: the question is who outside
the company is reading a certificate, and our own apps would drown it. Labelling
is not retroactive, and the screen says so.

### Correcting fall-protection records, and pushing them to BSI

`supabase/15_fp_records.sql` is the office's side of what the field recorded. A
correction **supersedes** — the old row stays, marked, and both correcting and
deleting demand a typed reason. Deleting is soft and promotes the previous
version *of the same date* (`is_current` is per `(asset_id, inspection_date)`,
not per item). `public_ref` can never change: tags already in the field point at
it.

The tech's own answers are not editable in the office. Changing what was found
is re-inspecting, not amending, and the screen says so.

Billing rides on `src/core/fp-bsi.ts` (pure mapping, unit-tested) plus
`src/fp-automation.ts` (thin Playwright layer) and `src/fp-runner.ts`. Three
rules, all load-bearing:

- **The preflight refuses.** BSI's fall-protection form has *not* been confirmed
  field by field — `FP_FORM` in `src/fp-automation.ts` is a best guess against
  the ladder form. If the page does not carry those controls the run stops and
  names what is missing rather than filling forty boxes with wrong values on a
  live work order. **Correct `FP_FORM` once somebody has the real form in front
  of them.**
- **A landed box is recorded immediately**, not at the end of the run
  (`onPushed` → `mark_fp_bsi_pushed`). A crash at item 20 of 40 must leave the
  database knowing those 20 went in, or the re-run bills them twice.
- **The operator confirms each work order** before anything is typed. Nothing on
  the BSI page reliably says which work order is open.

### Job assignment

`supabase/16_assignments.sql`. The lead plans the day on the Job Board in Lia
Office; the phone pulls it at every start via `my_jobs()` and caches it in
localStorage, so a tech with no signal still sees yesterday's plan, marked as of
when it was fetched.

Three things this deliberately is not, and should stay not:

- **A job does not own its records.** Progress is matched on `wo_key`, so work
  recorded before the job existed counts, and deleting a job destroys nothing.
- **An assignment is not a lock.** A tech can still work a job nobody gave him.
- **Peer visibility is server-enforced.** With `share_peer_work` off,
  `job_detail()` returns only the caller's rows — not merely hidden client-side.
  Totals still come back.

On an assigned job the work order number is the lead's: the field is `readOnly`
*and* `saveNow()` refuses to take it from the box, because a tech retyping
`WO 1234` for `WO-1234` is what stopped the office matching up a day's work.

### Writing tags, and the five ways to one record

`supabase/17_tag_write.sql`. `LiaNfc.write()` had existed with no caller; this is
the other half. A tech writes our own tag onto a piece of equipment and from then
on **five** identifiers reach the same record:

| identifier | belongs to | where it lives |
|---|---|---|
| `serial_key` | the equipment | stamped on the item |
| `tag_label` | **the tag** | printed on the tag face — new in 17 |
| `nfc_tag_uid` | the tag chip | read on a tap |
| `public_ref` | the certificate | in the link |
| `tag_url_key` | the tag | the link itself |

`tag_label` is deliberately not the serial. The serial belongs to the equipment;
the label belongs to the tag stuck on it, and a harness outlives several tags.

**The URL carries both `?t=<public_ref>` and `&s=<serial>`.** The serial is there
because it is what a human reads off the equipment. The ref is there because
`update_fp_asset` can correct a mistyped serial, and a tag riveted to a harness
in a plant room cannot be rewritten when it does — a link carrying only the
serial would stop resolving. `fp_tag_url()` is the single place the format is
decided; `LiaTagWrite.urlFor()` must produce the identical string, because a tag
written offline has to say the same thing as one written on wifi.

Uniqueness of `tag_label` and `nfc_tag_uid` is enforced **in the write path, not
by a unique index**. `consolidate_to_one_account()` merges companies, two of
which can each legitimately have a tag labelled FP999999 — a unique index makes
that consolidation fail, i.e. a migration that dies on data nobody has looked at.

Order of resolution is load-bearing: a URL goes straight to the link index and is
never run through the others (`fp_tag_url_key` on a non-URL can collide with a
real uid and return the **wrong item**), and the serial beats the label, because
a label is only ever a pointer to the equipment's own identity.

`LiaTagLink.serialFrom()` only reads `s=` off **our** host. `s` is an ordinary
parameter name on other people's links.

Writing is offline-first: the URL is built on the device, the write is queued as
`fp_tag_write` (blocking, never dropped — a tag the server never hears about
resolves for one phone only), and the cache is updated immediately so tapping the
tag you just wrote does not come back "not registered" off your own phone. The
physical write happens **before** anything is queued: nobody re-checks a tag the
system already believes is correct.

### Keeping the phone bundles in sync

`field-app/capacitor/{www,ios/App/App/public,android/.../assets/public}` are what
the store builds actually ship, and they were hand-copied and had drifted by
weeks. **Run `npm run sync:www` after any change under `field-app/`**;
`npm run check:www` fails if a bundle is behind.

It is not a plain copy — the bundle's `index.html` gets the CDN script tags
rewritten to vendored files and a CSP meta tag added. Both failures only show up
on a real handset: a CDN the phone cannot reach, or a `connect-src` that silently
blocks an origin. Any new outbound origin has to be added to `buildCsp()` in
`field-app/capacitor/scripts/sync-www.mjs` (`docs.google.com` is there for the
tag-link fetch).

### CSV format

Part columns are every column that is not in the metadata set: `Row#`, `Serial #`, `Location ID`, `Brand`, `Type`, `Length`, `Description`. Quantity is encoded inline: `"(2) G13"` or `"W44 (2)"`. Brand and Type abbreviations are expanded via lookup maps in `src/automation.ts` (`BRAND_ABBREV`, `TYPE_ABBREV`).

### Cost flags

After import, `src/runner.ts` re-scrapes all boxes and flags: boxes containing PM36 with total > $90, and any box with total > $250. Thresholds are `PM36_FLAG_THRESHOLD` and `HIGH_COST_THRESHOLD` constants at the top of `runner.ts`.

### Packaging notes

`electron-builder` asarUnpacks Playwright into `app.asar.unpacked/node_modules`. The runner lives in `Resources/` (extraResources). Main sets `NODE_PATH` to the unpacked modules dir so the runner can resolve `playwright` at runtime. `config.json` is also an extraResource so it's accessible to both main and the runner.

Logs are written to `~/Documents/Lia Logs/` in the packaged app (set via `BATAVIA_LOGS_DIR` env var) and to a temp dir in dev mode.
