# Lia — Project Status

**As of 2026-08-23** · branch `fall-protection` @ `194ba00`. `master` frozen at
`prod-baseline-2026-08-22` (`6db1ef3`), pushed.

---

## Fall protection work — where it stands

Full plan: `~/.claude/plans/we-will-be-adding-zany-corbato.md`.

| Phase | State |
|---|---|
| 0 — Migration safety (staging Supabase) | ⛔ **Blocked on you** — needs a staging project created |
| 1 — Shared CSV core + live bug fix | ✅ Done, tested |
| 2 — Accounts, versioning, correct billing | ✅ Written and tested locally, **not applied to any live DB** |
| 3 — Ladder L/C/V/P | ◐ Capture done and verified; BSI automation needs a codegen session |
| 4 — Field app sync | ◐ Read model + on-device cache done and tested; auth and upload need staging Supabase |
| 5 — Multi-tech merge | Not started |
| 6 — Fall protection | ◐ Schema, status, photo retention, job scope, **capture UI** all done. Remaining: the checklist templates syncing down, and upload |
| 7 — Cert site | ◐ `fp-site/index.html` built and verified; deploys under `/fp/` on the existing bucket |
| 8–9 — NFC, PWA decommission | Not started |

### ⚠️ Do not ship Lia Office before applying the migrations

The current build calls `preflight_work_order` and `charge_work_order`, which only
exist after `supabase/03_accounts_billing.sql` and `04_inspections_v2.sql` are
applied. Without them every import is blocked. Ship the SQL and the app together.

Rehearse the migrations first — they carry real credit balances and restructure
live inspection rows:

```bash
./supabase/test/run.sh      # throwaway local Postgres, 61 assertions
```

### What the billing rework changed

A token is now charged **once per work order, only after the import succeeds**.
Previously it was consumed the moment Start was clicked — before Chrome launched
and before the diff card where the user can still cancel — and re-running the same
work order charged again. Cancelling, a missing Chrome, and crashes are now free,
and editing or merging more techs' data into a paid work order is free.

The work order field is now **required**. It used to default to the literal string
`'unknown'`; under the new `(account, work order)` uniqueness that would have made
the first blank-work-order import charge and every one after it free forever.

### Bugs fixed along the way

- `src/csv-parser.ts` was importing every `[Custom] ` field into BSI as a part to
  search for. The renderer preview filtered them; the code that actually ran did
  not. Both now share `src/core/`.
- `autoInsertInspections` fired on failed runs, and wrote `notes: null`, blanking
  notes on every re-import.
- `inspections` RLS was `USING (true)` for every authenticated user — any tech
  could read and overwrite any other company's records.
- The destructive `UNIQUE (serial_num, inspection_date)` is gone; inspections are
  versioned and supersede rather than overwrite.

### Test suites

```bash
npm test              # 11 unit (CSV/flag logic)
npm run test:field    # 79 browser (device cache, modules, bundles, FP capture)
npm run test:sql      # 155 assertions against a throwaway local Postgres
npm run typecheck
```

### Still needed from you

1. **A staging Supabase project** — so the migrations can be rehearsed against a
   restored production snapshot before touching the real one.
2. **A BSI work order that can be dirtied** — for the codegen session that finds
   the four L/C/V/P checkbox selectors, and later the fall-protection box.
3. **How BSI identifies a fall-protection box.** Ladder boxes key off the serial;
   an aggregate FP box has none, so re-running an FP import would add a second box
   rather than update the first. That double-bills the customer.
4. **The valid set of `status` values** for fall-protection items. The column is
   deliberately free text with no CHECK constraint until that is known.
5. ~~How the capture screen should look~~ — settled. Mockups at
   <https://claude.ai/code/artifact/c07c621b-6767-42c0-8900-0d2f5c90f1c1>,
   source in `design/fp-screens/`. Building it is the next piece of work.

### Known consequence, flagged deliberately

Ladders and fall protection are always separate work orders, and a token is charged
per work order — so **a job site with both scopes costs two tokens**. That follows
from the two rules and is probably intended, but it had not been written down.

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
<https://d1uwg2boqwq3l6.cloudfront.net/privacy.html> — source at
`inspection-site/privacy.html`. Lia Field makes **zero** network calls and keeps
everything in on-device `localStorage`, so its data-safety declaration is
"no data collected." Lia Office syncs to Supabase. Do not merge the two policies
without rewriting the claims — the "collects nothing" line would become false.

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
