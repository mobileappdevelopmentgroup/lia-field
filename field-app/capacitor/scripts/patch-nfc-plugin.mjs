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

if (!fs.existsSync(pkg)) {
  // Not installed — nothing to do, and not an error.
  process.exit(0);
}

const src = fs.readFileSync(pkg, 'utf8');

if (src.includes(RIGHT)) {
  process.exit(0);
}

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
