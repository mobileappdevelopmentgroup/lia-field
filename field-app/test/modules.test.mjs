// Cross-module smoke test. The field app is split into classic scripts that
// share top-level bindings; nothing but loading the real page proves they still
// resolve across files. Also loads each shipped Capacitor bundle, since those
// are copies that can drift. Run with `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const b = await chromium.launch();
const p = await b.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{ if(m.type()==='error') errs.push('console: '+m.text()); });
await p.goto('file://' + ROOT + '/field-app/index.html');
await p.waitForTimeout(500);
let failures = 0;
const ok=(l,g,w)=>{ const good = JSON.stringify(g)===JSON.stringify(w); if(!good) failures++;
  console.log((good?'ok  ':`FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `)+l); };

// every module's globals reachable from every other
ok('storage loaded',   await p.evaluate(()=>typeof loadJobs), 'function');
ok('sound loaded',     await p.evaluate(()=>typeof playSound), 'function');
ok('catalog loaded',   await p.evaluate(()=>typeof getLibrary), 'function');
ok('jobs loaded',      await p.evaluate(()=>typeof jobScope), 'function');
ok('entry loaded',     await p.evaluate(()=>typeof buildLadderFromForm), 'function');
ok('list loaded',      await p.evaluate(()=>typeof renderLadderList), 'function');
ok('export loaded',    await p.evaluate(()=>typeof buildCsv), 'function');
ok('scan loaded',      await p.evaluate(()=>typeof startScan), 'function');
ok('sheets loaded',    await p.evaluate(()=>typeof renderLibList), 'function');
ok('cache loaded',     await p.evaluate(()=>typeof LiaCache), 'object');
// cross-module: export.js uses LADDER_FLAGS from entry.js
ok('cross-module constants resolve', await p.evaluate(()=>LADDER_FLAGS.length), 4);
ok('SCOPES visible to entry.js',     await p.evaluate(()=>Object.keys(SCOPES)), ['ladder','fall_protection']);
// demo job seeded and renders
ok('demo job rendered', await p.$$eval('.job-card', e=>e.length), 1);

// full round trip through several modules
await p.evaluate(()=>openJob(Object.keys(loadJobs())[0]));
await p.waitForTimeout(200);
await p.fill('#fi-serial','777001'); await p.fill('#fi-brand','LG'); await p.fill('#fi-length','24');
await p.click('#btn-add-ladder'); await p.waitForTimeout(250);
ok('ladder added via entry.js', await p.evaluate(()=>_job.ladders[0].serialNum), '777001');
ok('and rendered by list.js',   await p.$$eval('.ladder-card', e=>e.length>0), true);
ok('and exported by export.js', await p.evaluate(()=>buildCsv(_job).includes('777001')), true);
// parts flow spans catalog.js + entry.js + sheets.js
await p.evaluate(()=>{ _currentParts.set('M23',2); renderSelectedParts(); renderPartButtons(); });
ok('parts render', await p.$$eval('.part-chip', e=>e.length), 1);
await p.evaluate(()=>openSettings()); await p.waitForTimeout(150);
ok('settings sheet opens', await p.$eval('#settings-sheet',e=>!e.classList.contains('hidden')), true);
await p.evaluate(()=>closeSettings());
await p.evaluate(()=>openLibrary()); await p.waitForTimeout(150);
ok('library sheet opens', await p.$$eval('#lib-list .part-lib-row',e=>e.length>0), true);
// The shipped bundles are copies and can drift from source.
for (const dir of ['field-app/capacitor/www',
                   'field-app/capacitor/ios/App/App/public',
                   'field-app/capacitor/android/app/src/main/assets/public']) {
  const q = await b.newPage();
  const berrs=[]; q.on('pageerror',e=>berrs.push(e.message));
  await q.goto('file://' + ROOT + '/' + dir + '/index.html');
  await q.waitForTimeout(300);
  const r = await q.evaluate(()=>({
    scripts:[...document.querySelectorAll('script[src^="./js/"]')].length,
    cdn:!!document.querySelector('script[src*="cdn.jsdelivr"]'),
    entry:typeof buildLadderFromForm,
  }));
  const name = dir.split('/').slice(-3).join('/');
  ok(`${name}: every module shipped`, r.scripts, 15);
  // connect-src 'self' blocks every Supabase call — and only on device, so a
  // browser test passes while the phone silently fails. Assert the origin is
  // named rather than trusting the sync script ran.
  const csp = await q.evaluate(() => {
    const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return m ? m.getAttribute('content') : '';
  });
  const connect = (csp.match(/connect-src ([^;]*)/) || [])[1] || '';
  ok(`${name}: CSP lets the app reach Supabase`, /https:\/\/[a-z0-9]+\.supabase\.co/.test(connect), true);
  ok(`${name}: zxing is vendored, not from a CDN`, r.cdn, false);
  ok(`${name}: the app initialises`, r.entry, 'function');
  if (berrs.length) { failures++; console.log('FAIL', name, berrs[0]); }
  await q.close();
}

console.log('\npage errors:', errs.length?errs:'none');
await b.close();
console.log(failures ? `RESULT: ${failures} failure(s)` : 'RESULT: all passed');
process.exit(failures || errs.length ? 1 : 0);
