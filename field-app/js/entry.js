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
// again on every visualViewport change while a list is open, so the list moves
// when the keyboard does.
function placeAcList(input, list) {
  const vv  = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  const bot = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const r   = input.getBoundingClientRect();

  const below = bot - r.bottom - 8;
  const above = r.top - top - 8;
  const want  = Math.min(list.scrollHeight || 180, 180);

  const up = below < want && above > below;
  list.classList.toggle('drop-up', up);
  // Never taller than the space it is in, and never so short it is useless:
  // at 88px two rows show and the list scrolls, which beats a list that is
  // present but clipped to nothing.
  list.style.maxHeight = Math.max(88, Math.min(180, up ? above : below)) + 'px';
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
  const reflow = () => { if (list.classList.contains('open')) placeAcList(input, list); };
  window.visualViewport?.addEventListener('resize', reflow);
  window.visualViewport?.addEventListener('scroll', reflow);

  input.addEventListener('input',  () => showList(input.value));
  input.addEventListener('focus',  () => {
    input.select();
    showList(input.value);
    // Late enough for the keyboard to have started coming up.
    setTimeout(() => { keepInputVisible(input); reflow(); }, 300);
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
  const isFp = jobScope(job) === 'fall_protection';
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

function addLadder() {
  const serial = $('fi-serial').value.trim();
  if (needsWorkOrder()) { demandWorkOrder(); return; }
  if (!serial) {
    const el = $('fi-serial');
    el.focus(); el.style.borderColor = 'var(--err)';
    setTimeout(() => { el.style.borderColor = ''; }, 1200);
    return;
  }
  if (!_job.ladders) _job.ladders = [];
  const added = buildLadderFromForm();
  added.capturedAt = new Date().toISOString();
  _job.ladders.unshift(added);
  queueLadder(added);
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
