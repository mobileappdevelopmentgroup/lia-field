#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Upload an .aab to Google Play and release it to a testing track.
//
// Uses the Play Developer API v3 directly — no googleapis dependency. The
// service-account JWT is signed with node's crypto, the same way the App Store
// Connect calls in docs/RELEASE.md are.
//
//   PLAY_KEY=~/.play-keys/lia-play-publisher.json node tools/play-upload.mjs --check
//   node tools/play-upload.mjs --aab path/to/app-release.aab --notes "Fixes X"
//
// The key file is a credential. It is read from a path, never from the repo,
// and its contents are never printed — not in errors, not in verbose output.
// ═══════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = 'com.mobileappdevelopmentgroup.liafield';
const DEFAULT_AAB = 'field-app/capacitor/android/app/build/outputs/bundle/release/app-release.aab';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3';

// Production is deliberately not reachable from here. The key should not carry
// the permission either — this is the second lock, not the only one. Releasing
// to real users is a decision made in the console, with the listing in view.
const TRACKS = new Set(['internal', 'alpha', 'beta']);

// ── Arguments ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { track: 'internal', aab: DEFAULT_AAB, notes: '', check: false, draft: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    if (a === '--check') out.check = true;
    else if (a === '--draft') out.draft = true;
    else if (a === '--track') out.track = next();
    else if (a === '--aab') out.aab = next();
    else if (a === '--notes') out.notes = next();
    else if (a === '--key') out.key = next();
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else die(`Unknown argument: ${a}`);
  }
  return out;
}

function usage() {
  console.log(`
Upload an Android App Bundle to Google Play.

  --check          Verify the credential and permissions, upload nothing
  --aab <path>     Bundle to upload (default: the gradle release output)
  --track <name>   internal (default) | alpha | beta
  --notes <text>   Release notes shown to testers (en-US)
  --draft          Leave the release as a draft instead of rolling out
  --key <path>     Service-account JSON (or set PLAY_KEY)
`.trim());
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── Credential ──────────────────────────────────────────────────────────────
function loadKey(explicit) {
  let p = explicit || process.env.PLAY_KEY;
  if (!p) {
    die('No service-account key. Pass --key <path> or set PLAY_KEY.\n' +
        '  Create one: Play Console → Setup → API access. See CLAUDE.md.');
  }
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  if (!fs.existsSync(p)) die(`Key file not found: ${p}`);

  let key;
  try {
    key = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // Deliberately does not echo the file — a malformed credential is still a
    // credential, and this runs in terminals people screen-share.
    die(`Key file is not valid JSON: ${p}`);
  }
  if (!key.client_email || !key.private_key) {
    die(`Key file is missing client_email/private_key — is it a service-account key? ${p}`);
  }
  return key;
}

async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const sig = crypto.createSign('RSA-SHA256')
    .update(`${head}.${claim}`)
    .sign(key.private_key)
    .toString('base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claim}.${sig}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    die(`Could not get an access token (${res.status}): ${body.error_description || body.error || 'unknown'}\n` +
        '  A brand-new key can take a few minutes to work.');
  }
  return body.access_token;
}

// ── API helper ──────────────────────────────────────────────────────────────
async function api(token, method, url, { json, body, contentType } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body: json ? JSON.stringify(json) : body,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const msg = parsed?.error?.message || parsed.raw || res.statusText;
    const err = new Error(`${method} ${url.replace(/\?.*/, '')} → ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

const editUrl = (id, suffix = '') => `${API}/applications/${PKG}/edits/${id}${suffix}`;

// An edit is Play's transaction: nothing exists for anyone until it is
// committed, and deleting one leaves no trace. That is what makes --check
// safe to run against the live listing.
async function openEdit(token) {
  const edit = await api(token, 'POST', `${API}/applications/${PKG}/edits`);
  return edit.id;
}

async function discardEdit(token, id) {
  try { await api(token, 'DELETE', editUrl(id)); } catch { /* best effort */ }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!TRACKS.has(args.track)) {
    die(`Refusing track "${args.track}". This tool ships to ${[...TRACKS].join(', ')} only.\n` +
        '  Production releases are made in the Play Console, on purpose.');
  }

  const key = loadKey(args.key);
  const token = await accessToken(key);
  console.log(`✓ Authenticated as ${key.client_email}`);

  if (args.check) {
    // Read-only in effect: open a draft edit to prove the account can act on
    // this app, read the track back, then throw the edit away.
    let id;
    try {
      id = await openEdit(token);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        die(`${err.message}\n` +
            '  The service account exists but lacks access to this app.\n' +
            '  Play Console → Setup → API access → Manage Play Console permissions:\n' +
            '  grant it the Lia Field app and "Release apps to testing tracks".\n' +
            '  A fresh grant can take several minutes.');
      }
      throw err;
    }
    try {
      const track = await api(token, 'GET', editUrl(id, `/tracks/${args.track}`));
      const live = (track.releases || [])
        .flatMap(r => (r.versionCodes || []).map(v => `${v} (${r.status})`))
        .join(', ') || 'none';
      console.log(`✓ Can edit ${PKG}`);
      console.log(`✓ Track "${args.track}" currently has: ${live}`);
    } finally {
      await discardEdit(token, id);
      console.log('✓ Draft edit discarded — nothing was changed');
    }
    return;
  }

  const aab = path.resolve(args.aab);
  if (!fs.existsSync(aab)) {
    die(`Bundle not found: ${aab}\n` +
        '  Build it first:\n' +
        '  cd field-app/capacitor/android && JAVA_HOME=/opt/homebrew/opt/openjdk@21 \\\n' +
        '    ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ./gradlew bundleRelease');
  }
  const bytes = fs.readFileSync(aab);
  console.log(`• ${path.basename(aab)} (${(bytes.length / 1e6).toFixed(1)} MB)`);

  const id = await openEdit(token);
  let committed = false;
  try {
    const bundle = await api(token, 'POST', `${UPLOAD}/applications/${PKG}/edits/${id}/bundles?uploadType=media`, {
      body: bytes,
      contentType: 'application/octet-stream',
    });
    const versionCode = bundle.versionCode;
    console.log(`✓ Uploaded — versionCode ${versionCode}`);

    const release = {
      versionCodes: [String(versionCode)],
      status: args.draft ? 'draft' : 'completed',
    };
    if (args.notes) release.releaseNotes = [{ language: 'en-US', text: args.notes }];

    await api(token, 'PATCH', editUrl(id, `/tracks/${args.track}`), {
      json: { track: args.track, releases: [release] },
    });
    console.log(`✓ Assigned to "${args.track}" as ${release.status}`);

    await api(token, 'POST', editUrl(id, ':commit'));
    committed = true;
    console.log(`✓ Committed. Testers get versionCode ${versionCode} within minutes.`);
  } finally {
    // An uncommitted edit expires on its own, but leaving one behind makes the
    // next run's error confusing. Only discard if the commit never happened.
    if (!committed) {
      await discardEdit(token, id);
      console.error('✗ Failed before commit — the draft edit was discarded, nothing shipped.');
    }
  }
}

main().catch(err => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
