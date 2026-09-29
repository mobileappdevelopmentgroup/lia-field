// Lia Field — fp.js
//
// Fall protection capture. Built around what the tech actually does: he grabs
// the item, inspects it visually in one go, and moves on. So the screen is a
// RECORD TO VERIFY, not a form to fill — every check starts at its PASSING
// answer, and the only thing that costs more than two taps is a defective item.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step.

// The checks come from the item's EQUIPMENT TYPE — see js/fp-types.js. Not
// every type has the same pass/fail parameters, so the type is what decides
// which questions get asked, and it has to be picked before there is a
// checklist to show.
//
// A model may carry its own list that overrides its type's; that comes down in
// the synced catalogue like everything else.

// Equipment type is a PICKER, not a text field. The checklist is selected by
// it, so "lanyard" vs "lanyards" typed by hand would quietly produce the wrong
// questions on a safety record.
const FP_FIELDS = [
  { key: 'equipment_type', label: 'Equipment type', type: 'select' },
  { key: 'manufacturer',   label: 'Manufacturer' },
  { key: 'model',          label: 'Model' },
  { key: 'lot_number',     label: 'Lot #' },
  { key: 'mfg_month',      label: 'Mfg month', inputmode: 'numeric', placeholder: 'MM' },
  { key: 'mfg_year',       label: 'Mfg year',  inputmode: 'numeric', placeholder: 'YYYY' },
  { key: 'description',    label: 'Description' },
];

function fpTypes() { return window.LiaFpTypes; }

// The item being captured. Null between items.
let _fpItem = null;
let _fpChecks = [];
let _fpEditing = false;

// A tap-through run, or null. See the batch section at the bottom of this file.
let _fpBatch = null;

// Which job the item on screen belongs to. Opening another job must never write
// this one's item into it.
let _fpItemJob = null;

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
  // In a run the item on screen is passed by the next tap, so there is no save
  // button — until the tech presses Fail, when it becomes the removal.
  const batch = !!_fpBatch;
  const failing = batch && _fpBatch.failing;
  ['fp-record', 'fp-checks-panel'].forEach(id => {
    const el = $(id); if (el) el.style.display = has ? '' : 'none';
  });
  const sp = $('fp-save-panel');
  if (sp) sp.style.display = has && (!batch || failing) ? '' : 'none';
  const fc = $('fp-btn-fail-cancel');
  if (fc) fc.style.display = failing ? '' : 'none';
  const ef = $('fp-edit-form');
  if (ef) ef.style.display = has && _fpEditing ? '' : 'none';
  const rec = $('fp-record');
  if (rec) rec.style.display = has && !_fpEditing ? '' : 'none';
  const items = $('fp-items-panel');
  if (items) items.style.display = has ? 'none' : '';

  const inp = $('fp-input-panel');
  if (inp) inp.style.display = batch ? 'none' : '';
  const bp = $('fp-batch-panel');
  if (bp) bp.style.display = batch ? '' : 'none';

  if (batch) fpRenderBatch();
  if (has) { fpRenderRecord(); fpRenderEditForm(); fpRenderChecks(); fpRenderSave(); }
  else { fpRenderItems(); fpRenderPending(); }
  fpPersist();
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
      ${fpCanWriteTag() ? `<button class="fp-rec-write" id="fp-btn-write-tag">${
        it.tag_label || it.nfc_tag_uid ? 'Re-tag' : 'Write tag'}</button>` : ''}
    </div>
    <div class="fp-rec-body">
      <div style="margin-bottom:4px;">
        <span class="fp-rec-sn">${esc(it.serial_raw || '')}</span>
        <span class="fp-rec-sub">${esc([it.manufacturer, it.model].filter(Boolean).join(' '))}</span>
      </div>
      ${fpRow('Equipment type', (fpCurrentType() || {}).name || it.item_type)}
      ${fpRow('Description', it.description)}
      ${fpRow('Lot #', it.lot_number)}
      ${fpRow('Manufactured', fpMfg(it.mfg_month, it.mfg_year))}
      ${fpRow('Last inspected', it.last_inspected)}
      ${fpRow('Rep #', it.rep_number)}
      ${fpRow('Tag label', it.tag_label)}
      ${fpRow('Tag chip', it.nfc_tag_uid)}
      ${it.tag_url ? `<div class="fp-kv"><span class="k">Tag link</span>
        <span class="v fp-rec-link">${esc(it.tag_url)}</span></div>` : ''}
      ${it.suggested_type ? `<div class="fp-kv"><span class="k">Type claimed by link</span>
        <span class="v">${esc(it.suggested_type)} — pick the equipment type to confirm</span></div>` : ''}
    </div>`;
  const btn = $('fp-btn-edit');
  if (btn) btn.addEventListener('click', () => {
    if (_fpBatch && !_fpBatch.failing) return fpBatchEdit();
    _fpEditing = true; fpRenderAll();
  });
  const wt = $('fp-btn-write-tag');
  if (wt) wt.addEventListener('click', () => fpOpenWriteSheet());
}

// ── Writing a tag ───────────────────────────────────────────────────────────
// Our own tag, onto this item. Five identifiers end up pointing at one record —
// serial, printed label, chip id, certificate code, link — and the point is
// that a tech finds it holding any of them. See supabase/17_tag_write.sql.

function fpCanWriteTag() {
  // An item with no certificate code has never reached the server, so there is
  // no durable identifier to put on a tag yet. Offering the button would end in
  // a tag pointing at nothing.
  return !!(window.LiaTagWrite && window.LiaNfc && window.LiaNfc.canWrite
            && window.LiaNfc.canWrite() && _fpItem && _fpItem.public_ref);
}

function fpOpenWriteSheet() {
  if (!_fpItem) return;
  $('tw-sheet').classList.remove('hidden');
  $('sheet-backdrop').classList.remove('hidden');
  const input = $('tw-label');
  input.value = _fpItem.tag_label || '';
  $('tw-btn-write').disabled = false;
  $('tw-btn-write').textContent = 'Hold phone to tag';
  fpRenderWriteSheet();
  input.oninput = fpRenderWriteSheet;
}

function fpCloseWriteSheet() {
  $('tw-sheet').classList.add('hidden');
  $('sheet-backdrop').classList.add('hidden');
}

function fpRenderWriteSheet() {
  if (!_fpItem) return;
  const label = ($('tw-label').value || '').trim();
  const plan = window.LiaTagWrite.plan(_fpItem, label);

  $('tw-ttl').textContent = plan.retag ? 'Replace this tag' : 'Write tag';
  $('tw-desc').textContent = plan.retag
    // A re-tag is not a mistake, but it must never be silent: the old tag is
    // still physically on the equipment until somebody removes it.
    ? 'This item already has a tag. Writing a new one replaces it — take the old tag off the equipment.'
    : 'Everything below is written to the tag. Check it before you touch the phone to it.';

  $('tw-preview').innerHTML =
    `Serial <b>${esc(plan.serial_num || '—')}</b><br>` +
    `Label <b>${esc(plan.tag_label || '— none —')}</b><br>` +
    `Link <b>${esc(plan.url || '—')}</b>`;

  const warn = $('tw-warn');
  warn.style.display = 'none';
  warn.className = 'tw-warn';

  if (!label) {
    warn.style.display = '';
    warn.textContent = 'No label. The tag will still work, but nobody can look this item up ' +
      'by reading it — type whatever is printed on the tag face.';
    return;
  }

  // Checked against this phone's own catalogue, which catches the common
  // mistake — re-using a label off the same rack — without needing signal.
  window.LiaTagWrite.labelClash(label, _fpItem.asset_id).then(hit => {
    if (!hit || ($('tw-label').value || '').trim() !== label) return;
    warn.style.display = '';
    warn.className = 'tw-warn err';
    warn.textContent = `Label ${label} is already on ${hit.serial_raw || 'another item'}. ` +
      'Two items with one label means the wrong certificate comes up.';
  });
}

function fpWriteTag() {
  if (!_fpItem) return;
  const label = ($('tw-label').value || '').trim();
  const btn = $('tw-btn-write');
  const warn = $('tw-warn');
  btn.disabled = true;
  btn.textContent = 'Hold the phone against the tag…';

  window.LiaTagWrite.write(_fpItem, label).then(res => {
    // The device already believes it — LiaTagWrite.write updates the cache — so
    // the item on screen has to say the same thing, or the tech sees the old
    // label and writes it again.
    if (res.entry.tag_label) _fpItem.tag_label = res.entry.tag_label;
    if (res.entry.nfc_tag_uid) _fpItem.nfc_tag_uid = res.entry.nfc_tag_uid;
    _fpItem.tag_url = res.entry.tag_url;
    fpCloseWriteSheet();
    fpRenderRecord();
    // Same confirmation sound the app uses for a captured item — a tech holding
    // a phone against a harness in a plant room is not looking at the screen.
    if (typeof playSound === 'function') playSound('ladder');
  }).catch(err => {
    btn.disabled = false;
    // Closing Apple's sheet is the tech changing his mind; put the sheet back
    // the way it was rather than dressing it up as a failure.
    if (err && err.code === 'NFC_CANCELLED') {
      btn.textContent = 'Hold phone to tag';
      warn.style.display = 'none';
      return;
    }
    btn.textContent = 'Try again';
    warn.style.display = '';
    warn.className = 'tw-warn err';
    warn.textContent = (err && err.message) || 'Could not write to that tag.';
  });
}

(function wireWriteSheet() {
  const w = $('tw-btn-write');
  if (w) w.addEventListener('click', fpWriteTag);
  const c = $('tw-btn-cancel');
  if (c) c.addEventListener('click', fpCloseWriteSheet);
})();

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
        <div class="field-ig-wrap">${f.type === 'select'
          ? fpTypeSelectHtml('fpf-' + f.key, fpCurrentType())
          : `<input type="text" class="field-input" id="fpf-${f.key}"
               value="${esc(it[f.key] == null ? '' : it[f.key])}" autocomplete="off"
               ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}
               ${f.inputmode ? `inputmode="${f.inputmode}"` : ''}>`}</div>
      </div>`).join('')}
    <button class="btn-p" id="fp-btn-done-edit" style="margin-top:4px;padding:11px;font-size:14px;">Done</button>`;

  // Changing the type changes the questions, so the checks are rebuilt as soon
  // as it is picked rather than waiting for Done.
  const sel = $('fpf-equipment_type');
  if (sel) sel.addEventListener('change', () => {
    _fpItem.equipment_type = sel.value;
    const t = fpTypes().bySlug(sel.value);
    _fpItem.item_type = t ? t.name : '';
    fpBuildChecks();
    fpRenderChecks();
    fpRenderSave();
  });

  const done = $('fp-btn-done-edit');
  if (done) done.addEventListener('click', () => {
    fpApplyEditForm();
    // Back to listening, if the form is what stopped it (iOS).
    if (_fpBatch && !_fpBatch.failing) {
      const why = fpBatchMissing(_fpItem);
      fpBatchHint(why ? `Still ${why} — this one will be skipped unless you add it.`
                      : 'Inspecting. Tap the next item to pass it, or press Fail.', !!why);
      return fpBatchResume();
    }
    fpRenderAll();
  });
}

// Takes what is in the fields onto the item and closes them. Also called when a
// tap arrives mid-edit in a run: that tap is the tech moving on, and what he had
// typed is what he meant.
function fpApplyEditForm() {
  if (!_fpItem || !_fpEditing) return;
  const sn = $('fpf-serial');
  if (sn) _fpItem.serial_raw = sn.value.trim();
  FP_FIELDS.forEach(f => {
    const i = $('fpf-' + f.key);
    if (i) _fpItem[f.key] = i.value.trim();
  });
  const t = fpTypes().bySlug(_fpItem.equipment_type || '');
  if (t) _fpItem.item_type = t.name;
  _fpEditing = false;
  // Changing the type — or the model, which may carry its own list — changes
  // which checks apply.
  fpBuildChecks();
}

// One option per type the account has. Sorted as the catalogue orders them, so
// the list reads the same on every phone.
function fpTypeSelectHtml(id, current) {
  const opts = fpTypes().all().map(t =>
    `<option value="${esc(t.slug)}"${current && current.slug === t.slug ? ' selected' : ''}>${esc(t.name)}</option>`
  ).join('');
  return `<select class="field-input" id="${esc(id)}">` +
         `<option value=""${current ? '' : ' selected'}>Select a type…</option>` +
         opts + '</select>';
}

// Everything starts at its PASSING answer — which is not always "yes". The tech
// only touches a check to fail it.
function fpBuildChecks() {
  const t = fpCurrentType();
  _fpChecks = t ? fpTypes().startingAnswers(t) : [];
}

// The type the item is being inspected as. Resolved from the picker, falling
// back to whatever free text a pre-existing record carried.
function fpCurrentType() {
  if (!_fpItem) return null;
  return fpTypes().byKey(_fpItem.equipment_type || _fpItem.item_type || '');
}

function fpRenderChecks() {
  const el = $('fp-checks-list');
  if (!el) return;
  el.innerHTML = '';

  const hdr = $('fp-checks-label');
  const t = fpCurrentType();
  if (hdr) hdr.textContent = t ? `Checks — ${t.name}` : 'Checks';

  if (!_fpChecks.length) {
    el.innerHTML = '<div class="parts-empty-msg">Pick an equipment type to see its checks.</div>';
    return;
  }

  // In a run the checks are what the next tap records, and they only open when
  // the tech says the item failed.
  const locked = !!_fpBatch && !_fpBatch.failing;
  const note = document.querySelector('#fp-checks-panel .fp-checks-note');
  if (note) note.textContent = !_fpBatch ? 'All pass unless you say otherwise'
    : locked ? 'Passes on the next tap' : 'Tap what failed';

  _fpChecks.forEach((c, i) => {
    const failed = c.answer != null && !fpTypes().isPass(c);
    // The two buttons are the two ANSWERS, in their own words. A yes/no
    // question answered "Pass" would be nonsense, and "has the impact
    // indicator been activated? — Yes" is a fail, not a pass.
    const yes = fpTypes().labelFor(c, true);
    const no  = fpTypes().labelFor(c, false);
    const cls = a => (c.answer === a ? (a === c.pass_answer ? 'on-pass' : 'on-fail') : '');
    const row = document.createElement('div');
    row.className = 'fp-chk' + (failed ? ' failed' : '');
    row.innerHTML = `
      <div class="fp-chk-q">${esc(c.prompt)}</div>
      <div class="fp-seg">
        <button class="${cls(true)}"  data-a="1"${locked ? ' disabled' : ''}>${esc(yes)}</button>
        <button class="${cls(false)}" data-a="0"${locked ? ' disabled' : ''}>${esc(no)}</button>
      </div>`;
    row.querySelectorAll('[data-a]').forEach(b => {
      b.addEventListener('click', () => {
        _fpChecks[i].answer = b.dataset.a === '1';
        fpRenderChecks();
        fpRenderSave();
        fpPersist();
      });
    });
    el.appendChild(row);
  });
}

// The overall assessment is DERIVED — the tech never sets it, and there is no
// control for it anywhere on the screen. It passes only when every check
// passes. record_fp_inspection computes it the same way from the same answers,
// so the certificate can never disagree with what was recorded.
function fpOverallPass() {
  return _fpChecks.length > 0 && fpTypes().overallPass(_fpChecks);
}

// Which checks failed, by prompt — the reason an item is being removed.
function fpFailedPrompts(checks) {
  return (checks || []).filter(c => c.answer != null && c.answer !== c.pass_answer)
                       .map(c => c.prompt);
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
    // Failing a run's item: nothing to save until a check is marked failed.
    const waiting = pass && !!_fpBatch && _fpBatch.failing;
    b.className = 'add-ladder-btn' + (pass && !waiting ? '' : ' fail');
    b.textContent = waiting ? 'Tap what failed ↑' : pass ? 'Pass & Next Item' : 'Add Photo & Remove →';
    b.disabled = waiting;
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
  _fpItemJob = _job ? _job.id : null;
  _fpEditing = false;
  fpBuildChecks();
  fpHint('');
  fpRenderAll();
}

function fpBlank(serial) {
  fpAdopt({
    serial_raw: serial || '', manufacturer: '', model: '',
    equipment_type: '', item_type: '',
    lot_number: '', mfg_month: '', mfg_year: '', description: '',
  }, false);
  // A new item has nothing to verify, so open straight into the fields.
  _fpEditing = true;
  fpRenderAll();
}

// A miss is a normal outcome, not an error: it means a first inspection.
// A tag can hand back up to four ways in — the serial in its text record, its
// hardware uid, the certificate code in its URL, and the URL itself — and only
// one of them may be the one this account's catalogue knows the item by. Try
// each in turn.
//
// What a miss falls back to ENTERING is a separate question, and getting it
// wrong is how a wrong serial ends up on a safety record. Only a serial the
// tech could have read off the item goes into the serial field; a hardware uid
// and a hyperlink are identifiers of the tag, not of the equipment, so they are
// carried on the record but never typed into it as a serial.
function fpLookup(value, alsoTry, tag) {
  const candidates = [value].concat(alsoTry || [])
    .map(v => String(v || '').trim())
    .filter((v, i, a) => v && a.indexOf(v) === i);
  if (!candidates.length && !(tag && tag.url)) {
    // A tap that yields nothing must say so. Returning silently left the hint
    // on "Hold the phone against the tag…" after the tag had been read.
    if (tag) fpHint('That tag gave nothing to look up. Scan or type the serial instead.', true);
    return;
  }
  fpHint('Looking up…');

  const step = i => i >= candidates.length
    ? Promise.resolve(null)
    : window.LiaCache.find(candidates[i], 'fall_protection')
        .then(hit => hit || step(i + 1));

  // Nothing on this device: ask the server, exactly as a tap-through run does.
  const online = () => fpLookupOnline({
    serial: tag ? tag.serial : fpSerialCandidate(candidates, tag),
    ref: tag && tag.ref, url: tag && tag.url, uid: tag && tag.uid,
  });

  step(0).then(hit => hit || online()).then(hit => {
    if (hit) { fpAdopt(hit, true); fpAttachTag(tag); return; }
    // One of this account's own blank tags. Its chip carries a Google Sheet
    // link, which would otherwise read as somebody else's tag below.
    const blank = fpStockFor(candidates, tag);
    if (blank) return fpStartFromStock(blank, tag);
    // The tag carried somebody else's link and nothing on this device matched
    // it. That is the third-party-tag case and it gets its own path rather than
    // dropping into a blank form with a URL where the serial goes.
    if (fpTagIsForeign(tag)) return fpUnmatchedLink(tag);
    fpHint('Not on file — entering it now means it comes up filled in next time.');
    fpBlank(fpSerialCandidate(candidates, tag));
    fpAttachTag(tag);
  }).catch(() => {
    fpHint('Could not read the on-device catalogue.', true);
    fpBlank(fpSerialCandidate(candidates, tag));
    fpAttachTag(tag);
  });
}

// What is safe to pre-fill the serial box with. A typed or scanned value, or a
// tag's own text record — those are the equipment's serial. A hardware uid or a
// URL is not, and pre-filling one produces a record whose serial number is a
// string nobody can find on the item.
function fpSerialCandidate(candidates, tag) {
  if (tag) return String(tag.serial || '').trim();
  const first = candidates[0] || '';
  return window.LiaTagLink && window.LiaTagLink.isUrl(first) ? '' : first;
}

// ── One of our own blank tags ────────────────────────────────────────────────
// The lead's tags come printed and programmed (tag-stock.js). One that is on
// nothing yet identifies no item, so a tap on it starts a NEW item with the tag
// already attached: the printed number and the link both go on the record, and
// the server takes the tag out of stock when the inspection lands.
//
// The link is tried first, then whatever was typed or read, each only as what
// it is — see LiaTagStock.find.
function fpStockFor(candidates, tag) {
  const st = window.LiaTagStock;
  if (!st) return null;
  const vals = [tag && tag.url].concat(candidates || []);
  for (const v of vals) {
    const hit = v ? st.find(v) : null;
    if (hit) return hit;
  }
  return null;
}

function fpStockHint(blank) {
  return `${blank.tag_label} is one of your blank tags, not on anything yet. ` +
         `Enter the item you are putting it on. No serial on the item? Use ${blank.tag_label}.`;
}

// Only a serial read off the tag's own text record goes in the serial box —
// never the printed number: that belongs to the tag, and the tech decides
// whether the item has a serial of its own.
function fpStartFromStock(blank, tag) {
  fpBlank(tag ? String(tag.serial || '').trim() : '');
  fpAttachTag(tag);
  _fpItem.tag_label = blank.tag_label;
  if (!_fpItem.tag_url) _fpItem.tag_url = blank.tag_url || '';
  fpHint(fpStockHint(blank));
  fpRenderAll();
}

// Is this link somebody else's? A certificate link is ours: it carries a
// public_ref, resolves through the catalogue, and points at a page of our own —
// so there is nothing to fetch and no decision to put to the tech. One that
// missed just means the item is not on this device, which is the ordinary
// "not on file" outcome and has its own handling.
//
// parseRecords sets `foreign` directly; the fallback is for callers that hand
// us a bare {url, uid} — the batch stream's own tests among them.
function fpTagIsForeign(res) {
  if (!res || !res.url) return false;
  if (typeof res.foreign === 'boolean') return res.foreign;
  const tl = window.LiaTagLink;
  return !res.ref && !(tl && tl.refFrom(res.url));
}

// Everything a tag told us, hung on the item so it reaches the record whether
// or not it was what resolved the lookup. The link is the point: "record the
// hyperlink that was read" has to hold even when the read matched cleanly.
function fpAttachTag(tag) {
  if (!tag || !_fpItem) return;
  if (tag.uid) _fpItem.nfc_tag_uid = _fpItem.nfc_tag_uid || tag.uid;
  if (tag.url) _fpItem.tag_url = tag.url;
  fpRenderAll();
}

// ── A tag whose link matched nothing ────────────────────────────────────────
// The customer's existing rack is tagged by whoever supplied it. Those tags
// carry a link into somebody else's system and nothing this account has ever
// seen — no serial we know, no certificate code. Which means the tech is
// standing there holding an item the app cannot name.
//
// What must NOT happen: the app inventing an identifier (the hardware uid, or
// the URL) and putting it in the serial field, or refusing to move and leaving
// him stuck. So: the link is recorded either way, the app tries to read it, and
// the tech decides what the item is.
//
// On what comes back — see the header of tag-link.js. A fetched row is an
// unverified claim by whoever last wrote the tag, so it is shown as a claim,
// stored as an external record stamped with its source URL, and never allowed
// to stand in for an inspection.

let _fpLink = null;   // { tag, state, result, external }

function fpUnmatchedLink(tag) {
  const tl = window.LiaTagLink;
  _fpLink = { tag: tag, state: 'fetching', result: null, external: null };
  fpOpenLinkSheet();

  if (!tl) {
    _fpLink.state = 'nothing';
    fpRenderLinkSheet();
    return Promise.resolve();
  }

  return tl.fetch(tag.url).then(res => {
    if (!_fpLink || _fpLink.tag !== tag) return;   // the tech moved on
    _fpLink.result = res;

    if (!res.ok) { _fpLink.state = 'nothing'; fpRenderLinkSheet(); return; }
    const rec = res.records && res.records[0];
    if (!rec) { _fpLink.state = 'nothing'; fpRenderLinkSheet(); return; }

    _fpLink.external = rec;
    _fpLink.state = 'found';

    // The sheet may name an identifier this account already knows — a tech
    // handed a rack whose items were registered here, with the supplier's tags
    // still on them. That is a match, and it is worth far more than the fetched
    // row: it is our own record, and it turns an unresolvable tag into a
    // resolved one.
    //
    // Both the serial and the tag id are tried, because on the real sheets the
    // Serial Number field is frequently blank and the tag id ('FP158354') is the
    // only identifier present — and it is a code printed on the tag, so it is
    // one a tech could have typed and one this catalogue could hold.
    const ids = tl.identifiers(rec);
    if (!ids.length) { fpRenderLinkSheet(); return; }
    const tryId = i => i >= ids.length
      ? Promise.resolve(null)
      : window.LiaCache.findBySerial(ids[i], 'fall_protection').then(h => h || tryId(i + 1));
    return tryId(0).then(hit => {
      if (!_fpLink || _fpLink.tag !== tag) return;
      if (hit) { _fpLink.state = 'resolved'; _fpLink.hit = hit; }
      fpRenderLinkSheet();
    }).catch(() => fpRenderLinkSheet());
  }).catch(() => {
    // fetch() resolves rather than rejects on every expected outcome, so
    // landing here means something unforeseen — which still must not be a
    // dead end for the tech.
    if (!_fpLink || _fpLink.tag !== tag) return;
    _fpLink.state = 'nothing';
    fpRenderLinkSheet();
  });
}

function fpOpenLinkSheet() {
  const sheet = $('fp-link-sheet');
  const back = $('sheet-backdrop');
  if (sheet) sheet.classList.remove('hidden');
  if (back) back.classList.remove('hidden');
  fpRenderLinkSheet();
}

function fpCloseLinkSheet() {
  const sheet = $('fp-link-sheet');
  const back = $('sheet-backdrop');
  if (sheet) sheet.classList.add('hidden');
  if (back) back.classList.add('hidden');
}

function fpLinkVerdict(rec) {
  if (rec.overall_pass === true) return '<span class="fp-link-v pass">PASSED</span>';
  if (rec.overall_pass === false) return '<span class="fp-link-v fail">FAILED</span>';
  return rec.result_text
    ? `<span class="fp-link-v unk">${esc(rec.result_text)}</span>`
    : '<span class="fp-link-v unk">no verdict</span>';
}

function fpRenderLinkSheet() {
  const body = $('fp-link-body');
  const title = $('fp-link-ttl');
  if (!body || !_fpLink) return;
  const tag = _fpLink.tag;
  const url = tag.url || '';

  // The link, always and first. It is the one thing the tech can act on with no
  // help from us — read it off the phone, open it, call whoever owns it.
  let html = `<div class="fp-link-url">${esc(url)}</div>`;

  if (_fpLink.state === 'fetching') {
    if (title) title.textContent = 'Tag not on file';
    html += '<div class="fp-hint">Reading the link…</div>';
    body.innerHTML = html;
    fpLinkButtons(false);
    return;
  }

  if (_fpLink.state === 'nothing') {
    if (title) title.textContent = 'Tag not on file';
    const res = _fpLink.result;
    const why = (res && res.error) || 'The tag’s link could not be read from this device.';
    html += `<div class="fp-hint warn">${esc(why)}</div>`;
    // Naming the host is what lets whoever runs this account decide to trust it.
    // A generic "couldn't fetch" gives them nothing to act on.
    if (res && res.code === 'HOST_NOT_ALLOWED' && res.host) {
      html += `<div class="fp-hint">Nothing is fetched from a source that has not been ` +
              `trusted. The link is recorded either way.</div>`;
    }
    html += '<div class="fp-hint">The link is saved with whatever you record. ' +
            'Inspect the item, or set it aside.</div>';
    body.innerHTML = html;
    fpLinkButtons(true);
    return;
  }

  const rec = _fpLink.external;
  const hit = _fpLink.hit;

  if (_fpLink.state === 'resolved' && hit) {
    if (title) title.textContent = 'Matched by serial';
    html += `<div class="fp-hint">The link named <strong>${esc(rec.serial)}</strong>, ` +
            `which is on file here. Opening that record.</div>`;
    body.innerHTML = html;
    fpLinkButtons(true);
    return;
  }

  if (title) title.textContent = 'Tag not on file';

  // Every named field, then whatever columns we could not map — those are kept
  // verbatim rather than dropped. A column we failed to understand is still
  // something the tech can read, and silently discarding it would be worse than
  // not having fetched at all.
  const rows = [
    fpRow('Tag ID', rec.tag_id),
    fpRow('Serial', rec.serial),
    fpRow('Last inspected', rec.inspection_date || rec.inspection_date_raw),
    // The verdict is a chip, not text, so it does not go through fpRow — which
    // escapes its value, as every other record on this screen needs it to.
    `<div class="fp-kv"><span class="k">Result</span><span class="v">${fpLinkVerdict(rec)}</span></div>`,
    fpRow('Currency', rec.status_text),
    fpRow('Type', rec.item_type),
    fpRow('Description', rec.description),
    fpRow('Manufacturer', rec.manufacturer),
    fpRow('Model', rec.model),
    fpRow('Lot #', rec.lot_number),
    fpRow('Manufactured', rec.mfg_date || rec.mfg_date_raw),
    fpRow('Next due', rec.next_due_date || rec.next_due_raw),
    fpRow('Inspector', rec.inspector),
    fpRow('Notes', rec.notes),
  ].concat(
    Object.keys(rec.extra || {}).map(k => fpRow(k, rec.extra[k]))
  ).join('');

  // The component checks off the other system's form. Shown because they are
  // the most useful thing on the sheet for a tech about to look at the item —
  // and labelled as theirs, because our own checklist comes from the equipment
  // type and these do not feed it.
  const checks = (rec.checks || []).length
    ? `<div class="fp-link-checks">
         <div class="fp-link-claim-hdr">Their checklist</div>
         ${rec.checks.map(c => `<div class="fp-kv"><span class="k">${esc(c.prompt)}</span>
           <span class="v ${c.result === false ? 'fp-link-v fail' : ''}">${esc(c.answer)}</span></div>`).join('')}
       </div>`
    : '';

  // Phrased as a claim throughout. It is one: an unauthenticated row from a URL
  // written by somebody we cannot identify.
  html += `<div class="fp-link-claim">
    <div class="fp-link-claim-hdr">Claimed by the tag’s link — unverified</div>
    <div class="fp-link-rows">${rows}</div>
    ${checks}
  </div>`;

  html += '<div class="fp-hint">Nothing here counts as an inspection. Inspect the ' +
          'item to record one; what the link claims is kept alongside it.</div>';
  body.innerHTML = html;
  fpLinkButtons(true);
}

function fpLinkButtons(enabled) {
  ['fp-btn-link-inspect', 'fp-btn-link-save', 'fp-btn-link-ignore'].forEach(id => {
    const b = $(id);
    if (b) b.disabled = !enabled;
  });
  const ins = $('fp-btn-link-inspect');
  if (ins && _fpLink) {
    ins.textContent = _fpLink.state === 'resolved' ? 'Open the record' : 'Inspect this item';
  }
}

// "Inspect this item" — the ordinary screen, carrying the link and whatever the
// fetch claimed. A claimed serial or model pre-fills the form because retyping
// what is already on screen is exactly the work this app exists to remove; the
// tech is looking at the item and corrects anything wrong.
function fpLinkInspect() {
  if (!_fpLink) return;
  const tag = _fpLink.tag;
  const rec = _fpLink.external;
  fpCloseLinkSheet();

  if (_fpLink.state === 'resolved' && _fpLink.hit) {
    fpAdopt(_fpLink.hit, true);
    fpAttachTag(tag);
    fpStageExternal(rec, tag);
    _fpLink = null;
    return;
  }

  if (rec) {
    fpAdopt({
      // The sheet's own Serial Number when it has one, otherwise the tag id
      // printed on the tag — which on these forms is usually the only
      // identifier there is, and is what a tech reading the item would give.
      // Never the hardware uid: that is not written anywhere he can see.
      serial_raw: rec.serial || rec.tag_id || '',
      manufacturer: rec.manufacturer || '',
      model: rec.model || '',
      equipment_type: '',
      // Free text off somebody else's sheet is never trusted to select a
      // checklist — fpCurrentType() would resolve it by name and silently pick
      // the questions a safety record is judged against. It is shown as a
      // suggestion in the type picker's place and the tech picks the type.
      item_type: '',
      suggested_type: rec.item_type || '',
      lot_number: rec.lot_number || '',
      mfg_month: '', mfg_year: '',
      description: rec.description || rec.notes || '',
      last_inspected: rec.inspection_date || rec.inspection_date_raw || '',
    }, false);
    _fpEditing = true;
  } else {
    fpBlank('');
  }
  fpAttachTag(tag);
  fpStageExternal(rec, tag);
  fpHint(rec
    ? 'From the tag’s link, unverified — check it against the item and pick a type.'
    : 'Tag not on file and its link could not be read. Enter what is on the item.', !rec);
  _fpLink = null;
  fpRenderAll();
}

// The claimed row rides along with the item so it is uploaded as history beside
// the real inspection — never as one.
function fpStageExternal(rec, tag) {
  if (!_fpItem) return;
  _fpItem.tag_url = (tag && tag.url) || _fpItem.tag_url || '';
  if (!rec) return;
  _fpItem.external = {
    source_url: (tag && tag.url) || '',
    fetched_at: new Date().toISOString(),
    claimed: rec,
  };
}

// "Save link only" — the tech is not inspecting this one now, but the pairing of
// tag to link is worth keeping: next time anyone taps it, it resolves. This is
// the "record the hyperlink and move on" outcome.
function fpLinkSaveOnly() {
  if (!_fpLink || !_job) return;
  fpQueueTagLink(_fpLink.tag, _fpLink.external || null);
  fpCloseLinkSheet();
  fpHint('Link saved. Nothing was recorded as an inspection.');
  _fpLink = null;
  fpLinkDone();
}

// Keeps the pairing of a tag to its link without recording an inspection, so
// the next tap on it resolves. Also what a tap-through run does with an item
// it had to skip.
function fpQueueTagLink(tag, claimed) {
  if (!_job || !tag || !tag.url) return;
  const entry = {
    id: crypto.randomUUID(),
    kind: 'fp_tag_link',
    tag_url: tag.url || '',
    nfc_tag_serial: tag.uid || '',
    public_ref: tag.ref || '',
    serial_num: String(tag.serial || '').trim(),
    work_order_id: (_job && _job.workOrderNum) || null,
    claimed: claimed || null,
    fetched_at: claimed ? new Date().toISOString() : null,
    capturedAt: new Date().toISOString(),
  };
  _job.tagLinks = _job.tagLinks || [];
  _job.tagLinks.unshift(entry);
  saveNow();

  if (root_LiaSync()) {
    root_LiaSync().enqueue({
      clientId: entry.id,
      kind: 'fp_tag_link',
      payload: fpTagLinkPayload(entry),
    });
  }
}

function fpTagLinkPayload(entry) {
  return {
    tag_url: entry.tag_url || null,
    nfc_tag_serial: entry.nfc_tag_serial || null,
    public_ref: entry.public_ref || null,
    serial_num: entry.serial_num || null,
    work_order_id: entry.work_order_id || null,
    claimed: entry.claimed || null,
    fetched_at: entry.fetched_at || null,
    captured_at: entry.capturedAt,
  };
}

function fpLinkIgnore() {
  fpCloseLinkSheet();
  _fpLink = null;
  fpHint('Skipped.');
  fpLinkDone();
}

// A run that was paused for this decision picks back up; a single tap just
// returns to the input bar.
function fpLinkDone() {
  if (_fpBatch && !_fpItem) fpBatchResume();
  else fpRenderAll();
}

(function fpLinkWire() {
  const ins = $('fp-btn-link-inspect');
  if (ins) ins.addEventListener('click', fpLinkInspect);
  const save = $('fp-btn-link-save');
  if (save) save.addEventListener('click', fpLinkSaveOnly);
  const ign = $('fp-btn-link-ignore');
  if (ign) ign.addEventListener('click', fpLinkIgnore);
})();

// ── Saving ──────────────────────────────────────────────────────────────────

// One shape, built the same way whether the tech answered the checks himself or
// tapped through a rack he had already inspected. `source` is the only thing
// that differs, and it is recorded rather than inferred — see fpToPayload.
function fpMakeItem(rec, type, checks, source) {
  return {
    id: crypto.randomUUID(),
    kind: 'fall_protection',
    serial_num: String(rec.serial_raw || '').trim(),
    manufacturer: rec.manufacturer || '',
    model: rec.model || '',
    equipment_type: type.slug,
    item_type: type.name,
    // The checklist version this was performed against. A tech works offline
    // all day and the list may be republished meanwhile; pinning it is what
    // keeps the record valid rather than retroactively incomplete.
    template_id: type.template_id || null,
    description: rec.description || '',
    lot_number: rec.lot_number || '',
    mfg_month: rec.mfg_month || '',
    mfg_year: rec.mfg_year || '',
    nfc_tag_serial: rec.nfc_tag_uid || '',
    // The hyperlink that was read off the tag, on every record it appears on —
    // matched or not. It is the only handle a third-party tag gives us, and the
    // record is where it has to live for the next tap to resolve.
    tag_url: rec.tag_url || '',
    // The number printed on the tag, when the tag came from stock. Kept on the
    // device only: the server learns it from the link (29_fp_tag_stock_field).
    tag_label: rec.tag_label || '',
    // What the tag's link claimed, if anything was fetched. Kept beside the
    // inspection and never merged into it: see the header of tag-link.js.
    external: rec.external || null,
    inspection_date: fpToday(),
    next_due_date: fpNextDue(),
    overall_pass: checks.length > 0 && fpTypes().overallPass(checks),
    source: source || 'field',
    // Deliberately not sent: discard_reason. The database composes it from the
    // checks that failed, so a certificate always matches what actually failed.
    // `answer` is what the tech said; the verdict is derived server-side from
    // the template's own pass_answer, so a client cannot redefine what passes.
    checks: checks.map((c, i) => ({
      ord: i, code: c.code, prompt: c.prompt,
      answer_style: c.answer_style, pass_answer: c.pass_answer, answer: c.answer,
    })),
    capturedAt: new Date().toISOString(),
  };
}

function fpSave() {
  if (!_job || !_fpItem) return;
  const serial = String(_fpItem.serial_raw || '').trim();
  if (!serial) {
    _fpEditing = true;
    fpRenderAll();
    fpHint('A serial number is required.', true);
    return;
  }

  const type = fpCurrentType();
  if (!type) {
    _fpEditing = true;
    fpRenderAll();
    fpHint('Pick an equipment type — it decides which checks apply.', true);
    return;
  }

  const item = fpMakeItem(_fpItem, type, _fpChecks, 'field');
  if (_fpBatch && _fpBatch.failing && item.overall_pass) {
    fpBatchHint('Tap the check that failed — or "It passed" if it did.', true);
    return;
  }
  if (!item.overall_pass) {
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

  // Queue for upload. Local first, always: the record is already safe on the
  // device, and the queue drains whenever a connection turns up.
  if (root_LiaSync()) {
    root_LiaSync().enqueue({
      clientId: item.id,
      kind: 'fall_protection',
      payload: fpToPayload(item),
    });
    // A separate queue entry, not a field on the inspection. Two reasons: the
    // claim is not part of the record the tech signed off, and if the server
    // rejects one the other must still land — losing a real inspection because
    // somebody's spreadsheet had an odd column would be the wrong trade.
    if (item.external) {
      root_LiaSync().enqueue({
        clientId: item.id + ':ext',
        kind: 'fp_external',
        payload: {
          serial_num: item.serial_num,
          nfc_tag_serial: item.nfc_tag_serial || null,
          tag_url: item.tag_url || null,
          source_url: item.external.source_url || item.tag_url || null,
          fetched_at: item.external.fetched_at,
          claimed: item.external.claimed,
          captured_at: item.capturedAt,
        },
      });
    }
    // Behind the inspection it belongs to, so the server has the record to file
    // it against by the time it arrives.
    if (item.photo && item.photo.id) {
      root_LiaSync().enqueue({ clientId: item.id + ':photo', kind: 'fp_photo', payload: fpPhotoPayload(item) });
    }
    fpRenderPending();
  }

  // A blank tag just went on an item. Off the local list now, so a second tap
  // before the next sync does not offer it as blank again.
  if (window.LiaTagStock && (item.tag_label || item.tag_url)) {
    window.LiaTagStock.take({ tag_label: item.tag_label, tag_url: item.tag_url });
  }

  playSound('ladder');
  if (_fpBatch) {
    fpBatchRecorded(item);
    _fpItem = null; _fpChecks = []; _fpEditing = false;
    // A failed item stopped the reader; a passed one never did.
    fpBatchResume();
  } else fpReset();
}

function fpPhotoPayload(item) {
  return {
    photo_id: item.photo.id,
    serial_num: item.serial_num,
    // The inspection's own capture time — how record_fp_photo finds it.
    captured_at: item.capturedAt,
    photo_captured_at: item.photo.capturedAt || null,
    bytes: item.photo.bytes || null,
    width: item.photo.width || null,
    height: item.photo.height || null,
  };
}

// Builds before this one kept the photo itself inside the job, as a data URL in
// localStorage — where it filled the phone's storage and was never sent. Move
// each one into the photo store and queue it. Runs once per photo: afterwards
// the item holds only an id.
function fpMovePhotosOutOfJobs() {
  if (!window.LiaPhotos || !window.indexedDB) return Promise.resolve(0);
  const all = loadJobs();
  const todo = [];
  Object.values(all).forEach(job => (job.items || []).forEach(it => {
    if (it.photo && it.photo.dataUrl && !it.photo.id) todo.push({ job: job, item: it });
  }));
  if (!todo.length) return Promise.resolve(0);
  return todo.reduce((p, t) => p.then(n => {
    const blob = window.LiaPhotos.blobFromDataUrl(t.item.photo.dataUrl);
    if (!blob) return n;
    const id = crypto.randomUUID();
    return window.LiaPhotos.put({ id: id, blob: blob, bytes: blob.size, capturedAt: t.item.photo.capturedAt || null })
      .then(() => {
        t.item.photo = { id: id, bytes: blob.size, capturedAt: t.item.photo.capturedAt || null };
        const sync = root_LiaSync();
        if (sync) sync.enqueue({ clientId: t.item.id + ':photo', kind: 'fp_photo', payload: fpPhotoPayload(t.item) });
        return n + 1;
      })
      .catch(() => n);   // left as it was; tried again next start
  }), Promise.resolve(0)).then(n => {
    if (!n) return n;
    // The open job holds its own copy of the items; keep it in step so the
    // next save does not write the data URLs back.
    if (_job && all[_job.id]) _job.items = all[_job.id].items;
    saveJobs(all);
    return n;
  });
}
setTimeout(() => { fpMovePhotosOutOfJobs().catch(() => {}); }, 0);

function root_LiaSync() { return typeof window !== 'undefined' ? window.LiaSync : null; }

// The shape record_fp_inspection expects. Deliberately omits discard_reason —
// the database composes it from the failed checks, so a client cannot make a
// certificate disagree with what actually failed.
function fpToPayload(item) {
  return {
    serial_num: item.serial_num,
    manufacturer: item.manufacturer || null,
    model: item.model || null,
    equipment_type: item.equipment_type || null,
    item_type: item.item_type || null,
    template_id: item.template_id || null,
    description: item.description || null,
    lot_number: item.lot_number || null,
    mfg_month: item.mfg_month ? Number(item.mfg_month) : null,
    mfg_year: item.mfg_year ? Number(item.mfg_year) : null,
    nfc_tag_serial: item.nfc_tag_serial || null,
    tag_url: item.tag_url || null,
    work_order_id: (_job && _job.workOrderNum) || null,
    inspection_date: item.inspection_date,
    next_due_date: item.next_due_date,
    discard_note: item.discard_note || null,
    captured_at: item.capturedAt,
    // 'field' — the tech answered every check on this screen.
    // 'field_batch' — he inspected the item in his hands and tapped it through;
    // the checks were recorded as passing on his behalf. A certificate should
    // be able to say which happened, so it is stored rather than flattened.
    source: item.source || 'field',
    checks: item.checks,
  };
}

// A count of what has not reached the server yet. Techs work all day offline;
// they need to see the backlog is known about rather than lost.
function fpRenderPending() {
  const el = $('fp-pending');
  if (!el) return;
  const sync = root_LiaSync();
  if (!sync) { el.style.display = 'none'; return; }
  const p = sync.pendingSummary();
  if (!p.total) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.className = 'fp-pending' + (p.failing ? ' warn' : '');
  el.textContent = p.failing
    ? `${p.total} waiting to upload · ${p.failing} not going through`
    : `${p.total} waiting to upload`;
}

function fpRenderItems() {
  // One queue read for the whole list; see the same note in list.js.
  const _upq = window.LiaSyncState ? window.LiaSyncState.queued() : {};
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
    const sub = [it.item_type, it.manufacturer, it.model].filter(Boolean).join(' · ');
    card.innerHTML = `
      <div class="fp-item-top">
        <span class="fp-item-sn">${esc(it.serial_num)}</span>${window.LiaSyncState ? window.LiaSyncState.badge(it.id, _upq) : ''}
        <span class="fp-item-meta">${esc(sub)}</span>
        <span class="fp-item-badge ${it.overall_pass ? 'pass' : 'fail'}">${it.overall_pass ? 'PASS' : 'REMOVED'}</span>
      </div>
      <div class="fp-item-meta">${esc(it.overall_pass
        ? `Due ${it.next_due_date}`
        : fpFailedPrompts(it.checks).join('; '))}</div>`;
    list.appendChild(card);
  });
}

// ── The item in hand survives the app ───────────────────────────────────────
// Saved into its job on every change — every tap, every answer, every field
// typed — so a phone that dies, or an app the OS kills in the background, does
// not lose the item the tech was holding. Reopening the job picks it up again:
// see fpRecover.
function fpSnapshot() {
  const item = Object.assign({}, _fpItem);
  if (_fpEditing) fpReadEditForm(item);
  return {
    item: item,
    checks: _fpChecks.map(c => Object.assign({}, c)),
    batch: !!_fpBatch,
    failing: !!(_fpBatch && _fpBatch.failing),
    at: new Date().toISOString(),
  };
}

function fpPersist() {
  if (!_job || !_job.id) return;
  if (_fpItem) {
    if (_fpItemJob !== _job.id) return;
    _job.fpInProgress = fpSnapshot();
  } else {
    if (!_job.fpInProgress) return;
    delete _job.fpInProgress;
  }
  // Written straight through, not debounced: a debounce is the window in which
  // the app dies and the item is lost.
  try { const all = loadJobs(); all[_job.id] = _job; saveJobs(all); } catch (_) {}
}

// What is in the fields right now, without closing them.
function fpReadEditForm(into) {
  const sn = $('fpf-serial');
  if (sn) into.serial_raw = sn.value.trim();
  FP_FIELDS.forEach(f => { const i = $('fpf-' + f.key); if (i) into[f.key] = i.value.trim(); });
  return into;
}

// Typing is saved too, a moment after he stops.
(function fpPersistTyping() {
  const ef = $('fp-edit-form');
  let t = null;
  if (ef) ef.addEventListener('input', () => { clearTimeout(t); t = setTimeout(fpPersist, 300); });
})();

// Called when a fall protection job opens, with what it had in hand when it
// was last left — by the tech, or by the app dying.
function fpRecover(p) {
  if (!p || !p.item || !_job) return;
  const failed = (p.checks || []).some(c => c.answer != null && c.answer !== c.pass_answer);
  _fpItem = Object.assign({}, p.item);
  _fpItemJob = _job.id;
  _fpChecks = (p.checks || []).map(c => Object.assign({}, c));
  _fpEditing = false;
  const name = _fpItem.serial_raw || _fpItem.tag_label || 'The item you were on';

  // Tapped in a run and never failed: the run's own rule — it was looked at,
  // and it passed. Exactly what the next tap or leaving the screen would do.
  if (p.batch && !p.failing && !failed) {
    const why = fpBatchMissing(_fpItem);
    if (!why) {
      const type = fpCurrentType();
      fpCommit(fpMakeItem(_fpItem, type, fpTypes().startingAnswers(type), 'field_batch'));
      fpHint(`${name} was on screen when the app closed. Recorded as passed.`);
      return;
    }
    if (_fpItem.tag_url) fpQueueTagLink({ url: _fpItem.tag_url, uid: _fpItem.nfc_tag_uid,
                                          ref: _fpItem.public_ref, serial: _fpItem.serial_raw }, null);
    _fpItem = null; _fpChecks = [];
    fpRenderAll();
    fpHint(`${name} was on screen when the app closed. Not recorded — ${why}.`, true);
    return;
  }

  fpRenderAll();
  if (p.failing || failed) {
    fpAlertNoPhoto(`${name} was marked failed, and no photo has been taken. It is not recorded. ` +
                   `Mark what failed and take the photo now.`, null);
  } else {
    fpHint(`Picked up where you left off: ${name}.`);
  }
}

// ── Failed, with no photo ───────────────────────────────────────────────────
// The one thing the app interrupts for. A failed item with no photo is not
// recorded at all — a removal from service needs its evidence — so an item the
// tech failed and walked away from is an item that silently vanishes from the
// record while still being in service. That is worth an alert.
function fpFailedUnrecorded() {
  if (!_fpItem || _fpItemJob !== (_job && _job.id)) return false;
  if (_fpBatch) return !!_fpBatch.failing;
  return _fpChecks.some(c => c.answer != null && c.answer !== c.pass_answer);
}

let _fpLeaveOk = false;

// Asked by goScreen before leaving the job. True means "stay": the alert is up.
function fpBlockLeave(name) {
  if (_fpLeaveOk) { _fpLeaveOk = false; return false; }
  if (!fpFailedUnrecorded()) return false;
  const who = _fpItem.serial_raw || _fpItem.tag_label || 'This item';
  fpAlertNoPhoto(`${who} is marked failed, but it has no photo, so it is not recorded. ` +
                 `If you leave now it stays in service on paper.`, () => {
    _fpItem = null; _fpChecks = []; _fpEditing = false;
    if (_fpBatch) _fpBatch.failing = false;
    fpPersist();
    _fpLeaveOk = true;
    goScreen(name);
    if (name === 'jobs' && typeof renderJobList === 'function') renderJobList();
  });
  return true;
}

// `leave` — a way out that abandons the item, offered only when the alert is
// standing in front of navigation. Without it there is one button: deal with it.
function fpAlertNoPhoto(msg, leave) {
  playSound('scanFail');
  try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (_) {}
  $('fp-alert-msg').textContent = msg;
  const lv = $('fp-alert-leave');
  lv.style.display = leave ? '' : 'none';
  lv.onclick = () => { fpCloseAlert(); if (leave) leave(); };
  $('fp-alert-go').onclick = () => {
    fpCloseAlert();
    // Straight to the photo if he has already marked what failed; otherwise
    // the checks are open in front of him.
    if (_fpItem && _fpChecks.some(c => c.answer != null && c.answer !== c.pass_answer)) fpSave();
    else fpHint('Tap every check that failed, then take the photo.', true);
  };
  $('fp-alert').classList.remove('hidden');
  $('sheet-backdrop').classList.remove('hidden');
}

function fpCloseAlert() {
  $('fp-alert').classList.add('hidden');
  $('sheet-backdrop').classList.add('hidden');
}

// ── Wiring ──────────────────────────────────────────────────────────────────

(function fpWire() {
  const tap = $('fp-btn-tap');
  // A dead button is worse than no button: hide Tap outright where NFC is not
  // available, so scan and type are what the tech reaches for.
  if (tap && (!window.LiaNfc || !window.LiaNfc.isAvailable())) {
    tap.style.display = 'none';
  } else if (tap) {
    tap.addEventListener('click', () => {
      fpHint('Hold the phone against the tag…');
      window.LiaNfc.read().then(res => {
        // A tag may carry the serial, or only its own hardware id, or only a
        // URL — the catalogue indexes all four ways in, so any of them resolves
        // the item. The whole read is passed along so the link is recorded even
        // when something else is what matched.
        fpLookup(res.serial, [res.uid, res.ref, res.url], res);
      }).catch(err => fpHint(err.message || 'No tag read.', true));
    });
  }

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
let _fpPhoto = null;     // { blob, bytes, width, height, capturedAt, previewUrl }

// Phones produce 3–12 MP images. LiaPhotos.compress brings one down to a
// ~1280 px JPEG of ~200 KB or less before it is kept or sent — see photos.js.
function fpDropPhoto() {
  if (_fpPhoto && _fpPhoto.previewUrl) { try { URL.revokeObjectURL(_fpPhoto.previewUrl); } catch (_) {} }
  _fpPhoto = null;
}

function fpOpenCondemn(item) {
  _fpPending = item;
  fpDropPhoto();
  const failed = fpFailedPrompts(item.checks);
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
    img.src = _fpPhoto.previewUrl;
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
    window.LiaPhotos.compress(file).then(r => {
      fpDropPhoto();
      _fpPhoto = Object.assign(r, { capturedAt: new Date().toISOString(),
                                    previewUrl: URL.createObjectURL(r.blob) });
      fpRenderPhoto();
    }).catch(() => fpHint('Could not read that photo.', true));
  });

  const cancel = $('fp-btn-cancel-condemn');
  if (cancel) cancel.addEventListener('click', () => { _fpPending = null; fpDropPhoto(); fpCloseCondemn(); });

  const confirm = $('fp-btn-confirm-condemn');
  if (confirm) confirm.addEventListener('click', () => {
    if (!_fpPending || !_fpPhoto) return;   // the photo is the gate
    const note = $('fp-condemn-note');
    const item = _fpPending;
    const ph = _fpPhoto;
    item.discard_note = note ? note.value.trim() : '';
    // The file goes into the phone's photo store FIRST. The record carries only
    // its id, and is committed only once the file is safely kept — a removal
    // recorded against a photo that was never stored would be evidence lost.
    const id = crypto.randomUUID();
    confirm.disabled = true;
    window.LiaPhotos.put({ id: id, blob: ph.blob, bytes: ph.bytes, width: ph.width,
                           height: ph.height, capturedAt: ph.capturedAt })
      .then(() => {
        item.photo = { id: id, bytes: ph.bytes, width: ph.width, height: ph.height, capturedAt: ph.capturedAt };
        fpCloseCondemn();
        fpCommit(item);
        _fpPending = null;
        fpDropPhoto();
      })
      .catch(() => {
        confirm.disabled = false;
        fpHint('This phone could not store the photo. Try again — the item is not recorded yet.', true);
      });
  });
})();

// ── Tap-through ─────────────────────────────────────────────────────────────
// Walking a rack with the reader always listening. A tap means "I am
// inspecting this one NOW": the item comes up with its checks, every one at its
// passing answer, and the tech looks it over in his hands. He does nothing on
// screen for a good item — the NEXT tap is what says it passed, and records it.
//
// Only a defect costs him anything. Fail stops the reader, opens the checks for
// him to mark which ones failed, and demands a photo — the same removal path the
// single-item screen uses. Nothing is recorded as passing until he taps on.
//
// A pass recorded this way is stored as source 'field_batch' — the checks were
// left at passing rather than each being answered on screen — so a certificate
// can say which happened.
//
// An item the app knows too little about to pass — no equipment type means no
// checklist, and no serial means no record — stays on screen with "Add info".
// He does not have to. If he taps on without it, that item is NOT recorded: it
// is counted as skipped and its tag link, if it had one, is kept so the next tap
// on it resolves.
//
// Same on both platforms. The one difference is iOS's reader sheet, which sits
// over the app: the tech dismisses it to reach Fail, and "Keep tapping" brings
// it back. That is why editing stops the reader on iOS — the sheet would cover
// the form — while Android keeps listening, and a tap there takes whatever has
// been typed so far.

const FP_BATCH_REPEAT_MS = 4000;   // the same tag held against the phone

function fpBatchStart() {
  if (_fpBatch) return;
  if (!window.LiaNfc || !window.LiaNfc.isAvailable()) {
    fpHint('This device cannot read NFC tags.', true);
    return;
  }
  _fpItem = null; _fpChecks = []; _fpEditing = false;
  _fpBatch = { recorded: [], skipped: 0, last: null, lastAt: {}, stream: null,
               hint: '', warn: false, failing: false, currentKey: null };
  fpBatchListen();
  fpBatchHint(_fpBatch.stream.needsArming
    ? 'Tap the first item. If the reader closes, press Keep tapping.'
    : 'Tap the first item. Keep the screen on — a locked phone reads nothing.');
  fpRenderAll();
}

function fpBatchListen() {
  if (!_fpBatch || _fpBatch.stream) return;
  _fpBatch.stream = window.LiaNfc.readStream({
    onTag: fpBatchTag,
    onError: err => fpBatchHint(err && err.message || 'That tag could not be read.', true),
  });
}

function fpBatchQuiet() {
  if (!_fpBatch || !_fpBatch.stream) return;
  try { _fpBatch.stream.stop(); } catch (_) {}
  _fpBatch.stream = null;
}

// Ends the run and drops whatever is on screen. Only for a run that belongs to
// a job already left; leaving the screen goes through fpBatchLeave.
function fpBatchStop() {
  if (!_fpBatch) return;
  fpBatchQuiet();
  _fpBatch = null;
  _fpItem = null; _fpChecks = []; _fpEditing = false;
  fpRenderAll();
}

// Done: the item in hand has been looked at like every other, and there is no
// next tap to say so. Passed if it can be, then the run ends.
function fpBatchFinish() {
  if (!_fpBatch || _fpBatch.failing) return;
  if (_fpEditing) fpApplyEditForm();
  fpBatchSettle();
  const n = fpBatchTally();
  fpBatchStop();
  fpHint(`Tap-through finished — ${n}.`);
}

// Leaving the tap-through screen — back to the jobs list, or anywhere else. The
// item on screen was tapped and looked over like every other, and the tech
// walking away is not him saying it failed: it is recorded as passed, exactly
// as Pass & finish would. The one exception is an item he pressed Fail on and
// never photographed — that cannot be a pass, and without the photo it cannot
// be a removal either.
function fpBatchLeave() {
  if (!_fpBatch) return;
  if (!_fpBatch.failing) {
    if (_fpEditing) fpApplyEditForm();
    fpBatchSettle();
  }
  fpBatchStop();
}

// Back to listening after the tech stepped off it — failing an item, or filling
// one in on iOS.
function fpBatchResume() {
  if (!_fpBatch) return;
  _fpBatch.failing = false;
  fpBatchListen();
  fpRenderAll();
}

function fpBatchHint(msg, warn) {
  if (_fpBatch) { _fpBatch.hint = msg || ''; _fpBatch.warn = !!warn; }
  const h = $('fp-batch-hint');
  if (h) { h.textContent = msg || ''; h.className = 'fp-hint' + (warn ? ' warn' : ''); }
}

// Identity for "is this the same item?" — the asset if we resolved it,
// otherwise whatever the tag itself gave us.
function fpBatchKey(res, hit) {
  if (hit && hit.asset_id) return 'a:' + hit.asset_id;
  if (hit && hit.public_ref) return 'r:' + hit.public_ref;
  return 't:' + [res.uid, res.ref, res.serial, res.url].filter(Boolean).join('|');
}

// What stops the item on screen being recorded as a pass, or null if nothing.
function fpBatchMissing(it) {
  if (!it) return 'nothing on screen';
  if (!fpTypes().byKey(it.equipment_type || it.item_type || '')) return 'no equipment type';
  if (!String(it.serial_raw || '').trim()) return 'no serial number';
  return null;
}

function fpBatchTag(res) {
  if (!_fpBatch || _fpBatch.failing) return;
  const candidates = [res.serial, res.uid, res.ref, res.url]
    .map(v => String(v || '').trim())
    .filter((v, i, a) => v && a.indexOf(v) === i);

  if (!candidates.length) {
    playSound('scanFail');
    fpBatchHint('That tag carries nothing we can identify an item by. Nothing was recorded.', true);
    return;
  }

  const step = i => i >= candidates.length
    ? Promise.resolve(null)
    : window.LiaCache.find(candidates[i], 'fall_protection').then(h => h || step(i + 1));

  step(0)
    .then(hit => hit ? hit : fpLookupOnline(res))
    .then(hit => {
      if (!_fpBatch || _fpBatch.failing) return;
      const key = fpBatchKey(res, hit);
      const now = Date.now();
      // A tag left against the phone fires repeatedly; that is one presentation,
      // not one item — and certainly not the next item confirming this one.
      if (_fpBatch.lastAt[key] && now - _fpBatch.lastAt[key] < FP_BATCH_REPEAT_MS) return;
      _fpBatch.lastAt[key] = now;

      if (key === _fpBatch.currentKey) {
        fpBatchHint(`Still on ${(_fpItem && _fpItem.serial_raw) || 'this item'} — tap the next one to pass it.`);
        return;
      }
      if (_fpBatch.recorded.some(r => r.key === key)) {
        playSound('scanFail');
        fpBatchHint(`${(hit && hit.serial_raw) || candidates[0]} is already in this run. ` +
                    `Nothing changed.`, true);
        return;
      }

      // A new item: the one before it passed.
      if (_fpEditing) fpApplyEditForm();
      fpBatchOpen(res, hit, candidates, key, fpBatchSettle());
    })
    .catch(() => {
      playSound('scanFail');
      fpBatchHint('Could not read the on-device catalogue. Nothing was recorded.', true);
    });
}

// The item on screen is done: a pass if there is enough to record one,
// otherwise skipped with its link kept. Says which, so the next item's sound
// does not play over this one's.
function fpBatchSettle() {
  if (!_fpBatch || !_fpItem) return null;
  const it = _fpItem;
  const why = fpBatchMissing(it);
  if (!why) {
    const type = fpCurrentType();
    // startingAnswers() is every check at its PASSING answer — including the
    // inverted one, where passing means "no".
    const item = fpMakeItem(it, type, fpTypes().startingAnswers(type), 'field_batch');
    _fpBatch.last = { serial: item.serial_num, flagged: false,
      sub: 'Passed · ' + [type.name, it.manufacturer, it.model].filter(Boolean).join(' · ') };
    try { if (navigator.vibrate) navigator.vibrate(35); } catch (_) {}
    fpCommit(item);
    return 'pass';
  }
  _fpBatch.skipped++;
  if (it.tag_url) fpQueueTagLink({ url: it.tag_url, uid: it.nfc_tag_uid, ref: it.public_ref,
                                   serial: it.serial_raw }, null);
  _fpBatch.last = {
    serial: it.serial_raw || it.tag_label || 'Unknown tag', flagged: true,
    sub: `Not recorded — ${why}.` + (it.tag_url ? ' Its link is kept.' : ''),
  };
  playSound('scanFail');
  _fpItem = null; _fpChecks = []; _fpEditing = false;
  _fpBatch.currentKey = null;
  return 'skip';
}

// Puts a freshly tapped item on screen as the one being inspected.
function fpBatchOpen(res, hit, candidates, key, settled) {
  _fpBatch.currentKey = key;
  if (hit) {
    fpAdopt(hit, true);
  } else {
    // Only a serial read off the tag's own text record goes in the serial box.
    // A hardware uid, a certificate code or a link identifies the TAG, and a
    // record whose serial is one of those names nothing anyone can find.
    fpAdopt({ serial_raw: String(res.serial || '').trim(), manufacturer: '', model: '',
              equipment_type: '', item_type: '', lot_number: '', mfg_month: '',
              mfg_year: '', description: '' }, false);
    // One of our own blank tags: the printed number and its link go on the item.
    // Its link is never treated as somebody else's.
    const blank = fpStockFor(candidates, res);
    if (blank) {
      _fpItem.tag_label = blank.tag_label;
      _fpItem.tag_url = blank.tag_url || '';
    }
  }
  _fpItem.nfc_tag_uid = _fpItem.nfc_tag_uid || res.uid || '';
  // Recorded on every tap, not just the unknown ones: re-recording the link is
  // what keeps the mapping current when a customer re-tags an item.
  if (res.url) _fpItem.tag_url = res.url;

  const why = fpBatchMissing(_fpItem);
  if (why) {
    if (!settled) playSound('scanFail');
    const what = _fpItem.tag_label
      ? `${_fpItem.tag_label} is one of your blank tags.`
      : hit ? `On file, but ${why}.` : 'Not on file.';
    fpBatchHint(`${what} Add info to record it — tap on without it and this one is skipped.`, true);
  } else {
    // The first tap of a run has nothing before it to sound for.
    if (!settled) playSound('ladder');
    fpBatchHint('Inspecting. Tap the next item to pass it, or press Fail.');
  }
  fpRenderAll();
}

// What the server knows, for an item this device has never synced — a rack
// from another crew, or an item added since the last sync. Tried the same way
// whether the item was tapped, scanned or typed: by certificate code, by link,
// then by serial. Only reachable online, and a miss here is still a miss.
function fpLookupOnline(res) {
  if (!res.ref && !res.url && !res.serial) return Promise.resolve(null);
  if (!root_LiaSync()) return Promise.resolve(null);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(null);

  const cols = 'serial_num, public_ref, tag_url, item_type, description, manufacturer, ' +
               'model, lot_number, mfg_month, mfg_year, inspection_date';

  return root_LiaSync().client().then(sb => {
    if (!sb) return null;

    const adopt = row => row ? {
      asset_id: null, public_ref: row.public_ref,
      serial_raw: row.serial_num, item_type: row.item_type,
      description: row.description, manufacturer: row.manufacturer, model: row.model,
      lot_number: row.lot_number, mfg_month: row.mfg_month, mfg_year: row.mfg_year,
      last_inspected: row.inspection_date, nfc_tag_uid: res.uid || '',
      tag_url: row.tag_url || res.url || '',
    } : null;

    const byRef = () => res.ref
      ? sb.from('fall_protection_public').select(cols).eq('public_ref', res.ref).limit(1)
          .then(r => adopt(r && !r.error && r.data && r.data[0]))
      : Promise.resolve(null);

    // A third-party link the server has seen before, even though this device has
    // not. Matched on the canonical form, which is what the server stores.
    const byUrl = () => {
      const tl = window.LiaTagLink;
      const key = res.url && tl ? tl.urlKey(res.url) : '';
      if (!key) return Promise.resolve(null);
      return sb.from('fall_protection_public').select(cols).eq('tag_url_key', key).limit(1)
        .then(r => adopt(r && !r.error && r.data && r.data[0]));
    };

    const bySerial = () => {
      const key = res.serial && window.LiaCache ? window.LiaCache.serialKey(res.serial) : '';
      if (!key) return Promise.resolve(null);
      return sb.from('fall_protection_public').select(cols).eq('serial_key', key)
        .order('inspection_date', { ascending: false }).limit(1)
        .then(r => adopt(r && !r.error && r.data && r.data[0]));
    };

    return byRef().then(hit => hit || byUrl()).then(hit => hit || bySerial());
  }).catch(() => null);
}

// Fail: the reader stops — the next tap must not pass this item — and the checks
// open for him to mark what failed. Save then asks for the photo.
function fpBatchFail() {
  if (!_fpBatch || !_fpItem || _fpBatch.failing) return;
  if (!fpCurrentType()) {
    _fpEditing = true;
    fpBatchQuietForForm();
    fpBatchHint('Pick the equipment type first — it decides which checks there are to fail.', true);
    fpRenderAll();
    return;
  }
  if (_fpEditing) fpApplyEditForm();
  _fpBatch.failing = true;
  fpBatchQuiet();
  fpBuildChecks();
  fpHint('');
  fpBatchHint('Tap every check that failed, then add a photo.', true);
  fpRenderAll();
}

// Changed his mind: the item is back to passing and the reader back on.
function fpBatchCancelFail() {
  if (!_fpBatch || !_fpBatch.failing) return;
  fpBuildChecks();
  fpBatchHint('Back to passing. Tap the next item to pass this one.');
  fpBatchResume();
}

function fpBatchEdit() {
  if (!_fpBatch || !_fpItem || _fpBatch.failing) return;
  _fpEditing = true;
  fpBatchQuietForForm();
  fpRenderAll();
}

// iOS draws its reader sheet over the app, which would cover the form and the
// keyboard. Android draws nothing, so it keeps listening.
function fpBatchQuietForForm() {
  if (_fpBatch && _fpBatch.stream && _fpBatch.stream.needsArming) fpBatchQuiet();
}

// Undo the last pass: it comes back on screen to be failed or corrected, and
// whatever had just been tapped goes back to not-yet-looked-at.
function fpBatchUndo() {
  if (!_fpBatch || _fpBatch.failing) return;
  const last = _fpBatch.recorded[_fpBatch.recorded.length - 1];
  if (!last || !last.pass) return;
  const item = fpBatchWithdraw(last);
  if (!item) return;
  const dropped = _fpItem && (_fpItem.serial_raw || _fpItem.tag_label);
  if (_fpBatch.currentKey) delete _fpBatch.lastAt[_fpBatch.currentKey];
  _fpBatch.currentKey = last.key;
  fpAdopt({
    asset_id: item.asset_id, public_ref: item.public_ref,
    serial_raw: item.serial_num, manufacturer: item.manufacturer, model: item.model,
    equipment_type: item.equipment_type, item_type: item.item_type,
    description: item.description, lot_number: item.lot_number,
    mfg_month: item.mfg_month, mfg_year: item.mfg_year,
    nfc_tag_uid: item.nfc_tag_serial, tag_url: item.tag_url, tag_label: item.tag_label,
    external: item.external,
  }, true);
  _fpBatch.last = null;
  fpBatchHint(`${item.serial_num} is back — not recorded. Fail it, or tap the next item to pass it.` +
              (dropped ? ` Tap ${dropped} again when you get to it.` : ''));
  fpRenderAll();
}

// Take a recorded item back out of the job AND out of the upload queue, so
// nothing can reach the server saying it passed.
function fpBatchWithdraw(entry) {
  const idx = (_job && _job.items || []).findIndex(i => i.id === entry.id);
  if (idx < 0) return null;
  const item = _job.items[idx];
  _job.items.splice(idx, 1);
  const sync = root_LiaSync();
  if (sync && sync.dequeue) { sync.dequeue(entry.id); sync.dequeue(entry.id + ':ext'); sync.dequeue(entry.id + ':photo'); }
  saveNow();
  _fpBatch.recorded.pop();
  delete _fpBatch.lastAt[entry.key];
  fpRenderPending();
  return Object.assign({ asset_id: entry.asset_id, public_ref: entry.public_ref }, item);
}

// Called by fpCommit for every item that lands during a run, pass or fail.
function fpBatchRecorded(item) {
  if (!_fpBatch) return;
  _fpBatch.recorded.push({
    key: _fpBatch.currentKey || ('i:' + item.id), id: item.id, serial: item.serial_num,
    pass: !!item.overall_pass,
    asset_id: _fpItem && _fpItem.asset_id, public_ref: _fpItem && _fpItem.public_ref,
  });
  if (!item.overall_pass) {
    _fpBatch.last = { serial: item.serial_num, flagged: true,
                      sub: 'Removed from service — ' + fpFailedPrompts(item.checks).join('; ') };
    fpBatchHint('Recorded as failed. Tap the next item.');
  }
  _fpBatch.currentKey = null;
}

function fpBatchTally() {
  if (!_fpBatch) return '';
  const passed = _fpBatch.recorded.filter(r => r.pass).length;
  const failed = _fpBatch.recorded.length - passed;
  return [`${passed} passed`,
          failed ? `${failed} failed` : '',
          _fpBatch.skipped ? `${_fpBatch.skipped} skipped` : ''].filter(Boolean).join(' · ');
}

function fpRenderBatch() {
  if (!_fpBatch) return;
  const b = _fpBatch;
  const c = $('fp-batch-count');
  if (c) c.textContent = fpBatchTally();
  const live = $('fp-batch-live-txt');
  if (live) live.textContent = b.failing ? 'Paused — failing'
                             : b.stream ? 'Listening' : 'Paused';
  const dot = $('fp-batch-dot');
  if (dot) dot.style.visibility = b.stream ? '' : 'hidden';

  const l = $('fp-batch-last');
  if (l) {
    const last = b.last;
    l.style.display = last || !_fpItem ? '' : 'none';
    l.className = 'fp-batch-last' + (last ? (last.flagged ? ' flag' : ' ok') : '');
    l.innerHTML = last
      ? `<span class="sn">${esc(last.serial)}</span>
         <span class="sub">${esc(last.sub || '')}</span>`
      : '<span class="sub">Waiting for the first tap…</span>';
  }

  const has = !!_fpItem;
  const busy = b.failing || _fpEditing;
  const missing = has && fpBatchMissing(_fpItem);
  const cur = $('fp-batch-cur');
  if (cur) cur.style.display = has && !busy ? '' : 'none';
  const ways = $('fp-batch-ways');
  if (ways) ways.style.display = busy ? 'none' : '';
  const typed = $('fp-batch-typed');
  if (typed && busy) typed.style.display = 'none';
  const edit = $('fp-btn-batch-edit');
  if (edit) {
    edit.textContent = missing ? 'Add info' : 'Edit info';
    edit.classList.toggle('need', !!missing);
  }

  const lastRec = b.recorded[b.recorded.length - 1];
  const undo = $('fp-btn-batch-undo');
  if (undo) undo.disabled = busy || !(lastRec && lastRec.pass);
  const done = $('fp-btn-batch-stop');
  if (done) {
    done.disabled = b.failing;
    done.textContent = has && !missing ? 'Pass & finish' : 'Finish';
  }
  const arm = $('fp-btn-batch-arm');
  if (arm) arm.style.display = !b.failing && !(_fpEditing && !b.stream)
    && (!b.stream || b.stream.needsArming) ? '' : 'none';

  const h = $('fp-batch-hint');
  if (h) { h.textContent = b.hint || ''; h.className = 'fp-hint' + (b.warn ? ' warn' : ''); }
}

(function fpBatchWire() {
  const start = $('fp-btn-batch');
  // Same rule as the Tap button: no dead affordance where NFC does not exist.
  if (start && window.LiaNfc && window.LiaNfc.isAvailable()) start.style.display = '';
  if (start) start.addEventListener('click', fpBatchStart);

  const stop = $('fp-btn-batch-stop');
  if (stop) stop.addEventListener('click', fpBatchFinish);

  // iOS: the tech dismissed Apple's sheet, or it timed out for good. Android
  // never needs this unless the stream was stopped for a form.
  const arm = $('fp-btn-batch-arm');
  if (arm) arm.addEventListener('click', () => {
    if (!_fpBatch) return;
    if (_fpBatch.stream) _fpBatch.stream.arm(); else fpBatchListen();
    fpBatchHint('Reader re-opened.');
    fpRenderBatch();
  });

  const fail = $('fp-btn-batch-fail');
  if (fail) fail.addEventListener('click', fpBatchFail);
  const edit = $('fp-btn-batch-edit');
  if (edit) edit.addEventListener('click', fpBatchEdit);
  const cancel = $('fp-btn-fail-cancel');
  if (cancel) cancel.addEventListener('click', fpBatchCancelFail);

  const undo = $('fp-btn-batch-undo');
  if (undo) undo.addEventListener('click', fpBatchUndo);

  // Scanned or typed, an item goes through the run exactly as a tap does.
  const scan = $('fp-btn-batch-scan');
  if (scan) scan.addEventListener('click', () => {
    if (!_fpBatch) return;
    // iOS's reader sheet would sit over the camera. Back on after the scan.
    fpBatchQuietForForm();
    window._fpAwaitScan = true;
    startScan();
  });
  const type = $('fp-btn-batch-type');
  if (type) type.addEventListener('click', () => {
    const row = $('fp-batch-typed');
    if (!row) return;
    const show = row.style.display === 'none';
    row.style.display = show ? 'flex' : 'none';
    if (show) $('fp-batch-serial').focus();
  });
  const find = $('fp-btn-batch-find');
  const input = $('fp-batch-serial');
  const go = () => {
    const v = input.value.trim();
    if (!v || !_fpBatch) return;
    input.value = '';
    fpBatchTag({ serial: v });
  };
  if (find) find.addEventListener('click', go);
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
})();

// The scanner hands its result here while a run is going. Called from scan.js.
function fpBatchScanned(value) {
  if (!_fpBatch) return false;
  fpBatchListen();
  if (value) fpBatchTag({ serial: value });
  else fpRenderBatch();
  return true;
}
