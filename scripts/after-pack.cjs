'use strict';

// No-op: Lia now uses channel:'chrome' (system Google Chrome) instead of a
// bundled Playwright Chromium. Nothing needs to be copied at pack time.

module.exports = async function afterPack() {
  console.log('  [afterPack] Using system Chrome — no browser bundling needed.');
};
