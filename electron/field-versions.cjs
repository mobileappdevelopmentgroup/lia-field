'use strict';
// Every version of every record on a work order, grouped into items.
//
// A record is never edited in place: a correction writes a new version and the
// old one stays, marked not-current (26, 15). So "what was collected in the
// field, what the office changed, what went to BSI" is already in the
// database — this turns the rows into something a lead can read.
//
// An ITEM is one piece of equipment on one inspection date, which is the unit
// the server promotes and demotes versions within (`is_current` is per
// (asset, date), not per asset). Pure, so it is tested without Electron:
// electron/test/field-versions.test.mjs.

const LADDER_FIELDS = ['brand', 'type', 'length', 'notes', 'work_order_id', 'inspection_date',
  'lubricated', 'has_leveler', 'has_claw', 'has_vrung', 'parts'];
const FP_FIELDS = ['manufacturer', 'model', 'item_type', 'lot_number', 'mfg_month', 'mfg_year',
  'description', 'work_order_id', 'inspection_date', 'overall_pass', 'discard_note'];

// Where a version came from. `source` is set by the server on every office
// path (office_amend, office_add) and by the phone as 'field' / 'field_batch'.
function originOf(row) {
  const s = row.source || '';
  if (s === 'office_amend') return 'corrected';
  if (s === 'office_add') return 'added';
  if (s === 'office') return 'office_import';
  if (s.startsWith('import')) return 'imported';
  return (row.version || 1) > 1 ? 'field_resend' : 'field';
}

const partsText = (parts) => (Array.isArray(parts) ? parts : [])
  .filter(p => p && p.name)
  .map(p => (Number(p.qty) > 1 ? `${p.name} ×${p.qty}` : String(p.name)))
  .join(', ');

const show = (k, v) => {
  if (k === 'parts') return partsText(v) || '—';
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};

function changesBetween(prev, cur, fields) {
  if (!prev) return [];
  const out = [];
  for (const k of fields) {
    const a = show(k, prev[k]);
    const b = show(k, cur[k]);
    if (a !== b) out.push({ field: k, from: a, to: b });
  }
  return out;
}

// rows: { ladders: inspections rows, fp: fp_inspections rows (with assets.serial_raw),
//         audits: [{ scope, inspection_id, action, reason, actor_name, created_at }] }
function groupVersions({ ladders = [], fp = [], audits = [] } = {}) {
  const auditBy = new Map();
  for (const a of audits) {
    const k = `${a.scope}:${a.inspection_id}`;
    if (!auditBy.has(k)) auditBy.set(k, []);
    auditBy.get(k).push({ action: a.action, reason: a.reason, actor: a.actor_name || '', at: a.created_at });
  }

  const groups = new Map();
  const add = (scope, row, serial, fields) => {
    const who = row.asset_id || `serial:${String(serial || '').trim().toLowerCase()}`;
    const key = `${scope}|${who}|${row.inspection_date}`;
    if (!groups.has(key)) groups.set(key, { key, scope, serialNum: serial || '', inspectionDate: row.inspection_date, rows: [] });
    groups.get(key).rows.push({ row, fields });
  };
  ladders.forEach(r => add('ladder', r, r.serial_num, LADDER_FIELDS));
  fp.forEach(r => add('fall_protection', r, (r.assets && r.assets.serial_raw) || r.serial_raw || '', FP_FIELDS));

  const items = [];
  for (const g of groups.values()) {
    g.rows.sort((a, b) => (a.row.version || 1) - (b.row.version || 1));
    const fields = g.rows[0].fields;
    const versions = g.rows.map(({ row }, i) => {
      const snap = {};
      fields.forEach(k => { snap[k] = row[k] === undefined ? null : row[k]; });
      return {
        id: row.id,
        version: row.version || 1,
        origin: originOf(row),
        isCurrent: !!row.is_current && !row.is_deleted,
        isDeleted: !!row.is_deleted,
        capturedAt: row.captured_at || null,
        receivedAt: row.uploaded_at || row.created_at || null,
        bsiPushedAt: row.bsi_pushed_at || null,
        bsiBoxRef: row.bsi_box_ref || null,
        collector: row.collector_name || row.tech_name || '',
        snapshot: snap,
        changes: changesBetween(i ? g.rows[i - 1].row : null, row, fields),
        audit: (auditBy.get(`${g.scope}:${row.id}`) || [])
          .sort((a, b) => String(a.at).localeCompare(String(b.at))),
      };
    });

    const current = versions.find(v => v.isCurrent) || null;
    const latest = versions[versions.length - 1];
    let state;
    if (current) {
      if (current.bsiPushedAt) state = 'in_bsi';
      // An earlier version reached BSI and this one has not: the importer only
      // adds boxes, so this is a fix somebody makes in BSI by hand.
      else if (versions.some(v => v.bsiPushedAt && v.version < current.version)) state = 'changed_after_bsi';
      else state = 'not_in_bsi';
    } else if (latest.isDeleted) {
      state = 'deleted';
    } else {
      // Every version here was superseded by one that is no longer on this
      // work order — a correction moved it.
      state = 'moved';
    }

    items.push({
      key: g.key,
      scope: g.scope,
      serialNum: g.serialNum,
      inspectionDate: g.inspectionDate,
      state,
      current,
      // The one a Restore brings back: the item as it last stood.
      restoreId: state === 'deleted' ? latest.id : null,
      // Ids to delete, newest first, so each step promotes the next one down
      // and the last leaves nothing current.
      liveIds: versions.filter(v => !v.isDeleted).map(v => v.id).reverse(),
      // Undo is offered only for an office correction with something under it.
      canUndo: !!current && current.origin === 'corrected' && versions.some(v => !v.isDeleted && v.version < current.version),
      versions,
    });
  }

  const order = { not_in_bsi: 0, changed_after_bsi: 0, in_bsi: 0, deleted: 1, moved: 2 };
  items.sort((a, b) => (order[a.state] - order[b.state])
    || String(a.serialNum).localeCompare(String(b.serialNum), undefined, { numeric: true }));
  return items;
}

// "G13 x2, W44" ⇄ [{name,qty}]. The phone stores parts as {name, qty}.
function parseParts(text) {
  const out = [];
  for (const raw of String(text || '').split(',')) {
    const t = raw.trim();
    if (!t) continue;
    const m = t.match(/^(.+?)\s*(?:[x×*]\s*(\d+))?$/i);
    const name = m[1].trim();
    const qty = m[2] ? parseInt(m[2], 10) : 1;
    if (!name || name.length > 40) return { error: `"${t}" is not a part.` };
    if (!(qty >= 1 && qty <= 999)) return { error: `Quantity for ${name} must be 1–999.` };
    const prev = out.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (prev) prev.qty += qty; else out.push({ name, qty });
  }
  return { parts: out };
}

module.exports = { groupVersions, parseParts, partsText, originOf, LADDER_FIELDS, FP_FIELDS };
