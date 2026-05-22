'use strict';

// Copies the local Playwright Chromium installation into the packaged app's
// Resources directory so the app works without any installs on the target Mac.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

module.exports = async function afterPack(context) {
  const { appOutDir, packager } = context;

  const appName = packager.appInfo.productName;
  const resourcesDir = path.join(
    appOutDir,
    `${appName}.app`,
    'Contents',
    'Resources',
  );
  const destBrowsersDir = path.join(resourcesDir, 'playwright-browsers');

  // Playwright stores browsers at ~/Library/Caches/ms-playwright on macOS
  const srcBrowsersDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');

  if (!fs.existsSync(srcBrowsersDir)) {
    throw new Error(
      `Playwright browser cache not found at:\n  ${srcBrowsersDir}\n\n` +
      'Run this first:\n  npx playwright install chromium',
    );
  }

  const entries = fs.readdirSync(srcBrowsersDir).filter((f) => f.startsWith('chromium-'));
  if (entries.length === 0) {
    throw new Error('Chromium not found in Playwright cache. Run: npx playwright install chromium');
  }

  fs.mkdirSync(destBrowsersDir, { recursive: true });

  for (const entry of entries) {
    const src = path.join(srcBrowsersDir, entry);
    const dst = path.join(destBrowsersDir, entry);
    console.log(`  [afterPack] Bundling ${entry} → Resources/playwright-browsers/`);
    execSync(`cp -R "${src}" "${dst}"`);
  }

  console.log('  [afterPack] Playwright Chromium bundled successfully.');
};
