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
  // On an assigned job the work order number came from the lead. A tech
  // retyping it — 'WO 1234' for 'WO-1234' — is exactly what stopped the office
  // matching up a day's work, so it is fixed here rather than merely suggested.
  const assigned = !!_job.assignedId;
  $('job-wo').readOnly = assigned;
  $('job-wo').title = assigned ? 'Set by your lead for this job' : '';
  setSaveStatus('');
  // The favourite set this job was last worked with — a job is a site.
  if (_job.partSet) setActivePartSet(_job.partSet);
  clearFormAll();
  goScreen('detail');
  applyScopeToDetail(_job);
  renderLadderList();
  renderPartButtons();
  renderCustomFieldsForm();
  // Deliberately NOT focused. Opening a job put the cursor in the serial field,
  // which raises the keyboard, which squeezes the ladder list off the screen —
  // so the first thing a tech saw was a form covering the work he came to look
  // at, with Reset the only button that happened to dismiss it. The keyboard
  // now comes up when he asks for it: by tapping the field, or the camera.
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
  // Never taken from the box on an assigned job: a readOnly input is a UI
  // convention, not a guarantee, and the number is the lead's.
  if (!_job.assignedId) {
    const wasWo = _job.workOrderNum || '';
    _job.workOrderNum = $('job-wo').value.trim();
    // Records already uploaded without one carry no work order on the server,
    // so the office cannot match them. Sending them again attaches it: the
    // write path supersedes, so this corrects rather than duplicates.
    if (_job.workOrderNum && _job.workOrderNum !== wasWo) requeueJobLadders();
  }
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
// keepParts: Add & Duplicate carries the parts to the next ladder. The four
// flags are never carried — they record what the customer did to that ladder.
function clearEntryForm(keepParts) {
  ['fi-serial','fi-loc','fi-desc','fi-part-manual'].forEach(id => { const el=$(id); if(el) el.value=''; });
  const qty = $('fi-part-qty'); if (qty) qty.value = '1';
  _qtyExplicit = false;
  document.querySelectorAll('.cf-input').forEach(i => { i.value = ''; });
  updateSerialWarnState();
  showLadderLookup(null);
  // What stays in the form for the next ladder is marked as carried over, so
  // that ladder's own record replaces it if it has one.
  LOOKUP_FIELDS.forEach(([id]) => {
    const el = $(id);
    if (el.value.trim()) el.dataset.src = 'carry'; else delete el.dataset.src;
  });
  if (!keepParts) _currentParts = new Map();
  _currentFlags = NO_FLAGS();
  renderPartButtons();
  renderSelectedParts();
  renderFlags();
}

function clearFormAll() {
  ['fi-serial','fi-brand','fi-type','fi-length','fi-loc','fi-desc','fi-part-manual'].forEach(id => { const el=$(id); if(el) { el.value=''; delete el.dataset.src; } });
  showLadderLookup(null);
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

// Where to hang an open suggestion list.
//
// These used to be pinned upwards in the markup, which put Brand and Type over
// the serial field the tech had just filled in, and on a short handset the
// list ran off the top with no way to reach the rest of it.
//
// Down is the default, because that is where a list is expected and because
// the row it hangs off is near the top of the form. It flips up only when the
// list genuinely does not fit below AND there is more room above.
//
// Room is measured against `visualViewport`, not `innerHeight`: when the
// keyboard is up, the layout viewport does not change on either platform, so
// anything measured against it happily places a list behind the keys. Called
// again whenever anything moves under an open list (watchAcList), so the list
// follows the keyboard.
//
// The list is placed `position: fixed`, from the measurement, rather than
// hanging absolutely off its field. Every screen is `overflow: hidden`, so a
// list that ran past the screen's edge was clipped to nothing — "dropping up
// and out of the viewport". Fixed, it is only ever where it is put, and it is
// put inside the visible area: never taller than the room it opens into, and
// hidden outright when there is not room for one row, rather than spilling
// behind the keyboard or off the top.
const AC_MAX_H = 180, AC_MIN_ROOM = 44, AC_GAP = 2, AC_EDGE = 8;

function placeAcList(input, list) {
  const vv   = window.visualViewport;
  const vTop = (vv ? vv.offsetTop : 0) + AC_EDGE;
  const vBot = (vv ? vv.offsetTop + vv.height : window.innerHeight) - AC_EDGE;
  const r    = input.getBoundingClientRect();
  const wrap = (list.parentElement || input).getBoundingClientRect();

  const below = vBot - (r.bottom + AC_GAP);
  const above = (r.top - AC_GAP) - vTop;
  const want  = Math.min(list.scrollHeight || AC_MAX_H, AC_MAX_H);

  const up   = below < want && above > below;
  const room = Math.max(0, up ? above : below);
  const h    = Math.min(want, room);

  list.classList.toggle('drop-up', up);
  list.style.position  = 'fixed';
  list.style.left      = wrap.left + 'px';
  list.style.width     = wrap.width + 'px';
  list.style.right     = 'auto';
  list.style.bottom    = 'auto';
  list.style.top       = (up ? r.top - AC_GAP - h : r.bottom + AC_GAP) + 'px';
  list.style.maxHeight = h + 'px';
  // The field itself has scrolled out of sight, or there is not room for one row.
  const fieldGone = r.bottom < vTop || r.top > vBot;
  list.style.visibility = fieldGone || room < AC_MIN_ROOM ? 'hidden' : '';
}

// Re-place an open list whenever anything moves under it: the keyboard, the
// visual viewport panning, or a panel scrolling (capture catches every
// scrolling element, not just the window). Returns the re-placer.
//
// `reflow.settle()` keeps re-placing every frame for a short while. The
// keyboard slides in over ~300 ms and neither platform promises an event at
// the END of it, so a single measurement taken part way through can find no
// room, hide the list — and nothing moves it again until the tech drags the
// screen, which is exactly the "pull down to make the parts list appear"
// report from the field.
const AC_SETTLE_MS = 1000;

function watchAcList(input, list) {
  const reflow = () => { if (list.classList.contains('open')) placeAcList(input, list); };
  let until = 0;
  const tick = () => { reflow(); if (performance.now() < until) requestAnimationFrame(tick); };
  reflow.settle = () => {
    const idle = performance.now() >= until;
    until = performance.now() + AC_SETTLE_MS;
    if (idle) requestAnimationFrame(tick);
  };
  window.visualViewport?.addEventListener('resize', reflow.settle);
  window.visualViewport?.addEventListener('scroll', reflow);
  window.addEventListener('resize', reflow.settle);
  document.addEventListener('scroll', reflow, true);
  return reflow;
}

// Keep the field the tech is typing in above the keyboard. The keyboard's
// arrival is a visualViewport resize — there is no event for it — and on
// Android it lands late enough that scrolling on focus alone does nothing.
function keepInputVisible(input) {
  const vv = window.visualViewport;
  if (!vv) { input.scrollIntoView({ block: 'center' }); return; }
  const r = input.getBoundingClientRect();
  if (r.bottom > vv.offsetTop + vv.height - 8 || r.top < vv.offsetTop + 8) {
    input.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

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
    placeAcList(input, list);
  }

  // While a list is open the keyboard may still be animating in, which moves
  // the input under it. Re-place on every viewport change rather than trusting
  // the measurement taken at the moment of opening.
  const reflow = watchAcList(input, list);

  input.addEventListener('input',  () => showList(input.value));
  input.addEventListener('focus',  () => {
    input.select();
    showList(input.value);
    reflow.settle();
    // Late enough for the keyboard to have started coming up.
    setTimeout(() => { keepInputVisible(input); reflow.settle(); }, 300);
  });
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
  renderPartSetBar();
  markPickingField();
  if (_detailStep) { renderDetailPicker(); return; }
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

// ── Brand, type and length from buttons ─────────────────────────────────────
// A ladder we have never seen needs its brand, type and length for BSI. Typing
// them meant a keyboard and a suggestion list fighting for half a phone screen.
// Instead the part buttons are borrowed: brands, then types, then lengths, one
// tap each, and the parts come back when it is done. "Type it" is there for
// anything not offered, and Skip leaves a field blank — leaving them blank is
// still the tech's call.
let _detailStep = null;    // 'brand' | 'type' | 'length' | null
const DETAIL_STEPS = [
  { key: 'brand',  field: 'fi-brand',  label: 'Brand',  options: () => BRAND_OPTIONS },
  { key: 'type',   field: 'fi-type',   label: 'Type',   options: () => TYPE_OPTIONS },
  { key: 'length', field: 'fi-length', label: 'Length', options: () => lengthOptions($('fi-type').value) },
];
// Extension-style ladders are long; step-style ones are short.
function lengthOptions(type) {
  return /extension|straight|hook/i.test(type || '')
    ? ['8', '10', '12', '14', '16', '20', '24', '28', '32', '36', '40']
    : ['2', '3', '4', '5', '6', '7', '8', '10', '12', '14', '16', '20'];
}

// Rings the field the picker is filling and points its placeholder at the
// buttons, so the tech can see which box the next tap lands in.
function markPickingField() {
  DETAIL_STEPS.forEach(s => {
    const el = $(s.field);
    if (!el) return;
    const on = s.key === _detailStep;
    el.classList.toggle('picking', on);
    if (el.dataset.ph === undefined) el.dataset.ph = el.placeholder;
    el.placeholder = on ? 'Pick below ↓' : el.dataset.ph;
  });
}

function startDetailPicker() {
  _detailStep = 'brand';
  const a = document.activeElement;
  if (a && typeof a.blur === 'function') a.blur();
  renderPartButtons();
}
function endDetailPicker() {
  if (!_detailStep) return;
  _detailStep = null;
  renderPartButtons();
}
function detailStepAfter(key) {
  const i = DETAIL_STEPS.findIndex(s => s.key === key);
  return DETAIL_STEPS[i + 1] ? DETAIL_STEPS[i + 1].key : null;
}
function detailPick(step, value) {
  const el = $(step.field);
  el.value = value;
  delete el.dataset.src;              // chosen by the tech: his own value
  _detailStep = detailStepAfter(step.key);
  renderPartButtons();
}

function renderDetailPicker() {
  const step = DETAIL_STEPS.find(s => s.key === _detailStep);
  const grid = $('parts-grid');
  grid.innerHTML = '';
  const current = $(step.field).value.trim().toLowerCase();
  step.options().forEach(o => {
    const btn = document.createElement('button');
    btn.className = 'part-btn detail-btn' + (o.toLowerCase() === current ? ' active' : '');
    btn.textContent = step.key === 'length' ? o + ' ft' : o;
    btn.addEventListener('click', () => detailPick(step, o));
    grid.appendChild(btn);
  });
  // Not on the list: the field itself, with the keyboard.
  const own = document.createElement('button');
  own.className = 'part-btn detail-btn other';
  own.textContent = 'Type it…';
  own.addEventListener('click', () => { const el = $(step.field); _detailStep = null; renderPartButtons(); el.focus(); });
  grid.appendChild(own);
}

// One tap between favourite sets, right above the buttons. Hidden while there
// is only Main. While brand/type/length are being picked it is the picker's
// header instead: which step, Back, Skip, Done.
function renderPartSetBar() {
  const bar = $('part-set-bar');
  if (!bar) return;
  bar.innerHTML = '';
  if (_detailStep) {
    const i = DETAIL_STEPS.findIndex(s => s.key === _detailStep);
    const title = document.createElement('span');
    title.className = 'detail-step';
    title.textContent = `${DETAIL_STEPS[i].label} · ${i + 1} of ${DETAIL_STEPS.length}`;
    bar.appendChild(title);
    const mk = (text, fn) => {
      const b = document.createElement('button');
      b.className = 'part-set-chip';
      b.textContent = text;
      b.addEventListener('click', fn);
      bar.appendChild(b);
    };
    if (i > 0) mk('‹ Back', () => { _detailStep = DETAIL_STEPS[i - 1].key; renderPartButtons(); });
    mk('Skip', () => { _detailStep = detailStepAfter(_detailStep); renderPartButtons(); });
    mk('Parts ›', endDetailPicker);
    return;
  }
  const sets = listPartSets();
  if (sets.length < 2) return;
  const active = activePartSet();
  sets.forEach(s => {
    const b = document.createElement('button');
    b.className = 'part-set-chip' + (s.id === active ? ' active' : '');
    b.textContent = s.name;
    b.addEventListener('click', () => usePartSet(s.id));
    bar.appendChild(b);
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
// Add, then straight back to the camera for the next ladder. If the add was
// refused — no serial, no work order — the camera stays shut so the tech sees
// why.
//
// The add must not focus the serial field: that raises the keyboard in the
// same tap that asks for the camera, and on a phone the two fight over the
// screen.
$('btn-add-next').addEventListener('click', () => {
  if (_editingIdx >= 0) return;
  if (!addLadder({ focus: false })) return;
  const a = document.activeElement;
  if (a && typeof a.blur === 'function') a.blur();
  startScan();
});

// ── Add & Duplicate ─────────────────────────────────────────────────────────
// A rack of identical ladders getting identical parts. The ladder on the form
// is added, the camera opens and STAYS open, and every new barcode it reads is
// added as another ladder with the same parts. Done (the scanner's cancel
// button) ends it and opens the last ladder added, for editing.
//
// What carries is the parts — the thing being duplicated. Brand, type and
// length come from the lookup exactly as for a typed or scanned serial, so a
// ladder we know keeps its own record. The four flags are never carried.
let _ladderBatch = null;   // { parts: Map, added, busy, seen }

function ladderBatchActive() { return !!_ladderBatch; }

$('btn-add-dup').addEventListener('click', () => {
  if (_editingIdx >= 0 || _ladderBatch) return;
  const parts = new Map(_currentParts);
  if (!addLadder({ focus: false, keepParts: true })) return;
  const a = document.activeElement;
  if (a && typeof a.blur === 'function') a.blur();
  _ladderBatch = { parts, added: 1, busy: false, seen: _job.ladders[0].serialNum };
  $('btn-scan-cancel').textContent = 'Done';
  // Without a live camera the OS photo picker reads one barcode, and
  // ladderBatchScanned ends the run after it.
  Promise.resolve(startScan()).then(live => {
    if (live && _ladderBatch) batchHint(`Added ${_ladderBatch.seen} — scan the next ladder`);
  });
});

function batchHint(text, warn) {
  const h = $('scan-hint');
  if (!h) return;
  h.textContent = text;
  h.classList.toggle('warn', !!warn);
}

// The online lookup has no deadline of its own; a rack is not held up for a
// slow signal. Whatever the device knows is in by then anyway.
const BATCH_LOOKUP_WAIT_MS = 2500;

async function ladderBatchScanned(value) {
  const b = _ladderBatch;
  const sn = String(value || '').trim();
  if (!b || b.busy || !sn) return;
  // The decoder reads the same barcode every 400 ms while it is in view.
  // Say so once, not every tick.
  if (_job.ladders.some(l => ladderKey(l.serialNum) === ladderKey(sn))) {
    if (b.seen !== sn) { b.seen = sn; playSound('scanFail'); batchHint(`${sn} is already on this job — scan the next one`, true); }
    return;
  }
  b.seen = sn;
  // A misread is not added on a run nobody is looking at the form during.
  if (/\D/.test(sn)) {
    playSound('scanFail');
    batchHint(`Read “${sn}” — not a ladder serial. Rescan, or add it by hand after.`, true);
    return;
  }
  b.busy = true;
  try {
    $('fi-serial').value = sn;
    updateSerialWarnState();
    await Promise.race([lookupLadder(sn), new Promise(r => setTimeout(r, BATCH_LOOKUP_WAIT_MS))]);
    if (_ladderBatch !== b) return;                      // Done tapped meanwhile
    _currentParts = new Map(b.parts);
    if (addLadder({ focus: false, keepParts: true })) {
      b.added++;
      batchHint(`Added ${sn} — ${b.added} ladders so far. Scan the next, or Done.`);
      if (typeof _scanFailCount !== 'undefined') _scanFailCount = 0;
    } else {
      batchHint(`${sn} was not added`, true);
    }
  } finally {
    b.busy = false;
  }
  // Photo fallback: there is no viewfinder to keep open.
  if (typeof _scanStream !== 'undefined' && !_scanStream && _ladderBatch === b) endLadderBatch();
}

function endLadderBatch() {
  const b = _ladderBatch;
  _ladderBatch = null;
  $('btn-scan-cancel').textContent = 'Cancel';
  if (typeof stopScan === 'function') stopScan();
  if (!b) return;
  // The last one scanned, open for editing — it is at the top of the list.
  if (b.added > 0 && _job && _job.ladders && _job.ladders.length) editLadder(0);
}
$('btn-cancel-edit').addEventListener('click', cancelEdit);

function setEditMode(editing) {
  $('btn-add-ladder').textContent = editing ? 'Save Edits' : '+ Add Ladder';
  $('btn-cancel-edit').style.display = editing ? 'block' : 'none';
  $('btn-add-next').style.display = editing ? 'none' : '';
  $('btn-add-dup').style.display = editing ? 'none' : '';
  endDetailPicker();
}

// ── What we know about a scanned serial ─────────────────────────────────────
// A ladder that has EVER been inspected is already in BSI with its brand, type
// and length, so the serial alone is enough to record it. One that never has
// needs those details. The tech knows which is which better than we do; the
// point of looking it up is to tell him, and to fill in what we have so he does
// not type it again. Leaving the details blank is his call either way — the
// ladder is always added.
//
// Three places, cheapest first:
//   · the device catalogue — every ladder the account had at the last sync
//   · this phone's own jobs — inspected here and not yet synced back down
//   · the database, when online — inspected since this phone last synced
//
// The server's details are preferred — over whatever carried over from the
// previous ladder (a rack is usually one model, so they carry over on purpose)
// and over anything an earlier scan filled in. The one thing they never replace
// is a field the tech edited himself for this ladder: that is him fixing it,
// and it goes up and corrects the record.
//
// Each field says where its value came from, in data-src:
//   auto   — filled by a lookup
//   carry  — left over from the previous ladder
//   (none) — typed by the tech
// A hit fills every field that is empty, auto or carry. A miss clears only
// auto values — they belonged to a different serial — and keeps the rest.
const LOOKUP_FIELDS = [['fi-brand', 'brand'], ['fi-type', 'type'], ['fi-length', 'length']];

function lookupLadder(serial) {
  const sn = String(serial || '').trim();
  // Editing a ladder already in the list: its fields are what the tech entered
  // for it, and a lookup must not quietly replace them.
  if (_editingIdx >= 0) return Promise.resolve(null);
  if (!sn) { showLadderLookup(null); return Promise.resolve(null); }
  const fromCache = window.LiaCache
    ? window.LiaCache.findBySerial(sn, 'ladder').catch(() => null)
    : Promise.resolve(null);
  return fromCache
    .then(hit => hit ? { brand: hit.brand, type: hit.ladder_type, length: hit.length,
                         last: hit.last_inspected } : null)
    .then(hit => hit || ladderOnThisPhone(sn))
    .then(hit => hit || ladderOnline(sn))
    .then(hit => {
      if ($('fi-serial').value.trim() !== sn) return null;    // moved on already
      LOOKUP_FIELDS.forEach(([id, key]) => {
        const el = $(id);
        const mine = el.value.trim() && !el.dataset.src;
        if (hit && hit[key] && !mine) { el.value = hit[key]; el.dataset.src = 'auto'; }
        else if (!hit && el.dataset.src === 'auto') { el.value = ''; delete el.dataset.src; }
      });
      showLadderLookup(hit ? 'hit' : 'miss', hit);
      return hit;
    })
    .catch(() => { showLadderLookup(null); return null; });
}

// Typing in one of them makes it the tech's own value.
LOOKUP_FIELDS.forEach(([id]) => $(id).addEventListener('input', () => { delete $(id).dataset.src; }));

// A typed serial is looked up exactly like a scanned one, once he has finished
// typing it — on leaving the field or pressing Enter, not on every keystroke.
$('fi-serial').addEventListener('change', () => lookupLadder($('fi-serial').value));

function ladderKey(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// The most recent record of this serial in any job on the phone.
function ladderOnThisPhone(sn) {
  const k = ladderKey(sn);
  let best = null;
  Object.values(loadJobs()).forEach(job => (job.ladders || []).forEach(l => {
    if (ladderKey(l.serialNum) !== k) return;
    if (!best || String(l.capturedAt || '') > String(best.capturedAt || '')) best = l;
  }));
  return best ? { brand: best.brand, type: best.type, length: best.length,
                  last: String(best.capturedAt || '').slice(0, 10) } : null;
}

// Offline is the normal state on a job site, so this is a bonus, never a wait:
// no connection, no client, or any error is simply "not found".
function ladderOnline(sn) {
  const sync = window.LiaSync;
  if (!sync || (typeof navigator !== 'undefined' && navigator.onLine === false)) return Promise.resolve(null);
  return sync.client().then(sb => {
    if (!sb) return null;
    return sb.from('ladder_inspections_public')
      .select('brand, type, length, inspection_date')
      .eq('serial_key', ladderKey(sn))
      .order('inspection_date', { ascending: false })
      .limit(1)
      .then(r => {
        const row = r && !r.error && r.data && r.data[0];
        return row ? { brand: row.brand, type: row.type, length: row.length, last: row.inspection_date } : null;
      });
  }).catch(() => null);
}

function showLadderLookup(state, hit) {
  const el = $('fi-lookup');
  if (!el) return;
  // The picker is for a serial nobody knows. A known one, or the next ladder,
  // puts the parts back.
  if (state !== 'miss') endDetailPicker();
  if (!state) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = '';
  el.className = 'ladder-lookup ' + state;
  if (state === 'hit') {
    const what = [hit.brand, hit.type, hit.length ? hit.length + ' ft' : '']
      .filter(Boolean).join(' · ');
    el.textContent = 'Inspected before' + (hit.last ? ` (${hit.last})` : '') +
      (what ? ': ' + what : '') + '. BSI already has its details — the serial is enough.';
  } else {
    el.textContent = 'Never inspected that we know of — BSI will need its brand, type and length. ';
    const pick = document.createElement('button');
    pick.className = 'lookup-pick';
    pick.id = 'btn-pick-details';
    pick.textContent = 'Pick brand, type & length';
    pick.addEventListener('click', startDetailPicker);
    el.appendChild(pick);
  }
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
  const isFp = jobScope(job) === 'fall_protection';
  // Read before anything below clears the screen: it is what this job had in
  // hand when it was last left, or when the app died.
  const inProgress = job && job.fpInProgress;
  // Any run belonged to the job being left, whatever the new one is.
  if (typeof fpBatchStop === 'function') fpBatchStop(false);
  ['form-panel', 'parts-panel', 'add-btn-panel', 'recent-panel']
    .forEach(id => { const el = $(id); if (el) el.style.display = isFp ? 'none' : ''; });
  // fp.js decides which of its own panels are showing, since that depends on
  // whether an item is currently in hand.
  const fpInput = $('fp-input-panel');
  if (fpInput) fpInput.style.display = isFp ? '' : 'none';
  if (!isFp) {
    ['fp-record', 'fp-edit-form', 'fp-checks-panel', 'fp-save-panel', 'fp-items-panel',
     'fp-batch-panel']
      .forEach(id => { const el = $(id); if (el) el.style.display = 'none'; });
  } else if (typeof fpReset === 'function') {
    fpReset();
    if (inProgress && typeof fpRecover === 'function') fpRecover(inProgress);
    // Items passed with details missing: try their sheets again.
    if (typeof fpMineAll === 'function') fpMineAll();
  }
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


// ── Uploading a ladder ──────────────────────────────────────────────────────
// Ladders were captured locally and never sent. The queue has always known how
// (sendOne handles 'ladder'), the server has always had record_inspection, and
// the office's Merge Field Work screen reads exactly what this produces — but
// nothing ever enqueued one, so a tech's ladders reached the office only as a
// CSV somebody remembered to hand over.
//
// The record is saved on the device first and queued second, as everywhere
// else: local is the truth, the upload is a copy.
function ladderPayload(l) {
  const f = l.flags || {};
  return {
    serial_num:    l.serialNum,
    work_order_id: (_job && _job.workOrderNum) || undefined,
    brand:         l.brand || undefined,
    type:          l.type || undefined,
    length:        l.length || undefined,
    notes:         l.desc || undefined,
    // What the office bills the job on. Without these a field record imports
    // into BSI as a ladder with no line items.
    parts:         (l.parts && l.parts.length) ? l.parts : undefined,
    source:        'field',
    captured_at:   l.capturedAt || new Date().toISOString(),
    // Null means "not asked", which is not the same as false. Only a decision
    // the tech actually made is sent.
    lubricated:  f.lubricated === null || f.lubricated === undefined ? undefined : !!f.lubricated,
    has_leveler: f.leveler    === null || f.leveler    === undefined ? undefined : !!f.leveler,
    has_claw:    f.claw       === null || f.claw       === undefined ? undefined : !!f.claw,
    has_vrung:   f.vrung      === null || f.vrung      === undefined ? undefined : !!f.vrung,
  };
}

// Every ladder in this job, sent again with the work order now attached.
function requeueJobLadders() {
  const sync = window.LiaSync;
  if (!sync || !_job || !(_job.ladders || []).length) return;
  const state = window.LiaSyncState;
  (_job.ladders || []).forEach((l) => {
    if (!l.serialNum) return;
    if (state) state.markUnsent(l.id);     // the server holds a copy with no WO
    sync.enqueue({ clientId: l.id, kind: 'ladder', payload: ladderPayload(l) });
  });
  if (typeof renderLadderList === 'function') renderLadderList();
}

function queueLadder(l) {
  const sync = window.LiaSync;
  if (!sync || !l || !l.serialNum) return;
  // A work order is NOT required. It is what the office matches the day's work
  // on, so a record without one is harder to place later — but holding the
  // record hostage until somebody types it meant a tech who filled it in at
  // the end of the job uploaded nothing all morning, and could not tell why.
  //
  // It goes up now, and re-queues itself if a work order arrives later.
  sync.enqueue({ clientId: l.id, kind: 'ladder', payload: ladderPayload(l) });
  if (typeof renderPending === 'function') renderPending();
}

// A work order is optional on a phone that only logs locally — the CSV carries
// everything and the tech knows which job it was. Once signed in it is
// REQUIRED before the first ladder: the record goes to the company's account
// the moment it is captured, and one without a work order is work nobody can
// place afterwards. Better to ask for it now than to find it unattached later.
function needsWorkOrder() {
  if (_job && _job.workOrderNum) return false;
  if (_job && _job.assignedId) return false;          // the lead set it
  const st = window.LiaSyncState;
  return !!(st && st.syncingNow && st.syncingNow());
}

function demandWorkOrder() {
  const el = $('job-wo');
  if (!el) return;
  el.focus();
  el.style.borderColor = 'var(--err)';
  setTimeout(() => { el.style.borderColor = ''; }, 2000);
  setSaveStatus('Enter the work order number first — signed in, your work uploads to the company and needs one to be placed.');
}

// opts.focus: false when the camera opens next (see btn-add-next).
// opts.keepParts: the parts stay on the form for the next ladder.
function addLadder(opts) {
  const o = opts || {};
  const serial = $('fi-serial').value.trim();
  if (needsWorkOrder()) { demandWorkOrder(); return false; }
  if (!serial) {
    const el = $('fi-serial');
    el.focus(); el.style.borderColor = 'var(--err)';
    setTimeout(() => { el.style.borderColor = ''; }, 1200);
    return false;
  }
  if (!_job.ladders) _job.ladders = [];
  const added = buildLadderFromForm();
  added.capturedAt = new Date().toISOString();
  _job.ladders.unshift(added);
  queueLadder(added);
  clearEntryForm(!!o.keepParts);
  renderLadderList();
  scheduleSave();
  playSound('ladder');
  if (o.focus !== false) $('fi-serial').focus();
  return true;
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
  const edited = buildLadderFromForm(existingId);
  edited.capturedAt = _job.ladders[_editingIdx]?.capturedAt || new Date().toISOString();
  _job.ladders[_editingIdx] = edited;
  // An edit is sent again. record_inspection supersedes rather than
  // duplicating, so the corrected version becomes current and the old one
  // stays in the history where a correction belongs.
  if (window.LiaSyncState) window.LiaSyncState.markUnsent(edited.id);
  queueLadder(edited);
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


// ── Getting the keyboard back out of the way ────────────────────────────────
// A phone keyboard covers half the screen and has no visible dismiss. On a
// screen whose whole point is the list underneath, that is the difference
// between "I can see my work" and "I cannot".
(function keyboardDone() {
  const panel = document.getElementById('form-panel');
  const done = document.getElementById('btn-entry-done');
  if (!panel || !done) return;

  const show = () => { done.style.display = ''; };
  const hide = () => { done.style.display = 'none'; };

  panel.addEventListener('focusin', (e) => {
    if (e.target && e.target.matches('input, textarea')) show();
  });
  // Deferred: focus moving between two fields fires focusout before focusin,
  // and hiding the button between them makes it flicker on every tab.
  panel.addEventListener('focusout', () => setTimeout(() => {
    const a = document.activeElement;
    if (!a || !panel.contains(a) || !a.matches('input, textarea')) hide();
  }, 60));

  done.addEventListener('click', () => {
    const a = document.activeElement;
    if (a && typeof a.blur === 'function') a.blur();
    hide();
    // Scroll the list back into view: Android leaves the page where the
    // keyboard pushed it.
    const list = document.getElementById('ladders-list');
    if (list) list.scrollIntoView({ block: 'nearest' });
  });
})();
