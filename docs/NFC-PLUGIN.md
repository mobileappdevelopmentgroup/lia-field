# NFC — what is built, and what is left

`field-app/js/nfc.js` is a capability-detected wrapper. Everything that does not
need native code is done and tested: detection, tag parsing, uid normalization,
error handling, and the app degrading to scan-and-type where NFC is absent.

Where `isAvailable()` returns false the Tap button is hidden and the tech uses
scan or type. That is deliberate: a dead button is worse than no button.

## The work list (opened 2026-08-27)

Hardware testing of TestFlight build 3 turned up three defects and one open
design question. **All four are done and shipped in build 4 (2026-08-27).**

1. ✅ **Payloads were never decoded.** `@exxili/capacitor-nfc` returns `payload`
   as base64 of the *raw* NDEF payload bytes on both platforms
   (`NFCPlugin.swift`, `NFCPlugin.kt` `ndefMessageToJS`). `fromExxili()` passed
   that string straight through and `parseRecords()` used it verbatim, so a tag
   written by this very app read back as base64, matched nothing, and showed the
   tech a blank form for an item already in the catalogue. Now base64-decoded and
   NDEF-decoded: a `U` record's URI prefix byte, a `T` record's status byte and
   language code. Falls back to the raw string if a future plugin version stops
   encoding.
2. ✅ **Nothing looked up `public_ref`.** A tag whose only record is the
   certificate URL identifies its item by the `?t=` code, which is neither a tag
   id nor a serial. `device-cache.js` is now `DB_VERSION` 2 with a `by_ref`
   index, and `find()` tries tag → serial → ref. The index is declared on
   `public_ref` directly rather than on a normalized copy, so IndexedDB indexes
   the rows already on the device — no backfill over a 100k-item account and no
   forced re-sync. Asserted in `device-cache.test.mjs`, upgrading a real v1
   database.
3. ✅ **Android NFC could never have worked.** The plugin turns on foreground
   dispatch in `handleOnResume` and `startScan()` *rejects* by design
   ("Android NFC scanning does not require 'startScan' method"). `exxiliRead()`
   treated that rejection as fatal and tore down the listeners it had just
   installed. Android also implements no `cancelScan`, so cleanup was raising an
   unhandled rejection on every read. Both fixed.
4. ✅ **Tap-through** — a second way of working alongside single tap, which is
   unchanged. `LiaNfc.readStream()` keeps the reader armed and calls back per
   tag; `fp.js` records a pass per tap. The plugin is patched so one sheet
   covers a whole rack on iPhone — see below.

Not defects, but noted while reading the plugin: a `'ID'` record (the plugin's
stand-in for a tag carrying no NDEF message at all) was being read as a serial;
it now populates the uid instead.

## The plugin: chosen and installed

`@exxili/capacitor-nfc` 0.0.13 — MIT, ~30k downloads/month, peer `>=6 <9`,
documented `writeNDEF`. It was the only candidate on the registry (2026-08-23)
clearing both bars: declared Capacitor 8 support, and NDEF **write**, not just
read. `capacitor-nfc` was abandoned in 2022; `@capacitor-community/nfc` and
`@capawesome-team/capacitor-nfc` are not on the public registry.

Both platforms build with it. iOS links CoreNFC and carries 661 NFC symbols;
Android produces an APK with the permission and the optional hardware feature.

### It needs a patch to build on iOS

Capacitor 8 derives the SPM product name from the npm package name —
`@exxili/capacitor-nfc` becomes `ExxiliCapacitorNfc` — but the plugin declares
its product as `CapacitorNfc`. The generated manifest then asks for a product
that does not exist:

```
product 'ExxiliCapacitorNfc' required by package 'capapp-spm'
target 'CapApp-SPM' not found in package 'ExxiliCapacitorNfc'
```

`scripts/patch-nfc-plugin.mjs` renames it, run on `postinstall` — without that,
`npm install` restores the broken name and the next iOS build fails for a reason
unrelated to whatever was being worked on. It is idempotent and fails loudly if
upstream changes shape, at which point it can be deleted.

**Careful if you touch it:** `name: "CapacitorNfc",` appears twice, for the
package and for the product, and only the product is what Capacitor imports. A
plain first-match replace renames the package and leaves the build just as
broken. The patch anchors on the following `targets:` line.

### Why the wrapper still matters

0.0.x, one maintainer, and a shipped defect on the platform we care most about.
Nothing in the app calls the plugin directly: `nfc.js` speaks its exact API —
listener-based `startScan` + `nfcTag`, `writeNDEF`, and the raw NDEF codes
`'U'`/`'T'` it uses where Web NFC says `'url'`/`'text'` — so replacing it later
is one file.

## iOS — constraints that shape the UX, not just the build

- ⚠️ **Capability "Near Field Communication Tag Reading" on the App ID** — the
  one remaining step, and it can only be done in the Apple Developer portal. The
  entitlement file cannot grant itself; without the capability, signing fails.
- `com.apple.developer.nfc.readersession.formats` (`TAG` — `NDEF` was
  rejected at App Store validation; see STATUS.md) — ✅ done,
  `ios/App/App/App.entitlements`, referenced from both build configurations.
- `NFCReaderUsageDescription` in `Info.plist` — ✅ done.
- **Core NFC only reads or writes from a foreground session that shows Apple's
  own sheet.** There is no silent read and no background write, and the sheet
  cannot be suppressed. The flow has to be "tap the button, then hold the phone
  to the tag" — never an inline field that fills itself. This is why the design
  has a Tap *button* rather than an always-listening screen.
- **A session needs the app foregrounded and the screen on**, and iOS invalidates
  it on its own after about a minute. So a session cannot be left running across
  a locked screen or a long gap between items.
- **The "open this link?" banner is iOS background tag reading.** It is
  OS-owned; no entitlement or plist key disables it. It is suppressed in exactly
  one circumstance — while the app has a live reader session. On iPhone,
  "no sheet" and "no banner" are therefore mutually exclusive.
- Writing needs iPhone 7 or later, iOS 13+.

## Android

- `android.permission.NFC` plus `uses-feature … required="false"` — ✅ done. The
  plugin declares no permissions of its own, so they live in our manifest, and
  the feature is optional so phones without NFC hardware still install.
- Foreground dispatch is enabled by the plugin whenever the activity resumes,
  so taps arrive silently, with no system UI and no browser hijack — and the
  system's own NDEF dispatch is suppressed for as long as it is on. This is the
  platform where an always-listening screen is actually achievable. It still
  needs the screen on: a locked phone dispatches nothing.
- **Do not add an `NDEF_DISCOVERED` intent filter for the certificate URL.** The
  point of writing that URL is that a customer tapping the tag lands on the
  public certificate in their browser. An intent filter would hijack that on any
  phone with Lia Field installed — the opposite of what the tag is for.

## Tap-through (item 4)

Two ways of working, both first-class. **Single tap** is unchanged: tap an item,
see its checks, pass or fail it. **Tap-through** is for a rack the tech has
already inspected by hand — every tap records a pass and he never sees a form.

A run stops itself the moment it cannot honestly record a pass:

- the tag resolves to nothing on the device *or* on the server,
- it resolves but carries no equipment type, so there is no checklist,
- it has no serial number on file,
- the tech presses **Fail last**.

Each of those hands the item to the ordinary single-item screen with everything
the tag gave us — **including the certificate link itself**, shown to the tech,
since that is the one thing he can read off an item nothing else resolved. When
he is done with it the run picks up where it left off, count intact.

`Undo last` and `Fail last` both withdraw the pass from the job **and from the
upload queue** (`LiaSync.dequeue`), so nothing can reach the server claiming an
item passed after the tech said otherwise.

A pass recorded this way is stored as `source: 'field_batch'` rather than
`'field'`. The inspection is real — it happened in the tech's hands — but the
record should be able to say the checks were filled in on his behalf rather than
answered one at a time on screen. `fp_inspections.source` is plain text with no
constraint, so this needs no migration. (`fp_inspection_checks.source` is a
different column with a `CHECK (source IN ('template','adhoc'))` — leave it be.)

A run belongs to one job on one screen: leaving the detail screen or switching
scope ends it, so the reader is never left armed behind the tech's back.

### The continuous-read patch

The plugin invalidated its Core NFC session after every successful read, so the
only way to read a second tag was to open a second session — and on iOS a
session *is* Apple's sheet. That made tap-through one sheet per item, worse than
the button it replaced.

`scripts/patch-nfc-plugin.mjs` now adds an opt-in `continuous` flag to
`startScan()`. Set, a successful read calls `session.restartPolling()` instead of
`invalidate()`, so one sheet covers the whole rack. Unset — which is every
single-item `read()` — the behaviour is exactly as before. It patches 14 sites
across `NFCReader.swift` and `NFCPlugin.swift`, is idempotent, and **fails loudly
rather than silently reverting** to sheet-per-tag if upstream changes shape.
Android is untouched; foreground dispatch is already continuous there.

Two things the patch cannot fix, both handled in `nfc.js`/`fp.js` instead:

- iOS ends a session on its own after about a minute. `readStream` re-arms on the
  session's own error, capped at 3 consecutive attempts and reset by any tag that
  arrives, so a run survives the timeout without the tech noticing — and a reader
  failing for a real reason is still reported.
- The tech can dismiss the sheet, which kills a run silently. Hence the
  **Keep tapping** button on the batch panel.

⚠️ The patch lives in `node_modules`. `npm install` restores the original and
`postinstall` re-applies it — if that hook is ever removed, iOS tap-through
quietly regresses to one sheet per tag.

### The screen-off part cannot be built, on either platform

Core NFC needs the app foregrounded with the screen on; Android's foreground
dispatch needs the activity resumed. A locked phone reads nothing into an app on
either OS. On Android the screen can be *held* on with a wake lock, at a real
battery cost over a shift; on iOS not even that helps, because the sheet is still
up. Tap-through therefore assumes the tech is looking at the phone.

What each platform can actually give:

| | iOS | Android |
|---|---|---|
| Taps without a system sheet | never | already the case |
| Taps without the browser banner | only while a session is live | already the case |
| Many taps, one arming gesture | until the session times out (~1 min) | unlimited while resumed |
| Screen off between taps | no | no |

At a 30–60 second cadence a persistent iOS session would time out between
roughly every pair of items anyway. Tap-through pays off when the taps are
**batched** — inspect a rack by hand, then walk it tapping quickly — which is
how it is meant to be used on both platforms.

Because nothing appears between taps, each recorded pass gives a sound and a
haptic, the panel shows a running count and the last item recorded, and the same
tag held against the phone inside 4 seconds counts once, not repeatedly.

## What goes on a tag

A URI record with the certificate URL (`certificate_url()` in
`05_rep_and_attribution.sql`), plus a text record with the equipment serial.

When both are present the **text record wins** as the identifier: the URL only
carries the certificate code, and record order on a tag is not guaranteed.
`parseRecords()` handles that and is tested.

NTAG213 holds 144 bytes — a URL plus a serial fits. Larger payloads need a
bigger tag.

## Testing that still needs hardware

`field-app/test/nfc.test.mjs` covers parsing, normalization, and graceful
absence. These need real tags and real phones:

- read a factory tag, write a serial to a programmable one, read it back
- a device with NFC switched off in settings
- an Android phone with no NFC hardware
- a locked or read-only tag
- a tag too small for the payload
- a tap that fails part-way through a write
