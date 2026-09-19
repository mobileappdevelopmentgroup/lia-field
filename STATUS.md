# Lia — Project Status

**As of 2026-08-24** · branch `fall-protection` @ `f200e6b`+. `master` frozen at
`prod-baseline-2026-08-22` (`6db1ef3`), pushed. **The `fall-protection` branch
has never been pushed** — 47 commits live only on this machine, and pushing
needs the `mobileappdevelopmentgroup` account.

---

## Where it stands — 2026-08-24

**The migrations are applied and the anon leak is closed.** The thing that
blocked everything is done. Full write-up, and the one decision still open:
**`docs/PICK-UP-HERE.md`**.

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
  parameters from Batavia's sheet. `supabase/11_fp_equipment_types.sql` seeds
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
- `11_fp_equipment_types.sql` has **not** been applied to the live database yet.

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

### Still needed from you

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

**✅ The `REVOKE` is applied.** `supabase/02_inspections.sql` was re-run against
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
