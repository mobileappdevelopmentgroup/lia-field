// The end of a Lia Office ladder import, run through the real electron/main.cjs.
//
// From 2026-09-21 the 'complete' handler read `_billable`, a const declared
// inside a try block it could not see. The ReferenceError was swallowed by a
// catch meant for non-JSON lines, so no import was charged or recorded, and
// nothing on screen said so. Unit tests of the helpers could not have caught
// it — this loads main.cjs itself with Electron, the runner process and
// Supabase faked, plays a finished run into it, and checks what reached the
// "server" and what the screen was told.
//
// Pure Node: `node electron/test/import-complete.test.mjs`.
import { createRequire, register } from 'module';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lia-complete-'));
const csv = path.join(tmp, 'wo.csv');
fs.writeFileSync(csv, 'Row#,Serial #,Location ID,Brand,Type,Length,Description\n' +
                      '1,1509436,1,LG,Ext,28,\n2,1669421,1,LG,Ext,28,\n');

// ── The fake server ──────────────────────────────────────────────────────────
const calls = [];
globalThis.__liaFakeSb = {
  auth: {
    getSession: async () => ({ data: { session: { user: { email: 'nate@example.com' } } } }),
    setSession: async () => ({ data: {}, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  async rpc(name, args) {
    calls.push([name, args]);
    if (name === 'get_my_profile') return { data: { name: 'Nate Dobbs' }, error: null };
    if (name === 'my_context') {
      if (globalThis.__liaCtxError) return { data: null, error: { message: globalThis.__liaCtxError } };
      return { data: globalThis.__liaCtx || { account_id: 'acct-nate', account_name: 'Nate Dobbs' }, error: null };
    }
    if (name === 'preflight_work_order') return { data: { can_run: true, credits: -1 }, error: null };
    if (name === 'charge_work_order') return { data: { charged: true, credits: -1 }, error: null };
    if (name === 'record_inspections') return { data: args.p.length, error: null };
    return { data: null, error: null };
  },
  // Reads: `inspections` answers from globalThis.__liaExisting, filtered by
  // the serials asked for, so "already recorded" is computed for real.
  from(table) {
    const q = { table, serials: null,
      select() { return this; }, eq() { return this; },
      in(col, list) { this.serials = list; return this; },
      maybeSingle: async () => ({ data: null }),
      then(res, rej) {
        const rows = table === 'inspections'
          ? (globalThis.__liaExisting || []).filter(r => !this.serials || this.serials.includes(r.serial_num)) : [];
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      } };
    return q;
  },
};
// getSupabase() does `await import('@supabase/supabase-js')`; send that here.
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === '@supabase/supabase-js')
      return { url: 'data:text/javascript,export const createClient = () => globalThis.__liaFakeSb;', shortCircuit: true };
    return next(spec, ctx);
  }`), pathToFileURL(HERE + '/'));

// ── Fake Electron and a fake runner process ─────────────────────────────────
const handlers = {};
const sent = [];
const win = {
  isDestroyed: () => false, show() {}, focus() {}, loadFile() {}, on() {}, once() {},
  webContents: { send: (ch, v) => sent.push([ch, v]), on() {}, setZoomFactor() {}, getZoomFactor: () => 1 },
};
const anything = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'then' ? undefined : anything()),
  apply: () => anything(),
  construct: () => anything(),
});
const electron = {
  app: new Proxy({
    getPath: () => tmp, isPackaged: false, whenReady: () => new Promise(() => {}),
    on() {}, focus() {}, getVersion: () => 'test',
  }, { get: (t, k) => (k in t ? t[k] : anything()) }),
  ipcMain: { on: (ch, fn) => { handlers[ch] = fn; }, handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler() {} },
  BrowserWindow: anything(), dialog: anything(), session: anything(), shell: anything(),
  Menu: anything(), nativeTheme: anything(),
};
let child, forkEnv;
const Module = require('module');
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return electron;
  if (req === 'child_process') return { fork: (_p, _a, opts) => {
    forkEnv = opts && opts.env;
    child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { write() {} }; child.kill = () => {};
    return child;
  } };
  return realLoad.apply(this, arguments);
};

process.env.LIA_MAIN_TEST = '1';
process.resourcesPath = tmp;   // Electron sets this; plain Node does not
require(path.join(HERE, '..', 'main.cjs'));
Module._load = realLoad;

// main only talks to the window it created; give it ours.
const mainSrc = fs.readFileSync(path.join(HERE, '..', 'main.cjs'), 'utf8');
ok('main keeps its window in `mainWindow`', /let mainWindow\b/.test(mainSrc), true);

// ── Play a run ───────────────────────────────────────────────────────────────
async function playRun(workOrderId, success) {
  calls.length = 0; sent.length = 0; child = null;
  await handlers['automation:start']({ sender: win.webContents }, csv, workOrderId);
  for (let i = 0; i < 50 && !child; i++) await new Promise(r => setTimeout(r, 10));
  if (!child) throw new Error('the runner was never started');
  child.stdout.emit('data', Buffer.from('not json at all\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'complete', success }) + '\n'));
  for (let i = 0; i < 100 && !sent.some(s => s[0] === 'automation:records') && success; i++)
    await new Promise(r => setTimeout(r, 10));
}

// main.cjs sets mainWindow when the app is ready, which this harness never
// is. The handler checks it before sending, so hand it the fake window
// through the one hook main exposes for tests.
if (typeof globalThis.__liaSetMainWindow === 'function') globalThis.__liaSetMainWindow(win);
else { console.log('FAIL main.cjs does not expose __liaSetMainWindow for tests'); fails++; }

await playRun('98378', true);
const names = () => calls.map(c => c[0]);
ok('a finished import is charged', names().includes('charge_work_order'), true);
ok('and its ladders are recorded', names().includes('record_inspections'), true);
const recs = (calls.find(c => c[0] === 'record_inspections') || [, { p: [] }])[1].p;
ok('both ladders, on that work order', recs.map(r => [r.serial_num, r.work_order_id]),
   [['1509436', '98378'], ['1669421', '98378']]);
ok('the runner is told the work order and account, to save in its log',
   JSON.parse(forkEnv.LIA_RUN_META), { workOrderId: '98378', accountId: 'acct-nate', accountName: 'Nate Dobbs', techName: 'Nate Dobbs' });
const rec = sent.find(s => s[0] === 'automation:records');
ok('the screen is told what was saved', rec && [rec[1].written, rec[1].failed], [2, 0]);
ok('no internal error was reported',
   sent.filter(s => s[0] === 'automation:log' && /Internal error/.test(s[1])).map(s => s[1]), []);

await playRun('98379', false);
ok('a failed import is neither charged nor recorded',
   names().filter(n => n === 'charge_work_order' || n === 'record_inspections'), []);

// ── Recover Past Imports ─────────────────────────────────────────────────────
// A run log in this "computer's" Documents/Lia Logs, from an import that was
// never recorded. One of its ladders was since sent by a phone that day.
const logs = path.join(tmp, 'Lia Logs');
fs.mkdirSync(logs, { recursive: true });
const runName = 'run-2026-09-26T14-05-00.json';
fs.writeFileSync(path.join(logs, runName), JSON.stringify({ ladderResults: [
  { serialNum: '1509436', status: 'success' }, { serialNum: '1669421', status: 'partial' },
  { serialNum: '1700001', status: 'skipped' }, { serialNum: '1700002', status: 'error' } ] }));
const runDate = require(path.join(HERE, '..', 'office-records.cjs')).localDate(new Date('2026-09-26T14:05:00Z'));
globalThis.__liaExisting = [{ serial_num: '1509436', inspection_date: runDate }];

calls.length = 0;
let list = await handlers['recover:list']();
const row = list.runs && list.runs.find(r => r.name === runName);
ok('the run is listed with what went in, what is already there and what is missing',
   row && [row.imported, row.already, row.todo, row.recovered], [2, 1, 1, null]);

ok('a path is refused, not read', (await handlers['recover:record']({}, { name: '../../etc/passwd', workOrderId: '1' })).ok, false);
ok('no work order, nothing sent', [(await handlers['recover:record']({}, { name: runName, workOrderId: ' ' })).ok,
   calls.some(c => c[0] === 'record_inspections')], [false, false]);

const rr = await handlers['recover:record']({}, { name: runName, workOrderId: '98742' });
ok('recording sends only the missing ladder', [rr.ok, rr.written, rr.already], [true, 1, 1]);
const sentRecs = calls.filter(c => c[0] === 'record_inspections').flatMap(c => c[1].p);
ok('on the day of the import, under the typed work order, marked recovered',
   sentRecs.map(x => [x.serial_num, x.inspection_date, x.work_order_id, x.source]),
   [['1669421', runDate, '98742', 'office:recovered']]);

globalThis.__liaExisting.push({ serial_num: '1669421', inspection_date: runDate });
list = await handlers['recover:list']();
const after = list.runs.find(r => r.name === runName);
ok('afterwards it shows as on record, with the work order it went under',
   [after.todo, after.recovered && after.recovered.work_order, after.recovered && after.recovered.account],
   [0, '98742', 'Nate Dobbs']);

// ── The automatic check ──────────────────────────────────────────────────────
const lad = (serialNum) => ({ serialNum, status: 'success' });
const meta = (accountId, workOrderId) => ({ accountId, workOrderId, accountName: 'x', techName: 'Office Tech' });
fs.writeFileSync(path.join(logs, 'run-2026-11-20T15-00-00.json'),       // new log, this account
  JSON.stringify({ ladderResults: [lad('2000001')], lia: meta('acct-nate', '99001') }));
fs.writeFileSync(path.join(logs, 'run-2026-11-20T16-00-00.json'),       // new log, another account
  JSON.stringify({ ladderResults: [lad('2000002')], lia: meta('acct-mike', '99002') }));
fs.writeFileSync(path.join(logs, 'run-2026-10-05T15-00-00.json'),       // old log, in the lost window
  JSON.stringify({ ladderResults: [lad('2000003'), lad('2000004')] }));
fs.writeFileSync(path.join(logs, 'run-2026-06-13T15-00-00.json'),       // old log, before it
  JSON.stringify({ ladderResults: [lad('2000005')] }));
const d1005 = require(path.join(HERE, '..', 'office-records.cjs')).localDate(new Date('2026-10-05T15:00:00Z'));
// 2000004 was deleted by hand (a test import) the day after; it must stay deleted.
const next = new Date(d1005 + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
globalThis.__liaExisting.push({ serial_num: '2000004', inspection_date: next.toISOString().slice(0, 10), is_deleted: true });

calls.length = 0;
ok('while an import is running the check stands aside', (await handlers['recover:auto']()).skipped, 'import running');
child.emit('exit', 0);                 // the last run's runner finishes

const autoSent = () => calls.filter(c => c[0] === 'record_inspections').flatMap(c => c[1].p)
  .map(x => [x.serial_num, x.work_order_id || '', x.tech_name]).sort();
calls.length = 0;
let auto = await handlers['recover:auto']();
ok('the check records only what belongs to the account in use, and nothing deleted or too old',
   autoSent(), [['2000001', '99001', 'Office Tech'], ['2000003', '', 'Nate Dobbs']]);
ok('and says what it did', [auto.ok, auto.runs, auto.written, auto.waiting], [true, 2, 2, 2]);

calls.length = 0;
auto = await handlers['recover:auto']();
ok('a second check does not go over settled runs again', [autoSent(), auto.checked], [[], 2]);

globalThis.__liaCtx = { account_id: 'acct-mike', account_name: 'Michael' };
calls.length = 0;
auto = await handlers['recover:auto']();
ok('acting as the other account picks up its import', autoSent(), [['2000002', '99002', 'Office Tech']]);

globalThis.__liaCtx = { account_id: 'acct-batavia', account_name: 'Batavia', acting_is_umbrella: true };
fs.writeFileSync(path.join(logs, 'run-2026-10-06T15-00-00.json'), JSON.stringify({ ladderResults: [lad('2000006')] }));
calls.length = 0;
await handlers['recover:auto']();
ok('an umbrella does not take an old log it cannot place', autoSent(), []);

globalThis.__liaCtxError = 'network down';
auto = await handlers['recover:auto']();
ok('a failing check reports it and throws nothing', [auto.ok, auto.error], [false, 'network down']);
globalThis.__liaCtxError = null;
auto = await handlers['recover:auto']();
ok('and the next one runs normally', auto.ok, true);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nAll import-complete assertions passed.');
process.exit(fails ? 1 : 0);
