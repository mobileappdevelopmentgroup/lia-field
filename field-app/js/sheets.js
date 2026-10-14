// Lia Field — sheets.js
//
// The bottom sheets — settings, custom fields, the parts library — plus
// editing an existing ladder and adding parts by hand.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step. Modules would need a
// server, and the app has to run from file:// and from a Capacitor bundle.

// ════════════════════════════════════════════════════════════════
// Settings sheet
// ════════════════════════════════════════════════════════════════
$('btn-settings').addEventListener('click',       openSettings);
$('btn-close-settings').addEventListener('click', closeSettings);
$('sheet-backdrop').addEventListener('click',     closeSettings);

// Theme toggle
document.querySelectorAll('.theme-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.t;
    applyTheme(t); saveTheme(t);
    document.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.t === t));
  });
});

// Sound selects — save on change
['sound-scan-select','sound-ladder-select'].forEach(id => {
  $(id)?.addEventListener('change', () => {
    const prefs = loadSounds();
    prefs.scan   = $('sound-scan-select').value;
    prefs.ladder = $('sound-ladder-select').value;
    saveSounds(prefs);
  });
});

function openSettings() {
  // Apply current theme selection
  const curTheme = loadTheme();
  document.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.t === curTheme));
  // Apply current sound selections
  const prefs = loadSounds();
  $('sound-scan-select').value   = prefs.scan   ?? 'beep';
  $('sound-ladder-select').value = prefs.ladder  ?? 'chime';
  renderCfList();
  $('settings-sheet').classList.remove('hidden');
  $('sheet-backdrop').classList.remove('hidden');
  $('settings-scroll').scrollTop = 0;
}

function closeSettings() {
  $('settings-sheet').classList.add('hidden');
  $('sheet-backdrop').classList.add('hidden');
  renderCustomFieldsForm();
}

function renderCfList() {
  const fields = loadCustomFields();
  const list   = $('cf-list');
  list.innerHTML = '';
  if (fields.length === 0) {
    list.innerHTML = '<div class="cf-empty">No custom fields yet — add one below.</div>';
    return;
  }
  fields.forEach((name, idx) => {
    const row = document.createElement('div');
    row.className = 'cf-row';
    row.innerHTML = `
      <span class="cf-name">${esc(name)}</span>
      <button class="cf-del" title="Delete field" data-idx="${idx}">×</button>
    `;
    row.querySelector('.cf-del').addEventListener('click', () => {
      const f = loadCustomFields(); f.splice(idx, 1); saveCustomFields(f); renderCfList();
    });
    list.appendChild(row);
  });
}

$('btn-add-cf').addEventListener('click', addCustomField);
$('new-cf-input').addEventListener('keydown', e => { if (e.key === 'Enter') addCustomField(); });

function addCustomField() {
  const name = $('new-cf-input').value.trim();
  if (!name) return;
  const fields = loadCustomFields();
  if (!fields.includes(name)) { fields.push(name); saveCustomFields(fields); }
  $('new-cf-input').value = '';
  renderCfList();
}

// ── Edit / Duplicate ladder ───────────────────────────────────────────────────
function fillForm(l, includeSerial) {
  $('fi-serial').value = includeSerial ? (l.serialNum || '') : '';
  updateSerialWarnState();
  $('fi-brand').value  = l.brand      || '';
  $('fi-type').value   = l.type       || '';
  $('fi-length').value = l.length     || '';
  $('fi-loc').value    = l.locationId || '';
  $('fi-desc').value   = l.desc       || '';
  const pm = $('fi-part-manual'); if (pm) pm.value = '';
  _currentParts = new Map();
  (l.parts || []).forEach(p => _currentParts.set(p.name, p.qty));
  document.querySelectorAll('.cf-input').forEach(input => {
    input.value = (input.dataset.cf && l.customFields && l.customFields[input.dataset.cf]) || '';
  });
  _currentFlags = Object.assign(NO_FLAGS(), l.flags || {});
  renderPartButtons(); renderSelectedParts(); renderFlags();
  $('fi-serial').focus();
}

function editLadder(idx) {
  const l = _job.ladders[idx];
  if (!l) return;
  _editingIdx = idx;
  setEditMode(true);
  fillForm(l, true);
  renderLadderList(); // re-render to show editing highlight
}

function duplicateLadder(idx) {
  const l = _job.ladders[idx];
  if (!l) return;
  fillForm(l, false); // serial left blank
}

// ── Manual part input + autocomplete ─────────────────────────────────────────
// True only when the user actually typed in the qty box — then the number is
// the exact installed count, not an increment.
let _qtyExplicit = false;

function addManualPart() {
  const input = $('fi-part-manual');
  const raw = input.value.trim();
  if (!raw) return;
  const qtyInput = $('fi-part-qty');
  const lib = getLibrary();
  const found = lib.find(p => p.name.toLowerCase() === raw.toLowerCase());
  const partName = found ? found.name : raw;
  const step = (found && found.defaultQty) || 1;
  const cur = _currentParts.get(partName) || 0;
  if (_qtyExplicit) {
    // User dictated the count — set it outright (type 7 → exactly 7).
    _currentParts.set(partName, Math.max(1, parseInt(qtyInput?.value, 10) || 1));
  } else {
    // Catalog behavior: first add pulls the start qty, repeats add it again (2 → 4 → 6…).
    _currentParts.set(partName, cur + step);
  }
  if (!found) ensureInLibrary(raw);
  input.value = '';
  if (qtyInput) qtyInput.value = '1';
  _qtyExplicit = false;
  $('ac-part-list').classList.remove('open');
  renderPartButtons(); renderSelectedParts();
  input.focus();
}

$('btn-add-part-manual').addEventListener('click', addManualPart);
$('fi-part-manual').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addManualPart(); } });

// Qty input: clear on focus, restore 1 if left empty
$('fi-part-qty').addEventListener('focus', function() { this.value = ''; _qtyExplicit = false; });
$('fi-part-qty').addEventListener('input', function() { _qtyExplicit = this.value.trim() !== ''; });
$('fi-part-qty').addEventListener('blur',  function() { if (!this.value || parseInt(this.value) < 1) { this.value = '1'; _qtyExplicit = false; } });
$('fi-part-qty').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addManualPart(); } });

(function setupPartAutocomplete() {
  const input = $('fi-part-manual');
  const list  = $('ac-part-list');
  let focusedIdx = -1;

  function showList(q) {
    const lib = getLibrary();
    const matches = q
      ? lib.filter(p => p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 10)
      : lib.slice(0, 10);
    if (!matches.length) { list.classList.remove('open'); return; }
    list.innerHTML = ''; focusedIdx = -1;
    matches.forEach(p => {
      const item = document.createElement('div');
      item.className = 'ac-item';
      item.dataset.name = p.name;
      const dq = p.defaultQty || 1;
      // The description is why the catalogue is worth carrying: "LGH125ILC"
      // means nothing on a phone screen, "LEG CAP FOR FOOT REP INT" does.
      const desc = typeof partDescription === 'function' ? partDescription(p.name) : '';
      item.innerHTML = esc(p.name)
        + (desc ? `<span class="ac-desc">${esc(desc)}</span>` : '')
        + (dq > 1 ? `<span class="ac-dqty">adds ${dq}</span>` : '');
      function pickPart(name) {
        input.value = name;
        list.classList.remove('open');
        addManualPart();
      }
      item.addEventListener('mousedown', e => { e.preventDefault(); pickPart(p.name); });
      item.addEventListener('touchstart', e => { e.preventDefault(); pickPart(p.name); }, { passive: false });
      list.appendChild(item);
    });
    list.classList.add('open');
    placeAcList(input, list);
  }

  const reflow = watchAcList(input, list);

  input.addEventListener('input',  () => showList(input.value.trim()));
  input.addEventListener('focus',  () => {
    input.select();
    showList(input.value.trim());
    reflow.settle();
    setTimeout(() => { keepInputVisible(input); reflow.settle(); }, 300);
  });
  input.addEventListener('blur',   () => setTimeout(() => list.classList.remove('open'), 200));
  input.addEventListener('keydown', e => {
    const items = list.querySelectorAll('.ac-item');
    if (e.key === 'Enter' && !items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIdx = Math.min(focusedIdx + 1, items.length - 1);
      items.forEach((el,i) => el.classList.toggle('focused', i === focusedIdx));
      items[focusedIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIdx = Math.max(focusedIdx - 1, 0);
      items.forEach((el,i) => el.classList.toggle('focused', i === focusedIdx));
      items[focusedIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && focusedIdx >= 0 && items[focusedIdx]) {
      e.preventDefault();
      input.value = items[focusedIdx].dataset.name;
      list.classList.remove('open');
      addManualPart();
    } else if (e.key === 'Escape') { list.classList.remove('open'); }
  });
})();

// ── Parts library sheet ───────────────────────────────────────────────────────
$('btn-open-library').addEventListener('click',  openLibrary);
$('btn-close-library').addEventListener('click', closeLibrary);
$('lib-backdrop').addEventListener('click',      closeLibrary);

function openLibrary() {
  $('new-lib-input').value = '';
  closeSetEditor();
  renderLibSets();
  renderLibList();
  $('lib-sheet').classList.remove('hidden'); $('lib-backdrop').classList.remove('hidden');
}
function closeLibrary() { $('lib-sheet').classList.add('hidden'); $('lib-backdrop').classList.add('hidden'); }

// ── Favourite sets, in the library ──────────────────────────────────────────
function renderLibSets() {
  const sel = $('lib-set');
  const active = activePartSet();
  sel.innerHTML = listPartSets().map(s =>
    `<option value="${esc(s.id)}"${s.id === active ? ' selected' : ''}>★ ${esc(s.name)}${s.published ? ' (office)' : ''}</option>`).join('');
  const main = active === MAIN_PART_SET;
  const pub = isPublishedPartSet(active);
  $('lib-set-rename').style.display = main || pub ? 'none' : '';
  $('lib-set-delete').style.display = main || pub ? 'none' : '';
  $('lib-set-copy').style.display = pub ? '' : 'none';
  $('lib-set-note').style.display = pub ? '' : 'none';
  $('lib-set-delete').textContent = 'Delete';
  delete $('lib-set-delete').dataset.armed;
}

// Switching set changes the buttons, and the job remembers it: a job is a
// site, and the next time it is opened the same set comes back.
function usePartSet(id) {
  setActivePartSet(id);
  if (typeof _job !== 'undefined' && _job) { _job.partSet = activePartSet(); scheduleSave(); }
  renderPartButtons();
}

$('lib-set').addEventListener('change', () => {
  usePartSet($('lib-set').value);
  closeSetEditor();
  renderLibSets(); renderLibList();
});

let _setEditing = null;            // 'new' | 'rename'
function openSetEditor(mode) {
  _setEditing = mode;
  const cur = listPartSets().find(s => s.id === activePartSet());
  $('lib-set-name').value = mode === 'rename' && cur ? cur.name : '';
  $('lib-set-edit').style.display = 'flex';
  $('lib-set-name').focus();
}
function closeSetEditor() { _setEditing = null; $('lib-set-edit').style.display = 'none'; }
function saveSetEditor() {
  const name = $('lib-set-name').value.trim();
  if (!name) { $('lib-set-name').focus(); return; }
  if (_setEditing === 'rename') renamePartSet(activePartSet(), name);
  else usePartSet(createPartSet(name));
  closeSetEditor();
  renderLibSets(); renderLibList(); renderPartButtons();
}
$('lib-set-new').addEventListener('click', () => openSetEditor('new'));
$('lib-set-copy').addEventListener('click', () => {
  const id = copyPartSet(activePartSet());
  if (!id) return;
  usePartSet(id);
  renderLibSets(); renderLibList();
});
$('lib-set-rename').addEventListener('click', () => openSetEditor('rename'));
$('lib-set-cancel').addEventListener('click', closeSetEditor);
$('lib-set-save').addEventListener('click', saveSetEditor);
$('lib-set-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); saveSetEditor(); }
  else if (e.key === 'Escape') closeSetEditor();
});
// Two taps, no dialog: a native confirm() can wedge a WebView.
$('lib-set-delete').addEventListener('click', () => {
  const btn = $('lib-set-delete');
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Tap again to delete';
    setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = 'Delete'; } }, 3000);
    return;
  }
  deletePartSet(activePartSet());
  usePartSet(MAIN_PART_SET);
  renderLibSets(); renderLibList();
});

// ── The list, and searching it ──────────────────────────────────────────────
// Two thousand parts is not a list anybody scrolls. With nothing typed the
// sheet shows the starred parts of the set in use; typing filters the whole
// library — part numbers first, then, separately, parts whose description
// matches. Each section is capped so a one-letter query stays quick.
const LIB_SECTION_CAP = 60;
const libNorm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function renderLibList() {
  const lib = getLibrary();
  const list = $('lib-list');
  list.innerHTML = '';
  if (!lib.length) { list.innerHTML = '<div class="cf-empty">No parts yet — add one above.</div>'; return; }
  const slots = favoriteSlots(lib);
  const favCount = slots.size;
  const locked = isPublishedPartSet(activePartSet());
  const isFav = p => slots.has(p.name.toLowerCase());
  const raw = $('new-lib-input').value.trim();
  const q = libNorm(raw);

  const section = (label) => {
    const h = document.createElement('div');
    h.className = 'lib-section';
    h.textContent = label;
    list.appendChild(h);
  };
  const more = (n) => {
    const m = document.createElement('div');
    m.className = 'lib-more';
    m.textContent = `${n} more — keep typing to narrow it down`;
    list.appendChild(m);
  };
  const rows = (arr) => {
    arr.slice(0, LIB_SECTION_CAP).forEach(p => list.appendChild(libRow(p, isFav(p), slots, favCount, locked)));
    if (arr.length > LIB_SECTION_CAP) more(arr.length - LIB_SECTION_CAP);
  };

  if (!q) {
    const favs = lib.filter(isFav).sort((a, b) => slots.get(a.name.toLowerCase()) - slots.get(b.name.toLowerCase()));
    if (favs.length) rows(favs);
    else list.innerHTML = '<div class="cf-empty">Nothing starred in this set yet.</div>';
    const hint = document.createElement('div');
    hint.className = 'lib-more';
    hint.textContent = `Type above to search all ${lib.length} parts by number or description.`;
    list.appendChild(hint);
    return;
  }

  // Part numbers: starts-with beats contains, starred first within each.
  const byNumber = [];
  lib.forEach(p => {
    const n = libNorm(p.name);
    const at = n.indexOf(q);
    if (at >= 0) byNumber.push([at === 0 ? 0 : 1, isFav(p) ? 0 : 1, p]);
  });
  byNumber.sort((a, b) => a[0] - b[0] || a[1] - b[1] ||
    a[2].name.localeCompare(b[2].name, undefined, { sensitivity: 'base' }));
  const numbered = new Set(byNumber.map(r => r[2].name));

  // Descriptions: every word typed must appear, in any order.
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const byDesc = lib.filter(p => {
    if (numbered.has(p.name)) return false;
    const d = (typeof partDescription === 'function' ? partDescription(p.name) : '').toLowerCase();
    return d && words.every(w => d.includes(w));
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  if (!byNumber.length && !byDesc.length) {
    list.innerHTML = `<div class="cf-empty">No part matches “${esc(raw)}”. Tap Add to put it in the library.</div>`;
    return;
  }
  if (byNumber.length) { section('Part number'); rows(byNumber.map(r => r[2])); }
  if (byDesc.length)   { section('Description'); rows(byDesc); }
}

// locked: the set in use is the office's, so its stars and slots are shown
// but cannot be changed.
function libRow(p, fav, slots, favCount, locked) {
  const dqty = p.defaultQty || 1;
  const desc = typeof partDescription === 'function' ? partDescription(p.name) : '';
  const row = document.createElement('div');
  row.className = 'part-lib-row';
  row.innerHTML = `
    <button class="star-btn${fav ? ' starred' : ''}" title="${fav ? 'Unfavorite' : 'Favorite'}"${locked ? ' disabled' : ''}>${fav ? '★' : '☆'}</button>
    <div class="part-lib-text">
      <span class="part-lib-name">${esc(p.name)}</span>
      ${desc ? `<span class="part-lib-desc">${esc(desc)}</span>` : ''}
    </div>
    ${fav ? `<div class="lib-pos-wrap">
      <span class="lib-pos-label">Slot</span>
      <input class="lib-pos" type="number" min="1" max="${favCount}" value="${slots.get(p.name.toLowerCase()) ?? 1}" title="Button grid position (1 = first slot)"${locked ? ' disabled' : ''}>
    </div>` : ''}
    <div class="lib-qty-wrap">
      <span class="lib-qty-label">×</span>
      <input class="lib-qty" type="number" min="1" max="99" value="${dqty}" title="Default qty per first tap">
    </div>
    <button class="cf-del" title="Remove from library">×</button>
  `;
  row.querySelector('.star-btn').addEventListener('click', () => {
    toggleFavorite(p.name);
    renderLibList(); renderPartButtons();
  });
  if (fav) {
    const posEl = row.querySelector('.lib-pos');
    posEl.addEventListener('change', () => {
      moveFavorite(p.name, parseInt(posEl.value, 10) || 1);
      renderLibList(); renderPartButtons();
    });
  }
  const qtyEl = row.querySelector('.lib-qty');
  qtyEl.addEventListener('change', () => {
    const v = Math.max(1, parseInt(qtyEl.value, 10) || 1);
    qtyEl.value = v;
    const libData = getLibrary();
    const item = libData.find(x => x.name === p.name);
    if (item) { item.defaultQty = v; item.touched = true; savePartsLibrary(libData); }
    renderPartButtons();
  });
  row.querySelector('.cf-del').addEventListener('click', () => {
    const libData = getLibrary().filter(x => x.name !== p.name);
    normalizeOrders(libData);
    savePartsLibrary(libData);
    forgetFavoriteEverywhere(p.name);
    renderLibList(); renderPartButtons();
  });
  return row;
}

$('btn-add-lib-part').addEventListener('click', addLibPart);
$('new-lib-input').addEventListener('keydown', e => { if (e.key === 'Enter') addLibPart(); });
$('new-lib-input').addEventListener('input', renderLibList);

function addLibPart() {
  const name = $('new-lib-input').value.trim();
  if (!name) return;
  const lib = getLibrary();
  if (!lib.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    // Added by hand, so it is theirs from the start.
    lib.push({ name, favorited: false, defaultQty: 1, touched: true });
    savePartsLibrary(lib);
  }
  // The search is left on the part, so it can be starred straight away.
  renderLibList();
}
