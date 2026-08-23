// Fall protection capture. Drives the real page: four ways in, checks
// defaulting to pass, the Edit unlock, and the condemn flow's photo gate.
// Run with `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const b = await chromium.launch();
const p = await b.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{ if(m.type()==='error') errs.push('console: '+m.text()); });
let fails=0;
const ok=(l,g,w)=>{const good=JSON.stringify(g)===JSON.stringify(w); if(!good)fails++;
  console.log((good?'ok  ':`FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `)+l);};

await p.goto('file://' + ROOT + '/field-app/index.html');
await p.waitForTimeout(400);

// create a fall protection job
await p.click('#btn-new-job'); await p.waitForTimeout(150);
await p.click('.scope-opt[data-scope="fall_protection"]'); await p.waitForTimeout(300);

const vis = () => p.evaluate(()=>({
  input:  $('fp-input-panel').style.display !== 'none',
  record: $('fp-record').style.display !== 'none',
  checks: $('fp-checks-panel').style.display !== 'none',
  items:  $('fp-items-panel').style.display !== 'none',
  ladder: $('form-panel').style.display !== 'none',
}));
ok('an FP job shows the FP input bar, not the ladder form', await vis(),
   {input:true, record:false, checks:false, items:true, ladder:false});
ok('four ways in', await p.$$eval('.fp-way', e=>e.map(x=>x.textContent.trim())), ['Tap','Scan','Type','New']);

// New → straight into the fields
await p.click('#fp-btn-new'); await p.waitForTimeout(200);
ok('New opens the fields without a failed lookup first',
   await p.evaluate(()=>$('fp-edit-form').style.display !== 'none'), true);
await p.fill('#fpf-serial','H-9001');
await p.fill('#fpf-manufacturer','MSA');
await p.fill('#fpf-model','V-FIT');
await p.click('#fp-btn-done-edit'); await p.waitForTimeout(200);

ok('the record is shown read-only after entry',
   await p.evaluate(()=>$('fp-record').style.display !== 'none'), true);
ok('checks default to all pass',
   await p.evaluate(()=>_fpChecks.every(c=>c.result===true)), true);
ok('six checks by default', await p.$$eval('.fp-chk', e=>e.length), 6);
ok('the save button offers Pass & Next',
   await p.$eval('#fp-btn-save', e=>e.textContent.trim()), 'Pass & Next Item');

// two taps: confirm and move on
await p.click('#fp-btn-save'); await p.waitForTimeout(300);
ok('the item is recorded', await p.evaluate(()=>_job.items.length), 1);
ok('and passed', await p.evaluate(()=>_job.items[0].overall_pass), true);
ok('with a due date one year out',
   await p.evaluate(()=>{const i=_job.items[0];
     return new Date(i.next_due_date) - new Date(i.inspection_date) > 364*864e5;}), true);
ok('the form resets ready for the next item',
   await p.evaluate(()=>_fpItem===null), true);
ok('and the item list is showing again', (await vis()).items, true);

// Edit unlocks a matched record
await p.click('#fp-btn-new'); await p.waitForTimeout(150);
await p.fill('#fpf-serial','H-9002'); await p.click('#fp-btn-done-edit'); await p.waitForTimeout(150);
await p.click('#fp-btn-edit'); await p.waitForTimeout(150);
ok('Edit unlocks the record', await p.evaluate(()=>$('fp-edit-form').style.display !== 'none'), true);
await p.fill('#fpf-item_type','Lanyard'); await p.click('#fp-btn-done-edit'); await p.waitForTimeout(150);
ok('the edit sticks', await p.evaluate(()=>_fpItem.item_type), 'Lanyard');

// failing one check condemns the item
await p.click('.fp-chk:nth-child(3) [data-r="fail"]'); await p.waitForTimeout(200);
ok('one fail flips the whole item', await p.evaluate(()=>fpOverallPass()), false);
ok('the button becomes the photo step',
   await p.$eval('#fp-btn-save', e=>e.textContent.trim()), 'Add Photo & Remove →');
await p.click('#fp-btn-save'); await p.waitForTimeout(250);
ok('the removal sheet opens',
   await p.evaluate(()=>!$('fp-condemn-sheet').classList.contains('hidden')), true);
ok('the reason is the failed check, shown not typed',
   await p.$eval('#fp-condemn-why', e=>/Webbing/.test(e.textContent)), true);
ok('confirm is blocked until a photo is added',
   await p.$eval('#fp-btn-confirm-condemn', e=>e.disabled), true);
ok('the note is present and optional',
   await p.$$eval('.field-label', e=>e.some(x=>/Note — optional/i.test(x.textContent))), true);
// The disabled attribute is only the visible half. Fire the handler directly,
// the way a re-enabled button or a stray dispatch would, so the guard inside it
// is what is actually under test — a condemned item reaching the record with no
// evidence is the failure this must never allow.
await p.evaluate(()=>{
  const b=$('fp-btn-confirm-condemn');
  b.disabled=false;
  b.dispatchEvent(new MouseEvent('click',{bubbles:true}));
});
await p.waitForTimeout(200);
ok('a condemned item cannot be saved without a photo',
   await p.evaluate(()=>_job.items.length), 1);
ok('and the removal sheet stays open',
   await p.evaluate(()=>!$('fp-condemn-sheet').classList.contains('hidden')), true);

// supply a photo
await p.evaluate(async () => {
  const c=document.createElement('canvas'); c.width=2400; c.height=1800;
  const x=c.getContext('2d'); x.fillStyle='#888'; x.fillRect(0,0,2400,1800);
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.9));
  const dt=new DataTransfer(); dt.items.add(new File([blob],'p.jpg',{type:'image/jpeg'}));
  const i=$('fp-photo-input'); i.files=dt.files; i.dispatchEvent(new Event('change'));
});
await p.waitForTimeout(600);
ok('the photo is accepted', await p.evaluate(()=>!!_fpPhoto), true);
ok('and downscaled well under the original',
   await p.evaluate(()=>_fpPhoto.bytes < 400000), true);
ok('confirm is now enabled', await p.$eval('#fp-btn-confirm-condemn', e=>e.disabled), false);
await p.fill('#fp-condemn-note','Tagged, pulled from truck 14');
await p.click('#fp-btn-confirm-condemn'); await p.waitForTimeout(300);
ok('the condemned item is recorded', await p.evaluate(()=>_job.items.length), 2);
const rec = await p.evaluate(()=>_job.items[0]);
ok('marked as failed', rec.overall_pass, false);
ok('with the photo attached', !!rec.photo, true);
ok('and the optional note kept', rec.discard_note, 'Tagged, pulled from truck 14');
ok('the client sends no discard_reason — the database composes it',
   rec.discard_reason===undefined, true);
ok('the job list counts items, not ladders',
   await p.evaluate(()=>{goScreen('jobs');renderJobList();
     return document.querySelector('.job-card-meta').textContent.includes('2 items');}), true);

console.log('\npage errors:', errs.length?errs:'none');
console.log(fails?`RESULT: ${fails} failure(s)`:'RESULT: all passed');
await b.close();
process.exit(fails||errs.length?1:0);
