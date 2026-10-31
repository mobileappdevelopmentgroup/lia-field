-- The office adds a ladder to a work order; fall-protection corrections
-- follow an impersonation session (38). Runs after 31_fp_serial_pool_tags_test.sql.
--
-- What has to hold:
--   * an office add is a lead's act, with a reason, on the audit trail, marked
--     office_add by the SERVER and never by the client;
--   * it never buries a field record — an item that already has one that day
--     is a correction, and a deleted one is a restore;
--   * correcting a subcontractor's harness while acting as them works, and
--     lands in their account.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/38_field_work_edits.sql
-- Twice: the paste is idempotent.
\ir ../migrations/38_field_work_edits.sql

-- Whatever earlier files left running, start from the office's own account.
UPDATE impersonation_sessions SET ended_at = now() WHERE ended_at IS NULL;

SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- a tech under Nate
SELECT record_inspection('{"serial_num":"FE-1","work_order_id":"WO-FE","brand":"Werner","source":"field"}'::jsonb);

SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate, a lead

-- ── Refusals ────────────────────────────────────────────────────────────────
SELECT pg_temp.want_error('an add without a reason is refused',
  $$SELECT add_inspection_office('{"serial_num":"FE-2","work_order_id":"WO-FE","reason":"  "}'::jsonb)$$);
SELECT pg_temp.want_error('an add without a serial is refused',
  $$SELECT add_inspection_office('{"serial_num":"","work_order_id":"WO-FE","reason":"radioed in"}'::jsonb)$$);
SELECT pg_temp.want_error('an add without a work order is refused',
  $$SELECT add_inspection_office('{"serial_num":"FE-2","reason":"radioed in"}'::jsonb)$$);
SELECT pg_temp.want_error('an item the field already recorded today is a correction, not an add',
  $$SELECT add_inspection_office('{"serial_num":"fe-1","work_order_id":"WO-FE","reason":"dup"}'::jsonb)$$);

-- ── The add ─────────────────────────────────────────────────────────────────
DO $$
DECLARE v json; v_nate uuid;
BEGIN
  SELECT account_id INTO v_nate FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002';
  v := add_inspection_office(jsonb_build_object(
    'serial_num', 'FE-2', 'work_order_id', 'WO-FE', 'reason', 'tech radioed it in',
    'brand', 'Louisville', 'type', 'Step', 'length', '6',
    'has_leveler', true, 'source', 'field',              -- the client's word is ignored
    'parts', jsonb_build_array(jsonb_build_object('name', 'G13', 'qty', 2))));

  PERFORM pg_temp.want('it lands in the lead''s account', (v->>'account_id')::uuid, v_nate);
  PERFORM pg_temp.want('marked as added in the office, whatever the client said', v->>'source', 'office_add');
  PERFORM pg_temp.want('credited to who entered it',
    (v->>'collected_by')::uuid, '1a000000-0000-0000-0000-000000000002'::uuid);
  PERFORM pg_temp.want('version 1, current', (v->>'version') || '/' || (v->>'is_current'), '1/true');
  PERFORM pg_temp.want('not in BSI yet', v->>'bsi_pushed_at', NULL::text);
  PERFORM pg_temp.want('the parts went in', (v->'parts'->0->>'qty')::int, 2);
  PERFORM pg_temp.want('a flag that was given is kept', (v->>'has_leveler')::boolean, true);
  PERFORM pg_temp.want('one that was not is unassessed, not false', v->>'has_claw', NULL::text);
  PERFORM pg_temp.want('due a year out',
    (v->>'next_due_date')::date - (v->>'inspection_date')::date, 365);

  PERFORM pg_temp.want('the reason is on the audit trail',
    (SELECT action || ':' || reason FROM inspection_audit WHERE inspection_id = (v->>'id')::uuid),
    'add:tech radioed it in');
  PERFORM pg_temp.want('and the work order now counts it',
    (SELECT total FROM field_work_orders(false) WHERE work_order_id = 'WO-FE'), 2);
END $$;

-- ── Deleted is a restore ────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM delete_inspection(jsonb_build_object(
    'inspection_id', (SELECT id FROM inspections WHERE serial_num = 'FE-2' AND is_current),
    'reason', 'wrong work order'));
END $$;
SELECT pg_temp.want_error('adding an item deleted that day is refused — restore it',
  $$SELECT add_inspection_office('{"serial_num":"FE-2","work_order_id":"WO-FE","reason":"again"}'::jsonb)$$);

-- ── Only a lead ─────────────────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000004';
SELECT pg_temp.want_error('a tech cannot add from the office',
  $$SELECT add_inspection_office('{"serial_num":"FE-3","work_order_id":"WO-FE","reason":"x"}'::jsonb)$$);

-- ── Fall protection, while the umbrella acts as Nate ────────────────────────
DO $$ BEGIN
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'FE-H1', 'equipment_type', 'climbing_belt', 'work_order_id', 'WO-FE',
    'manufacturer', 'MSA',
    'checks', (SELECT jsonb_agg(jsonb_build_object('code', c.code, 'answer', c.pass_answer))
                 FROM fp_template_checks c
                 JOIN fp_check_templates t ON t.id = c.template_id
                 JOIN fp_equipment_types e ON e.id = t.equipment_type_id
                WHERE e.slug = 'climbing_belt' AND e.account_id IS NULL
                  AND t.published_at IS NOT NULL)));
END $$;

SET lia.uid = '1a000000-0000-0000-0000-000000000001';   -- Batavia's office
DO $$
DECLARE v_nate uuid; v_id uuid; v json;
BEGIN
  SELECT account_id INTO v_nate FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002';
  SELECT f.id INTO v_id FROM fp_inspections f JOIN assets a ON a.id = f.asset_id
   WHERE a.serial_raw = 'FE-H1' AND f.is_current;

  PERFORM start_impersonation(json_build_object('account_id', v_nate, 'reason', 'fixing his records')::jsonb);

  v := amend_fp_inspection(jsonb_build_object('inspection_id', v_id, 'reason', 'model was blank', 'model', 'V-FIT'));
  PERFORM pg_temp.want('a correction while acting as Nate goes through', v->>'model', 'V-FIT');
  PERFORM pg_temp.want('and stays in his account', (v->>'account_id')::uuid, v_nate);

  PERFORM delete_fp_inspection(jsonb_build_object('inspection_id', (v->>'id')::uuid, 'reason', 'undo the model'));
  PERFORM pg_temp.want('deleting the correction brings the field version back',
    (SELECT id FROM fp_inspections WHERE asset_id = (v->>'asset_id')::uuid AND is_current), v_id);

  PERFORM restore_fp_inspection(jsonb_build_object('inspection_id', (v->>'id')::uuid, 'reason', 'no, keep it'));
  PERFORM pg_temp.want('and restoring puts the correction back',
    (SELECT id FROM fp_inspections WHERE asset_id = (v->>'asset_id')::uuid AND is_current), (v->>'id')::uuid);

  v := add_inspection_office(jsonb_build_object('serial_num', 'FE-4', 'work_order_id', 'WO-FE', 'reason', 'office add as Nate'));
  PERFORM pg_temp.want('an office add while acting as Nate lands in his account', (v->>'account_id')::uuid, v_nate);

  PERFORM stop_impersonation();
END $$;

-- ── A sibling sees none of it ───────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000003';   -- Michael
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM pg_temp.want('Michael cannot read Nate''s office adds',
    (SELECT count(*)::int FROM inspections WHERE serial_num IN ('FE-2','FE-4')), 0);
  PERFORM pg_temp.want('nor their audit rows',
    (SELECT count(*)::int FROM inspection_audit WHERE serial_num IN ('FE-2','FE-4')), 0);
END $$;
RESET ROLE;

SELECT pg_temp.want_error('Michael cannot correct Nate''s harness',
  $$SELECT amend_fp_inspection(jsonb_build_object('inspection_id',
      (SELECT id FROM fp_inspections WHERE work_order_id = 'WO-FE' AND is_current LIMIT 1),
      'reason', 'x', 'model', 'Y'))$$);

RESET lia.uid;
SET ROLE anon;
SELECT pg_temp.want_error('anon cannot add', $$SELECT add_inspection_office('{}'::jsonb)$$);
RESET ROLE;
