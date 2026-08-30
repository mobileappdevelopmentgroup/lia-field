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
