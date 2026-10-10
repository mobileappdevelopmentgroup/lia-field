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

// Everything BSI knows, folded into the library.
//
// The library used to be ~30 part numbers somebody typed in, so a tech working
// a job with anything else got no autocomplete and no description — the part
// went in as free text and the importer had to guess at it. This brings the
// real catalogue, 1,936 parts, and it is merged rather than assigned:
// favourites, their slot order and parts a tech added by hand all survive.
//
// Returns true if it changed anything.
function mergeCatalogIntoLibrary(lib) {
  if (typeof PARTS_CATALOG === 'undefined') return false;
  const have = new Set(lib.map(p => p.name.toLowerCase()));
  let added = 0;
  for (let i = 0; i < PARTS_CATALOG.length; i++) {
    const name = PARTS_CATALOG[i][0];
    if (have.has(name.toLowerCase())) continue;
    // Not favourited: 1,936 favourites is no favourites. The tech pins what
    // they actually reach for, and the seed's own picks stay pinned.
    lib.push({ name, favorited: false, defaultQty: 1, fromCatalog: true });
    added++;
  }
  return added > 0;
}

// The lead's published list, arriving from Lia Office.
//
// Same rule as the BSI catalogue and for the same reason: it is a BASELINE,
// not an assignment. A tech has favourites, an order they put them in, a
// quantity they set and parts they added by hand. That is an arrangement made
// for their own hands, on an app used with gloves on, and a lead publishing
// a list on a Tuesday must not rearrange it mid-job.
//
// So what the lead sends is applied only where the tech has not already
// spoken:
//
//   * a part that is new to the device is added, with the lead's suggested
//     favourite and quantity
//   * a part the tech already has keeps THEIR favourite, order and quantity
//   * a part the lead removed is dropped only if the tech never touched it —
//     a part somebody pinned is a part they use, whatever the office thinks
//
// `rows` is what account_parts_catalog() returns, tombstones included:
// is_deleted is how a device learns a part went away.
function mergeCrewParts(rows) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const lib = getLibrary();
  const byName = new Map(lib.map(p => [p.name.toLowerCase(), p]));
  let dirty = false;

  rows.forEach(r => {
    const name = String(r.part_number || '').trim();
    if (!name) return;
    const have = byName.get(name.toLowerCase());

    if (r.is_deleted) {
      if (!have || have.touched) return;   // theirs; the office does not decide
      // Withdrawing is the lead taking back a SUGGESTION, not deleting a part.
      // If BSI knows the part it stays in the library — it is still a real
      // part, still searchable, still billable, and a tech who reaches for it
      // should find it. Only the lead's pin and quantity go.
      if (typeof PARTS_DESC !== 'undefined' && PARTS_DESC[name.toLowerCase()] !== undefined) {
        if (have.favorited || have.defaultQty !== 1) {
          have.favorited = false;
          delete have.order;
          have.defaultQty = 1;
          dirty = true;
        }
        return;
      }
      // Not a BSI part: it only ever existed because the lead put it there,
      // so there is nothing left for it to be.
      if (have.fromCrew && !have.favorited) {
        lib.splice(lib.indexOf(have), 1);
        dirty = true;
      }
      return;
    }

    if (!have) {
      lib.push({ name, favorited: !!r.favorited,
                 defaultQty: Math.max(1, Number(r.default_qty) || 1),
                 order: r.ord == null ? undefined : Number(r.ord),
                 fromCrew: true });
      dirty = true;
      return;
    }
    // Already on the device. A description is the one thing worth filling in
    // without asking — it is never something a tech chose.
    if (have.fromCatalog && !have.touched && !have.favorited) {
      const q = Math.max(1, Number(r.default_qty) || 1);
      if (have.defaultQty !== q) { have.defaultQty = q; dirty = true; }
      if (r.favorited && !have.favorited) { have.favorited = true; have.order = Number(r.ord) || undefined; dirty = true; }
    }
    if (!have.fromCrew) { have.fromCrew = true; dirty = true; }
  });

  if (dirty) { normalizeOrders(lib); savePartsLibrary(lib); }
  return dirty;
}

function getLibrary() {
  let lib = loadPartsLibrary();
  if (lib) {
    let dirty = false;
    // Migration: backfill L33 for existing installs
    if (!lib.some(p => p.name.toLowerCase() === 'l33')) {
      lib.push({ name: 'L33', favorited: false, defaultQty: 2 });
      dirty = true;
    }
    // Migration: an install from before the BSI catalogue existed.
    if (mergeCatalogIntoLibrary(lib)) dirty = true;
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
  // A fresh install: the seed first, so its favourites and quantities are the
  // ones that stick, then everything else BSI knows behind them.
  lib = PARTS_SEED.map(p => ({ ...p }));
  mergeCatalogIntoLibrary(lib);
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

// ── Favourite sets ────────────────────────────────────────────────────────────
// Different sites use different parts, so a tech can keep more than one set of
// quick-tap buttons and switch between them.
//
// "Main" is the library's own favourites — `favorited` and `order` on each part
// — and stays the one the lead's published list (mergeCrewParts) writes into.
// Every other set is just an ordered list of part names, kept apart from the
// library, so a list published from the office never rearranges a site set a
// tech built for himself. The quantity per tap belongs to the part, not the
// set: a ×2 part is ×2 whichever buttons it is on.
//
// The set in use is remembered per job (openJob), since a job is a site.
//
// Sets the office publishes (migration 33) live beside the tech's own, marked
// `published`. They are read-only here: the office republishing must never
// overwrite a change a tech made, and a tech's change must never pass for the
// office's. A tech who wants one different copies it.
const MAIN_PART_SET = 'main';

function loadPartSets() {
  try {
    const s = JSON.parse(localStorage.getItem('lia-part-sets') || 'null');
    if (s && Array.isArray(s.sets)) return s;
  } catch {}
  return { active: MAIN_PART_SET, sets: [] };
}
function savePartSets(ps) { localStorage.setItem('lia-part-sets', JSON.stringify(ps)); }

function listPartSets() {
  return [{ id: MAIN_PART_SET, name: 'Main', published: false }]
    .concat(loadPartSets().sets.map(s => ({ id: s.id, name: s.name, published: !!s.published })));
}
function isPublishedPartSet(id) {
  return loadPartSets().sets.some(s => s.id === id && s.published);
}

// What account_part_sets_catalog() returned, whole. Published sets are
// replaced to match; the tech's own sets are not touched. Returns true if
// anything changed.
function mergePublishedSets(rows) {
  if (!Array.isArray(rows)) return false;
  const ps = loadPartSets();
  const before = JSON.stringify(ps);
  const incoming = rows.filter(r => r && r.id && String(r.name || '').trim()).map(r => ({
    id: 'pub-' + r.id,
    name: String(r.name).trim().slice(0, 40),
    favs: (Array.isArray(r.parts) ? r.parts : []).map(n => String(n || '').trim()).filter(Boolean),
    published: true,
  }));
  // Published first, in the office's order, then the tech's own.
  ps.sets = incoming.concat(ps.sets.filter(s => !s.published));
  if (!ps.sets.some(s => s.id === ps.active)) ps.active = MAIN_PART_SET;
  const changed = JSON.stringify(ps) !== before;
  if (changed) savePartSets(ps);
  // A set naming a part the device has never heard of would show no button.
  incoming.forEach(s => s.favs.forEach(n => ensureInLibrary(n)));
  return changed;
}

// A published set the tech wants different: a copy of their own, chosen.
function copyPartSet(id) {
  const src = loadPartSets().sets.find(s => s.id === id);
  if (!src) return null;
  const nid = createPartSet((src.name + ' (mine)').slice(0, 40));
  const ps = loadPartSets();
  const copy = ps.sets.find(s => s.id === nid);
  if (copy) { copy.favs = src.favs.slice(); savePartSets(ps); }
  return nid;
}
function activePartSet() {
  const ps = loadPartSets();
  return ps.sets.some(s => s.id === ps.active) ? ps.active : MAIN_PART_SET;
}
function setActivePartSet(id) {
  const ps = loadPartSets();
  ps.active = ps.sets.some(s => s.id === id) ? id : MAIN_PART_SET;
  savePartSets(ps);
  return ps.active;
}
function createPartSet(name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n) return null;
  const ps = loadPartSets();
  const id = 'set-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  ps.sets.push({ id, name: n, favs: [] });
  ps.active = id;
  savePartSets(ps);
  return id;
}
function renamePartSet(id, name) {
  const n = String(name || '').trim().slice(0, 40);
  const ps = loadPartSets();
  const set = ps.sets.find(s => s.id === id);
  if (!set || !n || set.published) return false;
  set.name = n;
  savePartSets(ps);
  return true;
}
// Main cannot be deleted: it is where the lead's list lands.
function deletePartSet(id) {
  const ps = loadPartSets();
  ps.sets = ps.sets.filter(s => s.id !== id || s.published);
  if (ps.active === id) ps.active = MAIN_PART_SET;
  savePartSets(ps);
}

// lower-cased name → slot, for the set in use.
function favoriteSlots(lib) {
  const m = new Map();
  const id = activePartSet();
  if (id === MAIN_PART_SET) {
    lib.forEach(p => { if (p.favorited) m.set(p.name.toLowerCase(), p.order ?? 999); });
    return m;
  }
  const set = loadPartSets().sets.find(s => s.id === id);
  (set ? set.favs : []).forEach((n, i) => m.set(String(n).toLowerCase(), i + 1));
  return m;
}

function getFavoritedParts() {
  const lib = getLibrary();
  const slots = favoriteSlots(lib);
  return lib.filter(p => slots.has(p.name.toLowerCase()))
            .sort((a, b) => slots.get(a.name.toLowerCase()) - slots.get(b.name.toLowerCase()));
}

// Star or unstar a part in the set in use.
function toggleFavorite(name) {
  const id = activePartSet();
  if (id === MAIN_PART_SET) {
    const lib = getLibrary();
    const item = lib.find(x => x.name === name);
    if (!item) return;
    // Touched: from here on this part is the tech's, and a catalogue
    // published from the office leaves it alone.
    item.touched = true;
    item.favorited = !item.favorited;
    if (item.favorited) {
      const maxOrder = lib.filter(x => x.favorited).reduce((m, x) => Math.max(m, x.order ?? 0), 0);
      item.order = maxOrder + 1;
    } else {
      delete item.order;
      normalizeOrders(lib);
    }
    savePartsLibrary(lib);
    return;
  }
  const ps = loadPartSets();
  const set = ps.sets.find(s => s.id === id);
  if (!set || set.published) return;
  const i = set.favs.findIndex(n => n.toLowerCase() === name.toLowerCase());
  if (i >= 0) set.favs.splice(i, 1); else set.favs.push(name);
  savePartSets(ps);
}

// Move a starred part to slot `pos` (1-based) in the set in use.
function moveFavorite(name, pos) {
  const id = activePartSet();
  if (id === MAIN_PART_SET) {
    const lib = getLibrary();
    const item = lib.find(x => x.name === name);
    if (!item) return;
    item.touched = true;
    const favs = lib.filter(x => x.favorited).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    const to = Math.max(1, Math.min(favs.length, pos));
    favs.splice(favs.indexOf(item), 1);
    favs.splice(to - 1, 0, item);
    favs.forEach((p, i) => { p.order = i + 1; });
    savePartsLibrary(lib);
    return;
  }
  const ps = loadPartSets();
  const set = ps.sets.find(s => s.id === id);
  if (!set || set.published) return;
  const i = set.favs.findIndex(n => n.toLowerCase() === name.toLowerCase());
  if (i < 0) return;
  const [n] = set.favs.splice(i, 1);
  set.favs.splice(Math.max(1, Math.min(set.favs.length + 1, pos)) - 1, 0, n);
  savePartSets(ps);
}

// A part removed from the library leaves every set too.
function forgetFavoriteEverywhere(name) {
  const ps = loadPartSets();
  let dirty = false;
  ps.sets.forEach(s => {
    if (s.published) return;               // the office's; it comes back next sync anyway
    const before = s.favs.length;
    s.favs = s.favs.filter(n => n.toLowerCase() !== name.toLowerCase());
    if (s.favs.length !== before) dirty = true;
  });
  if (dirty) savePartSets(ps);
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
