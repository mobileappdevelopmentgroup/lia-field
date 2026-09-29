// Copies the field app into the three Capacitor bundles.
//
//   npm run sync:www          copy
//   npm run check:www         fail if any bundle is behind
//
// ── Why this exists ─────────────────────────────────────────────────────────
// These three directories are what the iOS and Android builds actually ship:
//
//   field-app/capacitor/www                               the staging copy
//   field-app/capacitor/ios/App/App/public                the iOS bundle
//   field-app/capacitor/android/.../assets/public         the Android bundle
//
// They were kept in step with field-app/ BY HAND, and they drifted — at the
// time this was written www/ was weeks stale and missing whole modules.
// Nothing caught it, because the PWA and the tests both run from field-app/ and
// were perfectly green. The only way to notice was to install a TestFlight
// build and find a feature simply absent.
//
// It is not a plain copy. The bundle's index.html differs from the source in
// two ways that MUST be applied, and both fail in a way that only shows up on a
// real handset:
//
//   1. CDN script tags become vendored copies. A packaged app cannot depend on
//      a CDN — no signal means no scanner and no Supabase client.
//   2. A Content-Security-Policy meta tag is added. It has to name every origin
//      the app talks to, because connect-src 'self' blocks the rest silently
//      and ONLY on device.
//
// vendor/, cordova.js and cordova_plugins.js live only in the bundles and are
// never touched.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');            // field-app/
const CAP = path.resolve(HERE, '..');                  // field-app/capacitor/

const TARGETS = [
  path.join(CAP, 'www'),
  path.join(CAP, 'ios', 'App', 'App', 'public'),
  path.join(CAP, 'android', 'app', 'src', 'main', 'assets', 'public'),
];

// Explicit rather than "everything except": a new directory that ought to ship
// should be a conscious line here, and test/ or tools/ silently ending up in a
// store build should not be possible.
const COPY = [
  'index.html',
  'manifest.json',
  'sw.js',
  'js',
  'help',                 // the manual and its screenshots
  'icon-192.png',
  'icon-512.png',
  'icon-1024.png',
  // The project URL and PUBLISHABLE key. Without it a store build cannot reach
  // Supabase at all: isConfigured() is false, so the app opens straight into
  // local-only logging and the sign-in screen is unreachable. That is exactly
  // what shipped in 1.7.0 — the phone builds had no config.json, so nobody
  // could sign in on a handset.
  //
  // It is gitignored, so a fresh clone has none. That is handled below rather
  // than by failing: a developer without it still gets a working local build.
  'config.json',
];

// Directories that are pruned — a module deleted from field-app/ must stop
// shipping, not linger and keep running.
const PRUNE = ['js', 'help'];

const VENDOR = [
  [/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@zxing\/browser[^"]*"><\/script>/,
   '<script src="./vendor/zxing/zxing-browser.min.js"></script>'],
  [/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"><\/script>/,
   '<script src="./vendor/supabase/supabase.min.js"></script>'],
];

// ── The policy ──────────────────────────────────────────────────────────────
// Every origin the app reaches has to be named. Getting this wrong is
// especially nasty: the browser tests pass, and the phone fails in silence.
//
// docs.google.com is here for the tag-link fetch (see field-app/js/tag-link.js).
// On native that request normally goes through CapacitorHttp, which is not
// subject to CSP — but the plain-fetch fallback is, and an un-named origin
// would make a third-party tag look permanently unreadable on device while
// working perfectly in the browser.
function buildCsp(supabaseOrigin) {
  const host = supabaseOrigin.replace(/^https:\/\//, '');
  return [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self' https://${host} wss://${host} https://docs.google.com`,
    "font-src 'self' data:",
  ].join('; ') + ';';
}

// The project origin is in config.json, which is gitignored and absent on a
// fresh clone. Falling back to whatever the bundle already declares means a
// developer without the config can still sync code without silently pointing
// the app at nothing.
function supabaseOrigin() {
  const cfgPath = path.join(SRC, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const url = cfg && cfg.supabase && cfg.supabase.url;
      if (url) return String(url).replace(/\/+$/, '');
    } catch (_) { /* fall through to the existing policy */ }
  }
  // Any bundle that still declares one will do. They are all the same project,
  // and reading from a sibling is what lets this recover when one bundle has
  // already been overwritten.
  for (const target of TARGETS) {
    const file = path.join(target, 'index.html');
    if (!fs.existsSync(file)) continue;
    const m = fs.readFileSync(file, 'utf8')
      .match(/connect-src[^;]*?(https:\/\/[a-z0-9-]+\.supabase\.co)/i);
    if (m) return m[1];
  }
  throw new Error(
    'Cannot determine the Supabase origin for the CSP.\n' +
    'Either put config.json in field-app/, or run this against a bundle that ' +
    'already has a Content-Security-Policy naming it.\n' +
    'Guessing would ship an app that cannot reach its own database.');
}

function transformIndex(text, origin) {
  let out = text;
  VENDOR.forEach(([re, replacement]) => {
    if (!re.test(out)) {
      throw new Error(
        'index.html no longer contains a script tag matching ' + re +
        '\nThe vendoring rules in sync-www.mjs are out of date. Fix them, or the ' +
        'packaged app will try to reach a CDN it cannot reach.');
    }
    out = out.replace(re, replacement);
  });

  const csp = `  <meta http-equiv="Content-Security-Policy" content="${buildCsp(origin)}">`;
  if (/<meta http-equiv="Content-Security-Policy"[^>]*>/.test(out)) {
    out = out.replace(/[ \t]*<meta http-equiv="Content-Security-Policy"[^>]*>/, csp);
  } else {
    // Immediately after <head> so it governs everything that follows.
    out = out.replace(/<head>\s*\n/, '<head>\n' + csp + '\n');
  }
  return out;
}

const check = process.argv.includes('--check');
let anyChanges = false;

for (const target of TARGETS) {
  if (!fs.existsSync(target)) {
    console.warn('skipping (not present): ' + path.relative(SRC, target));
    continue;
  }
  const changes = [];
  const origin = supabaseOrigin();

  const writeFile = (rel, contents) => {
    const dest = path.join(target, rel);
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    const next = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
    if (existing && existing.equals(next)) return;
    changes.push(rel);
    if (check) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, next);
  };

  const copyTree = (rel) => {
    const from = path.join(SRC, rel);
    if (!fs.existsSync(from)) return;
    if (fs.statSync(from).isDirectory()) {
      fs.readdirSync(from).forEach(name => copyTree(path.join(rel, name)));
      return;
    }
    if (rel === 'index.html') writeFile(rel, transformIndex(fs.readFileSync(from, 'utf8'), origin));
    else writeFile(rel, fs.readFileSync(from));
  };

  const prune = (rel) => {
    const dir = path.join(target, rel);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(name => {
      const relPath = path.join(rel, name);
      if (fs.statSync(path.join(target, relPath)).isDirectory()) { prune(relPath); return; }
      if (!fs.existsSync(path.join(SRC, relPath))) {
        changes.push('- ' + relPath);
        if (!check) fs.unlinkSync(path.join(target, relPath));
      }
    });
  };

  COPY.forEach((rel) => {
    // config.json is the one optional entry: absent on a fresh clone, and a
    // local-only bundle is a legitimate outcome rather than an error.
    if (rel === 'config.json' && !fs.existsSync(path.join(SRC, rel))) {
      console.log('    (no config.json — this bundle will be local-only)');
      return;
    }
    copyTree(rel);
  });
  PRUNE.forEach(prune);

  const name = path.relative(path.resolve(SRC, '..'), target);
  if (changes.length) {
    anyChanges = true;
    console.log(`${name}: ${changes.length} file(s)${check ? ' BEHIND' : ' synced'}`);
    changes.slice(0, 12).forEach(c => console.log('    ' + c));
    if (changes.length > 12) console.log(`    …and ${changes.length - 12} more`);
  } else {
    console.log(`${name}: up to date`);
  }
}

if (check && anyChanges) {
  console.error('\nThe shipped bundles are behind field-app/. Run: npm run sync:www');
  process.exit(1);
}
