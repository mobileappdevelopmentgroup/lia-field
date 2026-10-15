// Deleting a ladder line used to splice the list and nothing else, so a ladder
// still waiting in the upload queue went up anyway. Drives the real page.
// Run with `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 700 } });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{ if(m.type()==='error') errs.push('console: '+m.text()); });
let fails=0;
const ok=(l,g,w)=>{const good=JSON.stringify(g)===JSON.stringify(w); if(!good)fails++;
  console.log((good?'ok  ':`FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `)+l);};

await p.goto('file://' + ROOT + '/field-app/index.html');
await p.waitForTimeout(400);
await p.click('#btn-new-job'); await p.waitForTimeout(150);
await p.click('.scope-opt[data-scope="ladder"]').catch(()=>{}); await p.waitForTimeout(300);

// Three ladders, each captured and queued the way addLadder does it.
await p.evaluate(()=>{
  const mk = (sn, desc) => ({ id: 'L-' + sn + '-' + Math.random().toString(36).slice(2, 6),
    serialNum: sn, desc, parts: [], flags: {}, capturedAt: new Date().toISOString() });
  _job.ladders = [mk('A100', ''), mk('B200', ''), mk('B200', '')];
  _job.ladders.forEach(l => window.LiaSync.enqueue({ clientId: l.id, kind: 'ladder', payload: ladderPayload(l) }));
  renderLadderList();
});
const inQueue = id => p.evaluate(id => window.LiaSync._readQueue().filter(e => e.clientId === id).length, id);
const ids = await p.evaluate(()=>_job.ladders.map(l=>l.id));

// Not uploaded: Delete takes it out of the queue too.
ok('A100 is waiting to upload', await inQueue(ids[0]), 1);
await p.click('.ladder-card:nth-child(1) .lc-body'); await p.waitForTimeout(100);
await p.click('.ladder-card:nth-child(1) .lc-del'); await p.waitForTimeout(150);
ok('it is gone from the list', await p.evaluate(()=>_job.ladders.map(l=>l.serialNum)), ['B200', 'B200']);
ok('and from the upload queue', await inQueue(ids[0]), 0);
ok('the others are still queued', [await inQueue(ids[1]), await inQueue(ids[2])], [1, 1]);
ok('and the job on disk agrees', await p.evaluate(()=>{ saveNow(); return loadJobs()[_job.id].ladders.length; }), 2);

// Uploaded, and the only copy: it stays, and the tech is told who deletes it.
await p.evaluate(()=>{ window.LiaSync._writeQueue ? window.LiaSync._writeQueue([]) : null;
  _job.ladders.forEach(l => { window.LiaSync.dequeue(l.id); window.LiaSyncState.markSent(l.id); }); });
await p.evaluate(()=>{ _job.ladders[1].serialNum = 'C300'; renderLadderList(); });
ok('an uploaded one-off is not deleted from the phone', await p.evaluate(()=>deleteLadder(1)), 'uploaded');
ok('it is still listed', await p.evaluate(()=>_job.ladders.length), 2);
ok('and the tech is told the office deletes it', await p.$eval('#save-status', e=>/Lia Office/.test(e.textContent)), true);

// Uploaded duplicate: goes. Identical copies send nothing again.
await p.evaluate(()=>{ _job.ladders[1].serialNum = 'B200'; });
ok('an uploaded duplicate is deleted', await p.evaluate(()=>deleteLadder(1)), 'duplicate');
ok('one B200 left', await p.evaluate(()=>_job.ladders.length), 1);
ok('nothing is sent again', await p.evaluate(()=>window.LiaSync._readQueue().length), 0);

// The deleted copy landed last and said something different: the kept one goes up again.
await p.evaluate(()=>{
  const keep = _job.ladders[0];
  const later = { ...keep, id: 'L-later', desc: 'cracked rail' };
  _job.ladders.push(later);
  window.LiaSyncState.markSent(later.id);
});
ok('deleting the later, different copy', await p.evaluate(()=>deleteLadder(1)), 'duplicate');
ok('re-sends the one kept', await p.evaluate(()=>window.LiaSync._readQueue().map(e=>e.clientId)),
   await p.evaluate(()=>[_job.ladders[0].id]));

// Deleting a ladder above the one being edited must not move the edit onto another ladder.
await p.evaluate(()=>{
  window.LiaSync._readQueue().forEach(e=>window.LiaSync.dequeue(e.clientId));
  _job.ladders = [{ id: 'E1', serialNum: 'E1', parts: [], flags: {}, capturedAt: new Date().toISOString() },
                  { id: 'E2', serialNum: 'E2', parts: [], flags: {}, capturedAt: new Date().toISOString() }];
  editLadder(1);
  deleteLadder(0);
});
ok('the edit still points at the ladder being edited', await p.evaluate(()=>_job.ladders[_editingIdx].id), 'E2');
await p.evaluate(()=>deleteLadder(_editingIdx));
ok('deleting the ladder being edited ends the edit', await p.evaluate(()=>_editingIdx), -1);

console.log('\npage errors:', errs.length?errs:'none');
console.log(fails?`RESULT: ${fails} failure(s)`:'RESULT: all passed');
await b.close();
process.exit(fails||errs.length?1:0);
