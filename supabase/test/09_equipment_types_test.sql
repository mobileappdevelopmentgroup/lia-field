-- Equipment types and their per-type checklists. Runs after 07_authoring_test.sql.
--
-- The properties that matter here are safety properties, not CRUD:
--   • a type's checklist is the one that applies, whoever made the item
--   • the overall assessment is derived, and a tech cannot set it
--   • the inverted question (impact indicator) cannot be forged into a pass
--   • an unanswered required check cannot slip through as a pass
--   • editing a checklist never rewrites a certificate already issued

\set ON_ERROR_STOP on
\set ACME '11111111-1111-1111-1111-111111111111'
\set SUB  '33333333-3333-3333-3333-333333333333'

\ir _helpers.sql
\ir ../11_fp_equipment_types.sql

SET lia.uid = '11111111-1111-1111-1111-111111111111';

-- ── The seed ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('all fourteen standard types seeded',
    (SELECT count(*)::int FROM fp_equipment_types WHERE account_id IS NULL), 14);

  PERFORM pg_temp.want('every type has a published baseline',
    (SELECT count(*)::int FROM fp_equipment_types et
      WHERE et.account_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM fp_check_templates t
                         WHERE t.equipment_type_id = et.id AND t.published_at IS NOT NULL)), 0);

  -- Spot-check the two ends of the sheet.
  PERFORM pg_temp.want('a body harness carries nine checks',
    (SELECT count(*)::int FROM fp_current_checks(NULL, fp_type_for(NULL,'body_harness'))), 9);
  PERFORM pg_temp.want('a crane lift sling carries five',
    (SELECT count(*)::int FROM fp_current_checks(NULL, fp_type_for(NULL,'crane_lift_sling'))), 5);

  -- Not every type has the same parameters — that is the whole point.
  PERFORM pg_temp.want('a climbing belt has leather and stitching',
    (SELECT count(*)::int FROM fp_current_checks(NULL, fp_type_for(NULL,'climbing_belt'))
      WHERE code = 'leather_stitching'), 1);
  PERFORM pg_temp.want('a body harness does not',
    (SELECT count(*)::int FROM fp_current_checks(NULL, fp_type_for(NULL,'body_harness'))
      WHERE code = 'leather_stitching'), 0);

  -- "na" in the sheet means the check is not carried at all.
  PERFORM pg_temp.want('an equipped type asks about the impact indicator',
    (SELECT count(*)::int FROM fp_current_checks(NULL, fp_type_for(NULL,'body_harness'))
      WHERE code = 'impact_indicator'), 1);
  PERFORM pg_temp.want('a not-equipped type does not',
    (SELECT count(*)::int FROM fp_current_checks(NULL, fp_type_for(NULL,'climbing_belt'))
      WHERE code = 'impact_indicator'), 0);

  -- The inverted question.
  PERFORM pg_temp.want('the impact question is yes/no and passes on No',
    (SELECT answer_style || ':' || pass_answer::text
       FROM fp_current_checks(NULL, fp_type_for(NULL,'srl')) WHERE code='impact_indicator'),
    'yes_no:false');
  PERFORM pg_temp.want('the labels question is yes/no and passes on Yes',
    (SELECT answer_style || ':' || pass_answer::text
       FROM fp_current_checks(NULL, fp_type_for(NULL,'srl')) WHERE code='labels'),
    'yes_no:true');
  PERFORM pg_temp.want('a component check is pass/fail',
    (SELECT answer_style FROM fp_current_checks(NULL, fp_type_for(NULL,'srl')) WHERE code='webbing'),
    'pass_fail');
END $$;

-- Re-running the migration must not spawn a v2 or undo an edit.
\ir ../11_fp_equipment_types.sql
DO $$ BEGIN
  PERFORM pg_temp.want('re-running the seed is idempotent',
    (SELECT max(version)::int FROM fp_check_templates
      WHERE equipment_type_id = fp_type_for(NULL,'body_harness')), 1);
  PERFORM pg_temp.want('and does not duplicate the types',
    (SELECT count(*)::int FROM fp_equipment_types WHERE account_id IS NULL), 14);
END $$;

-- ── Recording against a type ────────────────────────────────────────────────
SET lia.uid = '11111111-1111-1111-1111-111111111111';

DO $$
DECLARE
  v_type uuid := fp_type_for(NULL, 'body_harness');
  v_tpl  uuid := fp_current_template(NULL, v_type);
  v_all  jsonb;
  v_id   uuid;
BEGIN
  -- Every check answered at its passing value — what the capture screen sends
  -- when the tech touches nothing.
  SELECT jsonb_agg(jsonb_build_object('ord', ord, 'code', code, 'answer', pass_answer)
                   ORDER BY ord)
    INTO v_all FROM fp_current_checks(NULL, v_type);

  v_id := record_fp_inspection(jsonb_build_object(
    'serial_num', 'FP-HARNESS-1', 'equipment_type', 'body_harness',
    'manufacturer', 'MSA', 'model', 'Workman', 'lot_number', 'L-42',
    'mfg_month', 3, 'mfg_year', 2024, 'description', 'Full body harness',
    'template_id', v_tpl, 'checks', v_all));

  PERFORM pg_temp.want('all-pass yields an overall pass',
    (SELECT overall_pass FROM fp_inspections WHERE id = v_id), true);
  PERFORM pg_temp.want('the type is recorded',
    (SELECT equipment_type_id FROM fp_inspections WHERE id = v_id), v_type);
  PERFORM pg_temp.want('and its name denormalized for the certificate',
    (SELECT item_type FROM fp_inspections WHERE id = v_id), 'Body harness');
  PERFORM pg_temp.want('the manufacture date is kept',
    (SELECT mfg_month::text || '/' || mfg_year::text FROM fp_inspections WHERE id = v_id), '3/2024');
  PERFORM pg_temp.want('the lot number is kept',
    (SELECT lot_number FROM fp_inspections WHERE id = v_id), 'L-42');
  PERFORM pg_temp.want('nine check results are stored',
    (SELECT count(*)::int FROM fp_inspection_checks WHERE fp_inspection_id = v_id), 9);
  PERFORM pg_temp.want('answering No to "was it activated" is a pass',
    (SELECT result FROM fp_inspection_checks
      WHERE fp_inspection_id = v_id AND code='impact_indicator'), true);
  PERFORM pg_temp.want('and the raw answer is preserved as No',
    (SELECT answer FROM fp_inspection_checks
      WHERE fp_inspection_id = v_id AND code='impact_indicator'), false);
END $$;

-- One failed check fails the item — no matter which one.
DO $$
DECLARE
  v_type uuid := fp_type_for(NULL, 'body_harness');
  v_tpl  uuid := fp_current_template(NULL, v_type);
  v_all  jsonb;
  v_id   uuid;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('ord', ord, 'code', code,
           'answer', CASE WHEN code = 'buckles' THEN NOT pass_answer ELSE pass_answer END)
         ORDER BY ord)
    INTO v_all FROM fp_current_checks(NULL, v_type);

  v_id := record_fp_inspection(jsonb_build_object(
    'serial_num', 'FP-HARNESS-2', 'equipment_type', 'body_harness',
    'template_id', v_tpl, 'checks', v_all));

  PERFORM pg_temp.want('one failed check fails the item',
    (SELECT overall_pass FROM fp_inspections WHERE id = v_id), false);
  PERFORM pg_temp.want('the status follows',
    (SELECT status FROM fp_inspections WHERE id = v_id), 'fail');
  PERFORM pg_temp.want('and the reason names the check, not free text',
    (SELECT discard_reason FROM fp_inspections WHERE id = v_id), 'Failed: Buckles');
END $$;

-- Answering YES to "has the impact indicator been activated?" must fail, even
-- though `true` is the passing answer for every other question in the list.
DO $$
DECLARE
  v_type uuid := fp_type_for(NULL, 'srl');
  v_tpl  uuid := fp_current_template(NULL, v_type);
  v_all  jsonb;
  v_id   uuid;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('ord', ord, 'code', code, 'answer', true) ORDER BY ord)
    INTO v_all FROM fp_current_checks(NULL, v_type);

  v_id := record_fp_inspection(jsonb_build_object(
    'serial_num', 'FP-SRL-1', 'equipment_type', 'srl',
    'template_id', v_tpl, 'checks', v_all));

  PERFORM pg_temp.want('yes to an activated indicator is a fail',
    (SELECT overall_pass FROM fp_inspections WHERE id = v_id), false);
  PERFORM pg_temp.want('and it is the indicator that is named',
    (SELECT discard_reason FROM fp_inspections WHERE id = v_id),
    'Failed: Has the impact indicator been activated?');
END $$;

-- A client must not be able to redefine what passes.
DO $$
DECLARE
  v_type uuid := fp_type_for(NULL, 'srl');
  v_tpl  uuid := fp_current_template(NULL, v_type);
  v_all  jsonb;
  v_id   uuid;
BEGIN
  -- Forged: says the indicator WAS activated, but claims yes is the pass.
  SELECT jsonb_agg(jsonb_build_object('ord', ord, 'code', code, 'answer', true,
                                      'pass_answer', true, 'answer_style', 'yes_no')
                   ORDER BY ord)
    INTO v_all FROM fp_current_checks(NULL, v_type);

  v_id := record_fp_inspection(jsonb_build_object(
    'serial_num', 'FP-SRL-FORGE', 'equipment_type', 'srl',
    'template_id', v_tpl, 'checks', v_all));

  PERFORM pg_temp.want('a client cannot redefine which answer passes',
    (SELECT overall_pass FROM fp_inspections WHERE id = v_id), false);
  PERFORM pg_temp.want('the template pass_answer is what is stored',
    (SELECT pass_answer FROM fp_inspection_checks
      WHERE fp_inspection_id = v_id AND code='impact_indicator'), false);
END $$;

-- Dropping a check must not be a way to pass.
DO $$
DECLARE
  v_type uuid := fp_type_for(NULL, 'body_harness');
  v_tpl  uuid := fp_current_template(NULL, v_type);
  v_some jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('ord', ord, 'code', code, 'answer', pass_answer) ORDER BY ord)
    INTO v_some FROM fp_current_checks(NULL, v_type) WHERE code <> 'buckles';

  PERFORM pg_temp.want_error('omitting a required check is refused',
    format($q$ SELECT record_fp_inspection(jsonb_build_object(
      'serial_num','FP-SHORT','equipment_type','body_harness',
      'template_id', %L::uuid, 'checks', %L::jsonb)) $q$, v_tpl, v_some));

  PERFORM pg_temp.want_error('leaving a check unanswered is refused',
    format($q$ SELECT record_fp_inspection(jsonb_build_object(
      'serial_num','FP-BLANK','equipment_type','body_harness',
      'template_id', %L::uuid,
      'checks', (SELECT jsonb_agg(jsonb_build_object('code', code)) FROM fp_current_checks(NULL, %L::uuid)))) $q$,
      v_tpl, v_type));
END $$;

-- ── Editing a checklist ─────────────────────────────────────────────────────
-- "These can be changed and more can be added at any point" — without ever
-- altering a certificate already issued.
DO $$
DECLARE
  v_shared uuid := fp_type_for(NULL, 'climbing_belt');
  v_acct   uuid := (SELECT account_id FROM account_members
                     WHERE user_id = '11111111-1111-1111-1111-111111111111'::uuid);
  v_base   jsonb;
  v_res    json;
  v_own    uuid;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt,
           'answer_style', answer_style, 'pass_answer', pass_answer) ORDER BY ord)
    INTO v_base FROM fp_current_checks(NULL, v_shared);

  v_res := publish_fp_type_checks(v_shared,
             v_base || jsonb_build_array(
               jsonb_build_object('code','body_belt_pad','prompt','Body belt pad')));

  PERFORM pg_temp.want('a lead can add a check to a type',
    (v_res->>'checks')::int, 6);

  -- Editing a SHARED type must fork it, not rewrite it for every account.
  v_own := (SELECT id FROM fp_equipment_types
             WHERE account_id = v_acct AND slug = 'climbing_belt');
  PERFORM pg_temp.want('editing a shared type forks it onto the account',
    v_own IS NOT NULL, true);
  PERFORM pg_temp.want('the shared baseline is untouched',
    (SELECT count(*)::int FROM fp_current_checks(NULL, v_shared)), 5);
  PERFORM pg_temp.want('and the account now resolves to its own',
    fp_type_for(v_acct, 'climbing_belt'), v_own);
  PERFORM pg_temp.want('which carries the added check',
    (SELECT count(*)::int FROM fp_current_checks(NULL, v_own)), 6);
END $$;

-- A certificate issued yesterday keeps its questions.
DO $$
DECLARE
  v_type uuid := fp_type_for(NULL, 'lanyard');
  v_tpl  uuid := fp_current_template(NULL, v_type);
  v_all  jsonb;
  v_id   uuid;
  v_base jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('ord', ord, 'code', code, 'answer', pass_answer) ORDER BY ord)
    INTO v_all FROM fp_current_checks(NULL, v_type);
  v_id := record_fp_inspection(jsonb_build_object(
    'serial_num','FP-LANYARD-1','equipment_type','lanyard',
    'template_id', v_tpl, 'checks', v_all));

  -- Now republish that type with a shorter list.
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt,
           'answer_style', answer_style, 'pass_answer', pass_answer) ORDER BY ord)
    INTO v_base FROM fp_current_checks(NULL, v_type) WHERE code IN ('labels','webbing');
  PERFORM publish_fp_type_checks(v_type, v_base);

  PERFORM pg_temp.want('the issued record keeps all seven results',
    (SELECT count(*)::int FROM fp_inspection_checks WHERE fp_inspection_id = v_id), 7);
  PERFORM pg_temp.want('and still names the version it was performed against',
    (SELECT template_version FROM fp_inspections WHERE id = v_id), 1);
END $$;

-- ── Who may author ──────────────────────────────────────────────────────────
SET lia.uid = '33333333-3333-3333-3333-333333333333';
DO $$ BEGIN
  PERFORM pg_temp.want_error('a sub-tech cannot add an equipment type',
    $q$ SELECT save_fp_equipment_type('{"name":"Improvised rig"}'::jsonb) $q$);
  PERFORM pg_temp.want_error('nor change a type checklist',
    format($q$ SELECT publish_fp_type_checks(%L, '[{"prompt":"x"}]'::jsonb) $q$,
           fp_type_for(NULL,'srl')));
END $$;

-- fp_checks_for_authoring is SECURITY DEFINER, so RLS does not protect it and
-- the account check has to be its own.
SET lia.uid = '22222222-2222-2222-2222-222222222222';
DO $$ BEGIN
  PERFORM pg_temp.want_error('another account cannot read this model''s checklist',
    format($q$ SELECT * FROM fp_checks_for_authoring(%L) $q$,
           (SELECT id FROM fp_models WHERE lower(model) = 'newton')));
END $$;

SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$ BEGIN
  PERFORM pg_temp.want('but its own account can',
    (SELECT count(*)::int FROM fp_checks_for_authoring(
       (SELECT id FROM fp_models WHERE lower(model) = 'newton'))) > 0, true);
END $$;

-- ── The device catalogue ────────────────────────────────────────────────────
SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE v_cat jsonb := fp_type_catalog();
BEGIN
  PERFORM pg_temp.want('the catalogue serves fourteen types',
    jsonb_array_length(v_cat), 14);
  -- sort_order is text inside jsonb, so ordering by it naively puts 10 before 2.
  PERFORM pg_temp.want('in the sheet''s order, not lexical order',
    (SELECT string_agg(e->>'sort_order', ',' ORDER BY ord)
       FROM jsonb_array_elements(v_cat) WITH ORDINALITY x(e, ord)),
    '1,2,3,4,5,6,7,8,9,10,11,12,13,14');
  PERFORM pg_temp.want('the forked climbing belt shadows the shared one',
    (SELECT jsonb_array_length(e->'checks') FROM jsonb_array_elements(v_cat) e
      WHERE e->>'slug' = 'climbing_belt'), 6);
  PERFORM pg_temp.want('every type comes down with its checks',
    (SELECT count(*)::int FROM jsonb_array_elements(v_cat) e
      WHERE jsonb_array_length(e->'checks') = 0), 0);
  PERFORM pg_temp.want('and with the template version to pin',
    (SELECT count(*)::int FROM jsonb_array_elements(v_cat) e
      WHERE e->>'template_id' IS NULL), 0);
END $$;

\echo ''
\echo 'All equipment type assertions passed.'
