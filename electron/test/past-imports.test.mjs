// Reading old run logs to recover imports whose ladders were never recorded
// (electron/past-imports.cjs). Real files, shaped like the ones in
// ~/Documents/Lia Logs. Pure Node: `node electron/test/past-imports.test.mjs`.
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const P = require('../past-imports.cjs');

let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lia-logs-'));
const lad = (serialNum, status) => ({ serialNum, status, partsTotal: 1, partsOk: 1, partResults: [] });
const write = (name, obj) => fs.writeFileSync(path.join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));

// 2026-09-26 14:05 UTC — a morning import in Pennsylvania.
write('run-2026-09-26T14-05-00.json', { totalLadders: 6, ladderResults: [
  lad('1509436', 'success'), lad('1669421', 'partial'), lad('1700001', 'skipped'),
  lad('1700002', 'error'), lad(' 1509436 ', 'success'), lad('', 'success'),
] });
// 2026-10-01 02:30 UTC is still 2026-09-30 in the evening in the US.
write('run-2026-10-01T02-30-00.json', { ladderResults: [lad('1800001', 'success')] });
write('run-2026-10-02T10-00-00.json', '{"ladderResults": [');   // cut short
write('notes.txt', 'not a log');
write('run-latest.json', '{}');

// ── One run ──────────────────────────────────────────────────────────────────
const r = P.readRun(path.join(dir, 'run-2026-09-26T14-05-00.json'));
ok('the time comes from the file name, as UTC', r.startedAt, '2026-09-26T14:05:00.000Z');
ok('counted by what happened to each box', r.counts, { success: 3, partial: 1, skipped: 1, error: 1 });
ok('only ladders whose box went in, once each, trimmed', r.serials, ['1509436', '1669421']);

// The test runs in whatever zone this machine is in; compare with the same
// local-date rule the module uses rather than hard-coding one zone.
const local = iso => { const d = new Date(iso); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const evening = P.readRun(path.join(dir, 'run-2026-10-01T02-30-00.json'));
ok('the inspection date is the local day of the run', evening.date, local('2026-10-01T02:30:00Z'));

// ── The folder ───────────────────────────────────────────────────────────────
const runs = P.listRuns(dir);
ok('only run logs, newest first, a damaged one marked rather than dropped',
   runs.map(x => [x.name, !!x.unreadable]),
   [['run-2026-10-02T10-00-00.json', true], ['run-2026-10-01T02-30-00.json', false], ['run-2026-09-26T14-05-00.json', false]]);
ok('no folder is no runs', P.listRuns(path.join(dir, 'nope')), []);
ok('a name that is not a run log is refused', [P.runTime('../x.json'), P.runTime('run-latest.json')], [null, null]);

// ── What is still missing ────────────────────────────────────────────────────
const plan = P.plan(r, [
  { serial_num: '1509436', inspection_date: r.date },           // a phone sent it that day
  { serial_num: '1669421', inspection_date: '2025-09-26' },     // last year's does not count
]);
ok('a ladder with a record that day is left alone; another day does not count', plan, { todo: ['1669421'], already: ['1509436'] });

const recs = P.recordsFor(r, plan.todo, ' 98742 ', 'Nate Dobbs');
ok('recorded on the run\'s day, the typed work order, marked as recovered',
   recs.map(x => [x.serial_num, x.inspection_date, x.work_order_id, x.source, x.tech_name]),
   [['1669421', r.date, '98742', 'office:recovered', 'Nate Dobbs']]);

// ── Done on this computer ────────────────────────────────────────────────────
const led = path.join(dir, 'state', 'recovered-runs.json');
ok('nothing recovered yet', P.readLedger(led), {});
P.markRecovered(led, r.name, { work_order: '98742', written: 1 });
ok('a recovered run is remembered with its work order',
   P.readLedger(led)[r.name], { work_order: '98742', written: 1 });

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nAll past-imports assertions passed.');
process.exit(fails ? 1 : 0);
