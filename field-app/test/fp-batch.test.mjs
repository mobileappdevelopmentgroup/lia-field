// Tap-through: the second way techs work a rack. Single tap is unchanged and
// tested in fp-capture; this covers the batch run — a pass per tap with no form
// in between, and every way a run is made to stop.
//
// Served over HTTP because the run leans on IndexedDB (the catalogue) and
// fetch (config.json), neither of which works under file://.
//
// Run via `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.png':'image/png' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.endsWith('config.json')) { res.writeHead(404); return res.end(); }
  const file = path.join(ROOT, 'field-app', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(ROOT, 'field-app')) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = 'http://127.0.0.1:' + server.address().port + '/';

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error' && !/404 \(Not Found\)/.test(m.text())) errs.push('console: ' + m.text()); });
let fails = 0;
const ok = (l,g,w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

// A stand-in for @exxili/capacitor-nfc, installed before any page script runs
// so the Tap-through button is wired the way it is on a real handset. Reports
// android, where the stream needs no re-arming.
await p.addInitScript(() => {
  const listeners = {};
  window.__nfc = { started: 0, cancelled: 0 };
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: { NFC: {
      startScan: async () => { window.__nfc.started++; throw new Error("Android NFC scanning does not require 'startScan' method."); },
      cancelScan: () => { window.__nfc.cancelled++; return Promise.reject(new Error('not implemented')); },
      writeNDEF: async () => {},
      addListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn);
        return Promise.resolve({ remove: () => { listeners[name] = (listeners[name]||[]).filter(f => f !== fn); } }); },
    } },
  };
  // Raw NDEF payloads, base64'd, exactly as the plugin delivers them.
  const b64 = a => btoa(String.fromCharCode.apply(null, a));
  const u8 = s => Array.from(new TextEncoder().encode(s));
  window.__tap = (opts) => {
    const records = [];
    if (opts.url) records.push({ type: 'U', payload: b64([0x04].concat(u8(opts.url.replace(/^https:\/\//,'')))) });
    if (opts.serial) records.push({ type: 'T', payload: b64([0x02].concat(u8('en'), u8(opts.serial))) });
    (listeners.nfcTag || []).forEach(fn => fn({
      messages: records.length ? [{ records }] : [],
      tagInfo: opts.uid ? { uid: opts.uid } : undefined,
    }));
  };
  window.__liveListeners = () => (listeners.nfcTag || []).length;
});

await p.goto(BASE);
await p.waitForTimeout(400);

// Seed the on-device catalogue: three items with types, one with no type.
await p.evaluate(async () => {
  await LiaCache.status();                       // creates the v2 schema
  const db = await new Promise(r => { const q = indexedDB.open('lia-field'); q.onsuccess = () => r(q.result); });
  await new Promise((res, rej) => {
    const t = db.transaction(['assets','meta'], 'readwrite');
    const s = t.objectStore('assets');
    s.put({ asset_id:'a1', serial_key:'H1', serial_raw:'H-1', kind:'fall_protection',
            tag_key:'04A1B2C3', public_ref:'REF0000001', item_type:'Body harness', manufacturer:'MSA', model:'V-FIT' });
    s.put({ asset_id:'a2', serial_key:'H2', serial_raw:'H-2', kind:'fall_protection',
            tag_key:'', public_ref:'REF0000002', item_type:'Lanyard', manufacturer:'MSA' });
    s.put({ asset_id:'a3', serial_key:'H3', serial_raw:'H-3', kind:'fall_protection',
            tag_key:'', public_ref:'REF0000003', item_type:'', manufacturer:'MSA' });
    t.objectStore('meta').put({ key:'sync', since:'2026-01-01T00:00:00Z', at:new Date().toISOString(), count:3 });
    t.oncomplete = () => { db.close(); res(); };
    t.onerror = () => rej(t.error);
  });
});

await p.click('#btn-new-job'); await p.waitForTimeout(150);
await p.click('.scope-opt[data-scope="fall_protection"]'); await p.waitForTimeout(300);

// ── Both ways stay on offer ─────────────────────────────────────────────────
ok('single tap is still one of the four ways',
   await p.$$eval('.fp-way', e => e.map(x => x.textContent.trim())), ['Tap','Scan','Type','New']);
ok('and tap-through is offered alongside it, not instead',
   await p.$eval('#fp-btn-batch', e => e.style.display !== 'none'), true);

// ── A run ───────────────────────────────────────────────────────────────────
await p.click('#fp-btn-batch'); await p.waitForTimeout(150);
ok('starting a run takes over the input bar', await p.evaluate(() => ({
     input: $('fp-input-panel').style.display !== 'none',
     batch: $('fp-batch-panel').style.display !== 'none',
   })), { input:false, batch:true });
ok('a listener is live', await p.evaluate(() => window.__liveListeners()), 1);
ok('and Android is not asked to re-arm',
   await p.$eval('#fp-btn-batch-arm', e => e.style.display), 'none');

await p.evaluate(() => window.__tap({ serial:'H-1', url:'https://lia.test/fp/?t=REF0000001', uid:'04:A1:B2:C3' }));
await p.waitForTimeout(250);
ok('a tap records the item with no form in between', await p.evaluate(() => _job.items.length), 1);
const first = await p.evaluate(() => _job.items[0]);
ok('as a pass', first.overall_pass, true);
ok('against the checklist for its type', first.item_type, 'Body harness');
ok('with every check answered at its passing answer',
   first.checks.every(c => c.answer === c.pass_answer), true);
ok('and recorded as a batch pass, not as answered on screen', first.source, 'field_batch');
ok('the run counts it', await p.$eval('#fp-batch-count', e => e.textContent), '1 recorded');

// A tag left against the phone fires repeatedly; that is one presentation.
await p.evaluate(() => { window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' }); window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' }); });
await p.waitForTimeout(250);
ok('a tag held against the phone is not recorded twice',
   await p.evaluate(() => _job.items.length), 1);

// Resolvable by the certificate code alone — no serial record on the tag.
await p.evaluate(() => window.__tap({ url:'https://lia.test/fp/?t=REF0000002' }));
await p.waitForTimeout(250);
ok('a url-only tag resolves through its certificate code',
   await p.evaluate(() => _job.items[0].serial_num), 'H-2');
ok('the run counts both', await p.$eval('#fp-batch-count', e => e.textContent), '2 recorded');

// ── Undo ────────────────────────────────────────────────────────────────────
ok('the queued upload holds both', await p.evaluate(() => LiaSync.queueLength()), 2);
await p.click('#fp-btn-batch-undo'); await p.waitForTimeout(200);
ok('undo takes the last one back out of the job', await p.evaluate(() => _job.items.length), 1);
ok('and out of the upload queue, so it cannot reach the server',
   await p.evaluate(() => LiaSync.queueLength()), 1);
ok('the count follows', await p.$eval('#fp-batch-count', e => e.textContent), '1 recorded');

// ── An item that cannot be passed honestly stops the run ────────────────────
await p.evaluate(() => window.__tap({ serial:'H-3' }));   // on file, but no equipment type
await p.waitForTimeout(300);
ok('an item with no equipment type stops the run rather than passing it',
   await p.evaluate(() => ({ batch: $('fp-batch-panel').style.display !== 'none',
                             checks: $('fp-checks-panel').style.display !== 'none' })),
   { batch:false, checks:true });
ok('and hands it to the ordinary screen, filled in',
   await p.evaluate(() => _fpItem.serial_raw), 'H-3');
ok('the run is paused, not ended', await p.evaluate(() => !!_fpBatch), true);
ok('with its reader released while the tech is off it',
   await p.evaluate(() => window.__liveListeners()), 0);

// Give it a type and pass it; the run picks up where it left off.
await p.selectOption('#fpf-equipment_type', await p.evaluate(() => LiaFpTypes.all()[0].slug));
await p.waitForTimeout(150);
await p.click('#fp-btn-save'); await p.waitForTimeout(300);
ok('finishing that item returns to the run', await p.evaluate(() => ({
     batch: $('fp-batch-panel').style.display !== 'none', live: window.__liveListeners() })),
   { batch:true, live:1 });
ok('and it was recorded as answered on screen, not as a batch pass',
   await p.evaluate(() => _job.items[0].source), 'field');

// ── Fail last: a pass already recorded, taken back to be failed properly ─────
await p.evaluate(() => window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' }));
await p.waitForTimeout(250);
const beforeFail = await p.evaluate(() => ({ items:_job.items.length, queue:LiaSync.queueLength() }));
await p.click('#fp-btn-batch-fail'); await p.waitForTimeout(300);
ok('failing the last one withdraws the pass it already recorded',
   await p.evaluate(() => _job.items.length), beforeFail.items - 1);
ok('and unqueues it, so no upload can claim it passed',
   await p.evaluate(() => LiaSync.queueLength()), beforeFail.queue - 1);
ok('putting the item back on the checks with its type intact',
   await p.evaluate(() => ({ checks: $('fp-checks-panel').style.display !== 'none',
                             serial: _fpItem.serial_raw, type: _fpItem.item_type })),
   { checks:true, serial:'H-1', type:'Body harness' });
ok('every check still starts at passing — only the tech fails one',
   await p.evaluate(() => _fpChecks.every(c => c.answer === c.pass_answer)), true);
// Fail a check, and it becomes a removal rather than a pass.
await p.evaluate(() => { const b = document.querySelectorAll('#fp-checks-list .fp-seg')[0].querySelectorAll('button');
  (_fpChecks[0].pass_answer ? b[1] : b[0]).click(); });
await p.waitForTimeout(150);
ok('which turns the save into a removal', await p.$eval('#fp-btn-save', e => e.textContent.trim()),
   'Add Photo & Remove →');
await p.click('#fp-btn-batch-stop').catch(() => {});
await p.evaluate(() => { _fpBatch = null; _fpItem = null; _fpChecks = []; fpRenderAll(); });
await p.waitForTimeout(150);
await p.click('#fp-btn-batch'); await p.waitForTimeout(200);

// ── An unknown tag: flagged, with its link kept and shown ────────────────────
await p.evaluate(() => window.__tap({ url:'https://lia.test/fp/?t=ZZZZZZZZZZ', uid:'DE:AD:BE:EF' }));
await p.waitForTimeout(400);
ok('a tag matching nothing stops the run',
   await p.evaluate(() => $('fp-batch-panel').style.display !== 'none'), false);
ok('and says so rather than silently passing it',
   await p.$eval('#fp-hint', e => /not on file/i.test(e.textContent)), true);
ok('keeping the link off the tag and showing it to the tech',
   await p.$eval('#fp-hint', e => e.textContent.includes('https://lia.test/fp/?t=ZZZZZZZZZZ')), true);
ok('the tech can pass or fail it from there',
   await p.evaluate(() => $('fp-checks-panel').style.display !== 'none'), true);
ok('with the tag id carried across so it is on file next time',
   await p.evaluate(() => _fpItem.nfc_tag_uid), 'DEADBEEF');

// ── A third-party tag: a link into somebody else's system ───────────────────
// The commonest tag on a customer's existing rack. It carries no serial we
// know, no certificate code, and a link we may or may not be able to read — and
// the app must not invent an identifier for it. The host here is not trusted, so
// nothing is fetched: that is the ordinary web outcome, and the decision still
// has to reach the tech.
await p.evaluate(() => { fpBatchStop(false); _fpItem = null; _fpChecks = []; _fpLink = null; fpRenderAll(); });
await p.waitForTimeout(150);
await p.click('#fp-btn-batch'); await p.waitForTimeout(200);
await p.evaluate(() => window.__tap({ url:'https://acme.example/tag/FP158354', uid:'AB:CD:EF:01' }));
await p.waitForTimeout(500);

ok('a foreign link stops the run and asks the tech',
   await p.evaluate(() => !$('fp-link-sheet').classList.contains('hidden')), true);
ok('showing him the link, which is the one thing he can act on unaided',
   await p.$eval('#fp-link-body', e => e.textContent.includes('https://acme.example/tag/FP158354')), true);
ok('and saying plainly that nothing was fetched from an untrusted source',
   await p.$eval('#fp-link-body', e => /not a trusted source/i.test(e.textContent)), true);
// All three outcomes the tech is offered must be live, or the sheet is a trap.
ok('with all three decisions available',
   await p.evaluate(() => ['fp-btn-link-inspect','fp-btn-link-save','fp-btn-link-ignore']
     .map(id => !$(id).disabled)), [true, true, true]);

// "Save the link only": the pairing is kept so the next tap resolves, and
// nothing is recorded as an inspection.
const beforeLink = await p.evaluate(() => ({ items: _job.items.length, queue: LiaSync.queueLength() }));
await p.click('#fp-btn-link-save'); await p.waitForTimeout(300);
ok('saving the link records no inspection',
   await p.evaluate(() => _job.items.length), beforeLink.items);
ok('but does queue the link, so the next tap on it resolves',
   await p.evaluate(() => LiaSync.queueLength()), beforeLink.queue + 1);
ok('as its own kind of record, not as an inspection',
   await p.evaluate(() => JSON.parse(localStorage.getItem('lia-upload-queue')).pop().kind), 'fp_tag_link');
ok('and the run picks back up',
   await p.evaluate(() => $('fp-batch-panel').style.display !== 'none'), true);

// "Inspect this item": the ordinary screen, carrying the link — and NOT the
// hardware uid in the serial box, which is the bug this whole path exists to
// stop. A uid is printed nowhere on the item.
await p.evaluate(() => window.__tap({ url:'https://acme.example/tag/OTHER', uid:'11:22:33:44' }));
await p.waitForTimeout(500);
await p.click('#fp-btn-link-inspect'); await p.waitForTimeout(300);
ok('inspecting it opens the fields', await p.evaluate(() => $('fp-edit-form').style.display !== 'none'), true);
ok('with the serial box EMPTY rather than holding the hardware id',
   await p.evaluate(() => _fpItem.serial_raw), '');
ok('the link carried onto the record',
   await p.evaluate(() => _fpItem.tag_url), 'https://acme.example/tag/OTHER');
ok('and the tag id kept too', await p.evaluate(() => _fpItem.nfc_tag_uid), '11223344');

await p.evaluate(() => { fpBatchStop(false); _fpItem = null; _fpChecks = []; _fpLink = null; fpRenderAll(); });
await p.waitForTimeout(150);

// ── A run cannot outlive the screen it belongs to ───────────────────────────
// Left armed, the reader keeps firing into a job the tech has left — and on
// iOS leaves Apple's sheet up over whatever he moved to.
// The previous flag left a run paused; clear it and start a clean one.
await p.evaluate(() => { fpBatchStop(false); _fpItem = null; _fpChecks = []; fpRenderAll(); });
await p.waitForTimeout(150);
await p.click('#fp-btn-batch'); await p.waitForTimeout(200);
ok('a run is live before leaving', await p.evaluate(() => ({
     live: window.__liveListeners(), batch: !!_fpBatch })), { live:1, batch:true });
await p.evaluate(() => goScreen('jobs')); await p.waitForTimeout(200);
ok('leaving the job ends the run and releases the reader',
   await p.evaluate(() => ({ live: window.__liveListeners(), batch: !!_fpBatch })),
   { live:0, batch:false });
ok('and puts the batch panel away',
   await p.evaluate(() => $('fp-batch-panel').style.display), 'none');

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close(); server.close();
process.exit(fails || errs.length ? 1 : 0);
