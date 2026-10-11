// Lia Office's Inventory screen: trucks and warehouses, load-outs, restocking.
//
// The server does every sum (supabase/migrations/34_vehicle_inventory.sql); the screen
// must show what it is given, send what the lead did, and never offer to
// change a subcontractor's truck from the umbrella's own account.
//
// Run with `npm run test:desktop`.
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(ROOT, 'electron', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(ROOT, 'electron')) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = 'http://127.0.0.1:' + server.address().port;

let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('dialog', d => d.accept());

await p.addInitScript(() => {
  window.__calls = [];
  const call = (fn, data) => (...a) => { window.__calls.push({ fn, a }); return Promise.resolve({ ok: true, data: typeof data === 'function' ? data(...a) : data }); };
  window.__overview = {
    auto_deduct: false,
    locations: [
      { id: 't14', kind: 'vehicle', name: 'Truck 14', unit: 'KXP-221', active: true, mine: true, account_name: 'Nate',
        loadout_id: 'lo1', loadout: 'Ladder truck', assignees: [{ user_id: 'u-crew', name: 'Crew Kid', primary: true }],
        parts: 2, short: 1, negative: 0 },
      { id: 'shop', kind: 'warehouse', name: 'Shop', unit: null, active: true, mine: true, account_name: 'Nate',
        loadout_id: null, loadout: null, assignees: [], parts: 1, short: 0, negative: 1 },
      { id: 'm1', kind: 'vehicle', name: 'Mike Van', unit: null, active: true, mine: false, account_name: 'Michael',
        loadout_id: null, loadout: null, assignees: [], parts: 0, short: 0, negative: 0 } ],
    loadouts: [ { id: 'lo1', name: 'Ladder truck', lines: [ { part_number: 'G13', par: 10 } ] } ],
  };
  const detail = id => id === 'm1'
    ? { id: 'm1', kind: 'vehicle', name: 'Mike Van', unit: null, active: true, mine: false, loadout_id: null, lines: [], moves: [] }
    : { id: 't14', kind: 'vehicle', name: 'Truck 14', unit: 'KXP-221', active: true, mine: true, loadout_id: 'lo1',
        lines: [ { part_number: 'G13', part_key: 'G13', qty: 6, par: 10, par_override: null, need: 4 },
                 { part_number: 'W44', part_key: 'W44', qty: -1, par: null, par_override: null, need: 0 } ],
        moves: [ { part_number: 'G13', delta: -1, reason: 'ladder', wo_key: 'WO77', who: 'Crew Kid',
                   captured_at: '2026-10-11T09:00:00Z', note: null } ] };
  window.api = {
    isSupabaseConfigured: async () => false,
    getSession: async () => null,
    teamMembers: async () => ({ ok: true, team: [
      { user_id: 'u-lead', name: 'Nate', role: 'lead' }, { user_id: 'u-crew', name: 'Crew Kid', role: 'tech' },
      { user_id: 'u-gone', name: 'Gone', role: 'tech', removed_at: '2026-01-01' } ] }),
    stockOverview: async () => ({ ok: true, data: window.__overview }),
    stockDetail: call('stockDetail', detail),
    stockSaveLocation: call('stockSaveLocation', p => ({ id: p.id || 'new-loc' })),
    stockAssign: call('stockAssign', { assigned: 1 }),
    stockSaveLoadout: call('stockSaveLoadout', p => ({ id: p.id || 'lo-new', lines: p.lines.length })),
    stockDeleteLoadout: call('stockDeleteLoadout', {}),
    stockSetPar: call('stockSetPar', {}),
    stockAdjust: call('stockAdjust', { id: 'm', qty: 9 }),
    stockTransfer: call('stockTransfer', { lines: 1 }),
    stockRestock: call('stockRestock', [ { location_id: 't14', name: 'Truck 14', unit: 'KXP-221',
      lines: [ { part_number: 'G13', qty: 6, par: 10, need: 4 } ] } ]),
    stockSettings: call('stockSettings', p => ({ auto_deduct: p.auto_deduct })),
    fpListTypes: async () => ({ ok: true, types: [] }), fpListModels: async () => ({ ok: true, models: [] }),
    fieldList: async () => ({ ok: true, workOrders: [] }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
  };
});

await p.goto(BASE + '/index.html');
await p.waitForTimeout(400);
const calls = fn => p.evaluate(f => window.__calls.filter(c => c.fn === f).map(c => c.a), fn);

ok('Inventory is on the home screen', await p.$eval('#home-inventory', e => /Inventory/.test(e.textContent)), true);
await p.click('#home-inventory'); await p.waitForTimeout(400);
ok('it opens', await p.evaluate(() => document.querySelector('#screen-inventory').classList.contains('active')), true);
ok('listing this company\'s places, then a subcontractor\'s under its name',
   await p.$$eval('#inv-list .inv-group, #inv-list .cat-item-name', e => e.map(x => x.textContent.trim().split('\n')[0].trim())),
   ['Yours', '🚚 Truck 14', '🏬 Shop', 'Michael', '🚚 Mike Van']);
ok('with what is short and what has gone below zero',
   await p.$$eval('#inv-list .inv-badge', e => e.map(x => x.textContent)), ['1 short', '1 below zero']);

// ── A truck ─────────────────────────────────────────────────────────────────
await p.click('[data-inv-loc="t14"]'); await p.waitForTimeout(300);
ok('the stock table shows the server\'s numbers', await p.$$eval('#inv-detail .inv-tbl tr', rs => rs.slice(1).map(r =>
   [...r.querySelectorAll('td')].slice(0, 4).map(td => td.textContent.trim()).join('|'))), ['G13|6|10|4', 'W44|-1|—|']);
ok('a below-zero line is marked', await p.$$eval('#inv-detail .inv-tbl td.neg', e => e.length), 1);
ok('who can change it from a phone is the current crew, ticked as assigned',
   await p.$$eval('[data-inv-person]', e => e.map(x => x.dataset.invPerson + ':' + x.checked)), ['u-lead:false', 'u-crew:true']);
ok('a ladder\'s parts show in the history with their work order',
   /On a ladder · WO WO77/.test(await p.$eval('#inv-detail', e => e.textContent)), true);

await p.fill('#inv-part', 'g13'); await p.selectOption('#inv-reason', 'count'); await p.fill('#inv-qty', '9');
await p.click('#btn-inv-adjust'); await p.waitForTimeout(250);
ok('recording a count sends a count', (await calls('stockAdjust')).map(a => [a[0].reason, a[0].qty, a[0].location_id]), [['count', 9, 't14']]);
ok('and says what is on hand now', /9 on hand now/.test(await p.$eval('#inv-msg', e => e.textContent)), true);

await p.fill('#inv-xpart', 'G13'); await p.fill('#inv-xqty', '4'); await p.selectOption('#inv-xto', 'shop');
await p.click('#btn-inv-transfer'); await p.waitForTimeout(250);
ok('a move sends both places and the line', (await calls('stockTransfer')).map(a => a[0]),
   [{ from_location_id: 't14', to_location_id: 'shop', lines: [{ part_number: 'G13', qty: 4 }] }]);

await p.fill('[data-inv-par="G13"]', '12'); await p.press('[data-inv-par="G13"]', 'Tab'); await p.waitForTimeout(200);
ok('a truck\'s own par is saved for that part', await calls('stockSetPar'), [['t14', 'G13', 12]]);

await p.click('[data-inv-person="u-lead"]');
await p.click('#btn-inv-save'); await p.waitForTimeout(250);
ok('saving sends the truck', (await calls('stockSaveLocation')).map(a => [a[0].id, a[0].name, a[0].loadout_id]), [['t14', 'Truck 14', 'lo1']]);
ok('and who is on it', await calls('stockAssign'), [['t14', ['u-lead', 'u-crew']]]);

// ── A subcontractor's truck ─────────────────────────────────────────────────
await p.click('[data-inv-loc="m1"]'); await p.waitForTimeout(300);
ok('a subcontractor\'s truck is read-only from here', await p.evaluate(() => [
   /read-only/.test($('inv-detail').textContent), !!$('btn-inv-save'), $('inv-name').disabled]), [true, false, true]);

// ── A new truck ─────────────────────────────────────────────────────────────
await p.click('#btn-inv-new-truck'); await p.waitForTimeout(100);
await p.click('#btn-inv-save'); await p.waitForTimeout(100);
ok('a truck needs a name', /Give it a name/.test(await p.$eval('#inv-msg', e => e.textContent)), true);
await p.fill('#inv-name', 'Truck 21');
await p.click('#btn-inv-save'); await p.waitForTimeout(300);
ok('a new truck is sent without an id', (await calls('stockSaveLocation')).pop()[0].id, null);

// ── Load-outs ───────────────────────────────────────────────────────────────
await p.click('[data-inv-tab="loadouts"]'); await p.waitForTimeout(200);
await p.click('[data-inv-lo="lo1"]'); await p.waitForTimeout(150);
await p.click('#btn-lo-add'); await p.waitForTimeout(100);
await p.fill('[data-lo-part="1"]', 'W44'); await p.fill('[data-lo-par="1"]', '4');
await p.click('#btn-lo-save'); await p.waitForTimeout(250);
ok('a load-out is saved with its lines', (await calls('stockSaveLoadout')).map(a => a[0]),
   [{ id: 'lo1', name: 'Ladder truck', lines: [{ part_number: 'G13', par: 10 }, { part_number: 'W44', par: 4 }] }]);

// ── Restock ─────────────────────────────────────────────────────────────────
await p.click('[data-inv-tab="restock"]'); await p.waitForTimeout(300);
ok('the restock list says what to load on which truck',
   await p.$eval('#inv-detail', e => /Truck 14[\s\S]*G13[\s\S]*4/.test(e.textContent)), true);

// ── Automatic deduction ─────────────────────────────────────────────────────
await p.click('#inv-auto'); await p.waitForTimeout(250);
ok('switching on ladder deduction asks first, then saves it', await calls('stockSettings'), [[{ auto_deduct: true }]]);

// ── A database without 34 ───────────────────────────────────────────────────
await p.evaluate(() => { window.api.stockOverview = async () => ({ ok: false, error: 'function stock_overview() does not exist', missing: true }); });
await p.evaluate(() => loadInventory()); await p.waitForTimeout(200);
ok('without the migration it says so', /database update/.test(await p.$eval('#inv-msg', e => e.textContent)), true);

ok('no page errors', errs, []);
await b.close(); server.close();
console.log(fails ? `\n${fails} failed` : '\nAll inventory assertions passed.');
process.exit(fails ? 1 : 0);
