// Attach to the browser tools/bsi-session.mjs is holding open, and report or
// act on whatever page is in front. Read-only unless told otherwise.
//
//   node tools/bsi-probe.mjs where            # url + title of every tab
//   node tools/bsi-probe.mjs dump [out.json]  # structure of every control
//   node tools/bsi-probe.mjs text             # visible text, trimmed
//   node tools/bsi-probe.mjs html <selector>  # outerHTML of one element
//   node tools/bsi-probe.mjs goto <url>
//   node tools/bsi-probe.mjs click <selector>
import { chromium } from 'playwright';
import fs from 'fs';

const PORT = Number(process.env.BSI_CDP_PORT || 9222);
const [cmd, ...rest] = process.argv.slice(2);

const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = b.contexts()[0];
const pages = ctx.pages();
// The last page that is not about:blank is the one being worked in.
const page = [...pages].reverse().find(p => !/^about:/.test(p.url())) || pages[0];

const SECRET = /pass|pwd|secret|token|card|cvv|ssn/i;

const PROBE = () => {
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && l.textContent.trim()) return l.textContent.trim().slice(0, 80);
    }
    const wrap = el.closest('label');
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim().slice(0, 80);
    let p = el.previousElementSibling;
    while (p) { const t = (p.textContent || '').trim(); if (t) return t.slice(0, 80); p = p.previousElementSibling; }
    const cell = el.closest('td'); const prev = cell && cell.previousElementSibling;
    if (prev && prev.textContent.trim()) return prev.textContent.trim().slice(0, 80);
    return '';
  };
  const out = [];
  document.querySelectorAll('input, select, textarea, button').forEach((el) => {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    const rec = { tag: el.tagName.toLowerCase(), type, id: el.id || '',
                  name: el.getAttribute('name') || '',
                  cls: (el.className || '').toString().slice(0, 120),
                  label: labelFor(el),
                  visible: !!(el.offsetParent || el.getClientRects().length),
                  box: (el.closest('[id^="box-"]') || {}).id || '' };
    if (el.tagName === 'SELECT') {
      rec.options = [...el.options].slice(0, 80).map(o => ({ v: o.value, t: o.text.trim().slice(0, 60) }));
      rec.optionCount = el.options.length;
    }
    if (type === 'checkbox' || type === 'radio') { rec.checked = !!el.checked; rec.value = el.getAttribute('value') || ''; }
    if (type === 'button' || el.tagName === 'BUTTON') rec.text = (el.value || el.textContent || '').trim().slice(0, 60);
    out.push(rec);
  });
  return { url: location.href, title: document.title,
           boxes: [...document.querySelectorAll('[id^="box-"]')].map(b => b.id),
           jquery: typeof window.jQuery !== 'undefined' ? ((window.jQuery.fn && window.jQuery.fn.jquery) || 'yes') : null,
           controls: out };
};

if (cmd === 'where') {
  pages.forEach((p, i) => console.log(`[${i}] ${p.url()}`));
} else if (cmd === 'goto') {
  await page.goto(rest[0], { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  console.log(page.url(), '|', await page.title());
} else if (cmd === 'click') {
  await page.click(rest[0]);
  await page.waitForTimeout(1500);
  console.log('clicked', rest[0], '→', page.url());
} else if (cmd === 'text') {
  const t = await page.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 6000));
  console.log(t);
} else if (cmd === 'html') {
  const h = await page.evaluate((s) => {
    const el = document.querySelector(s); return el ? el.outerHTML.slice(0, 20000) : `no match for ${s}`;
  }, rest[0]);
  console.log(h);
} else {
  const snap = await page.evaluate(PROBE);
  snap.controls = snap.controls.filter(c => !SECRET.test(c.id + ' ' + c.name) && c.type !== 'password');
  const out = rest[0];
  if (out) { fs.writeFileSync(out, JSON.stringify(snap, null, 2)); console.log('wrote', out); }
  console.log(`${snap.title} — ${snap.url}`);
  console.log(`jQuery: ${snap.jquery || 'none'} | boxes: ${snap.boxes.join(', ') || 'none'}`);
  const cb = snap.controls.filter(c => c.type === 'checkbox');
  console.log(`${snap.controls.length} controls, ${cb.length} checkbox(es)`);
  cb.forEach(c => console.log(`  CHECKBOX #${c.id || '-'} name=${c.name || '-'} val=${c.value} "${c.label}" box=${c.box || '-'}`));
}
await b.close();
