// The window is resizable, so the layout has to hold at the size somebody
// actually drags it to. Run with `npm run test:desktop`.
//
// 800x640 is the stated floor. What is checked is not how it looks but whether
// it WORKS: every card reachable, nothing off the right edge, no sideways
// scroll, and the two-column screens folded rather than crushed.
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
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

const stub = () => {
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'office@batavia.test' }, credits: -1 }),
    getContext: async () => ({ ok: true, ctx: {
      role: 'lead', is_umbrella: true, acting_is_umbrella: true, impersonating: false,
      can_act_as: [{ account_id: 'a', name: 'Michael Dobbs' }] } }),
    supportAmIDeveloper: async () => ({ ok: true, developer: true }),
    supportCounts: async () => ({ ok: true, counts: { open: 0, unread: 0 } }),
    teamMembers: async () => ({ ok: true, team: [] }),
    listSubs: async () => ({ ok: true, subs: [] }),
    fpListModels: async () => ({ ok: true, models: [] }),
    fpListTypes: async () => ({ ok: true, types: [] }),
    jobsBoard: async () => ({ ok: true, jobs: [] }),
    jobsTeam: async () => ({ ok: true, team: [] }),
    mergeWorkOrders: async () => ({ ok: true, workOrders: [] }),
    loadHistory: async () => ({ ok: true, groups: [] }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    onFpPushLog(){}, onFpPushWaiting(){}, onFpPushPushed(){}, onFpPushComplete(){},
    onFpPushError(){}, onFpPushExited(){},
  };
};

const b = await chromium.launch();

// Every size from the app's own floor to a large monitor.
for (const [w, h, minCols] of [[800, 640, 3], [1024, 700, 4], [1440, 900, 4], [1920, 1080, 4]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(stub);
  await p.goto(BASE + '/index.html');
  await p.waitForTimeout(400);

  const home = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.mode-card')].filter(c => c.style.display !== 'none');
    const clipped = cards.filter(c => {
      const r = c.getBoundingClientRect();
      return r.right > window.innerWidth + 1 || r.left < -1;
    });
    const grid = document.querySelector('.mode-cards');
    return {
      cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      clipped: clipped.length,
      sideways: document.documentElement.scrollWidth > window.innerWidth,
      scrolls: getComputedStyle(document.getElementById('screen-home')).overflowY,
    };
  });

  ok(`${w}x${h}: no card is cut off`, home.clipped, 0);
  ok(`${w}x${h}: the page does not scroll sideways`, home.sideways, false);
  ok(`${w}x${h}: at least ${minCols} columns`, home.cols >= minCols, true);
  // Twelve cards do not fit a short window, so reaching them must not depend
  // on the window being tall.
  ok(`${w}x${h}: the home screen scrolls`, home.scrolls, 'auto');

  // The screens built as list + detail.
  for (const id of ['catalog', 'fpr', 'jobs', 'team']) {
    const m = await p.evaluate((s) => {
      showScreen(s);
      const el = document.getElementById('screen-' + s);
      const body = el.querySelector('.cat-body');
      const over = [...el.querySelectorAll('*')].some(n => n.getBoundingClientRect().right > window.innerWidth + 2);
      return { dir: body ? getComputedStyle(body).flexDirection : 'none', over };
    }, id);
    ok(`${w}x${h}: ${id} keeps everything on screen`, m.over, false);
    // Folded below 820, side by side above it.
    ok(`${w}x${h}: ${id} is laid out ${w < 820 ? 'stacked' : 'side by side'}`,
       m.dir, w < 820 ? 'column' : 'row');
  }

  // Finishing an import hides the office sidebar, which used to take the only
  // way home with it.
  const stranded = await p.evaluate(() => {
    showScreen('office');
    document.body.classList.add('summary-mode');
    const sidebarHome = document.getElementById('btn-office-home');
    const titlebarHome = document.getElementById('btn-titlebar-home');
    const visible = (el) => !!el && el.offsetParent !== null;
    const out = { sidebar: visible(sidebarHome), titlebar: visible(titlebarHome) };
    document.body.classList.remove('summary-mode');
    return out;
  });
  ok(`${w}x${h}: the summary hides the sidebar's way home`, stranded.sidebar, false);
  ok(`${w}x${h}: but there is still a way home`, stranded.titlebar, true);

  const onHome = await p.evaluate(() => {
    showScreen('home');
    const el = document.getElementById('btn-titlebar-home');
    return el.style.display === 'none';
  });
  ok(`${w}x${h}: and it is not offered on the home screen itself`, onHome, true);

  ok(`${w}x${h}: no page errors`, errs, []);
  await ctx.close();
}

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll layout assertions passed.');
process.exit(fails ? 1 : 0);
