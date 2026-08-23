// Lia Field — fp.js
//
// Fall protection capture. Built around what the tech actually does: he grabs
// the item, inspects it visually in one go, and moves on. So the screen is a
// RECORD TO VERIFY, not a form to fill — every check starts at Pass, and the
// only thing that costs more than two taps is a defective item.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step.

// Checks come from the model's published checklist. Until that syncs down, this
// is the fallback set — a harness/lanyard baseline. `impact` is only asked for
// models that have an indicator, which the catalogue records.
const FP_DEFAULT_CHECKS = [
  { code: 'labels',   prompt: 'Labels and markings present, secured and legible' },
  { code: 'impact',   prompt: 'Impact indicator not activated', needsIndicator: true },
  { code: 'webbing',  prompt: 'Webbing free of cuts, fraying, chemical damage' },
  { code: 'stitch',   prompt: 'Stitching intact, no pulled or broken threads' },
  { code: 'hardware', prompt: 'Hardware free of cracks, corrosion and distortion' },
  { code: 'buckles',  prompt: 'D-rings and buckles operate correctly' },
];

const FP_FIELDS = [
  { key: 'manufacturer', label: 'Manufacturer' },
  { key: 'model',        label: 'Model' },
  { key: 'item_type',    label: 'Item type' },
  { key: 'lot_number',   label: 'Lot #' },
  { key: 'mfg_month',    label: 'Mfg month', inputmode: 'numeric' },
  { key: 'mfg_year',     label: 'Mfg year',  inputmode: 'numeric' },
  { key: 'description',  label: 'Description' },
];

// The item being captured. Null between items.
let _fpItem = null;
let _fpChecks = [];
let _fpEditing = false;

function fpReset() {
  _fpItem = null;
  _fpChecks = [];
  _fpEditing = false;
  const t = $('fp-typed-row'); if (t) t.style.display = 'none';
  const i = $('fp-serial-input'); if (i) i.value = '';
  fpRenderAll();
}

// Everything below the input bar only exists once an item is in hand.
function fpRenderAll() {
  const has = !!_fpItem;
  ['fp-record', 'fp-checks-panel', 'fp-save-panel'].forEach(id => {
    const el = $(id); if (el) el.style.display = has ? '' : 'none';
  });
  const ef = $('fp-edit-form');
  if (ef) ef.style.display = has && _fpEditing ? '' : 'none';
  const rec = $('fp-record');
  if (rec) rec.style.display = has && !_fpEditing ? '' : 'none';
  const items = $('fp-items-panel');
  if (items) items.style.display = has ? 'none' : '';

  if (has) { fpRenderRecord(); fpRenderEditForm(); fpRenderChecks(); fpRenderSave(); }
  else fpRenderItems();
}

const fpMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fpMfg(m, y) {
  if (!y) return '';
  return m ? `${fpMonths[Number(m) - 1] || m} ${y}` : String(y);
}

function fpRow(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<div class="fp-kv"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;
}

function fpRenderRecord() {
  const el = $('fp-record');
  if (!el || !_fpItem) return;
  const it = _fpItem;
  el.className = it.matched ? 'matched' : '';
  el.innerHTML = `
    <div class="fp-rec-hdr">
      <span class="fp-rec-tag">${it.matched ? 'Matched — inspected before' : 'First inspection for this item'}</span>
      <button class="fp-rec-edit" id="fp-btn-edit">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>Edit
      </button>
    </div>
    <div class="fp-rec-body">
      <div style="margin-bottom:4px;">
        <span class="fp-rec-sn">${esc(it.serial_raw || '')}</span>
        <span class="fp-rec-sub">${esc([it.manufacturer, it.model].filter(Boolean).join(' '))}</span>
      </div>
      ${fpRow('Item type', it.item_type)}
      ${fpRow('Description', it.description)}
      ${fpRow('Lot #', it.lot_number)}
      ${fpRow('Manufactured', fpMfg(it.mfg_month, it.mfg_year))}
      ${fpRow('Last inspected', it.last_inspected)}
      ${fpRow('Rep #', it.rep_number)}
      ${fpRow('Tag', it.nfc_tag_uid)}
    </div>`;
  const btn = $('fp-btn-edit');
  if (btn) btn.addEventListener('click', () => { _fpEditing = true; fpRenderAll(); });
}

function fpRenderEditForm() {
  const el = $('fp-edit-form');
  if (!el || !_fpItem) return;
  const it = _fpItem;
  el.innerHTML = `
    <div class="field-ig">
      <div class="field-label">Serial #</div>
      <div class="field-ig-wrap"><input type="text" class="field-input" id="fpf-serial"
        value="${esc(it.serial_raw || '')}" autocomplete="off" autocapitalize="characters"></div>
    </div>
    ${FP_FIELDS.map(f => `
      <div class="field-ig">
        <div class="field-label">${esc(f.label)}</div>
        <div class="field-ig-wrap"><input type="text" class="field-input" id="fpf-${f.key}"
          value="${esc(it[f.key] == null ? '' : it[f.key])}" autocomplete="off"
          ${f.inputmode ? `inputmode="${f.inputmode}"` : ''}></div>
      </div>`).join('')}
    <button class="btn-p" id="fp-btn-done-edit" style="margin-top:4px;padding:11px;font-size:14px;">Done</button>`;

  const done = $('fp-btn-done-edit');
  if (done) done.addEventListener('click', () => {
    const sn = $('fpf-serial');
    if (sn) _fpItem.serial_raw = sn.value.trim();
    FP_FIELDS.forEach(f => {
      const i = $('fpf-' + f.key);
      if (i) _fpItem[f.key] = i.value.trim();
    });
    _fpEditing = false;
    // Editing the model can change which checks apply.
    fpBuildChecks();
    fpRenderAll();
  });
}

// Everything starts at Pass. The tech only touches a check to fail it.
function fpBuildChecks() {
  const hasIndicator = _fpItem && _fpItem.has_impact_indicator !== false;
  _fpChecks = FP_DEFAULT_CHECKS
    .filter(c => !c.needsIndicator || hasIndicator)
    .map(c => ({ code: c.code, prompt: c.prompt, result: true }));
}

function fpRenderChecks() {
  const el = $('fp-checks-list');
  if (!el) return;
  el.innerHTML = '';
  _fpChecks.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'fp-chk' + (c.result === false ? ' failed' : '');
    row.innerHTML = `
      <div class="fp-chk-q">${esc(c.prompt)}</div>
      <div class="fp-seg">
        <button class="${c.result === true ? 'on-pass' : ''}" data-r="pass">Pass</button>
        <button class="${c.result === false ? 'on-fail' : ''}" data-r="fail">Fail</button>
      </div>`;
    row.querySelectorAll('[data-r]').forEach(b => {
      b.addEventListener('click', () => {
        _fpChecks[i].result = b.dataset.r === 'pass';
        fpRenderChecks();
        fpRenderSave();
      });
    });
    el.appendChild(row);
  });
}

// The overall result is derived from the checks — the tech never sets it. The
// database computes it the same way, so the two cannot disagree.
function fpOverallPass() {
  return !_fpChecks.some(c => c.result === false);
}

function fpRenderSave() {
  const pass = fpOverallPass();
  const o = $('fp-overall');
  if (o) {
    o.innerHTML = pass
      ? `<span class="dot" style="background:var(--ok);"></span>Overall <strong style="color:var(--ok-fg);">PASS</strong> · next due ${esc(fpNextDue())}`
      : `<span class="dot" style="background:var(--bad);"></span><span style="color:var(--bad-fg);">Overall <strong>FAIL</strong> — one check failed</span>`;
  }
  const b = $('fp-btn-save');
  if (b) {
    b.className = 'add-ladder-btn' + (pass ? '' : ' fail');
    b.textContent = pass ? 'Pass & Next Item' : 'Add Photo & Remove →';
  }
}

function fpToday() { return new Date().toISOString().split('T')[0]; }
function fpNextDue() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
}

// ── Getting an item in hand ─────────────────────────────────────────────────

function fpHint(msg, warn) {
  const h = $('fp-hint');
  if (!h) return;
  h.textContent = msg || '';
  h.className = 'fp-hint' + (warn ? ' warn' : '');
}

function fpAdopt(rec, matched) {
  _fpItem = Object.assign({}, rec, { matched: !!matched });
  _fpEditing = false;
  fpBuildChecks();
  fpHint('');
  fpRenderAll();
}

function fpBlank(serial) {
  fpAdopt({
    serial_raw: serial || '', manufacturer: '', model: '', item_type: '',
    lot_number: '', mfg_month: '', mfg_year: '', description: '',
  }, false);
  // A new item has nothing to verify, so open straight into the fields.
  _fpEditing = true;
  fpRenderAll();
}

// A miss is a normal outcome, not an error: it means a first inspection.
function fpLookup(value) {
  const v = String(value || '').trim();
  if (!v) return;
  fpHint('Looking up…');
  const finder = root => root.find(v, 'fall_protection');
  finder(window.LiaCache).then(hit => {
    if (hit) fpAdopt(hit, true);
    else {
      fpHint('Not on file — entering it now means it comes up filled in next time.');
      fpBlank(v);
    }
  }).catch(() => {
    fpHint('Could not read the on-device catalogue.', true);
    fpBlank(v);
  });
}

// ── Saving ──────────────────────────────────────────────────────────────────

function fpSave() {
  if (!_job || !_fpItem) return;
  const serial = String(_fpItem.serial_raw || '').trim();
  if (!serial) {
    _fpEditing = true;
    fpRenderAll();
    fpHint('A serial number is required.', true);
    return;
  }

  const pass = fpOverallPass();
  const item = {
    id: crypto.randomUUID(),
    kind: 'fall_protection',
    serial_num: serial,
    manufacturer: _fpItem.manufacturer || '',
    model: _fpItem.model || '',
    item_type: _fpItem.item_type || '',
    description: _fpItem.description || '',
    lot_number: _fpItem.lot_number || '',
    mfg_month: _fpItem.mfg_month || '',
    mfg_year: _fpItem.mfg_year || '',
    nfc_tag_serial: _fpItem.nfc_tag_uid || '',
    inspection_date: fpToday(),
    next_due_date: fpNextDue(),
    overall_pass: pass,
    // Deliberately not sent: discard_reason. The database composes it from the
    // checks that failed, so a certificate always matches what actually failed.
    checks: _fpChecks.map((c, i) => ({ ord: i, code: c.code, prompt: c.prompt, result: c.result })),
    capturedAt: new Date().toISOString(),
  };

  if (!pass) {
    // A defective item needs a photo before it can be recorded. Reason comes
    // from the failed checks; a note is offered and never demanded.
    fpOpenCondemn(item);
    return;
  }
  fpCommit(item);
}

function fpCommit(item) {
  _job.items = _job.items || [];
  _job.items.unshift(item);
  // saveNow, not scheduleSave: a completed inspection — checks, and possibly a
  // photo — is not a keystroke. The 800 ms debounce is right for typing and
  // wrong here; backgrounding the app inside that window would lose the record.
  saveNow();
  playSound('ladder');
  fpReset();
}

function fpRenderItems() {
  const list = $('fp-items-list');
  const hdr = $('fp-items-hdr');
  if (!list) return;
  const items = (_job && _job.items) || [];
  if (hdr) hdr.textContent = `Items (${items.length})`;
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<div class="parts-empty-msg">No items yet — tap, scan or add one.</div>';
    return;
  }
  items.forEach(it => {
    const card = document.createElement('div');
    card.className = 'fp-item' + (it.overall_pass ? '' : ' failed');
    const sub = [it.manufacturer, it.model, it.item_type].filter(Boolean).join(' · ');
    card.innerHTML = `
      <div class="fp-item-top">
        <span class="fp-item-sn">${esc(it.serial_num)}</span>
        <span class="fp-item-meta">${esc(sub)}</span>
        <span class="fp-item-badge ${it.overall_pass ? 'pass' : 'fail'}">${it.overall_pass ? 'PASS' : 'REMOVED'}</span>
      </div>
      <div class="fp-item-meta">${esc(it.overall_pass
        ? `Due ${it.next_due_date}`
        : it.checks.filter(c => c.result === false).map(c => c.prompt).join('; '))}</div>`;
    list.appendChild(card);
  });
}

// ── Wiring ──────────────────────────────────────────────────────────────────

(function fpWire() {
  const tap = $('fp-btn-tap');
  if (tap) tap.addEventListener('click', () => {
    // NFC is native-only; the sheet lands in the NFC phase.
    if (!window.LiaNfc) { fpHint('Tag reading needs the installed app — scan or type instead.', true); return; }
    window.LiaNfc.read().then(uid => fpLookup(uid)).catch(() => fpHint('No tag read.', true));
  });

  const scan = $('fp-btn-scan');
  if (scan) scan.addEventListener('click', () => {
    // Reuses the ladder scanner; it writes into #fi-serial, so read it back.
    window._fpAwaitScan = true;
    startScan();
  });

  const type = $('fp-btn-type');
  if (type) type.addEventListener('click', () => {
    const row = $('fp-typed-row');
    if (!row) return;
    row.style.display = row.style.display === 'none' ? 'flex' : 'none';
    if (row.style.display === 'flex') $('fp-serial-input').focus();
  });

  const lookup = $('fp-btn-lookup');
  if (lookup) lookup.addEventListener('click', () => fpLookup($('fp-serial-input').value));
  const input = $('fp-serial-input');
  if (input) input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); fpLookup(input.value); }
  });

  const nw = $('fp-btn-new');
  if (nw) nw.addEventListener('click', () => { fpHint(''); fpBlank(''); });

  const save = $('fp-btn-save');
  if (save) save.addEventListener('click', fpSave);
})();

// ── Removal from service ────────────────────────────────────────────────────
// A defective item is the only thing that costs the tech more than two taps,
// and even then he does not type why: the check he failed IS the reason, shown
// back to him. A photo is required; a note is offered and never demanded.

let _fpPending = null;   // the item awaiting a photo
let _fpPhoto = null;     // { dataUrl, bytes, capturedAt }

// Phones produce 3–12 MP images. Downscale before storing — a truck's worth of
// full-size photos would blow past the storage budget and take minutes to
// upload over LTE.
function fpDownscale(file, maxPx, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo.')); };
    img.src = url;
  });
}

function fpOpenCondemn(item) {
  _fpPending = item;
  _fpPhoto = null;
  const failed = item.checks.filter(c => c.result === false).map(c => c.prompt);
  const why = $('fp-condemn-why');
  if (why) {
    why.innerHTML = `<strong style="color:var(--bad-fg);">${esc(item.serial_num)}</strong> failed: ` +
                    esc(failed.join('; ')) +
                    '. This item must be destroyed or returned, not put back in service.';
  }
  const note = $('fp-condemn-note'); if (note) note.value = '';
  fpRenderPhoto();
  $('fp-condemn-sheet').classList.remove('hidden');
  $('sheet-backdrop').classList.remove('hidden');
}

function fpCloseCondemn() {
  $('fp-condemn-sheet').classList.add('hidden');
  $('sheet-backdrop').classList.add('hidden');
}

function fpRenderPhoto() {
  const row = $('fp-photo-row');
  if (!row) return;
  const add = $('fp-btn-photo');
  [...row.querySelectorAll('.fp-photo-thumb')].forEach(e => e.remove());
  if (_fpPhoto) {
    const img = document.createElement('img');
    img.className = 'fp-photo-thumb';
    img.src = _fpPhoto.dataUrl;
    row.insertBefore(img, add);
    if (add) add.querySelector('span').textContent = 'Retake';
  } else if (add) {
    add.querySelector('span').textContent = 'Add photo';
  }
  const confirm = $('fp-btn-confirm-condemn');
  if (confirm) {
    confirm.disabled = !_fpPhoto;
    confirm.style.opacity = _fpPhoto ? '' : '.45';
  }
}

(function fpWireCondemn() {
  const btn = $('fp-btn-photo');
  const input = $('fp-photo-input');
  if (btn && input) btn.addEventListener('click', () => input.click());
  if (input) input.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    fpDownscale(file, 1600, 0.7).then(dataUrl => {
      _fpPhoto = { dataUrl: dataUrl, bytes: Math.round(dataUrl.length * 0.75), capturedAt: new Date().toISOString() };
      fpRenderPhoto();
    }).catch(() => fpHint('Could not read that photo.', true));
  });

  const cancel = $('fp-btn-cancel-condemn');
  if (cancel) cancel.addEventListener('click', () => { _fpPending = null; _fpPhoto = null; fpCloseCondemn(); });

  const confirm = $('fp-btn-confirm-condemn');
  if (confirm) confirm.addEventListener('click', () => {
    if (!_fpPending || !_fpPhoto) return;   // the photo is the gate
    const note = $('fp-condemn-note');
    _fpPending.discard_note = note ? note.value.trim() : '';
    _fpPending.photo = _fpPhoto;
    fpCloseCondemn();
    fpCommit(_fpPending);
    _fpPending = null;
    _fpPhoto = null;
  });
})();
