// Lia Field — entry.js
//
// The ladder entry form: detail-screen state, saving, the field set, the
// four BSI flags, and adding or amending a ladder.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step. Modules would need a
// server, and the app has to run from file:// and from a Capacitor bundle.

// ════════════════════════════════════════════════════════════════
// Job Detail
// ════════════════════════════════════════════════════════════════
let _job          = null;
let _saveTimer    = null;
let _currentParts = new Map();
let _editingIdx   = -1;

function openJob(id) {
  const all = loadJobs();
  _job = all[id];
  if (!_job) { goScreen('jobs'); return; }
  $('job-name').value = _job.name || '';
  $('job-wo').value   = _job.workOrderNum || '';
  setSaveStatus('');
  clearFormAll();
  goScreen('detail');
  applyScopeToDetail(_job);
  renderLadderList();
  renderPartButtons();
  renderCustomFieldsForm();
  if (jobScope(_job) !== 'fall_protection') $('fi-serial').focus();
}

$('btn-back').addEventListener('click', () => {
  saveNow();
  goScreen('jobs');
  renderJobList();
});

// ── Save ──────────────────────────────────────────────────────────────────────
function scheduleSave() {
  setSaveStatus('saving…');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveNow, 800);
}

function saveNow() {
  if (!_job) return;
  clearTimeout(_saveTimer);
  _job.name         = $('job-name').value.trim();
  _job.workOrderNum = $('job-wo').value.trim();
  _job.updatedAt    = new Date().toISOString();
  const all = loadJobs(); all[_job.id] = _job; saveJobs(all);
  setSaveStatus('saved');
}

function setSaveStatus(text) {
  const el = $('save-status');
  el.textContent = text === 'saved' ? 'Saved' : text;
  el.className   = 'save-status' + (text === 'saved' ? ' saved' : '');
}

$('job-name').addEventListener('input', scheduleSave);
$('job-wo').addEventListener('input',   scheduleSave);

// ── Form clear ────────────────────────────────────────────────────────────────
function clearEntryForm() {
  ['fi-serial','fi-loc','fi-desc','fi-part-manual'].forEach(id => { const el=$(id); if(el) el.value=''; });
  const qty = $('fi-part-qty'); if (qty) qty.value = '1';
  _qtyExplicit = false;
  document.querySelectorAll('.cf-input').forEach(i => { i.value = ''; });
  updateSerialWarnState();
  _currentParts = new Map();
  _currentFlags = NO_FLAGS();
  renderPartButtons();
  renderSelectedParts();
  renderFlags();
}

function clearFormAll() {
  ['fi-serial','fi-brand','fi-type','fi-length','fi-loc','fi-desc','fi-part-manual'].forEach(id => { const el=$(id); if(el) el.value=''; });
  const qty = $('fi-part-qty'); if (qty) qty.value = '1';
  _qtyExplicit = false;
  document.querySelectorAll('.cf-input').forEach(i => { i.value = ''; });
  updateSerialWarnState();
  _currentParts = new Map();
  _currentFlags = NO_FLAGS();
  renderPartButtons();
  renderSelectedParts();
  renderFlags();
}

$('btn-clear-form').addEventListener('click', clearFormAll);

// × clear buttons
document.addEventListener('click', e => {
  const x = e.target.closest('.field-clear-x[data-clear]');
  if (!x) return;
  const target = $(x.dataset.clear);
  if (target) { target.value = ''; target.focus(); }
  if (x.dataset.clear === 'fi-serial') updateSerialWarnState();
});

// Serial numbers are digits-only; flag anything else so the user knows to
// double-check or re-scan. Returns true when the current value is suspect.
function updateSerialWarnState() {
  const el = $('fi-serial');
  const bad = /\D/.test(el.value);
  el.classList.toggle('serial-warn', bad);
  return bad;
}
$('fi-serial').addEventListener('input', updateSerialWarnState);

// ── Autocomplete ──────────────────────────────────────────────────────────────
function setupAutocomplete(inputId, listId, options) {
  const input = $(inputId);
  const list  = $(listId);
  let focusedIdx = -1;

  function showList(q) {
    const f = q.toLowerCase();
    const matches = f ? options.filter(o => o.toLowerCase().includes(f)) : options;
    if (!matches.length) { list.classList.remove('open'); return; }
    list.innerHTML = ''; focusedIdx = -1;
    matches.forEach(o => {
      const item = document.createElement('div');
      item.className = 'ac-item';
      item.textContent = o;
      item.addEventListener('mousedown', e => { e.preventDefault(); input.value = o; list.classList.remove('open'); });
      item.addEventListener('touchstart', e => { e.preventDefault(); input.value = o; list.classList.remove('open'); }, { passive: false });
      list.appendChild(item);
    });
    list.classList.add('open');
  }

  input.addEventListener('input',  () => showList(input.value));
  input.addEventListener('focus',  () => { input.select(); showList(input.value); });
  input.addEventListener('blur',   () => setTimeout(() => list.classList.remove('open'), 200));
  input.addEventListener('keydown', e => {
    const items = list.querySelectorAll('.ac-item');
    if (!items.length) return;
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
      input.value = items[focusedIdx].textContent;
      list.classList.remove('open');
    } else if (e.key === 'Escape') { list.classList.remove('open'); }
  });
}

setupAutocomplete('fi-brand', 'ac-brand-list', BRAND_OPTIONS);
setupAutocomplete('fi-type',  'ac-type-list',  TYPE_OPTIONS);

// ── Part buttons ──────────────────────────────────────────────────────────────
function renderPartButtons() {
  const grid = $('parts-grid');
  grid.innerHTML = '';
  const favs = getFavoritedParts();
  if (!favs.length) {
    grid.innerHTML = '<div class="parts-empty-msg">No favorites — tap ★ in the library (☰) to pin parts here.</div>';
    return;
  }
  favs.forEach(({ name, defaultQty = 1 }) => {
    const qty = _currentParts.get(name) || 0;
    const btn = document.createElement('button');
    btn.className = 'part-btn' + (qty > 0 ? ' active' : '');
    const dLabel = defaultQty > 1 ? `<span class="pb-dqty">(${defaultQty})</span>` : '';
    btn.innerHTML = (qty > 0 ? `<span class="pb-count">${qty}</span>` : '') + esc(name.toUpperCase()) + dLabel;
    btn.addEventListener('click', () => {
      const cur = _currentParts.get(name) || 0;
      // Each tap adds the catalog qty: a ×2 part counts 2, 4, 6…
      _currentParts.set(name, cur + defaultQty);
      renderPartButtons(); renderSelectedParts();
    });
    grid.appendChild(btn);
  });
}

function renderSelectedParts() {
  const container = $('parts-selected');
  container.innerHTML = '';
  _currentParts.forEach((qty, name) => {
    if (qty <= 0) return;
    const chip = document.createElement('span');
    chip.className = 'part-chip';
    chip.innerHTML = `${esc(name.toUpperCase())}${qty > 1 ? ` ×${qty}` : ''} <button class="part-chip-x" title="Remove">×</button>`;
    chip.querySelector('.part-chip-x').addEventListener('click', e => {
      e.stopPropagation();
      _currentParts.delete(name); renderPartButtons(); renderSelectedParts();
    });
    // Tap the chip to type the exact installed count instead of tapping repeatedly
    chip.addEventListener('click', () => {
      const cur = _currentParts.get(name) || 1;
      chip.innerHTML = `${esc(name.toUpperCase())} ×<input type="number" class="chip-qty-input" min="0" max="99" inputmode="numeric" value="${cur}">`;
      const inp = chip.querySelector('input');
      inp.focus(); inp.select();
      let done = false;
      const commit = () => {
        if (done) return; done = true;
        const v = parseInt(inp.value, 10);
        if (!isNaN(v)) {
          if (v > 0) _currentParts.set(name, Math.min(v, 99));
          else _currentParts.delete(name);
        }
        renderPartButtons(); renderSelectedParts();
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', e2 => {
        if (e2.key === 'Enter') { e2.preventDefault(); inp.blur(); }
        else if (e2.key === 'Escape') { done = true; renderSelectedParts(); }
      });
    }, { once: true });
    container.appendChild(chip);
  });
}

// ── Custom fields form ────────────────────────────────────────────────────────
function renderCustomFieldsForm() {
  const container = $('custom-fields-form');
  container.innerHTML = '';
  const fields = loadCustomFields();
  if (!fields.length) return;
  // Lay out custom fields two per row
  for (let i = 0; i < fields.length; i += 2) {
    const row = document.createElement('div');
    row.className = 'meta-row-2';
    [fields[i], fields[i+1]].forEach(name => {
      if (!name) return;
      const wrap = document.createElement('div');
      wrap.className = 'field-ig';
      wrap.innerHTML = `
        <div class="field-label">${esc(name)}</div>
        <div class="field-ig-wrap">
          <input type="text" class="field-input cf-input" data-cf="${esc(name)}"
                 placeholder="${esc(name)}…" autocomplete="off">
          <button class="field-clear-x" style="border:none;background:none;"
                  onclick="this.previousElementSibling.value='';this.previousElementSibling.focus();">×</button>
        </div>
      `;
      row.appendChild(wrap);
    });
    container.appendChild(row);
  }
}

// ── Add Ladder / Save Edits ───────────────────────────────────────────────────
$('btn-add-ladder').addEventListener('click', () => { if (_editingIdx >= 0) saveEdits(); else addLadder(); });
$('btn-cancel-edit').addEventListener('click', cancelEdit);

function setEditMode(editing) {
  $('btn-add-ladder').textContent = editing ? 'Save Edits' : '+ Add Ladder';
  $('btn-cancel-edit').style.display = editing ? 'block' : 'none';
}

// The four checkboxes that sit under Length on the BSI ladder form.
const LADDER_FLAGS = [
  { key: 'leveler',    code: 'L', col: 'Leveler',    label: 'Leveler' },
  { key: 'claw',       code: 'C', col: 'Claw',       label: 'Claw' },
  { key: 'vrung',      code: 'V', col: 'V-Rung',     label: 'V-Rung' },
  { key: 'lubricated', code: 'P', col: 'Lubricated', label: 'Properly lubricated' },
];
const NO_FLAGS = () => ({ leveler: null, claw: null, vrung: null, lubricated: null });
let _currentFlags = NO_FLAGS();

// A fall protection job must not be handed the ladder entry form — the fields
// and the parts catalogue are both wrong for it.
function applyScopeToDetail(job) {
  const isFp  = jobScope(job) === 'fall_protection';
  const ladderPanels = ['form-panel', 'parts-panel', 'add-btn-panel', 'recent-panel'];
  ladderPanels.forEach(id => { const el = $(id); if (el) el.style.display = isFp ? 'none' : ''; });
  const todo = $('fp-todo-panel'); if (todo) todo.style.display = isFp ? '' : 'none';
  const share = $('btn-share-csv');
  // The ladder CSV shape does not describe a fall protection item.
  if (share) share.style.display = isFp ? 'none' : '';
}

function renderFlags() {
  const row = $('flag-row');
  if (!row) return;
  row.innerHTML = '';
  LADDER_FLAGS.forEach(f => {
    const v = _currentFlags[f.key];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'flag-btn' + (v === true ? ' yes' : v === false ? ' no' : '');
    b.title = f.label + (v === true ? ': yes' : v === false ? ': no' : ' \u2014 not assessed');
    b.innerHTML = `<span class="fb-k">${f.code}</span>` +
                  `<span class="fb-v">${v === true ? 'YES' : v === false ? 'NO' : '\u2014'}</span>`;
    // unset -> yes -> no -> unset. "Not assessed" has to stay distinct from
    // "no": the importer only ever ticks a box, it never unticks one.
    b.addEventListener('click', () => {
      _currentFlags[f.key] = v === null ? true : v === true ? false : null;
      renderFlags();
    });
    row.appendChild(b);
  });
}

function buildLadderFromForm(existingId) {
  const parts = [];
  _currentParts.forEach((qty, name) => { if (qty > 0) parts.push({ name, qty }); });
  const customFields = {};
  document.querySelectorAll('.cf-input').forEach(input => {
    const v = input.value.trim();
    if (input.dataset.cf && v) customFields[input.dataset.cf] = v;
  });
  return {
    id:         existingId || crypto.randomUUID(),
    serialNum:  $('fi-serial').value.trim(),
    brand:      $('fi-brand').value.trim(),
    type:       $('fi-type').value.trim(),
    length:     $('fi-length').value.trim(),
    locationId: $('fi-loc').value.trim(),
    desc:       $('fi-desc').value.trim(),
    customFields,
    parts,
    flags: { ..._currentFlags },
  };
}

function addLadder() {
  const serial = $('fi-serial').value.trim();
  if (!serial) {
    const el = $('fi-serial');
    el.focus(); el.style.borderColor = 'var(--err)';
    setTimeout(() => { el.style.borderColor = ''; }, 1200);
    return;
  }
  if (!_job.ladders) _job.ladders = [];
  _job.ladders.unshift(buildLadderFromForm());
  clearEntryForm();
  renderLadderList();
  scheduleSave();
  playSound('ladder');
  $('fi-serial').focus();
}

function saveEdits() {
  const serial = $('fi-serial').value.trim();
  if (!serial) {
    const el = $('fi-serial');
    el.focus(); el.style.borderColor = 'var(--err)';
    setTimeout(() => { el.style.borderColor = ''; }, 1200);
    return;
  }
  const existingId = _job.ladders[_editingIdx]?.id;
  _job.ladders[_editingIdx] = buildLadderFromForm(existingId);
  _editingIdx = -1;
  setEditMode(false);
  clearEntryForm();
  renderLadderList();
  scheduleSave();
  $('fi-serial').focus();
}

function cancelEdit() {
  _editingIdx = -1;
  setEditMode(false);
  clearEntryForm();
  renderLadderList();
  $('fi-serial').focus();
}
