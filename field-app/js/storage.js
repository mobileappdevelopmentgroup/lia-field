// Lia Field — storage.js
//
// Persistence. localStorage for jobs, custom fields and preferences.
// The catalogue of previously-inspected items lives in IndexedDB instead —
// see device-cache.js; localStorage caps around 5 MB.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step. Modules would need a
// server, and the app has to run from file:// and from a Capacitor bundle.

// ════════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Bumped at release, alongside the service worker cache name in sw.js and the
// native version strings. It exists so a support ticket can say which build hit
// the problem: asking a tech on a ladder which version he is running gets a
// wrong answer or no answer, and a bug report without a build number is a
// guessing game.
const LIA_APP_VERSION = '1.9.0';

function goScreen(name) {
  // A tap-through run belongs to one job on one screen. Leaving without ending
  // it would leave the NFC reader armed behind the tech's back — and on iOS,
  // Apple's sheet up over whatever he moved to.
  if (name !== 'detail' && typeof fpBatchStop === 'function') fpBatchStop(false);
  ['auth','sync','jobs','detail','help'].forEach(s => {
    const el = $(`screen-${s}`);
    if (el) el.classList.toggle('active', s === name);
  });
}

// ── localStorage helpers ──────────────────────────────────────────────────────
function loadJobs() {
  try { return JSON.parse(localStorage.getItem('lia-field-jobs') || '{}'); }
  catch { return {}; }
}
function saveJobs(all) { localStorage.setItem('lia-field-jobs', JSON.stringify(all)); }

function loadCustomFields() {
  try { return JSON.parse(localStorage.getItem('lia-custom-fields') || '[]'); }
  catch { return []; }
}
function saveCustomFields(f) { localStorage.setItem('lia-custom-fields', JSON.stringify(f)); }

// ── Theme ─────────────────────────────────────────────────────────────────────
function loadTheme() { return localStorage.getItem('lia-theme') || 'light'; }
function saveTheme(t) { localStorage.setItem('lia-theme', t); }
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const mc = document.querySelector('meta[name="theme-color"]');
  if (mc) mc.content = t === 'light' ? '#ffffff' : '#4f6ef7';
}
applyTheme(loadTheme());
