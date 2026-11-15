// The phone and the database keep two lists that must agree.
//
//   * Placeholder serials — field-app/js/serial-check.js refuses them on the
//     phone; supabase/migrations/39_placeholder_serials.sql refuses them in the
//     database. A word only one of them knows is either let through on one side
//     or refused with a different message on the other.
//   * Destroy parts — the BSI parts catalogue's "cut and destroy" entries
//     (field-app/js/parts-catalog.js) and the codes
//     supabase/migrations/40_destroyed_ladders.sql reads as a destroyed ladder.
//     A destroy code BSI adds and the database does not know would put a
//     cut-up ladder on the certificate as VALID.
//
//   node field-app/test/server-lists.test.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fails = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${pass ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
}
const key = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const words = s => [...s.matchAll(/'([^']*)'/g)].map(m => m[1]);

// ── Placeholder serials ─────────────────────────────────────────────────────
const js = read('field-app/js/serial-check.js');
const jsList = words(js.match(/var PLACEHOLDERS = \[([\s\S]*?)\];/)[1]).sort();
const sql = read('supabase/migrations/39_placeholder_serials.sql');
const sqlList = words(sql.match(/= ANY \(ARRAY\[([\s\S]*?)\]\)/)[1]).sort();

ok('the phone has a placeholder list', jsList.length > 10, true);
ok('the database refuses exactly the words the phone refuses', sqlList, jsList);
ok('every entry is already a key (the database matches keys)', sqlList.filter(w => key(w) !== w), []);

require(path.join(ROOT, 'field-app/js/serial-check.js'));
const check = globalThis.LiaSerialCheck;
ok('the phone calls each of the database\'s words a placeholder',
   sqlList.filter(w => check.problem(w) !== 'placeholder'), []);
ok('both sides refuse all-zeros and all-X',
   [/\^\(0\+\|X\+\)\$/.test(sql), /\^0\+\$/.test(js) && /\^X\+\$/.test(js)], [true, true]);

// ── Destroy parts ───────────────────────────────────────────────────────────
const catalog = read('field-app/js/parts-catalog.js');
const destroyCodes = [...catalog.matchAll(/\["([^"]+)","([^"]*DESTROY[^"]*)"\]/g)].map(m => key(m[1])).sort();
const mig40 = read('supabase/migrations/40_destroyed_ladders.sql');
const valuesBlock = mig40.match(/JOIN \(VALUES([\s\S]*?)\) AS d\(code, reason\)/)[1];
const sqlCodes = [...valuesBlock.matchAll(/\('([A-Z0-9]+)',/g)].map(m => m[1]).sort();

ok('the catalogue has destroy parts', destroyCodes.length >= 8, true);
ok('the database reads every destroy part in the catalogue as a destruction', destroyCodes, sqlCodes);
ok('PMCD4 (repair cost prohibitive) is one of them', sqlCodes.includes('PMCD4'), true);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
