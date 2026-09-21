// Look at the real BSI form, so the automation stops guessing at it.
//
// Two things are unknown and both need the actual page in front of us:
//
//   1. The four checkboxes under Length — Leveler, Claw, V-Rung, Lubricated.
//      src/types.ts has described them since the beginning and
//      src/automation.ts has never touched one. They go live next week.
//   2. Whether a fall protection box is the same form as a ladder box, which
//      is what the office says it is: one box, a part number, and bill it.
//
// HOW THIS WORKS
//
// It opens a real Chromium window and then gets out of the way. YOU log in and
// open a work order — this script never types a credential and never reads
// one. It watches the page, and the moment a ladder/box form appears it writes
// the STRUCTURE of every control to a JSON file: tag, type, id, name, classes,
// the label next to it, and a select's options.
//
// It deliberately does not record what is typed IN the fields. The structure
// is the whole question; the contents are somebody's live work order.
//
//   node tools/inspect-bsi-form.mjs [--out <file>] [--url <url>]
//
// Leave the window open and work normally — it dumps again each time the form
// changes, so opening a ladder box and then a fall protection box captures
// both. Close the window when you are done.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const URL = argOf('--url', 'https://bsiwebapp.com');
const OUT = path.resolve(argOf('--out', 'bsi-form-dump.json'));

// Anything that smells like a credential is never read, even structurally.
const SECRET = /pass|pwd|secret|token|card|cvv|ssn/i;

// Runs in the page. Returns the shape of every form control it can see.
const PROBE = () => {
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && l.textContent.trim()) return l.textContent.trim().slice(0, 80);
    }
    const wrap = el.closest('label');
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim().slice(0, 80);
    // BSI lays these out as table cells and floated divs, so the nearest text
    // to the left is usually the label even when no <label> exists.
    let p = el.previousElementSibling;
    while (p) {
      const t = (p.textContent || '').trim();
      if (t) return t.slice(0, 80);
      p = p.previousElementSibling;
    }
    const cell = el.closest('td');
    const prev = cell && cell.previousElementSibling;
    if (prev && prev.textContent.trim()) return prev.textContent.trim().slice(0, 80);
    return '';
  };

  const out = [];
  document.querySelectorAll('input, select, textarea, button').forEach((el) => {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    const name = el.getAttribute('name') || '';
    const id   = el.id || '';
    const rec = {
      tag: el.tagName.toLowerCase(),
      type,
      id,
      name,
      cls: (el.className || '').toString().slice(0, 120),
      label: labelFor(el),
      visible: !!(el.offsetParent || el.getClientRects().length),
      disabled: !!el.disabled,
      // Which box on the page this control belongs to, if any.
      box: (el.closest('[id^="box-"]') || {}).id || '',
    };
    if (el.tagName === 'SELECT') {
      rec.options = [...el.options].slice(0, 60).map(o => ({ v: o.value, t: o.text.trim().slice(0, 60) }));
      rec.optionCount = el.options.length;
    }
    if (type === 'checkbox' || type === 'radio') {
      rec.checked = !!el.checked;
      rec.value = el.getAttribute('value') || '';
    }
    if (type === 'button' || el.tagName === 'BUTTON') {
      rec.text = (el.value || el.textContent || '').trim().slice(0, 60);
    }
    out.push(rec);
  });

  return {
    url: location.href,
    title: document.title,
    boxes: [...document.querySelectorAll('[id^="box-"]')].map(b => b.id),
    jquery: typeof window.jQuery !== 'undefined'
      ? (window.jQuery.fn && window.jQuery.fn.jquery) || 'yes' : null,
    controls: out,
  };
};

const b = await chromium.launch({ headless: false, args: ['--window-size=1400,1000'] });
const ctx = await b.newContext({ viewport: null });
const page = await ctx.newPage();
await page.goto(URL).catch(() => {});

console.log(`
  A browser window is open at ${URL}.

  Log in yourself — this script does not type, read or store credentials.
  Then open a work order and expand a box. Each time the form changes, its
  structure is appended to:

      ${OUT}

  Open a fall protection box too, if it is a different page. Close the window
  when you are finished.
`);

const dumps = [];
let lastSig = '';

// Poll rather than hook navigation: BSI builds boxes with jQuery after the
// fact, so "the page changed" is not a navigation event.
const timer = setInterval(async () => {
  try {
    if (page.isClosed()) return;
    const snap = await page.evaluate(PROBE);
    const interesting = snap.controls.filter(c =>
      !SECRET.test(c.id + ' ' + c.name) && c.type !== 'password');
    // A signature of the SHAPE, so a dump is written when the form changes
    // rather than every two seconds.
    const sig = interesting.map(c => `${c.tag}:${c.type}:${c.id}:${c.name}`).join('|');
    if (!sig || sig === lastSig) return;
    lastSig = sig;
    const entry = { at: new Date().toISOString(), url: snap.url, title: snap.title,
                    boxes: snap.boxes, jquery: snap.jquery, controls: interesting };
    dumps.push(entry);
    fs.writeFileSync(OUT, JSON.stringify(dumps, null, 2));
    const cb = interesting.filter(c => c.type === 'checkbox');
    console.log(`  [${dumps.length}] ${snap.title || snap.url} — ` +
                `${interesting.length} controls, ${cb.length} checkbox(es), ` +
                `${snap.boxes.length} box(es)`);
    if (cb.length) cb.forEach(c => console.log(`        ☐ #${c.id || '(no id)'} name=${c.name || '-'} "${c.label}"`));
  } catch { /* mid-navigation; the next tick will catch it */ }
}, 2000);

await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
clearInterval(timer);
await b.close().catch(() => {});
console.log(`\n  Wrote ${dumps.length} snapshot(s) to ${OUT}`);
