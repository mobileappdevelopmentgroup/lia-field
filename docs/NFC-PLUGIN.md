# NFC — what is built, and the one decision left

`field-app/js/nfc.js` is a capability-detected wrapper. Everything that does not
need native code is done and tested: detection, tag parsing, uid normalization,
error handling, and the app degrading to scan-and-type where NFC is absent.

**Today only Web NFC works — Chrome on Android.** Everywhere else `isAvailable()`
returns false, the Tap button is hidden, and the tech uses scan or type. That is
deliberate: a dead button is worse than no button.

## The plugin: researched, one candidate, adapter already written

`capacitor.plugins.json` is `[]` — this would be the project's first plugin.
The registry was searched on 2026-08-23 against the two bars that matter:
**declared Capacitor 8 support**, and **NDEF write**, not just read.

| Package | Capacitor 8 | Writes | Last release | Verdict |
|---|---|---|---|---|
| `@exxili/capacitor-nfc` | ✅ `>=6 <9` | ✅ `writeNDEF` | Feb 2026 | **only viable candidate** |
| `capacitor-nfc` | ❌ | — | Apr 2022 | abandoned |
| `@capacitor-community/nfc` | — | — | — | does not exist |
| `@capawesome-team/capacitor-nfc` | — | — | — | not on the public registry |

`@exxili/capacitor-nfc` at a glance: MIT, ~30k downloads/month, 8 releases, still
**0.0.x**. The version number is the only real reservation — the API is
reasonable and the write path is documented.

**Recommendation: use it, and keep `nfc.js` as the seam.** The residual risk is
a single-maintainer 0.0.x package, and the mitigation is already in place:
nothing in the app calls the plugin directly. `nfc.js` already speaks its exact
API — listener-based `startScan` + `nfcTag` event, `writeNDEF`, and the raw NDEF
type codes `'U'`/`'T'` that it uses where Web NFC says `'url'`/`'text'` — and
that adapter is tested against a stub of its documented shape. If it is
abandoned, replacing it is one file.

### Installing it

Not installed yet, because it touches the native projects and iOS needs an
entitlement only you can add.

```bash
cd field-app/capacitor
npm install @exxili/capacitor-nfc
npx cap sync
```

Then the iOS capability and `Info.plist` string below. No app code should need
to change — `nfc.js` detects `Capacitor.Plugins.NFC` on its own.

## iOS — constraints that shape the UX, not just the build

- Capability **Near Field Communication Tag Reading** on the App ID, and the
  `com.apple.developer.nfc.readersession.formats` entitlement (`NDEF`).
- `NFCReaderUsageDescription` in `Info.plist`.
- **Core NFC only reads or writes from a foreground session that shows Apple's
  own sheet.** There is no silent read and no background write, and the sheet
  cannot be suppressed. The flow has to be "tap the button, then hold the phone
  to the tag" — never an inline field that fills itself. This is why the design
  has a Tap *button* rather than an always-listening screen.
- Writing needs iPhone 7 or later, iOS 13+.

## Android

- `android.permission.NFC`, plus
  `<uses-feature android:name="android.hardware.nfc" android:required="false"/>`
  so phones without the hardware can still install.
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
