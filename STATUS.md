# Lia — Project Status

**As of 2026-07-28** · master @ `1a42405`, pushed, working tree clean.

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

### What just landed (today)

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

### Blocked on you

1. **Upload the AAB** to Play Console → Internal testing. Needs App content filled
   in first — privacy policy URL, data safety, camera justification. All three
   answers are in the deliverables README.
2. **Windows code-signing certificate** — in progress on your side. Until it
   lands, Windows installers are unsigned and trip SmartScreen.
3. **Set the `LIA_CONFIG_JSON` repo secret** so the Windows CI can run at all.
   It's the full body of `config.json`, which is gitignored. Without it the
   workflow fails fast by design.

### Then

4. Run **Actions → Build Lia Office (Windows)** and verify the installer on a real
   Windows machine. ⚠️ The NSIS build has never executed — it cannot be built or
   verified from macOS, so treat the first run as unproven.
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

**🔴 The Supabase anon key is still exposed.**
`sb_publishable_WgGGcm9a-sJFt-9kpaWwAg_Rm-ft5Nj` is in `config.json` and in git
history on a public repo. Deliberately deferred, not forgotten. Rotation is the
only real fix — history scrubbing won't help, it's been public for weeks.

**⚠️ The `REVOKE` is written but not applied.** `supabase/02_inspections.sql` now
revokes anon's access to the base table, but that is inert until the file is
re-run against the live database. Until you do, anon can still read it.

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
