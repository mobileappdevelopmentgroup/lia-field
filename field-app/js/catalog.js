// Lia Field — catalog.js
//
// The parts library and the brand/type lists that drive autocomplete.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step. Modules would need a
// server, and the app has to run from file:// and from a Capacitor bundle.

// ── Parts library ─────────────────────────────────────────────────────────────
function loadPartsLibrary() {
  try { const s = localStorage.getItem('lia-parts-library'); return s ? JSON.parse(s) : null; }
  catch { return null; }
}
function savePartsLibrary(lib) { localStorage.setItem('lia-parts-library', JSON.stringify(lib)); }

function getLibrary() {
  let lib = loadPartsLibrary();
  if (lib) {
    let dirty = false;
    // Migration: backfill L33 for existing installs
    if (!lib.some(p => p.name.toLowerCase() === 'l33')) {
      lib.push({ name: 'L33', favorited: false, defaultQty: 2 });
      dirty = true;
    }
    // Migration: assign slot order to favorited parts that don't have one
    const favs = lib.filter(p => p.favorited);
    if (favs.some(p => p.order == null)) {
      [...favs].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
               .forEach((p, i) => { p.order = i + 1; });
      dirty = true;
    }
    if (dirty) savePartsLibrary(lib);
    return lib;
  }
  lib = PARTS_SEED.map(p => ({ ...p }));
  // Migrate old lia-quick-parts if present
  try {
    const old = JSON.parse(localStorage.getItem('lia-quick-parts') || 'null');
    if (Array.isArray(old)) {
      const existing = new Set(lib.map(p => p.name.toLowerCase()));
      for (const n of old) if (!existing.has(n.toLowerCase())) lib.push({ name: n, favorited: true, defaultQty: 1 });
    }
  } catch {}
  savePartsLibrary(lib);
  return lib;
}

function getFavoritedParts() {
  return getLibrary().filter(p => p.favorited).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

function normalizeOrders(lib) {
  lib.filter(p => p.favorited)
     .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
     .forEach((p, i) => { p.order = i + 1; });
}

function ensureInLibrary(name) {
  const lib = getLibrary();
  if (!lib.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    lib.push({ name, favorited: false, defaultQty: 1 });
    savePartsLibrary(lib);
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const BRAND_OPTIONS = [
  'Little Giant','Werner','Louisville','Featherlite','Bauer','DeWalt',
  'Gorilla','Cosco','Tricam','Metaltech','Xtend+Climb','Telesteps',
  'Bathey','Davidson','Alco-Lite','Duo-Safety','Youngman','Zarges','ProMaster'
];
const TYPE_OPTIONS = [
  'Extension','Step','Combination','Multi-Position','Straight',
  'Platform','Attic','Podium','Trestle','Articulated','Rolling','Folding','Hook'
];
// ── Parts library seed (from Batavia work-order data) ─────────────────────────
// favorited = shown as a quick-tap button; defaultQty = first-tap quantity
const PARTS_SEED = [
  { name: 'M23',      favorited: true,  defaultQty: 1 },
  { name: 'M16',      favorited: true,  defaultQty: 1 },
  { name: 'RC',       favorited: true,  defaultQty: 1 },
  { name: 'R28L',     favorited: true,  defaultQty: 1 },
  { name: 'Hlm100',   favorited: true,  defaultQty: 1 },
  { name: 'Lgh123WP', favorited: true,  defaultQty: 1 },
  { name: 'LGE26p',   favorited: true,  defaultQty: 1 },
  { name: 'Lgh92',    favorited: true,  defaultQty: 1 },
  { name: 'B74',      favorited: true,  defaultQty: 1 },
  { name: 'SLS',      favorited: true,  defaultQty: 2 },
  { name: 'S375',     favorited: true,  defaultQty: 1 },
  { name: 'M13',      favorited: false, defaultQty: 1 },
  { name: 'M200',     favorited: false, defaultQty: 1 },
  { name: 'R28',      favorited: false, defaultQty: 1 },
  { name: 'Lgh123c',  favorited: false, defaultQty: 1 },
  { name: 'Lgh26p',   favorited: false, defaultQty: 1 },
  { name: 'Lge26p',   favorited: false, defaultQty: 1 },
  { name: 'Lgh36b',   favorited: false, defaultQty: 1 },
  { name: 'PTS',      favorited: false, defaultQty: 1 },
  // Blue Ridge
  { name: 'PM36',    favorited: false, defaultQty: 1 },
  { name: 'PMCD4',   favorited: false, defaultQty: 1 },
  { name: 'W44',     favorited: false, defaultQty: 1 },
  { name: 'G13',     favorited: false, defaultQty: 1 },
  { name: 'W36-B',   favorited: false, defaultQty: 1 },
  { name: 'L18i',    favorited: false, defaultQty: 1 },
  // Northern Tier
  { name: 'Hom200',  favorited: false, defaultQty: 1 },
  { name: 'Levelers',favorited: false, defaultQty: 1 },
  { name: 'Lge123',  favorited: false, defaultQty: 1 },
  { name: 'Lge36b',  favorited: false, defaultQty: 1 },
  { name: 'LGE43',   favorited: false, defaultQty: 1 },
  { name: 'LGE55',   favorited: false, defaultQty: 1 },
  { name: 'B92',     favorited: false, defaultQty: 1 },
  { name: 'B72',     favorited: false, defaultQty: 1 },
  { name: 'Lge70r',  favorited: false, defaultQty: 1 },
  { name: 'L33',     favorited: false, defaultQty: 2 },
];
