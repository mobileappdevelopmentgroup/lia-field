// The equipment type catalogue exists twice: as the seed in
// supabase/migrations/11_fp_equipment_types.sql and as the built-in fallback in
// field-app/js/fp-types.js. They are generated from one table, and this fails
// if they ever drift — a phone asking different questions than the database
// scores against would corrupt a safety record quietly.
//
// Run with `npm run test:field`.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let fails = 0;
const ok = (l, g, w) => {
  const good = JSON.stringify(g) === JSON.stringify(w);
  if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l);
};

// ── The SQL seed ────────────────────────────────────────────────────────────
const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/11_fp_equipment_types.sql'), 'utf8');
const m = sql.match(/v_defs jsonb := '(\[[\s\S]*?\])'::jsonb;/);
if (!m) { console.log('FAIL could not find the seed in 11_fp_equipment_types.sql'); process.exit(1); }
const seed = JSON.parse(m[1].replace(/''/g, "'"));

// ── The built-in fallback ───────────────────────────────────────────────────
// Classic script, so run it against a stand-in global rather than importing.
const sandbox = { window: undefined, module: { exports: {} } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'field-app/js/fp-types.js'), 'utf8'), sandbox);
const Types = sandbox.module.exports;

ok('the built-in catalogue loaded', typeof Types.all, 'function');
ok('the same number of types', Types.BUILT_IN.length, seed.length);

const norm = t => ({
  slug: t.slug, name: t.name, sort_order: t.sort_order,
  checks: t.checks.map(c => ({
    code: c.code, prompt: c.prompt,
    answer_style: c.answer_style, pass_answer: c.pass_answer, required: c.required !== false,
  })),
});
ok('every type, name, check, prompt and polarity matches the seed',
   Types.BUILT_IN.map(norm), seed.map(norm));

// ── The properties the sheet defines ────────────────────────────────────────
ok('fourteen equipment types', Types.BUILT_IN.length, 14);
ok('every type carries the labels question',
   Types.BUILT_IN.filter(t => !t.checks.some(c => c.code === 'labels')).map(t => t.slug), []);
ok('every check is required — there is no partial pass',
   Types.BUILT_IN.every(t => t.checks.every(c => c.required !== false)), true);

// Equipped (e) vs not equipped (na), straight from the sheet.
const withIndicator = Types.BUILT_IN
  .filter(t => t.checks.some(c => c.code === 'impact_indicator')).map(t => t.slug).sort();
ok('only the equipped types ask about the impact indicator', withIndicator, [
  'body_harness', 'lanyard', 'rescue_device_r550', 'self_rescue_device',
  'self_rescue_with_bag', 'srl', 'temporary_horizontal_lifeline',
  'tie_off_adaptor', 'vertical_lifeline_arrester',
].sort());

// The inverted question. Getting this backwards would turn a fallen harness
// into a passing certificate.
ok('"has it been activated?" is a yes/no that fails on Yes',
   Types.BUILT_IN.flatMap(t => t.checks).filter(c => c.code === 'impact_indicator')
     .every(c => c.answer_style === 'yes_no' && c.pass_answer === false), true);
ok('"are the labels legible?" is a yes/no that passes on Yes',
   Types.BUILT_IN.flatMap(t => t.checks).filter(c => c.code === 'labels')
     .every(c => c.answer_style === 'yes_no' && c.pass_answer === true), true);
ok('every other check is a plain pass/fail component',
   Types.BUILT_IN.flatMap(t => t.checks)
     .filter(c => !['labels', 'impact_indicator'].includes(c.code))
     .every(c => c.answer_style === 'pass_fail' && c.pass_answer === true), true);

// A prompt is printed on a certificate; a code is a stable identifier. Neither
// may be ambiguous within a type.
for (const t of Types.BUILT_IN) {
  const codes = t.checks.map(c => c.code);
  ok(`${t.slug}: no repeated check`, codes.length, new Set(codes).size);
}

// ── The derived assessment ──────────────────────────────────────────────────
const harness = Types.bySlug('body_harness');
const answers = Types.startingAnswers(harness);
ok('a fresh checklist starts at all-pass', Types.overallPass(answers), true);
ok('and every check is answered', answers.every(a => a.answer != null), true);

const impact = answers.find(a => a.code === 'impact_indicator');
impact.answer = true;                       // yes, it was activated
ok('yes to an activated indicator fails the item', Types.overallPass(answers), false);
ok('even though every other check still passes',
   answers.filter(a => a.code !== 'impact_indicator').every(Types.isPass), true);
impact.answer = false;
ok('and setting it back to No restores the pass', Types.overallPass(answers), true);

const webbing = answers.find(a => a.code === 'webbing');
webbing.answer = false;
ok('one failed component fails the whole item', Types.overallPass(answers), false);
webbing.answer = true;

// An unanswered check must never read as a pass.
answers[0].answer = null;
ok('an unanswered check is not a pass', Types.overallPass(answers), false);
answers[0].answer = answers[0].pass_answer;

ok('the buttons read Yes / No for a question',
   [Types.labelFor(impact, true), Types.labelFor(impact, false)], ['Yes', 'No']);
ok('and Pass / Fail for a component',
   [Types.labelFor(webbing, true), Types.labelFor(webbing, false)], ['Pass', 'Fail']);

// Free-text item_type on records that predate the picker must still resolve.
ok('a legacy display name still finds its type', Types.byKey('Body harness').slug, 'body_harness');
ok('case and spacing do not matter', Types.byKey('  BODY HARNESS ').slug, 'body_harness');
ok('an unknown type resolves to nothing, not a wrong checklist', Types.byKey('trampoline'), null);

console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
process.exit(fails ? 1 : 0);
