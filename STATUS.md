# Lia — Project Status

**As of 2026-07-29** · master @ `e9592f2`, pushed, working tree clean.

---

## Where we are

Three products ship from this repo. Here is the honest state of each.

| Product | State | Channel |
|---------|-------|---------|
| **Lia Field (iOS)** | ✅ Live in TestFlight, build 2 | Internal testing |
| **Lia Field (Android)** | ✅ Signed AAB + APK built, not yet uploaded | Play internal testing |
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

### Blocked on you

1. **Upload the AAB** to Play Console → Internal testing. Needs App content filled
   in first — privacy policy URL, data safety, camera justification. All three
   answers are in the deliverables README.
2. **Windows code-signing certificate** — in progress on your side. Until it
   lands, Windows installers are unsigned and trip SmartScreen. ⚠️ Check how the
   cert is delivered: since June 2023 OV code-signing certs ship on a hardware
   token or cloud HSM, and a hardware token **cannot** be used from a
   GitHub-hosted runner. If yours is a token, signing has to happen on a local
   Windows machine and the CI path becomes unsigned-builds-only.

### Then — pick one Windows build path

3. **CI path**: set the `LIA_CONFIG_JSON` repo secret (full body of the gitignored
   `config.json`; the workflow fails fast without it), then run
   **Actions → Build Lia Office (Windows)**.
4. **Local path**: on a real Windows box, clone, `npm ci`, drop `config.json` in
   by hand, `npm run electron:build:win`. No repo secret needed at all — item 3
   becomes unnecessary.

Either way, verify the installer on a real Windows machine. ⚠️ The NSIS build has
never executed. It cannot be built or verified from macOS, so treat the first run
as unproven whichever path you take.

### After that

5. Collect tester feedback, fix, bump `versionCode`, re-ship.
6. Decide on public release. Everything so far is internal-track only.

---

## Decisions worth remembering

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
