// "Defective, no tag" (field report 2026-10-14, #3): an item with no tag takes
// the next number from the company's list instead of spending a tag. The
// numbers are reserved to this phone while it had signal, so it hands them out
// offline and never one another phone holds. Drives the real page.
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
await p.click('.scope-opt[data-scope="fall_protection"]'); await p.waitForTimeout(300);

const shown = () => p.$eval('#fp-btn-untagged', e => e.offsetParent !== null);
ok('no list loaded: no button', await shown(), false);

// What reserve_fp_serials hands this phone.
let rpcCalls = [];
await p.evaluate(() => {
  window.__rpc = [];
  const sb = { rpc: (name, args) => { window.__rpc.push([name, args]);
    return Promise.resolve({ data: [{ serial: 'UT-0001' }, { serial: 'UT-0002' }], error: null }); } };
  return window.LiaSerialPool.pull(sb);
});
rpcCalls = await p.evaluate(() => window.__rpc);
ok('the phone asks the server to reserve numbers for it', rpcCalls, [['reserve_fp_serials', { p_count: 5 }]]);
await p.evaluate(() => fpRenderAll());
ok('with a list, the button is there', await shown(), true);

await p.click('#fp-btn-untagged'); await p.waitForTimeout(150);
ok('it opens a new item under the next number', await p.$eval('#fpf-serial', e => e.value), 'UT-0001');
ok('and says to write it on the item', await p.$eval('#fp-hint', e => /UT-0001/.test(e.textContent) && /no tag/.test(e.textContent)), true);

// Backing out spends nothing.
await p.evaluate(() => { fpReset(); fpRenderAll(); });
await p.click('#fp-btn-untagged'); await p.waitForTimeout(150);
ok('backing out leaves the number for the next one', await p.$eval('#fpf-serial', e => e.value), 'UT-0001');

// Record it as defective: type, fail a check, photo-less confirm path is not
// needed here — commit directly, the way every save path ends.
await p.selectOption('#fpf-equipment_type', 'body_harness'); await p.waitForTimeout(100);
await p.evaluate(() => { const t = fpCurrentType(); fpCommit(fpMakeItem(_fpItem, t, fpTypes().startingAnswers(t), 'field')); });
await p.waitForTimeout(150);
ok('recording it spends the number', await p.evaluate(() => window.LiaSerialPool.available()), ['UT-0002']);
await p.click('#fp-btn-untagged'); await p.waitForTimeout(150);
ok('so the next item gets the next number', await p.$eval('#fpf-serial', e => e.value), 'UT-0002');
await p.evaluate(() => { const t = 'body_harness'; _fpItem.equipment_type = t; fpCommit(fpMakeItem(_fpItem, fpCurrentType(), fpTypes().startingAnswers(fpCurrentType()), 'field')); });
await p.waitForTimeout(150);

await p.click('#fp-btn-untagged'); await p.waitForTimeout(150);
ok('none left offline: it says so and opens nothing', await p.evaluate(() => !_fpItem && /Connect to the internet/.test($('fp-hint').textContent)), true);

// Next sync: the server still returns UT-0002 (not uploaded yet) and a new one.
await p.evaluate(() => window.LiaSerialPool.set([{ serial: 'UT-0002' }, { serial: 'UT-0003' }]));
ok('a number spent here but not yet uploaded stays spent', await p.evaluate(() => window.LiaSerialPool.available()), ['UT-0003']);

// Signing out drops them: they belong to this user.
await p.evaluate(() => window.LiaSerialPool.clear());
await p.evaluate(() => fpRenderAll());
ok('cleared: no button', await shown(), false);

console.log('\npage errors:', errs.length?errs:'none');
console.log(fails?`RESULT: ${fails} failure(s)`:'RESULT: all passed');
await b.close();
process.exit(fails||errs.length?1:0);
