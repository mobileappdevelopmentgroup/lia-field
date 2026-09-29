// The page that replaces the retired PWA. Its whole job is to not strand a
// tech's data, so that is what is tested. Run via `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, 'pages-farewell', 'index.html');
  res.writeHead(200, { 'content-type': 'text/html' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = 'http://127.0.0.1:' + server.address().port;

let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

const b = await chromium.launch();

// A tech with unsent work in the old browser storage — the case this exists for.
{
  const ctx = await b.newContext({ acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(() => {
    localStorage.setItem('lia-field-jobs', JSON.stringify({
      j1: { id: 'j1', name: 'Comcast North', workOrderNum: 'WO-1', ladders: [
        { id: 'a', serialNum: '111' }, { id: 'b', serialNum: '222' }] },
      j2: { id: 'j2', name: 'Depot', workOrderNum: 'WO-2', scope: 'fall_protection',
            ladders: [], items: [{ id: 'c', serial_num: 'H-1' }] },
    }));
    localStorage.setItem('lia-parts-library', JSON.stringify([{ name: 'M23', favorited: true }]));
  });
  await p.goto(BASE + '/');
  await p.waitForTimeout(400);

  ok('unsent work is noticed', await p.$eval('#data-card', e => e.style.display !== 'none'), true);
  ok('and counted so the tech knows what is at stake',
     await p.$eval('#data-summary', e => e.textContent), '2 jobs with 3 items recorded.');
  ok('the "nothing to move" card stays hidden',
     await p.$eval('#clean-card', e => e.style.display === 'none'), true);

  const dl = await Promise.all([
    p.waitForEvent('download', { timeout: 8000 }),
    p.click('#btn-export'),
  ]).then(r => r[0]);
  const saved = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));

  ok('the export names itself by date', /^lia-field-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), true);
  ok('every job is in the file', Object.keys(saved['lia-field-jobs']).sort(), ['j1', 'j2']);
  ok('including fall protection items', saved['lia-field-jobs'].j2.items.length, 1);
  ok('and the parts library', saved['lia-parts-library'][0].name, 'M23');
  ok('with provenance, so a supervisor knows what it is', saved.source, 'lia-field-pwa');
  ok('the tech is told what to do next',
     await p.$eval('#status', e => /[Ss]end that file/.test(e.textContent)), true);
  ok('no page errors', errs, []);
  await ctx.close();
}

// A browser with nothing in it must not imply data was lost.
{
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto(BASE + '/');
  await p.waitForTimeout(300);
  ok('an empty browser says there is nothing to move',
     await p.$eval('#clean-card', e => e.style.display !== 'none'), true);
  ok('and offers no export', await p.$eval('#data-card', e => e.style.display === 'none'), true);
  await ctx.close();
}

// The old service worker would otherwise keep serving the cached app.
{
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto(BASE + '/');
  await p.waitForTimeout(300);
  ok('the page tears down the old service worker',
     await p.evaluate(() => /getRegistrations|unregister/.test(document.body.parentElement.innerHTML)), true);
  await ctx.close();
}

await b.close(); server.close();
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
process.exit(fails ? 1 : 0);
