// Field reports, 2026-10-14: a fall-protection line entered twice could not be
// deleted, and the removal sheet's photo and Confirm buttons could not be
// scrolled to. Drives the real page on a phone-sized screen.
// Run with `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 600 } });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{ if(m.type()==='error') errs.push('console: '+m.text()); });
let fails=0;
const ok=(l,g,w)=>{const good=JSON.stringify(g)===JSON.stringify(w); if(!good)fails++;
  console.log((good?'ok  ':`FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `)+l);};

await p.goto('file://' + ROOT + '/field-app/index.html');
await p.waitForTimeout(400);
await p.click('#btn-new-job'); await p.waitForTimeout(150);
await p.click('.scope-opt[data-scope="fall_protection"]'); await p.waitForTimeout(300);

async function startItem(serial, type) {
  await p.click('#fp-btn-new'); await p.waitForTimeout(150);
  await p.fill('#fpf-serial', serial);
  await p.selectOption('#fpf-equipment_type', type); await p.waitForTimeout(150);
  await p.click('#fp-btn-done-edit'); await p.waitForTimeout(150);
}
async function passItem(serial) {
  await startItem(serial, 'body_harness');
  await p.click('#fp-btn-save'); await p.waitForTimeout(250);
}

// ── Bug 2: everything on the removal sheet is reachable ─────────────────────
// Fail every check, so the reason above the photo is as long as it gets.
await startItem('H-FAIL', 'body_harness');
await p.evaluate(()=>document.querySelectorAll('.fp-chk').forEach(c=>{
  const isYesNo=[...c.querySelectorAll('.fp-seg button')].some(x=>x.textContent==='Yes');
  c.querySelector(isYesNo ? '[data-a="1"]' : '[data-a="0"]').click();
}));
await p.waitForTimeout(150);
await p.click('#fp-btn-save'); await p.waitForTimeout(250);
ok('the removal sheet opens', await p.evaluate(()=>!$('fp-condemn-sheet').classList.contains('hidden')), true);
// Make the reason longer than any screen, the case that hid the buttons.
await p.evaluate(()=>{ $('fp-condemn-why').textContent += ' ' + 'Frayed webbing at the dorsal D-ring. '.repeat(30); });

const reachable = id => p.evaluate(id => {
  const el = document.getElementById(id);
  el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
}, id);
ok('the sheet itself scrolls', await p.evaluate(()=>{
  const s=$('fp-condemn-sheet'); return s.scrollHeight > s.clientHeight;
}), true);
ok('the photo button can be brought on screen', await reachable('fp-btn-photo'), true);
ok('so can the note', await reachable('fp-condemn-note'), true);
ok('so can Confirm Removal', await reachable('fp-btn-confirm-condemn'), true);
ok('so can Back to checks', await reachable('fp-btn-cancel-condemn'), true);
ok('the sheet never runs past the bottom of the screen', await p.evaluate(()=>
  $('fp-condemn-sheet').getBoundingClientRect().bottom <= window.innerHeight + 0.5), true);
await p.click('#fp-btn-cancel-condemn'); await p.waitForTimeout(150);
await p.evaluate(()=>{ fpReset(); fpRenderAll(); });
await p.waitForTimeout(150);

// ── Bug 1: deleting a line ──────────────────────────────────────────────────
await passItem('H-200');
await passItem('H-100');
await passItem('H-100');           // the accidental second entry — newest, so first in the list
ok('three lines recorded', await p.evaluate(()=>_job.items.length), 3);

ok('Delete is hidden until a line is tapped', await p.evaluate(()=>
  document.querySelector('.fp-item .fp-item-actions').offsetHeight > 0), false);
await p.click('.fp-item:nth-child(1) .fp-item-top'); await p.waitForTimeout(100);
ok('tapping a line shows Delete', await p.evaluate(()=>
  document.querySelector('.fp-item:nth-child(1) .fp-item-actions').offsetHeight > 0), true);

// Not uploaded: one tap arms, the second deletes, and it leaves the queue.
const qOf = id => p.evaluate(id => window.LiaSync && window.LiaSync._readQueue
  ? window.LiaSync._readQueue().filter(e => e.clientId === id).length : 0, id);
await p.evaluate(()=>{ const it=_job.items[0];
  if (!window.LiaSync._readQueue().some(e=>e.clientId===it.id))
    window.LiaSync.enqueue({ clientId: it.id, kind: 'fall_protection', payload: fpToPayload(it) }); });
const firstId = await p.evaluate(()=>_job.items[0].id);
ok('the line is waiting to upload', await qOf(firstId), 1);
await p.click('.fp-item:nth-child(1) .fp-item-del'); await p.waitForTimeout(100);
ok('one tap only arms it', await p.evaluate(()=>_job.items.length), 3);
ok('and says so', await p.$eval('.fp-item:nth-child(1) .fp-item-del', e=>e.textContent), 'Tap again to delete');
await p.click('.fp-item:nth-child(1) .fp-item-del'); await p.waitForTimeout(150);
ok('the second tap deletes it', await p.evaluate(()=>_job.items.length), 2);
ok('it is out of the upload queue', await qOf(firstId), 0);
ok('and the job on disk agrees', await p.evaluate(()=>loadJobs()[_job.id].items.length), 2);

// Uploaded and unique: a live certificate is not hidden from the phone.
await p.evaluate(()=>_job.items.forEach(i=>window.LiaSyncState.markSent(i.id)));
const del = id => p.evaluate(id => fpDeleteItem(id), id);
const h200 = await p.evaluate(()=>_job.items.find(i=>i.serial_num==='H-200').id);
ok('an uploaded one-off is not deleted from the phone', await del(h200), 'uploaded');
ok('it is still listed', await p.evaluate(()=>_job.items.length), 2);
ok('and the tech is told the office deletes it', await p.$eval('#fp-hint', e=>/Lia Office/.test(e.textContent)), true);

// Uploaded duplicate: the server already holds one current record, so it goes.
await passItem('H-200');
await p.evaluate(()=>window.LiaSyncState.markSent(_job.items[0].id));
const dup = await p.evaluate(()=>_job.items[0].id);
const before = await p.evaluate(()=>window.LiaSync._readQueue().length);
ok('an uploaded duplicate is deleted', await del(dup), 'duplicate');
ok('one H-200 left', await p.evaluate(()=>_job.items.filter(i=>i.serial_num==='H-200').length), 1);
ok('identical copies send nothing again',
   await p.evaluate(()=>window.LiaSync._readQueue().length), before);

// A needs-details line (passed, never queued) carries its Delete openly.
await p.evaluate(()=>{ _job.items.unshift(fpMakePending({ serial_raw: '' }, 'pick its type')); fpRenderItems(); });
ok('a needs-details line shows Delete without expanding', await p.evaluate(()=>
  document.querySelector('.fp-item.pend .fp-item-actions').offsetHeight > 0), true);
const pend = await p.evaluate(()=>_job.items[0].id);
ok('and deletes', await del(pend), 'removed');

console.log('\npage errors:', errs.length?errs:'none');
console.log(fails?`RESULT: ${fails} failure(s)`:'RESULT: all passed');
await b.close();
process.exit(fails||errs.length?1:0);
