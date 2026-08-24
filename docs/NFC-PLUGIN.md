# NFC — what is built, and the one decision left

`field-app/js/nfc.js` is a capability-detected wrapper. Everything that does not
need native code is done and tested: detection, tag parsing, uid normalization,
error handling, and the app degrading to scan-and-type where NFC is absent.

**Today only Web NFC works — Chrome on Android.** Everywhere else `isAvailable()`
returns false, the Tap button is hidden, and the tech uses scan or type. That is
deliberate: a dead button is worse than no button.

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
- `com.apple.developer.nfc.readersession.formats` (`NDEF`) — ✅ done,
  `ios/App/App/App.entitlements`, referenced from both build configurations.
- `NFCReaderUsageDescription` in `Info.plist` — ✅ done.
- **Core NFC only reads or writes from a foreground session that shows Apple's
  own sheet.** There is no silent read and no background write, and the sheet
  cannot be suppressed. The flow has to be "tap the button, then hold the phone
  to the tag" — never an inline field that fills itself. This is why the design
  has a Tap *button* rather than an always-listening screen.
- Writing needs iPhone 7 or later, iOS 13+.

## Android

- `android.permission.NFC` plus `uses-feature … required="false"` — ✅ done. The
  plugin declares no permissions of its own, so they live in our manifest, and
  the feature is optional so phones without NFC hardware still install.
- Foreground dispatch / reader mode while the tag screen is open.
- **Do not add an `NDEF_DISCOVERED` intent filter for the certificate URL.** The
  point of writing that URL is that a customer tapping the tag lands on the
  public certificate in their browser. An intent filter would hijack that on any
  phone with Lia Field installed — the opposite of what the tag is for.

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
