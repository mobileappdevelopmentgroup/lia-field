#!/usr/bin/env node
// @exxili/capacitor-nfc 0.0.13 declares its SPM product as "CapacitorNfc",
// but Capacitor 8 derives the name it imports from the npm package —
// "@exxili/capacitor-nfc" becomes "ExxiliCapacitorNfc". They do not match, so
// the generated CapApp-SPM/Package.swift asks for a product the plugin does not
// expose and the iOS build fails to resolve:
//
//   product 'ExxiliCapacitorNfc' required by package 'capapp-spm'
//   target 'CapApp-SPM' not found in package 'ExxiliCapacitorNfc'
//
// This renames the product to match. It runs on postinstall because npm install
// would otherwise silently restore the broken name and the next iOS build would
// fail for a reason that has nothing to do with whatever was being worked on.
//
// Remove this once upstream fixes the name — the script says so if it finds
// nothing to do.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..', 'node_modules', '@exxili', 'capacitor-nfc', 'Package.swift');

const WRONG = 'name: "CapacitorNfc",\n            targets: ["NFCPlugin"])';
const RIGHT = 'name: "ExxiliCapacitorNfc",\n            targets: ["NFCPlugin"])';

// Not installed — nothing to do, and not an error. Both patches below need it.
if (!fs.existsSync(pkg)) process.exit(0);

const src = fs.readFileSync(pkg, 'utf8');

if (!src.includes(RIGHT)) {
  if (!src.includes(WRONG)) {
    // The upstream shape changed. Fail loudly rather than leaving a broken build
    // to be discovered in Xcode.
    console.error('patch-nfc-plugin: @exxili/capacitor-nfc no longer declares the');
    console.error('  product name this patch expected. Check whether the SPM product');
    console.error('  is now "ExxiliCapacitorNfc" upstream — if it is, delete this');
    console.error('  script and its postinstall hook.');
    process.exit(1);
  }
  fs.writeFileSync(pkg, src.replace(WRONG, RIGHT));
  console.log('patch-nfc-plugin: renamed the SPM product to ExxiliCapacitorNfc');
}

// ── Continuous reading (Lia) ────────────────────────────────────────────────
// The plugin invalidates its Core NFC session after every successful read, so
// the only way to read a second tag is to open a second session — and on iOS a
// session IS Apple's modal sheet. Tapping through a rack of fall-protection
// items then means one sheet per item, which is worse than the button it was
// meant to replace.
//
// This adds an opt-in `continuous` flag to startScan(). When it is set, a
// successful read calls session.restartPolling() instead of invalidate(), so
// one sheet covers the whole rack. Unset — which is every single-item read —
// the behaviour is exactly as before: the sheet closes when the tag is read.
//
// Android is untouched: foreground dispatch is already continuous there.
//
// iOS still ends the session on its own after about a minute, and the tech can
// dismiss the sheet, so field-app/js/fp.js offers a "Keep tapping" button
// rather than assuming a run lasts forever.

const iosDir = path.join(here, '..', 'node_modules', '@exxili', 'capacitor-nfc',
                         'ios', 'Sources', 'NFCPlugin');
const readerPath = path.join(iosDir, 'NFCReader.swift');
const pluginPath = path.join(iosDir, 'NFCPlugin.swift');

if (!fs.existsSync(readerPath) || !fs.existsSync(pluginPath)) process.exit(0);

const MARK = 'LIA-CONTINUOUS-PATCH';
let reader = fs.readFileSync(readerPath, 'utf8');
let plugin = fs.readFileSync(pluginPath, 'utf8');
const already = reader.includes(MARK) && plugin.includes(MARK);

function bail(what) {
  console.error(`patch-nfc-plugin: ${what}`);
  console.error('  @exxili/capacitor-nfc no longer has the shape the continuous-read');
  console.error('  patch expects. iOS tap-through would silently go back to one');
  console.error('  system sheet per tag. Re-check ios/Sources/NFCPlugin against');
  console.error('  docs/NFC-PLUGIN.md before shipping.');
  process.exit(1);
}

if (!already) {
  // 1. The flag, and one place that decides what "done with this tag" means.
  const anchor = '    public var onNDEFMessageReceived: (([NFCNDEFMessage], [String: Any]?) -> Void)?';
  if (!reader.includes(anchor)) bail('NFCReader.swift: could not find the callback declarations.');
  reader = reader.replace(anchor, `    // ${MARK}
    // Set by startScan(continuous:). Off by default, so a single-item read is
    // unchanged: the sheet closes as soon as the tag is read.
    @objc public var continuousMode: Bool = false

    private func finishRead(_ session: NFCTagReaderSession) {
        if continuousMode { session.restartPolling() } else { session.invalidate() }
    }

    private func finishRead(_ session: NFCNDEFReaderSession) {
        if continuousMode { session.restartPolling() } else { session.invalidate() }
    }

${anchor}`);

  // 2. Every path that ends a session because it read a tag successfully. The
  //    error paths keep invalidating — a failed read should close the sheet.
  const successRe = /(session\.alertMessage = "(?:Found 1 NDEF message\.|Tag detected but no NDEF message found\.|No NDEF message found\.)"\n(\s*))session\.invalidate\(\)/g;
  const before = reader;
  reader = reader.replace(successRe, (_m, head, indent) => `${head}self.finishRead(session)`);
  const patched = (before.match(successRe) || []).length;
  if (patched < 8) bail(`NFCReader.swift: expected at least 8 successful-read sites, patched ${patched}.`);

  // The legacy NDEF delegate has no alertMessage line, so it is matched apart.
  const legacy = `        if !messages.isEmpty {
            session.invalidate()
            onNDEFMessageReceived?(messages, nil)`;
  if (!reader.includes(legacy)) bail('NFCReader.swift: could not find didDetectNDEFs.');
  reader = reader.replace(legacy, `        if !messages.isEmpty {
            finishRead(session)
            onNDEFMessageReceived?(messages, nil)`);

  // 3. Let JS ask for it.
  const startAnchor = '        reader.onNDEFMessageReceived = { messages, tagInfo in';
  if (!plugin.includes(startAnchor)) bail('NFCPlugin.swift: could not find startScan.');
  plugin = plugin.replace(startAnchor, `        // ${MARK}
        reader.continuousMode = call.getBool("continuous") ?? false
${startAnchor}`);

  fs.writeFileSync(readerPath, reader);
  fs.writeFileSync(pluginPath, plugin);
  console.log(`patch-nfc-plugin: added continuous reading (${patched + 1} sites)`);
}

// ── Android before 13 (Lia) ─────────────────────────────────────────────────
// The plugin reads the tag out of the intent with the typed overloads
// getParcelableExtra(name, Class) and getParcelableArrayExtra(name, Class),
// which only exist from Android 13 (API 33). The app's minSdk is 24. On
// anything older — a Galaxy S8 tops out at Android 9 — every tag tap threw
// NoSuchMethodError, which is an Error, not an Exception, so nothing caught it
// and the app died on the tap. The @RequiresApi annotations only silenced the
// lint warning; handleOnNewIntent is called on every version regardless.
//
// This swaps both calls for helpers that use the typed overload on 13+ and the
// deprecated untyped one below it.

const ktPath = path.join(here, '..', 'node_modules', '@exxili', 'capacitor-nfc',
                         'android', 'src', 'main', 'kotlin', 'com', 'exxili',
                         'capacitornfc', 'NFCPlugin.kt');

if (fs.existsSync(ktPath)) {
  const KT_MARK = 'LIA-OLD-ANDROID-PATCH';
  let kt = fs.readFileSync(ktPath, 'utf8');
  if (!kt.includes(KT_MARK)) {
    const ktBail = (what) => {
      console.error(`patch-nfc-plugin: NFCPlugin.kt: ${what}`);
      console.error('  @exxili/capacitor-nfc no longer has the shape the old-Android patch');
      console.error('  expects. Tapping a tag would crash every phone below Android 13.');
      process.exit(1);
    };

    const TAG_CALL = 'intent.getParcelableExtra(NfcAdapter.EXTRA_TAG, Tag::class.java)';
    const MSG_CALL = /intent\.getParcelableArrayExtra\(\s*EXTRA_NDEF_MESSAGES,\s*NdefMessage::class\.java\s*\)/;
    const tagSites = kt.split(TAG_CALL).length - 1;
    if (tagSites !== 2) ktBail(`expected 2 typed EXTRA_TAG reads, found ${tagSites}.`);
    if (!MSG_CALL.test(kt)) ktBail('could not find the typed EXTRA_NDEF_MESSAGES read.');
    kt = kt.split(TAG_CALL).join('tagFrom(intent)').replace(MSG_CALL, 'ndefMessagesFrom(intent)');

    const clsAnchor = '    private fun byteArrayToHexString(inarray: ByteArray): String {';
    if (!kt.includes(clsAnchor)) ktBail('could not find byteArrayToHexString.');
    kt = kt.replace(clsAnchor, `    // ${KT_MARK}
    // The typed overloads are API 33+; minSdk is 24.
    @Suppress("DEPRECATION")
    private fun tagFrom(intent: Intent): Tag? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            intent.getParcelableExtra(NfcAdapter.EXTRA_TAG, Tag::class.java)
        else
            intent.getParcelableExtra(NfcAdapter.EXTRA_TAG) as? Tag

    @Suppress("DEPRECATION")
    private fun ndefMessagesFrom(intent: Intent): Array<NdefMessage>? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            intent.getParcelableArrayExtra(EXTRA_NDEF_MESSAGES, NdefMessage::class.java)
        else
            intent.getParcelableArrayExtra(EXTRA_NDEF_MESSAGES)
                ?.mapNotNull { it as? NdefMessage }?.toTypedArray()

${clsAnchor}`);

    // Nothing left needs 13; the annotations would only mislead the next reader.
    kt = kt.split('    @RequiresApi(Build.VERSION_CODES.TIRAMISU)\n').join('');

    fs.writeFileSync(ktPath, kt);
    console.log('patch-nfc-plugin: made tag reads safe below Android 13');
  }
}

// ── How an iOS write ended (Lia) ────────────────────────────────────────────
// The plugin's writer had three outcomes and reported one of them. Success
// arrived as 'nfcWriteSuccess'. The other two did not arrive at all:
//
//   - the tech dismissing Apple's sheet was deliberately swallowed, and
//   - a tag the writer refused (read-only, not NDEF) closed the sheet with a
//     message and never called onError — and iOS then reports that close with
//     the SAME code as a dismissal, so it was swallowed too.
//
// Either way the app sat on "Hold the phone against the tag…" until its own
// timeout, and a locked supplier tag read as "no tag detected". This keeps the
// refusal's message, reports a dismissal as 'nfcWriteCancelled', and ignores
// the close that follows a successful write.

const writerPath = path.join(iosDir, 'NFCWriter.swift');
if (fs.existsSync(writerPath)) {
  const WC_MARK = 'LIA-WRITE-OUTCOME-PATCH';
  let writer = fs.readFileSync(writerPath, 'utf8');
  let plug = fs.readFileSync(pluginPath, 'utf8');
  if (!writer.includes(WC_MARK) || !plug.includes(WC_MARK)) {
    const wBail = (what) => {
      console.error(`patch-nfc-plugin: ${what}`);
      console.error('  @exxili/capacitor-nfc no longer has the shape the write-outcome patch');
      console.error('  expects. A dismissed or refused iOS write would hang the write sheet.');
      process.exit(1);
    };

    const declAnchor = '    public var onError: ((Error) -> Void)?\n';
    if (!writer.includes(declAnchor)) wBail('NFCWriter.swift: could not find onError.');
    writer = writer.replace(declAnchor, `${declAnchor}
    // ${WC_MARK}
    public var onFailure: ((String) -> Void)?
    public var onCancel: (() -> Void)?
    private var failure: String?
    private var succeeded = false

    private func failWith(_ message: String, _ session: NFCNDEFReaderSession) {
        failure = message
        session.invalidate(errorMessage: message)
    }
`);

    const startAnchor = '        self.messageToWrite = message\n';
    if (!writer.includes(startAnchor)) wBail('NFCWriter.swift: could not find startWriting.');
    writer = writer.replace(startAnchor, `${startAnchor}        self.failure = nil
        self.succeeded = false
`);

    const failRe = /session\.invalidate\(errorMessage: ("[^"]*")\)/g;
    const fails = (writer.match(failRe) || []).length;
    if (fails < 7) wBail(`NFCWriter.swift: expected at least 7 refusal sites, found ${fails}.`);
    writer = writer.replace(failRe, (_m, msg) => `self.failWith(${msg}, session)`);

    const okAnchor = '                            session.alertMessage = "NDEF message written successfully."\n';
    if (!writer.includes(okAnchor)) wBail('NFCWriter.swift: could not find the success path.');
    writer = writer.replace(okAnchor, `                            self.succeeded = true\n${okAnchor}`);

    const invAnchor = '        print("NFC writer session error: \\(error.localizedDescription)")\n        onError?(error)\n';
    if (!writer.includes(invAnchor)) wBail('NFCWriter.swift: could not find didInvalidateWithError.');
    writer = writer.replace(invAnchor, `        print("NFC writer session error: \\(error.localizedDescription)")
        // Closing the sheet ourselves — after a write, or to refuse a tag — is
        // reported with the same code as the tech dismissing it.
        if succeeded { return }
        if let message = failure { failure = nil; onFailure?(message); return }
        if let nfcError = error as? NFCReaderError,
           nfcError.code == .readerSessionInvalidationErrorUserCanceled {
            onCancel?()
            return
        }
        onError?(error)
`);

    const errBlock = `        writer.onError = { error in
            if let nfcError = error as? NFCReaderError {
                if nfcError.code != .readerSessionInvalidationErrorUserCanceled {
                    self.notifyListeners("nfcError", data: ["error": nfcError.localizedDescription])
                }
            }
        }
`;
    if (!plug.includes(errBlock)) wBail('NFCPlugin.swift: could not find the writer onError block.');
    plug = plug.replace(errBlock, `        // ${WC_MARK}
        writer.onError = { error in
            self.notifyListeners("nfcError", data: ["error": error.localizedDescription])
        }
        writer.onFailure = { message in
            self.notifyListeners("nfcError", data: ["error": message])
        }
        writer.onCancel = {
            self.notifyListeners("nfcWriteCancelled", data: [:])
        }
`);

    fs.writeFileSync(writerPath, writer);
    fs.writeFileSync(pluginPath, plug);
    console.log(`patch-nfc-plugin: iOS writes now report refusal and dismissal (${fails} sites)`);
  }
}
