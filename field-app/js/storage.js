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

function goScreen(name) {
  ['auth','sync','jobs','detail'].forEach(s => {
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
