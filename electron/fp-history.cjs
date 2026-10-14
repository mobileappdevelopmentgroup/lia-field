// Fall-protection history: a spreadsheet of past inspections → rows for
// import_fp_history() (supabase/migrations/35_fp_history_import.sql).
//
// Pure — no Electron, no network — so it is tested on its own
// (src/core/fp-history.test.ts) and main.cjs only reads the file and calls it.
//
// Nobody has handed us "the" format: every company's spreadsheet names its
// columns its own way. So headers are matched loosely against a list of the
// names people actually use, the match is shown before anything is sent, and a
// column nobody recognises is listed rather than silently dropped.
//
// What it will NOT guess:
//   * Pass or fail. A file with no result column imports nothing until the
//     office says, in so many words, that every row in it passed.
//   * An ambiguous date. 03/04/2025 is read the way the rest of the FILE says
//     to read it (any 13–31 in the first place means day-first); a file where
//     nothing settles it is read month-first, US style, and the preview says so.
'use strict';

// Matched after lower-casing and squeezing out everything but letters/digits,
// so "Serial #", "serial_no" and "SERIAL NUMBER" meet. The serial is the
// number Batavia assigns (decided 2026-10-14); the manufacturer's goes to
// mfr_serial and is never matched on.
const COLUMNS = {
  serial:          ['serial', 'serialno', 'serialnumber', 'serialnum', 'sn', 'assignedserial',
                    'assignednumber', 'assignedno', 'assignedserialnumber', 'bataviaserial',
                    'bataviano', 'bataviaid', 'assetno', 'assetnumber', 'assetid',
                    'equipmentno', 'equipmentnumber', 'equipmentid', 'itemno'],
  inspection_date: ['inspectiondate', 'date', 'dateinspected', 'inspected', 'lastinspection',
                    'lastinspected', 'lastinspectiondate', 'inspecteddate', 'dateofinspection'],
  result:          ['result', 'passfail', 'pf', 'status', 'outcome', 'condition', 'inspectionresult',
                    'overall', 'overallresult'],
  equipment_type:  ['type', 'equipmenttype', 'itemtype', 'item', 'equipment', 'category',
                    'producttype'],
  manufacturer:    ['manufacturer', 'mfr', 'mfg', 'make', 'brand', 'maker'],
  model:           ['model', 'modelno', 'modelnumber', 'modelnum'],
  mfr_serial:      ['manufacturerserial', 'manufacturersserial', 'manufacturerserialnumber',
                    'mfrserial', 'mfgserial', 'mfrsn', 'mfgsn', 'manufacturersn', 'oemserial',
                    'mfrserialnumber', 'mfgserialnumber'],
  lot_number:      ['lot', 'lotno', 'lotnumber', 'batch', 'batchno'],
  mfg_date:        ['dateofmanufacture', 'dom', 'mfgdate', 'manufacturedate', 'manufactured',
                    'manufacturingdate', 'datemanufactured'],
  tag_label:       ['tag', 'tagno', 'tagnumber', 'taglabel', 'nfctag', 'nfc', 'tagid'],
  inspector:       ['inspector', 'inspectedby', 'tech', 'techname', 'technician', 'inspectorname'],
  work_order_id:   ['workorder', 'workorderno', 'workordernumber', 'wo', 'wono', 'wonumber'],
  reason:          ['reason', 'failurereason', 'failreason', 'whyfailed', 'defect', 'defects',
                    'reasonforfailure'],
  description:     ['description', 'desc', 'itemdescription'],
  notes:           ['notes', 'note', 'comments', 'comment', 'remarks'],
};
const REQUIRED = ['serial', 'inspection_date'];

// The same vocabulary the server accepts; anything else is reported here,
// before the upload, rather than coming back skipped.
const PASS = ['pass', 'passed', 'p', 'yes', 'y', 'ok', 'true', 'in service'];
const FAIL = ['fail', 'failed', 'f', 'no', 'n', 'false', 'removed', 'out of service',
              'condemned', 'destroyed'];

// A spreadsheet's word for a type → our slug. Exact names only, as on the
// phone (FP_SHEET_TYPES in field-app/js/fp.js): the type picks the checklist,
// so a fuzzy guess is how the wrong questions get asked. Anything not here is
// sent in the file's own words; the server resolves our own names and keeps
// the rest as text with no type.
const TYPES = {
  'body harness': 'body_harness', 'harness': 'body_harness', 'harnesses': 'body_harness',
  'full body harness': 'body_harness', 'fbh': 'body_harness',
  'lanyard': 'lanyard', 'lanyards': 'lanyard', 'shock absorbing lanyard': 'lanyard',
  'positioning lanyard': 'positioning_lanyard', 'positioning lanyards': 'positioning_lanyard',
  'positioning strap': 'positioning_strap', 'positioning straps': 'positioning_strap',
  'climbing belt': 'climbing_belt', 'climbing belts': 'climbing_belt',
  'srl': 'srl', 'srls': 'srl', 'self retracting lifeline': 'srl', 'self retracting lifelines': 'srl',
  'pole climbing device': 'pole_climbing_device',
  'crane lifting sling': 'crane_lift_sling', 'crane lift sling': 'crane_lift_sling',
  'tie off adaptor': 'tie_off_adaptor', 'tie off adapter': 'tie_off_adaptor',
  'self rescue device': 'self_rescue_device',
};

const squeeze = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const words   = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean   = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function mapHeaders(headers) {
  const map = {};          // field → header as written
  const unmapped = [];
  headers.forEach(h => {
    const k = squeeze(h);
    if (!k) return;
    const field = Object.keys(COLUMNS).find(f => !map[f] && COLUMNS[f].includes(k));
    if (field) map[field] = h; else unmapped.push(h);
  });
  return { map, unmapped };
}

// ── Dates ───────────────────────────────────────────────────────────────────
const ISO = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const SLASH = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/;

function validYmd(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Which way round the file writes a/b/yyyy: 'dmy' if anything in it can only
// be day-first, 'mdy' if anything can only be month-first, 'conflict' if both,
// null if nothing settles it.
function slashOrder(values) {
  let dmy = false, mdy = false;
  values.forEach(v => {
    const m = SLASH.exec(clean(v));
    if (!m) return;
    const a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) dmy = true;
    if (b > 12 && a <= 12) mdy = true;
  });
  if (dmy && mdy) return 'conflict';
  return dmy ? 'dmy' : mdy ? 'mdy' : null;
}

function toIso(v, order) {
  const s = clean(v);
  if (!s) return null;
  let m = ISO.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = SLASH.exec(s);
  if (m) {
    let y = +m[3];
    if (m[3].length === 2) y += 2000;
    const [mo, d] = order === 'dmy' ? [+m[2], +m[1]] : [+m[1], +m[2]];
    return validYmd(y, mo, d);
  }
  // "Jan 15 2025", "15 January 2025" — words leave no doubt about the month.
  const t = Date.parse(s.replace(/(\d)(st|nd|rd|th)\b/gi, '$1'));
  if (!isNaN(t) && /[a-z]{3}/i.test(s)) {
    const dt = new Date(t);
    return validYmd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }
  return null;
}

// Date of manufacture → month and year. "06/2021", "2021-06", "June 2021",
// "2021", or a full date.
function mfgParts(v, order) {
  const s = clean(v);
  if (!s) return {};
  let m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12) return { mfg_month: +m[1], mfg_year: +m[2] };
  m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return { mfg_month: +m[2], mfg_year: +m[1] };
  m = /^(\d{4})$/.exec(s);
  if (m) return { mfg_year: +m[1] };
  const iso = toIso(s, order);
  if (iso) return { mfg_month: +iso.slice(5, 7), mfg_year: +iso.slice(0, 4) };
  const t = Date.parse('1 ' + s);
  if (!isNaN(t)) { const dt = new Date(t); return { mfg_month: dt.getMonth() + 1, mfg_year: dt.getFullYear() }; }
  return {};
}

function resultOf(v) {
  const w = words(v);
  if (PASS.includes(w)) return 'pass';
  if (FAIL.includes(w)) return 'fail';
  return null;
}

/**
 * @param {Array<Object>} records  rows keyed by header, as PapaParse { header: true } gives them
 * @param {string[]} headers       the header row, in order
 * @param {{ today?: string }} [opts]
 * @returns {{ rows, skipped, map, unmapped, missing, dateOrder, needsResultConfirm, unknownTypes, error? }}
 */
function parseFpHistory(records, headers, opts) {
  const today = (opts && opts.today) || new Date().toISOString().slice(0, 10);
  const { map, unmapped } = mapHeaders(headers || []);
  const missing = REQUIRED.filter(f => !map[f]);
  if (missing.length) {
    return { rows: [], skipped: [], map, unmapped, missing, dateOrder: null,
             needsResultConfirm: false, unknownTypes: [],
             error: 'No column for ' + missing.map(f => f === 'serial' ? 'the serial (assigned number)' : 'the inspection date').join(' or ') +
                    '. Columns found: ' + (headers || []).filter(Boolean).join(', ') };
  }
  const get = (r, f) => map[f] ? clean(r[map[f]]) : '';

  const order = slashOrder(records.map(r => get(r, 'inspection_date')));
  if (order === 'conflict') {
    return { rows: [], skipped: [], map, unmapped, missing, dateOrder: order,
             needsResultConfirm: false, unknownTypes: [],
             error: 'The inspection dates are written both day-first and month-first in this file. ' +
                    'Make them one or the other (YYYY-MM-DD is safest) and choose it again.' };
  }
  const mfgOrder = slashOrder(records.map(r => get(r, 'mfg_date'))) === 'dmy' ? 'dmy' : (order || 'mdy');

  const rows = [], skipped = [], unknown = new Map(), seen = new Map();
  records.forEach((r, i) => {
    const row = i + 2;     // the spreadsheet's own numbering: header is row 1
    if (Object.values(r).every(v => !clean(v))) return;
    const serial = get(r, 'serial');
    if (!serial) { skipped.push({ row, reason: 'No serial' }); return; }
    if (serial.length > 64) { skipped.push({ row, serial, reason: 'Serial is longer than 64 characters' }); return; }

    const rawDate = get(r, 'inspection_date');
    const date = toIso(rawDate, order || 'mdy');
    if (!date) { skipped.push({ row, serial, reason: rawDate ? `"${rawDate}" is not a date` : 'No inspection date' }); return; }
    if (date > today) { skipped.push({ row, serial, reason: `${date} is in the future` }); return; }

    let result = null;
    if (map.result) {
      result = resultOf(get(r, 'result'));
      if (!result) {
        skipped.push({ row, serial, reason: `Result "${get(r, 'result')}" is not pass or fail` });
        return;
      }
    }

    const key = squeeze(serial) + '|' + date;
    if (seen.has(key)) {
      skipped.push({ row, serial, reason: `Same item and date as row ${seen.get(key)}` });
      return;
    }
    seen.set(key, row);

    const typeText = get(r, 'equipment_type');
    const slug = TYPES[words(typeText)] || null;
    if (typeText && !slug) unknown.set(typeText, (unknown.get(typeText) || 0) + 1);

    rows.push(Object.assign({
      row, serial, inspection_date: date, result,
      equipment_type: slug || typeText || null,
      manufacturer: get(r, 'manufacturer') || null,
      model: get(r, 'model') || null,
      mfr_serial: get(r, 'mfr_serial') || null,
      lot_number: get(r, 'lot_number') || null,
      tag_label: get(r, 'tag_label') || null,
      inspector: get(r, 'inspector') || null,
      work_order_id: get(r, 'work_order_id') || null,
      reason: get(r, 'reason') || null,
      description: get(r, 'description') || null,
      notes: get(r, 'notes') || null,
    }, mfgParts(get(r, 'mfg_date'), mfgOrder)));
  });

  return {
    rows, skipped, map, unmapped, missing,
    dateOrder: order,
    needsResultConfirm: !map.result,
    // The server knows our own type names too (fp_type_for), so these are only
    // "might not be known" — the preview says which ones will be checked.
    unknownTypes: [...unknown.entries()].map(([text, count]) => ({ text, count })),
  };
}

// The template offered from the import screen.
const SAMPLE = [
  'Serial #,Inspection Date,Result,Type,Manufacturer,Model,Manufacturer Serial,Lot #,Date of Manufacture,Tag #,Inspector,Work Order #,Reason,Notes',
  'BAT-1001,2025-03-12,Pass,Body harness,MSA,V-FORM,MSA-20219988,L2104,06/2021,FP170001,J. Ortiz,WO-2231,,',
  'BAT-1002,2025-03-12,Pass,Lanyard,3M,1246167,,,2022,,J. Ortiz,WO-2231,,',
  'BAT-1003,2025-03-12,Fail,SRL,Miller,MFL-1,,,,,J. Ortiz,WO-2231,Housing cracked,Tagged out',
].join('\r\n');

module.exports = { parseFpHistory, mapHeaders, toIso, slashOrder, mfgParts, resultOf, SAMPLE, TYPES };
