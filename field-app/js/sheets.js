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
      item.innerHTML = esc(p.name) + (dq > 1 ? `<span class="ac-dqty">adds ${dq}</span>` : '');
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

  const reflow = () => { if (list.classList.contains('open')) placeAcList(input, list); };
  window.visualViewport?.addEventListener('resize', reflow);
  window.visualViewport?.addEventListener('scroll', reflow);

  input.addEventListener('input',  () => showList(input.value.trim()));
  input.addEventListener('focus',  () => {
    input.select();
    showList(input.value.trim());
    setTimeout(() => { keepInputVisible(input); reflow(); }, 300);
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

function openLibrary()  { renderLibList(); $('lib-sheet').classList.remove('hidden'); $('lib-backdrop').classList.remove('hidden'); }
function closeLibrary() { $('lib-sheet').classList.add('hidden'); $('lib-backdrop').classList.add('hidden'); }

function renderLibList() {
  const lib = getLibrary();
  const list = $('lib-list');
  list.innerHTML = '';
  if (!lib.length) { list.innerHTML = '<div class="cf-empty">No parts yet — add one below.</div>'; return; }
  const favCount = lib.filter(p => p.favorited).length;
  const sorted = [...lib].sort((a, b) => {
    if (a.favorited !== b.favorited) return a.favorited ? -1 : 1;
    if (a.favorited && b.favorited) return (a.order ?? 999) - (b.order ?? 999);
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  sorted.forEach(p => {
    const dqty = p.defaultQty || 1;
    const row = document.createElement('div');
    row.className = 'part-lib-row';
    row.innerHTML = `
      <button class="star-btn${p.favorited ? ' starred' : ''}" title="${p.favorited ? 'Unfavorite' : 'Favorite'}">${p.favorited ? '★' : '☆'}</button>
      <span class="part-lib-name">${esc(p.name)}</span>
      ${p.favorited ? `<div class="lib-pos-wrap">
        <span class="lib-pos-label">Slot</span>
        <input class="lib-pos" type="number" min="1" max="${favCount}" value="${p.order ?? 1}" title="Button grid position (1 = first slot)">
      </div>` : ''}
      <div class="lib-qty-wrap">
        <span class="lib-qty-label">×</span>
        <input class="lib-qty" type="number" min="1" max="99" value="${dqty}" title="Default qty per first tap">
      </div>
      <button class="cf-del" title="Remove from library">×</button>
    `;
    row.querySelector('.star-btn').addEventListener('click', () => {
      const libData = getLibrary();
      const item = libData.find(x => x.name === p.name);
      if (!item) return;
      item.favorited = !item.favorited;
      if (item.favorited) {
        const maxOrder = libData.filter(x => x.favorited).reduce((m, x) => Math.max(m, x.order ?? 0), 0);
        item.order = maxOrder + 1;
      } else {
        delete item.order;
        normalizeOrders(libData);
      }
      savePartsLibrary(libData);
      renderLibList(); renderPartButtons();
    });
    if (p.favorited) {
      const posEl = row.querySelector('.lib-pos');
      posEl.addEventListener('change', () => {
        const libData = getLibrary();
        const item = libData.find(x => x.name === p.name);
        if (!item) return;
        const favs = libData.filter(x => x.favorited).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
        const newPos = Math.max(1, Math.min(favs.length, parseInt(posEl.value, 10) || 1));
        const idx = favs.indexOf(item);
        favs.splice(idx, 1);
        favs.splice(newPos - 1, 0, item);
        favs.forEach((p, i) => { p.order = i + 1; });
        savePartsLibrary(libData);
        renderLibList(); renderPartButtons();
      });
    }
    const qtyEl = row.querySelector('.lib-qty');
    qtyEl.addEventListener('change', () => {
      const v = Math.max(1, parseInt(qtyEl.value, 10) || 1);
      qtyEl.value = v;
      const libData = getLibrary();
      const item = libData.find(x => x.name === p.name);
      if (item) { item.defaultQty = v; savePartsLibrary(libData); }
      renderPartButtons();
    });
    row.querySelector('.cf-del').addEventListener('click', () => {
      const libData = getLibrary().filter(x => x.name !== p.name);
      normalizeOrders(libData);
      savePartsLibrary(libData);
      renderLibList(); renderPartButtons();
    });
    list.appendChild(row);
  });
}

$('btn-add-lib-part').addEventListener('click', addLibPart);
$('new-lib-input').addEventListener('keydown', e => { if (e.key === 'Enter') addLibPart(); });

function addLibPart() {
  const name = $('new-lib-input').value.trim();
  if (!name) return;
  const lib = getLibrary();
  if (!lib.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    lib.push({ name, favorited: false, defaultQty: 1 });
    savePartsLibrary(lib);
  }
  $('new-lib-input').value = '';
  renderLibList();
}
