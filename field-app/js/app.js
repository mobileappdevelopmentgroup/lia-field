// Lia Field — app.js
//
// Startup: service worker, first-run demo data, and the initial render.
// Loaded last, so everything it calls is already defined.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step. Modules would need a
// server, and the app has to run from file:// and from a Capacitor bundle.

// ── Service worker ────────────────────────────────────────────────────────────
// Skipped inside Capacitor — the WKWebView/WebView already serves the bundled
// app offline, so a service worker would just add a redundant caching layer.
if ('serviceWorker' in navigator && !window.Capacitor?.isNativePlatform()) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── Demo job seed (first launch only) ────────────────────────────────────────
(function seedDemoJob() {
  if (localStorage.getItem('lia-demo-seeded')) return;
  localStorage.setItem('lia-demo-seeded', '1');
  const now = new Date().toISOString();
  const id  = 'demo-' + Date.now();
  const job = {
    id, name: 'Demo Job — Comcast Northern Tier', workOrderNum: 'WO-12345',
    createdAt: now, updatedAt: now,
    ladders: [
      {
        id: crypto.randomUUID(), serialNum: '1509167', brand: 'LG', type: 'Ext',
        length: '28', locationId: '10', desc: 'Needs leveler swap too',
        customFields: {},
        parts: [{ name: 'M23', qty: 1 }, { name: 'RC', qty: 1 }, { name: 'Hom200', qty: 1 },
                { name: 'Lgh92', qty: 1 }, { name: 'Levelers', qty: 1 }],
      },
      {
        id: crypto.randomUUID(), serialNum: '1460300', brand: 'LG', type: 'Ext',
        length: '28', locationId: '27', desc: '',
        customFields: {},
        parts: [{ name: 'M23', qty: 1 }, { name: 'RC', qty: 1 }, { name: 'LGE55', qty: 1 },
                { name: 'PTS', qty: 1 }],
      },
      {
        id: crypto.randomUUID(), serialNum: '1358340', brand: 'LG', type: 'Ext',
        length: '28', locationId: '34', desc: 'Levels swap — confirm with supervisor',
        customFields: {},
        parts: [{ name: 'M23', qty: 1 }, { name: 'RC', qty: 1 }, { name: 'Lge36b', qty: 1 },
                { name: 'Lge123', qty: 1 }, { name: 'Lge43', qty: 1 }, { name: 'SLS', qty: 2 }],
      },
      {
        id: crypto.randomUUID(), serialNum: '1553138', brand: 'Blue Bird', type: 'Comp',
        length: '8', locationId: '14', desc: '',
        customFields: {},
        parts: [{ name: 'M16', qty: 1 }, { name: 'SLS', qty: 1 }],
      },
      {
        id: crypto.randomUUID(), serialNum: '1626146', brand: 'Blue Bird', type: 'Ext',
        length: '28', locationId: '9', desc: '',
        customFields: {},
        parts: [{ name: 'M23', qty: 1 }, { name: 'R28L', qty: 1 }, { name: 'B92', qty: 1 }],
      },
    ],
  };
  const all = loadJobs(); all[id] = job; saveJobs(all);
})();

// ── Init ──────────────────────────────────────────────────────────────────────
renderJobList();
renderFlags();

// An answer to a ticket arrives while the app is shut. Check on the way in, so
// the dot is already there rather than appearing once he happens to open Help.
if (typeof helpBadgeRender === 'function') {
  helpBadgeRender();
  if (window.LiaSupport) {
    window.LiaSupport.refresh().then(helpBadgeRender).catch(() => {});
  }
}
