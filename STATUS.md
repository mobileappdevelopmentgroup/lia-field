# Lia — Project Status

**As of 2026-09-19** · branch `fall-protection` @ `47b83f6`, **pushed** and in
step with `origin`. `master` is still the 2026-08-22 production baseline
(`prod-baseline-2026-08-22`) plus one CI-only commit, `280d340`, the Windows
test-step fix below. Pushing needs the `mobileappdevelopmentgroup` gh account.

---

## Where it stands — 2026-09-19

**1.7.0 is the current release everywhere it can be built.** Shipped 2026-08-30
with migrations 11–17 live on production (`docs/RELEASE.md` is how it was done).

| Product | Build | State |
|---|---|---|
| Lia Field (iOS) | 1.7.0, TestFlight build **5** | Uploaded 2026-08-30 |
| Lia Field (Android) | 1.7.0, **versionCode 4** | ✅ Live on Play **internal testing** — confirmed 2026-09-19 through the API (`npm run play:upload -- --check` reads the track back) |
| Lia Office (macOS) | 1.7.0 DMG | Signed, **not notarized** |
| Lia Office (Windows) | 1.7.0 NSIS, **unsigned** | ✅ **First build ever, 2026-09-19** (CI). ⚠️ Never installed or run on Windows yet |

### Done 2026-09-19

- **The Windows installer builds.** `LIA_CONFIG_JSON` repo secret set, and
  **Actions → Build Lia Office (Windows)** produced `Lia Setup 1.7.0.exe`
  (x64, 85 MB) on its first run — run `35464632388`. Copied to
  `~/Desktop/Lia-Deliverables/`. The build moved to CI rather than the local
  path in `docs/WINDOWS-BUILD.md`: the bench Windows PC is for **testing only**,
  so neither the toolchain nor `config.json` has to live on it.
- **The Windows build now runs every unit test.** A manual run uses *master's*
  copy of the workflow to build whatever `ref` it is given, and master's listed
  only `src/*.test.ts` — the first build ran 10 of 52. The step now finds
  `*.test.ts` under `src/` in the checked-out code, so it is right on either
  branch (master has no `src/core/`, so copying the branch's list would have
  broken master's builds instead). Fixed on both branches; run `35465208292`
  confirms 52/52 on Windows. **Dispatch with `--ref master -f ref=fall-protection`**
  — the default `ref` is `master`, which builds the August baseline app.
- **Store-declaration docs made consistent.** Six places still called the
  "no data collected" declarations an open blocker; they were updated in both
  consoles on 2026-08-24 (see below). ⚠️ Taken from this file's record of that
  day, not re-checked in the consoles.
- **Play uploads are scripted.** `tools/play-upload.mjs` (`npm run play:upload`)
  uploads an .aab and releases it to a testing track through the Play Developer
  API — no `googleapis` dependency, the service-account JWT is signed with
  node's `crypto`. Key at `~/.play-keys/lia-play-publisher.json` (mode 600,
  passed by path, never in the repo), granted **Lia Field + release to testing
  tracks only**. `--check` verifies credential and permission without changing
  anything; the tool refuses `production` outright. ⚠️ The **upload path itself
  is still unproven** — versionCode 4 went up by hand before the key existed, so
  the first scripted upload will be versionCode 5.
  **Play Console → Setup → API access could not be found in this account's nav**;
  the service account was made in Google Cloud and granted through
  **Users and permissions** instead, which works and avoids that page entirely.
- **Tester pack refreshed** for an Android tester onboarding 2026-09-20.
  `~/Desktop/Lia-Deliverables/` now holds the 1.7.0 .aab, the Windows
  installer, a README with the full onboarding checklist (Play tester list →
  Supabase invite → `create_lia_user` as a `tech` on the Batavia account), and a
  rewritten `FOR-TESTERS.md` — the old one told testers the app never signs in
  and uploads nothing. The v1.1 / versionCode 1 files are in `old-2026-07-28/`
  and must not be handed out.

### Done 2026-09-19 — the account model became an umbrella

Batavia holds the contracts and parses the work out to lead subcontractors
(Nate · 763 · Pennsylvania, Michael · 738 · California), each running their own
crew. The flat one-account-per-company model could not express that, and two
leads in one account would have shared everything. Four migrations, written,
tested and **not yet applied**:

| | |
|---|---|
| `18_umbrella_accounts.sql` | Accounts gain a parent. Work flows **up** to the umbrella, catalogue flows **down** to the subs. `create_subcontractor()` and `add_crew_member()` make onboarding one call each. Applying it changes nothing until accounts are linked. |
| `19_certificate_attribution.sql` | The certificate names the responsible **lead** and the umbrella. ⚠️ **Closes a live disclosure**: the public views publish the *field person's* name as `tech_name` today, readable by anon. |
| `20_impersonation.sql` | The office can act as a subcontractor — expiring, recorded, downward-only. |
| `21_impersonation_write_paths.sql` | The write paths follow that session. Without it, work recorded while acting as somebody lands in the office's own account and looks like it worked. |

Apply with `supabase/dist/apply-18-21.sql`, then run
`supabase/ops/2026-09-19-restructure-umbrella.sql` — which moves the **1,724
records to Nate's new account** with their assets, links both subs under
Batavia, and makes Alex lead of the umbrella. Both rehearsed:
`./supabase/test/run-apply-18-21.sh` applies the bundle twice to a
production-shaped database, and the restructure was rehearsed against seeded
live-shaped data. Full suite: **578 assertions**.

Onboarding people — leads, crews, acting as a subcontractor — is
**`docs/ONBOARDING.md`**.

**Lia Office drives it** as of the same day: an *Act as a Subcontractor* card
(shown only when the server says you may), a panel that demands a reason, and a
banner naming the account with time remaining and a Stop button. The credit
badge follows the account being **billed**, not the office's own — showing
Batavia's "Unlimited" while acting as a sub would promise an import the server
then refuses. Starting or stopping drops every cached screen.
`electron/test/act-as.test.mjs` covers it and caught two real bugs: a panel
wired before its markup existed (which silently killed the rest of the
renderer), and an expired session recursing until the window died.

**Onboarding is a screen now too** — `22_onboarding_rpcs.sql` plus *Your Crew*
and *Subcontractors* in Lia Office. ⚠️ **22 is not applied yet**: paste
`supabase/dist/apply-22.sql`, or those two screens error. It also **replaces
`add_crew_member`**, which resolved the account itself — so the office acting as
a subcontractor added a hand to the *office's* account, silently. The SQL tests
caught it.

**Two bugs found while building the screens**, both pre-existing:
`.mode-cards` never wrapped, so at the window's own default width the card row
ran to 2620px and **eight of twelve cards were unreachable** — Job Board, FP
Records, Certificate Views and Support among them — and the home screen did not
scroll. Both fixed.

**Still not built:** the Supabase invite itself (no API for it from here), and
catalogue authoring and tag links do not follow an impersonation session.

⚠️ **The other desktop tests cannot run on this machine** — Playwright's bundled
Chromium is missing (`npx playwright install chromium` restores it). The new
test uses system Chrome, like the automation does, so it runs regardless.

### Done 2026-09-21 — the field round trip actually works

**The upload bug.** The queue stopped at the first record the server refused and
waited on it for ever, so one bad record meant nothing behind it uploaded while
the app said "waiting". A record refused three times now steps aside (never
dropped, named in Settings with the server's own words), a job goes up in one
call instead of one record at a time, and uploads start seconds after capture.

**Ladders never uploaded at all** before this — `sendOne` handled them, the
office's merge screen expected them, nothing ever queued one. They do now, with
their parts (migration 24), which is what made importing field work possible.

**A shared phone is safe.** The queue is scoped to whoever captured the record,
jobs are labelled with the address that owns them, assignments are cleared at
sign-out and say which lead assigned them (migration 25), and jobs can be
archived rather than deleted.

**Lia Office** gained a How To covering the real process — CSV, field work,
merging several techs, and the checking step after an import — plus *Import
this into BSI* from Merge Field Work, *Run this again*, a way home from every
screen, a working layout from 800×640 up, and issue/feature reporting.

Shipped as **1.11.0**: Android versionCode 9, iOS build 10 (VALID), all three
desktop builds in `~/Desktop/Lia-Deliverables/`. Migrations **24 and 25 applied**.

**1.11.1 — office only.** Merge Field Work asked `inspections` for
`uploaded_at`, a column only `fp_inspections` has, and failed the whole pull in
front of a work order; it reads `created_at` now, which is the same fact. Every
desktop test stubs the Supabase client and a stub answers to any column name, so
`electron/test/columns.test.mjs` checks the app's real column lists against the
committed schema snapshot. The three desktop builds in
`~/Desktop/Lia-Deliverables/` are 1.11.1; the phones stay on 1.11.0 and need no
reinstall.


**1.12.0 — 2026-09-21.** Android **versionCode 10**, iOS **build 11**, all three
desktop builds in `~/Desktop/Lia-Deliverables/`.

Three things that did not work on a real device, all of them silent: **Save CSV
did nothing at all on Android** (the WebView has neither the Web Share API nor a
download manager, so both routes the code took were no-ops; iOS has Web Share,
which hid it), the **suggestion lists opened upwards** over the field just
filled in, and the **greeting was sheared off** the top of Lia Office.

**The four ladder checkboxes now reach BSI.** L, C, V and P had never been wired
up — the parser filled them, the CSV carried them, the database stored them, and
`src/automation.ts` never read `record.flags`. Read off a live work order
(`docs/BSI-FORM.md`): they are bound to `click`, not `change`, unlike the
dropdowns beside them, so the house pattern would have ticked them on screen and
saved nothing.

**Fall protection is the same form** — one box per work order, serial `1111` +
the work order number, items as parts by type. So `src/core/fp-bsi.ts` is wrong
at the premise and `FP_FORM` guesses at a form that does not exist. The derived
serial also answers the double-billing question: the existing diff finds the box
on a re-run.

**The phone knows every part BSI does** — 1,936 with descriptions, merged behind
each tech's own favourites and order. Not 11,079: that is the price matrix,
23 customer types deep, which is also why a part number alone never identifies a
price.

**Lia Office has fewer, clearer screens**: Import CSVs Manually, **Field Work**
(Merge and FP Records as one list, coloured by what still owes BSI), Work Order
Assigning, Catalog, and Advanced for the rest. Work History is Field Work's
archived half, read-only, with one button that sends a work order back.

Migrations **26 and 27 are written and tested but NOT applied** — Field Work and
the shared catalogue need them. `docs/QUEUE.md` has what is left.

**1.12.1 — 2026-09-21.** Android **versionCode 11**, iOS **build 12**, all three
desktop builds in `~/Desktop/Lia-Deliverables/`. Migrations **26 and 27 applied
and verified** against the live database.

**Fall protection pushes to BSI.** It never could: `FP_FORM` guessed at a form
nobody had seen and a preflight refused every run. Work order 98471 showed the
guess was unnecessary — fall protection is the ladder form, one box per work
order, serial `1111` + the work order number, items collapsed onto it as parts
by type. `src/core/fp-bsi.ts` was wrong at the premise and its tests passed the
whole time, because they checked the mapping against itself. The box now goes
through `runAutomation()` and `fp-automation.ts` lost two thirds of its lines.
The derived serial makes a re-run safe, which closes the double-billing
question.

**Six equipment types have no billing code** and stay that way until the office
knows: inspected, named on the push screen as "inspected, not invoiced", never
billed under a neighbouring code. Adding one is a row in `FP_TYPE_CODES`.

**The lead's parts list** — Catalog → Ladder parts. Picked from BSI's 1,936 by
number or description; a part BSI does not know is allowed and marked as one
that will not bill. On the phones it lands behind each tech's own favourites,
order and quantities.

A ladder-side bug fell out of it: `fillNewSerialFields` hardcoded Description to
"Ladder Repair", so a fall-protection box would have been filed as a ladder
repair.

### Still needed from you

1. ~~Confirm Play has 1.7.0 (4)~~ — done 2026-09-19.
2. **Test Lia Office on the bench Windows PC**: install (SmartScreen → *More
   info → Run anyway*), sign in, open a CSV, start an import (needs **Chrome**),
   the lead screens (Job Board, FP records, Certificate Views), relaunch still
   signed in. None of it has ever run on Windows. Logs: `Documents\Lia Logs\`.
3. **Decide the rep-number model** — still open, still built per-account (every
   certificate names the lead). The write-up was in `docs/PICK-UP-HERE.md`,
   removed in `bf445c9`; read it with
   `git show bf7e8e9:docs/PICK-UP-HERE.md`. It recommends per-tech. More
   pressing now that a second tech is joining.
4. **A BSI work order that can be dirtied** — L/C/V/P selectors, `FP_FORM`, and
   how BSI identifies an aggregate fall-protection box (re-run double-billing).
5. **NFC hardware testing** — `docs/NFC-PLUGIN.md`, plus the iOS `TAG`-only
   entitlement question. Not recorded as done.
6. **Windows code-signing certificate** — installers stay unsigned until then.
7. **Confirm the two expanded checklist prompts** ("Arrester enclosure
   exterior", "Warning center not extended") before the first real FP
   certificate.

---

## Where it stood — 2026-08-24

**The migrations are applied and the anon leak is closed.** The thing that
blocked everything is done. Full write-up, and the one decision still open:
**`docs/PICK-UP-HERE.md`** (removed in `bf445c9`; `git show bf7e8e9:docs/PICK-UP-HERE.md`).

Verified from outside the database with the publishable key:
`GET /rest/v1/inspections` → **401 `42501`** (was 200 with 1,724 rows);
`ladder_inspections_public` still serves all 1,724; a real certificate URL
(`/?t=RTPTXK9PJK`) returns 200 on the new domain.

One account — `265882ec-…`, **Batavia** — 1,724 inspections adopted, 0
ownerless, unlimited credits preserved.

### ⚠️ Open decision: rep numbers do not scale to more importers

`record_inspection` stamps the responsible rep from the account's *lead*, so
with several techs importing, every certificate they produce names one person.
More importers are coming. Two models and a recommendation are written up in
`docs/PICK-UP-HERE.md` — this is the thing to decide next.

---

## Fall protection work — where it stands

Full plan: `~/.claude/plans/we-will-be-adding-zany-corbato.md`.

| Phase | State |
|---|---|
| 0 — Migration safety | ✅ Superseded — staging skipped deliberately; Route B rehearsed against production-shaped data |
| 1 — Shared CSV core + live bug fix | ✅ Done |
| 2 — Accounts, versioning, billing | ✅ **Applied to the live DB 2026-08-24** |
| 3 — Ladder L/C/V/P | ◐ Capture done; BSI automation needs a work order |
| 4 — Field app sync | ✅ Auth, catalogue cache, upload queue, first-sync gate |
| 5 — Multi-tech merge | ✅ Merge logic + review screen |
| 6 — Fall protection | ✅ Schema, capture UI, catalogue authoring, the fourteen equipment types |
| 7 — Certificate site | ✅ Live on `lia.mobileappdevelopmentgroup.com`; `/fp/` deployed 2026-08-24 (it had never been uploaded) |
| 8 — NFC | ◐ Read path fixed + tap-through built; **TestFlight build 4 (2026-08-27)**, VALID, live to internal testers. Still needs hardware testing |
| 9 — PWA decommission | ◐ Farewell page ready; removal waits on the native release |

### Done 2026-08-25

- **The fourteen equipment types are in**, with the per-type pass/fail
  parameters from Batavia's sheet. `supabase/migrations/11_fp_equipment_types.sql` seeds
  them; `field-app/js/fp-types.js` is the device-side copy, generated from the
  same table with a test that fails if they drift.
- **The checklist moved from the model to the equipment type.** It had hung off
  manufacturer+model, which is wrong: a body harness is checked as a body
  harness whoever made it. A model can still be given its own list, which
  overrides its type's and is seeded from it.
- **Equipment type is now a picker, not free text.** The checklist is selected
  by it, so "lanyard" vs "lanyards" typed by hand would have quietly produced
  the wrong questions on a safety record.
- **Checks carry how they are answered.** Two are yes/no questions and one is
  inverted — "has the impact indicator been activated?" fails on *Yes*. Storing
  that as a plain pass/fail would have printed the opposite of the truth on a
  certificate. `record_fp_inspection` now takes the polarity from the template
  rather than the payload, and refuses a record with an unanswered required
  check.
- **`supabase/build-combined.sh` globbed `0[3-9]_*.sql`**, so anything numbered
  10 or higher was silently missing from the paste script. Fixed.

#### Still open

- Two prompts expand abbreviations from the source sheet and are worth
  confirming before the first real inspection, since they print on a
  certificate: "arrester encloser ext" → **"Arrester enclosure exterior"**, and
  "warning center not ext" → **"Warning center not extended"**.
- ~~`11_fp_equipment_types.sql` has **not** been applied to the live database yet.~~
  Applied 2026-08-30 with 12–17.

### Done 2026-08-24

- **Store paperwork closed.** Apple App Privacy and Play Data safety both filled
  in. Privacy policy rewritten and deployed — the live one had still said
  "does not collect, transmit, or share any personal data", which stopped being
  true when sync landed.
- **Moved onto a real domain.** `lia.mobileappdevelopmentgroup.com` now serves
  the certificate site, `/fp/`, the privacy policy and the new data-deletion
  page. ACM cert + CloudFront alias + Route 53 records applied. The old
  `d1uwg2boqwq3l6.cloudfront.net` address still works.
  `app_settings.certificate_base_url` was repointed **before any NFC tag was
  written** — that URL is permanent once tags are in the field.
- **Data deletion page** (`inspection-site/data-deletion.html`) — Play's Data
  safety form requires a deletion *URL*; the policy only offered an email.
- **TestFlight build 3 uploaded and VALID**, export compliance answered,
  available to internal testers.

### Two things the build 3 upload uncovered

1. **The regenerated provisioning profile was the wrong type.** What was created
   in the portal was a `MAC_APP_STORE` profile (`.provisionprofile`), which
   cannot sign an iOS app, and it carried no NFC entitlement. The correct
   `IOS_APP_STORE` profile — "Lia Field App Store NFC" — was created through the
   App Store Connect API and is what `ExportOptions.plist` now names.
2. **`NDEF` is no longer a valid NFC entitlement format.** Apple rejected the
   first upload: *"The sdk version '26.2' and min OS version '15.0' are not
   compatible ... 'NDEF is disallowed'"*. `App.entitlements` now declares `TAG`.
   ⚠️ The plugin uses `NFCNDEFReaderSession`; that it still reads NDEF tags under
   a `TAG`-only entitlement is **unverified** and is now the first thing hardware
   testing must check.

### Still needed from you *(as of 2026-08-24 — superseded by the 2026-09-19 list above)*

1. **Decide the rep-number model** — `docs/PICK-UP-HERE.md`. Everything else is
   mechanical.
2. **A BSI work order that can be dirtied** — for the L/C/V/P checkbox selectors,
   and to answer **how BSI identifies an aggregate fall-protection box**. Ladder
   boxes key off the serial; an FP box has none, so a re-run adds a second box
   and double-bills the customer. This is the only unanswered design question
   left in the project.
3. **NFC hardware testing** — real tags, real phones. List in `docs/NFC-PLUGIN.md`,
   plus the `TAG`-entitlement question above. Build 4 is the one to test: it is
   the first build whose read path could ever have worked (payloads were never
   being decoded), and the first with tap-through.
4. **Android build 3 is signed but not uploaded.** `bundleRelease` produced
   `field-app/capacitor/android/app/build/outputs/bundle/release/app-release.aab`
   (versionCode 3). It cannot be pushed from here: Play uploads need a Google
   Cloud service-account JSON key and one has never been created — see
   `CLAUDE.md` under Google Play. Upload it by hand, or create the key.
5. **Windows code-signing certificate**, and a first NSIS build — it has never
   been built even once, and cannot be from macOS.
6. **Push the branch** — needs the org account.

### Decided 2026-08-24

`DEVIATIONS.md` item 1 is settled: the merge UI keeps **no** pass/fail override.
A FAIL beating a PASS is a safety rule, not a default to click past. Reasoning
is recorded there.

### Known consequence, flagged deliberately

Ladders and fall protection are always separate work orders, and a token is charged
per work order — so **a job site with both scopes costs two tokens**. That follows
from the two rules and is probably intended, but it had not been written down.

### Test suites

```bash
npm test              # 30 unit (CSV/flag logic)
npm run test:field    # browser (cache, modules, bundles, capture, sync, boot, NFC)
npm run test:desktop  # browser (catalogue authoring, merge review)
npm run test:sql      # 8 suites against a throwaway local Postgres
npm run typecheck
```

All green as of 2026-08-24.

### Deviations from the plan

`DEVIATIONS.md` lists every place the build differs from what was approved, and
why.

---

## Prior status (2026-08-08)

## Where we are

Three products ship from this repo. Here is the honest state of each.

| Product | State | Channel |
|---------|-------|---------|
| **Lia Field (iOS)** | ✅ Live in TestFlight, build 2 | Internal testing |
| **Lia Field (Android)** | ✅ **Live in Play internal testing**, versionCode 1 | Internal testing |
| **Lia Office (macOS)** | ✅ Working, ships as DMG | Direct download |
| **Lia Office (Windows)** | ⚠️ Code + CI done, **never built** | Direct download (NSIS) |
| **Ladder Inspection Site** | ✅ Live, unchanged since June | S3 / CloudFront |

We are in **internal testing**, not public release. Nothing is on a public store
listing and nothing should be until the testers come back.

### What landed 2026-07-28

- Closed the two MEDIUM security TODOs — anon can no longer reach the
  `inspections` base table, and `res.error` is escaped before hitting `innerHTML`.
- Made Lia Office run on Windows (see below).
- Wrote and deployed the privacy policy both stores require.
- Rebuilt Lia Field for Android off current master.
- Reclaimed ~57 GB of disk (was at 4.4 GB free, now 58 GB).

---

## Deliverables ready to send

Staged in **`~/Desktop/Lia-Deliverables/`**, built from `1a42405`:

| File | For |
|------|-----|
| `lia-field-v1.0-vc1-sideload.apk` | Testers, right now — sideload, no Play Console |
| `lia-field-v1.0-vc1.aab` | Play Console → Internal testing |
| `README.md` | Upload steps and the App content answers |

Both signed with `~/.android-keystores/lia-field-release.keystore`:
`SHA-256 a6dc524332ddfd96efedf294d60eef52db783a718443a9549e805b67bf67f720`.
`versionCode 1`, `versionName 1.0`.

iOS testers need nothing new — TestFlight build 2 already has the same features.

**What testers are actually exercising:** the non-numeric serial warning and
catalog quantities everywhere (the June 12 work), on top of the barcode scanner.

---

## What we're doing next

### Done 2026-07-29

- Applied the `REVOKE` against the live database.
- Sent the sideload APK to internal testers. Feedback is now accumulating.
- Dropped the anon-key rotation (see "Still open" for the reasoning).
- Fixed the Windows CI test step, which would have failed on its first run —
  `npm test` globs `src/*.test.ts`, and npm shells out to `cmd.exe` on Windows,
  which does not expand globs. Now runs `npx tsx` under bash.

### Done 2026-08-08

- **Lia Field is on Google Play internal testing.** App content declarations
  filled in (privacy policy URL, data safety = no data collected, camera
  justification), `lia-field-v1.0-vc1.aab` uploaded and rolled out.
  The tester opt-in link is deliberately kept out of this repo — it lives in
  `~/Desktop/Lia-Deliverables/FOR-TESTERS.md`, and Play Console shows it under
  Test and release → Testing → Internal testing → Testers.
- Enrolled in **Play App Signing** — the local keystore
  (`a6dc5243…`) is now the *upload* key only; Google holds the app signing key
  that end users' installs are signed with. The two fingerprints differ by
  design.
- Rewrote `~/Desktop/Lia-Deliverables/FOR-TESTERS.md` for the Play install path,
  with an uninstall-first warning (see below).

### Blocked on you

1. **Windows code-signing certificate** — in progress on your side. Until it
   lands, Windows installers are unsigned and trip SmartScreen. ⚠️ Check how the
   cert is delivered: since June 2023 OV code-signing certs ship on a hardware
   token or cloud HSM, and a hardware token **cannot** be used from a
   GitHub-hosted runner. If yours is a token, signing has to happen on a local
   Windows machine and the CI path becomes unsigned-builds-only.

### Then — pick one Windows build path

2. **CI path**: set the `LIA_CONFIG_JSON` repo secret (full body of the gitignored
   `config.json`; the workflow fails fast without it), then run
   **Actions → Build Lia Office (Windows)**.
3. **Local path** ← chosen. On a real Windows box, clone, `npm ci`, drop
   `config.json` in by hand, `npm run electron:build:win`. No repo secret needed
   at all — item 2 becomes unnecessary. Full step-by-step, including winget
   prerequisites and the signing caveat: **`docs/WINDOWS-BUILD.md`**.

Either way, verify the installer on a real Windows machine. ⚠️ The NSIS build has
never executed. It cannot be built or verified from macOS, so treat the first run
as unproven whichever path you take.

### After that

4. Collect tester feedback, fix, bump `versionCode`, re-ship. ⚠️ **versionCode 1
   is permanently burned** — Play rejects it forever, even after a release is
   deleted. The next Android build must be `versionCode 2` in
   `field-app/capacitor/android/app/build.gradle:10`.
5. Decide whether Android production is even wanted. **The Play account is a
   Personal account** (confirmed 2026-08-08), so production access requires 12
   testers opted into a *closed* track for 14 continuous days, then a
   Google-reviewed application. Internal testing earns **zero** progress toward
   it. Recruit ~18–20 so attrition doesn't reset the clock, and read the live
   progress card under Test and release → Testing → Closed testing rather than
   trusting remembered policy details.

   ⚠️ Worth questioning before starting that clock: Lia Field's users are field
   techs at a handful of businesses. Internal testing caps at 100 testers and
   closed testing is uncapped — either may serve permanently, making the
   production gate moot. Public discoverability is not a goal for this app, by
   the same reasoning that keeps Lia Office off the Microsoft Store. Also
   unverified: if the Play account predates 2023-11-13 the requirement does not
   apply at all.

---

## Decisions worth remembering

**Sideloaded builds cannot update from Play.** The APKs sent to testers before
2026-08-08 are signed with `~/.android-keystores/lia-field-release.keystore`
directly. Play-distributed builds are signed with Google's Play App Signing key.
Same package name, different signature — Android refuses the install with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` (or a bare "App not installed"). Testers
must uninstall the sideloaded app first, which wipes its `localStorage`. Don't
hand out raw APKs alongside the Play track again.

**No Microsoft Store.** Lia Office automates a third-party site
(`bsiwebapp.com`) under a credentialed login, its users are a handful of
businesses rather than store browsers, and entitlement already runs through
Supabase. Store certification would add delay, cost control over releases, and
put the automation in front of a reviewer. A signed installer on a download page
is the better channel — and needs the same certificate anyway.

**Privacy policy covers Lia Field only.**
<https://lia.mobileappdevelopmentgroup.com/privacy.html> — source at
`inspection-site/privacy.html`. *(Superseded 2026-08-24: Lia Field now syncs, so
the policy was rewritten and both store declarations updated — see
`docs/STORE-DATA-DECLARATIONS.md`. The line below is kept as history.)* Before
sync, Lia Field made zero network calls, so its declaration was "no data
collected". Lia Office is a separate data model and is still out of scope.

**No `ipcRenderer.once()` in preload.** An old TODO suggested it for
`onComplete`/`onExited`. That would be a bug: the renderer binds at module scope
and reuses handlers across runs, so a one-shot listener leaves the second import
with no completion handler. Registration now goes through an `on()` helper that
clears the channel first.

---

## Still open

**✅ The `REVOKE` is applied.** `supabase/migrations/02_inspections.sql` was re-run against
the live database on 2026-07-29. Anon no longer has any grant on the
`inspections` base table.

**The anon key is not a leak — closed, with a correction.** Earlier revisions of
this file flagged `sb_publishable_WgGGcm9a-sJFt-9kpaWwAg_Rm-ft5Nj` as 🔴 because
it sits in `config.json` and in git history on a public repo. That framing was
wrong. The key is hardcoded at `inspection-site/index.html:312` and deployed to
S3/CloudFront **by design** — it is a publishable browser-side identifier, and
the public inspection site cannot query anything without it. It is in git
history because it was always meant to be public.

The actual control is RLS plus table grants, and that is what the `REVOKE` above
fixed. Anon's only remaining path to inspection data is the
`ladder_inspections_public` view, which exposes exactly the fields the public
site is built to display.

Rotation was considered and **deliberately dropped**. It would swap one public
identifier for another while requiring three coordinated redeploys — the S3
site, the macOS DMG, and the `LIA_CONFIG_JSON` CI secret — with a broken product
surface if any one is missed. Revisit only if the Supabase project shows
abnormal API volume, i.e. someone scraping the key to burn quota. That is a
monitoring trigger, not a backlog item.

**✅ Migrations 11 through 17 are applied.** Run on 2026-08-30 from
`supabase/dist/apply-11-17.sql`. Verified from outside afterwards with the
publishable key:

- `ladder_inspections_public` still serves **1,724 rows**, and a certificate
  still resolves both ways the public site looks one up — by certificate code
  (`RTPTXK9PJK` → 1000090) and by serial.
- `GET /rest/v1/inspections` still returns **401** — the base-table grant stays
  closed.
- `fall_protection_public` carries `tag_url`, `tag_label`, `tag_label_key` and
  `tag_write_url`, so 12 and 17 both landed on the view.
- Every new function from 11–17 answers **42501** to anon (present, no EXECUTE),
  and `record_certificate_view` — the one function 14 grants anon on purpose —
  accepts a call and correctly skips a view whose source is not `web`.

Getting there took two attempts and the reason is worth keeping: the first
bundle started at **14**, on the wrong belief that the live database was at 13.
It is at 10 — 11, 12 and 13 were written on this branch after the 2026-08-24
apply. 14's RLS policy calls `is_developer()`, which 13 defines, so the run died
there and left a half-applied database. `./supabase/test/run-apply.sh` now
reproduces that exact failure and proves the correct bundle recovers from it.

**Check what is live before writing a bundle, rather than trusting this file.**
`git ls-files supabase/*.sql` shows what pre-dates the branch, and the REST
schema shows what the database actually has.

**The BSI fall-protection form has not been confirmed.** `FP_FORM` in
`src/fp-automation.ts` is a guess based on the ladder form. The preflight
deliberately refuses the run and names the missing controls rather than filling
boxes with wrong values on a live customer work order, so this is safe as it
stands — but Push to BSI will refuse every run until somebody with the real form
in front of them corrects those selectors.

Remaining lower-priority items are in `CLAUDE.md` → Security TODOs.

---

## Environment notes

- Pushing to `origin` needs the **`mobileappdevelopmentgroup`** gh account —
  `hectorahinojosa1` has pull-only rights. `gh auth switch --user
  mobileappdevelopmentgroup`, push, then switch back.
- `node_modules` was cleared repo-wide during the disk cleanup. `npm install`
  before working in any project, including `field-app/capacitor/`.
- Playwright browsers were cleared too — `npx playwright install` before the next
  real BSI import run.
- Android builds need `JAVA_HOME=/opt/homebrew/opt/openjdk@21` and
  `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`.
