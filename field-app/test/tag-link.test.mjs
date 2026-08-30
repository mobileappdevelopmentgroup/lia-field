// Tag hyperlinks: canonicalizing a link, deciding whether to fetch it, and
// reading somebody else's inspection form out of what comes back.
//
// The fixture is a REAL sheet — the one a live tag points at — saved verbatim
// at fixtures/tag-sheet-v1.csv. Tests written against an invented layout would
// prove nothing here: the whole difficulty is that the sheet is a form on a
// grid rather than a table, and the value for a label sits sometimes to its
// right and sometimes on the line below.
//
// Run via `npm run test:field`.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'tag-link.js'), 'utf8');
const sheet = fs.readFileSync(path.join(here, 'fixtures', 'tag-sheet-v1.csv'), 'utf8');

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto('https://example.com/');
await p.addScriptTag({ content: src });

const out = await p.evaluate(async (sheetCsv) => {
  const log = []; let fails = 0;
  const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
    log.push((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };
  const T = window.LiaTagLink;

  // ── The canonical key ────────────────────────────────────────────────────
  // EVERY pair here is also asserted against the SQL in
  // supabase/test/10_tag_links_test.sql. A device and a server that disagree on
  // when two links are the same link index items nobody can then find, so the
  // two suites are kept deliberately redundant.
  ok('scheme and host fold to lower case',
     T.urlKey('HTTPS://Docs.Google.COM/a/B'), 'https://docs.google.com/a/B');
  // Plenty of systems key off a case-sensitive id; folding it merges two items.
  ok('but the path keeps its case', T.urlKey('https://x.com/AbC') === T.urlKey('https://x.com/abc'), false);
  ok('a leading www is dropped', T.urlKey('https://www.acme.com/t/1'), 'https://acme.com/t/1');
  ok('a trailing slash is dropped', T.urlKey('https://acme.com/t/1/'), 'https://acme.com/t/1');
  ok('the default port is dropped', T.urlKey('https://acme.com:443/t'), 'https://acme.com/t');
  ok('a non-default port is kept', T.urlKey('https://acme.com:8443/t'), 'https://acme.com:8443/t');
  ok('credentials in the authority are stripped', T.urlKey('https://u:p@acme.com/t'), 'https://acme.com/t');
  // Otherwise one tag shared from two places indexes as two items.
  ok('tracking parameters are dropped',
     T.urlKey('https://acme.com/t?id=7&utm_source=qr&gclid=z'), 'https://acme.com/t?id=7');
  ok('and the rest are sorted', T.urlKey('https://acme.com/t?b=2&a=1'), 'https://acme.com/t?a=1&b=2');
  // #gid is the only thing telling two tabs of one workbook apart.
  ok('a sheet tab id survives in the fragment',
     T.urlKey('https://docs.google.com/spreadsheets/d/ID/edit#gid=42'),
     'https://docs.google.com/spreadsheets/d/ID/edit#gid=42');
  ok('any other fragment does not', T.urlKey('https://acme.com/t#section'), 'https://acme.com/t');
  ok('an empty link keys to nothing rather than throwing', T.urlKey(''), '');
  // A tag can carry anything at all.
  ok('a non-url is still keyed, consistently with itself', T.urlKey('NOT A URL'), 'not a url');

  // ── Ours versus somebody else's ──────────────────────────────────────────
  ok('a certificate link yields its ref',
     T.refFrom('https://lia.mobileappdevelopmentgroup.com/fp/?t=B7K2M9QRXZ'), 'B7K2M9QRXZ');
  ok('a third-party link yields none', T.refFrom('https://acme.example/tag/9'), null);

  // ── Google Sheets ────────────────────────────────────────────────────────
  // The link a signed-in browser actually copies, account segment and all.
  ok('a signed-in htmlview link rewrites to CSV',
     T.toCsvUrl('https://docs.google.com/spreadsheets/u/0/d/SHEET/htmlview'),
     'https://docs.google.com/spreadsheets/d/SHEET/gviz/tq?tqx=out:csv&gid=0');
  ok('a tab is carried across',
     T.toCsvUrl('https://docs.google.com/spreadsheets/d/SHEET/edit#gid=77'),
     'https://docs.google.com/spreadsheets/d/SHEET/gviz/tq?tqx=out:csv&gid=77');
  ok('a published sheet uses its own endpoint',
     /\/d\/e\/PUB\/pub\?output=csv/.test(T.toCsvUrl('https://docs.google.com/spreadsheets/d/e/PUB/pubhtml')), true);
  ok('a non-Sheets link is left alone', T.toCsvUrl('https://acme.example/tag/9'), null);

  // ── Which hosts get fetched ──────────────────────────────────────────────
  // Default-deny: a URL off a tag is attacker-controlled, and a client that
  // fetches whatever it is handed will reach intranet hosts on the tech's wifi.
  ok('Google Sheets is trusted', T.hostAllowed('docs.google.com'), true);
  ok('an unknown vendor is not', T.hostAllowed('acme.example'), false);
  // A suffix match must not be a substring match, or evil.net wins.
  ok('a lookalike host does not pass', T.hostAllowed('docs.google.com.evil.net'), false);

  ok('an untrusted host is refused rather than fetched',
     await T.fetch('https://acme.example/tag/9').then(r => r.code), 'HOST_NOT_ALLOWED');
  // http on a site's own wifi is trivially spoofable, and the answer becomes a
  // safety record.
  ok('so is plain http', await T.fetch('http://docs.google.com/x').then(r => r.code), 'NOT_HTTPS');
  ok('and a tag carrying junk', await T.fetch('not a url').then(r => r.code), 'BAD_URL');
  // Every outcome is a decision the tech is shown, so none of them throws.
  ok('none of which rejects', await T.fetch('http://x/').then(() => 'resolved', () => 'threw'), 'resolved');
  ok('a refusal still names the host so it can be trusted later',
     await T.fetch('https://acme.example/t').then(r => r.host), 'acme.example');

  // ── The real sheet ───────────────────────────────────────────────────────
  const res = T.interpret(sheetCsv, 'text/csv');
  // Not a table: labels are scattered across eight columns.
  ok('a form-shaped sheet is read as a form', res.mode, 'grid');
  const r = res.records[0];

  // The value is to the RIGHT of its label here…
  ok('a value beside its label is found', r.manufacturer, 'BUCKINGHAM');
  ok('and another', r.model, 'U69P98Q2');
  ok('and the inspection date', r.inspection_date, '2026-08-22');
  // …and BELOW it here, with a different label immediately to the right, which
  // is exactly the case that made an earlier version return nothing.
  ok('a value under its label is found too', r.tag_id, 'FP158354');
  ok('and the equipment type, likewise underneath', r.item_type, 'CRANE LIFTING SLING');
  ok('and the inspector', r.inspector, '763');

  // The tag id is not the serial. On these sheets Serial Number is usually
  // blank, and merging the two would put a tag's code into the serial field of
  // an item that has its own.
  ok('a blank serial stays blank', r.serial, '');
  ok('but the tag id is still an identifier to look up by', T.identifiers(r), ['FP158354']);

  // A field whose neighbour is another label must read as empty, not as that
  // label's text.
  ok('an empty field does not adopt the next label', r.lot_number, '');
  ok('nor does an empty date', r.mfg_date, null);

  ok('the overall assessment is the item verdict', r.overall_pass, true);
  ok('and is the assessment row, not a component row', r.result_text, 'Pass');
  // Currency and verdict are different claims: an expired item is not a failed
  // one, and vice versa.
  ok('currency is kept apart from the verdict', r.status_text, 'Current');
  // These forms state currency as a duration, which is not a date and must not
  // silently vanish.
  ok('a duration where a date was expected is kept verbatim', r.next_due_raw, '357 days');
  ok('and does not fabricate a date', r.next_due_date, null);

  ok('their checklist is captured', r.checks.length, 6);
  ok('including the question answered in a far column',
     r.checks[0].answer, 'Yes');
  ok('and the one whose answer is neither pass nor fail',
     r.checks.find(c => /impact indicator/.test(c.prompt)).result, null);
  // A question already shown as a check must not be listed again as an unmapped
  // field — the tech would see the same answer twice under two headings.
  ok('a question is not also listed as an extra field', Object.keys(r.extra), []);

  // ── Reading the verdict ──────────────────────────────────────────────────
  ok('the ways people write a pass', ['Pass','OK','Serviceable','Y','1'].map(T.toVerdict),
     [true, true, true, true, true]);
  ok('and a fail', ['Fail','Removed','Unserviceable','N','0'].map(T.toVerdict),
     [false, false, false, false, false]);
  // Anything unreadable must read as UNKNOWN. Guessing a pass on fall
  // protection is the one error that gets somebody hurt.
  ok('and anything else is unknown, never a pass',
     ['Not Equipped','?','see notes',''].map(T.toVerdict), [null, null, null, null]);

  // ── Dates ────────────────────────────────────────────────────────────────
  ok('US order is assumed, as that is where the crews are', T.toDate('8/22/2026'), '2026-08-22');
  // A day over 12 in first position can only be day-first.
  ok('unless the first number cannot be a month', T.toDate('22/8/2026'), '2026-08-22');
  ok('ISO passes through', T.toDate('2026-08-22'), '2026-08-22');
  ok('a named month reads', T.toDate('22 Aug 2026'), '2026-08-22');
  ok('either way round', T.toDate('Aug 22, 2026'), '2026-08-22');
  ok('and nonsense yields nothing rather than a wrong date', T.toDate('soon'), null);

  // ── A genuine header-row table still works ───────────────────────────────
  const tbl = T.interpret(
    'Serial,Inspection Date,Result,Notes\n' +
    'H-1,2025-01-02,Pass,fine\n' +
    'H-1,2026-01-02,Fail,"cut, frayed"\n', 'text/csv');
  ok('a header-row sheet is read as a table', tbl.mode, 'table');
  // Most recent first: a sheet that appends at the bottom would otherwise lead
  // with the oldest row, and the tech cares about the last inspection.
  ok('newest first', tbl.records.map(x => x.inspection_date), ['2026-01-02', '2025-01-02']);
  // A comma inside a quoted note shifts every field after it if the parser is a
  // split(',') — and the field that shifts is the one saying pass or fail.
  ok('a comma inside a quoted note does not shift the columns', tbl.records[0].notes, 'cut, frayed');
  ok('so the verdict stays with its row', tbl.records[0].overall_pass, false);

  // ── Degrading ────────────────────────────────────────────────────────────
  ok('an empty document yields nothing rather than throwing', T.interpret('', 'text/csv').records, []);
  ok('and so does junk', T.interpret('\n\n\n', 'text/csv').records, []);
  ok('a spreadsheet error is not read as data',
     T.interpret('Model,Serial\n#NUM!,#REF!\n', 'text/csv').records, []);

  return { log, fails };
}, sheet);

await b.close();
out.log.forEach(l => console.log(l));
if (errs.length) { console.error('Page errors:', errs); process.exit(1); }
if (out.fails) { console.error(`\n${out.fails} tag-link assertion(s) failed.`); process.exit(1); }
console.log('\nAll tag link assertions passed.');
