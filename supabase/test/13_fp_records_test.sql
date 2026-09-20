-- Correcting and deleting fall-protection records. Runs after
-- 12_certificate_views_test.sql.
--
-- These are safety documents, so the properties under test are all about what
-- CANNOT happen:
--   • a correction never destroys what the record used to say
--   • a deletion never destroys the row, and never leaves an item with no
--     current record while an earlier valid one exists
--   • neither is possible without a reason, or by a tech
--   • public_ref cannot be changed — tags in the field already point at it

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/15_fp_records.sql

SET lia.uid = '11111111-1111-1111-1111-111111111111';

-- Two inspections a year apart on one item.
DO $$
DECLARE v_checks jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt, 'answer', pass_answer))
    INTO v_checks FROM fp_current_checks(NULL, fp_type_for(NULL, 'body_harness'));

  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'REC-1', 'equipment_type', 'body_harness',
    'manufacturer', 'MSA', 'model', 'V-FIT',
    'inspection_date', '2025-08-01', 'work_order_id', 'WO-777',
    'checks', v_checks));

  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'REC-1', 'equipment_type', 'body_harness',
    'manufacturer', 'MSA', 'model', 'V-FIT',
    'inspection_date', '2026-08-01', 'work_order_id', 'WO-888',
    'checks', v_checks));
END $$;

-- ── Browsing ────────────────────────────────────────────────────────────────
DO $$
DECLARE v json; v_row json;
BEGIN
  v := fp_records(NULL, NULL, 100, 0);
  PERFORM pg_temp.want('the account''s items are listed',
    (SELECT count(*)::int FROM json_array_elements(v->'rows')) > 0, true);

  v_row := (SELECT r FROM json_array_elements(v->'rows') r WHERE r->>'serial_raw' = 'REC-1');
  PERFORM pg_temp.want('showing the latest inspection', v_row->>'inspection_date', '2026-08-01');
  -- The office needs to know there IS history before it clicks in.
  PERFORM pg_temp.want('and how many there have been', (v_row->>'history_count')::int, 2);

  -- The office is holding an item and does not know which identifier it has.
  PERFORM pg_temp.want('search finds it by serial',
    (SELECT count(*)::int FROM json_array_elements(fp_records('REC-1', NULL, 100, 0)->'rows')), 1);
  PERFORM pg_temp.want('and by model',
    (SELECT count(*)::int FROM json_array_elements(fp_records('V-FIT', NULL, 100, 0)->'rows')) > 0, true);
  PERFORM pg_temp.want('and a search matching nothing returns nothing, not everything',
    (SELECT count(*)::int FROM json_array_elements(fp_records('ZZZNOPE', NULL, 100, 0)->'rows')), 0);
END $$;

-- ── Correcting ──────────────────────────────────────────────────────────────
DO $$
DECLARE v_asset uuid; v_id uuid; v_new json; v_detail json;
BEGIN
  SELECT id INTO v_asset FROM assets WHERE serial_key = serial_key('REC-1');
  SELECT id INTO v_id FROM fp_inspections
   WHERE asset_id = v_asset AND inspection_date = '2026-08-01'
     AND is_current AND NOT is_deleted;

  v_new := amend_fp_inspection(jsonb_build_object(
    'inspection_id', v_id, 'manufacturer', 'MSA Safety',
    'reason', 'Manufacturer was abbreviated on the phone'));

  PERFORM pg_temp.want('the correction is applied', v_new->>'manufacturer', 'MSA Safety');
  PERFORM pg_temp.want('as a new version', (v_new->>'version')::int, 2);
  PERFORM pg_temp.want('pointing back at what it replaced', (v_new->>'supersedes')::uuid, v_id);
  -- So a certificate can never present an amended record as though the tech had
  -- answered that way on the day.
  PERFORM pg_temp.want('and marked as an office correction', v_new->>'source', 'office_amend');

  -- THE property. The old row is still there, saying what it said.
  PERFORM pg_temp.want('the superseded row still exists',
    (SELECT manufacturer FROM fp_inspections WHERE id = v_id), 'MSA');
  PERFORM pg_temp.want('marked not current',
    (SELECT is_current FROM fp_inspections WHERE id = v_id), false);
  PERFORM pg_temp.want('and not deleted',
    (SELECT is_deleted FROM fp_inspections WHERE id = v_id), false);

  -- Correcting a typo does not change who did the inspection.
  PERFORM pg_temp.want('the collector is unchanged by a correction',
    v_new->>'collector_name',
    (SELECT collector_name FROM fp_inspections WHERE id = v_id));

  -- The checks are what the tech found; an amendment corrects the item's
  -- details, not the findings.
  PERFORM pg_temp.want('the checks carry across intact',
    (SELECT count(*)::int FROM fp_inspection_checks WHERE fp_inspection_id = (v_new->>'id')::uuid),
    (SELECT count(*)::int FROM fp_inspection_checks WHERE fp_inspection_id = v_id));

  v_detail := fp_record_detail(v_asset);
  -- Hiding superseded rows would defeat the point of never destroying one.
  PERFORM pg_temp.want('the history shows every version, superseded included',
    (SELECT count(*)::int FROM json_array_elements(v_detail->'history')), 3);
  PERFORM pg_temp.want('and the correction is on the audit trail',
    (SELECT x->>'reason' FROM json_array_elements(v_detail->'audit') x LIMIT 1),
    'Manufacturer was abbreviated on the phone');
END $$;

-- A correction with no reason is indistinguishable from tampering later on.
SELECT pg_temp.want_error('a correction with no reason is refused',
  $$ SELECT amend_fp_inspection(jsonb_build_object(
       'inspection_id', (SELECT id FROM fp_inspections WHERE is_current LIMIT 1),
       'manufacturer', 'X')) $$);

-- ── Deleting ────────────────────────────────────────────────────────────────
DO $$
DECLARE v_asset uuid; v_id uuid;
BEGIN
  SELECT id INTO v_asset FROM assets WHERE serial_key = serial_key('REC-1');
  -- Pinned to a DATE: is_current is per inspection date, so this item has two
  -- current rows and picking one arbitrarily made the test non-deterministic.
  SELECT id INTO v_id FROM fp_inspections
   WHERE asset_id = v_asset AND inspection_date = '2026-08-01'
     AND is_current AND NOT is_deleted;

  PERFORM delete_fp_inspection(jsonb_build_object(
    'inspection_id', v_id, 'reason', 'Recorded against the wrong item'));

  -- Stops appearing as it was; does not stop existing.
  PERFORM pg_temp.want('the row survives deletion',
    (SELECT count(*)::int FROM fp_inspections WHERE id = v_id), 1);
  PERFORM pg_temp.want('marked deleted',
    (SELECT is_deleted FROM fp_inspections WHERE id = v_id), true);

  -- Deleting an AMENDMENT reverts to the version it replaced rather than
  -- wiping the date. That is the point of superseding: the earlier record was
  -- never destroyed, so undoing the correction brings it back.
  PERFORM pg_temp.want('the version it superseded takes over',
    (SELECT count(*)::int FROM fp_inspections
      WHERE asset_id = v_asset AND inspection_date = '2026-08-01'
        AND is_current AND NOT is_deleted), 1);
  PERFORM pg_temp.want('so the certificate shows what it said before the correction',
    (SELECT manufacturer FROM fall_protection_public
      WHERE serial_num = 'REC-1' AND inspection_date = '2026-08-01'), 'MSA');

  -- Last year's record is current in its own right — is_current is per DATE —
  -- so it is untouched by any of this.
  PERFORM pg_temp.want('and the earlier visit is unaffected',
    (SELECT count(*)::int FROM fall_protection_public
      WHERE serial_num = 'REC-1' AND inspection_date = '2025-08-01'), 1);

  -- Undo, because deleting the wrong one is itself a mistake worth fixing.
  PERFORM restore_fp_inspection(jsonb_build_object('inspection_id', v_id));
  PERFORM pg_temp.want('a deletion can be undone',
    (SELECT is_deleted FROM fp_inspections WHERE id = v_id), false);
  -- The partial unique index would reject a second one outright, so this is
  -- really asserting that restore stood the other version down first.
  PERFORM pg_temp.want('and that date has one current record again',
    (SELECT count(*)::int FROM fp_inspections
      WHERE asset_id = v_asset AND inspection_date = '2026-08-01'
        AND is_current AND NOT is_deleted), 1);
END $$;

-- A record that was never corrected has nothing to fall back to, so deleting it
-- must take that date off the certificate entirely. This is the case the office
-- actually reaches for: an inspection recorded against the wrong item.
DO $$
DECLARE v_checks jsonb; v_asset uuid; v_id uuid;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt, 'answer', pass_answer))
    INTO v_checks FROM fp_current_checks(NULL, fp_type_for(NULL, 'lanyard'));
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'REC-2', 'equipment_type', 'lanyard',
    'inspection_date', '2026-08-05', 'checks', v_checks));

  SELECT id INTO v_asset FROM assets WHERE serial_key = serial_key('REC-2');
  SELECT id INTO v_id FROM fp_inspections WHERE asset_id = v_asset AND is_current;

  PERFORM delete_fp_inspection(jsonb_build_object(
    'inspection_id', v_id, 'reason', 'Recorded against the wrong item'));

  PERFORM pg_temp.want('an uncorrected record leaves the certificate when deleted',
    (SELECT count(*)::int FROM fall_protection_public WHERE serial_num = 'REC-2'), 0);
  PERFORM pg_temp.want('but the row is still on file',
    (SELECT count(*)::int FROM fp_inspections WHERE id = v_id), 1);
  PERFORM pg_temp.want('with the reason recorded',
    (SELECT reason FROM fp_record_audit WHERE inspection_id = v_id AND action = 'delete'),
    'Recorded against the wrong item');
END $$;

SELECT pg_temp.want_error('a deletion with no reason is refused',
  $$ SELECT delete_fp_inspection(jsonb_build_object(
       'inspection_id', (SELECT id FROM fp_inspections WHERE is_current LIMIT 1))) $$);

-- ── The item's identity ─────────────────────────────────────────────────────
DO $$
DECLARE v_asset uuid; v_ref_before text;
BEGIN
  SELECT id, public_ref INTO v_asset, v_ref_before
    FROM assets WHERE serial_key = serial_key('REC-1');

  PERFORM update_fp_asset(jsonb_build_object(
    'asset_id', v_asset, 'serial_raw', 'REC-1A',
    'reason', 'Serial was mistyped on first entry'));

  PERFORM pg_temp.want('a mistyped serial can be corrected',
    (SELECT serial_raw FROM assets WHERE id = v_asset), 'REC-1A');
  PERFORM pg_temp.want('and the lookup key follows it',
    (SELECT serial_key FROM assets WHERE id = v_asset), serial_key('REC-1A'));

  -- Tags already in the field point at this code. Changing it would make every
  -- one of them resolve to nothing.
  PERFORM pg_temp.want('but the certificate code is untouched',
    (SELECT public_ref FROM assets WHERE id = v_asset), v_ref_before);
END $$;

SELECT pg_temp.want_error('a serial already in use is refused',
  $$ WITH a AS (SELECT id FROM assets WHERE serial_key = serial_key('VIEW-1'))
     SELECT update_fp_asset(jsonb_build_object(
       'asset_id', (SELECT id FROM a), 'serial_raw', 'REC-1A', 'reason', 'x')) $$);

-- ── What still has to reach BSI ─────────────────────────────────────────────
-- An inspection that never got to BSI is unbilled work.
DO $$
DECLARE v_pending json; v_id uuid;
BEGIN
  v_pending := fp_pending_bsi(NULL);
  PERFORM pg_temp.want('unpushed inspections are listed',
    (SELECT count(*)::int FROM json_array_elements(v_pending)) > 0, true);

  v_id := (SELECT (x->>'inspection_id')::uuid FROM json_array_elements(v_pending) x LIMIT 1);
  PERFORM pg_temp.want('marking one as pushed reports how many landed',
    mark_fp_bsi_pushed(jsonb_build_object('items',
      jsonb_build_array(jsonb_build_object('inspection_id', v_id, 'box_ref', 'box-3')))), 1);
  PERFORM pg_temp.want('and it drops off the pending list',
    (SELECT count(*)::int FROM json_array_elements(fp_pending_bsi(NULL)) x
      WHERE (x->>'inspection_id')::uuid = v_id), 0);
  -- So a re-run after a crash knows what it already did.
  PERFORM pg_temp.want('with the box it landed in recorded',
    (SELECT bsi_box_ref FROM fp_inspections WHERE id = v_id), 'box-3');
END $$;

-- ── Only a lead ─────────────────────────────────────────────────────────────
-- A tech records what he inspected. Going back and changing what a certificate
-- says is a different act.
SET lia.uid = '33333333-3333-3333-3333-333333333333';
SELECT pg_temp.want_error('a sub-tech cannot correct a record',
  $$ SELECT amend_fp_inspection(jsonb_build_object(
       'inspection_id', (SELECT id FROM fp_inspections WHERE is_current LIMIT 1),
       'manufacturer', 'X', 'reason', 'because')) $$);
SELECT pg_temp.want_error('nor delete one',
  $$ SELECT delete_fp_inspection(jsonb_build_object(
       'inspection_id', (SELECT id FROM fp_inspections WHERE is_current LIMIT 1),
       'reason', 'because')) $$);
SELECT pg_temp.want_error('nor change an item''s serial',
  $$ SELECT update_fp_asset(jsonb_build_object(
       'asset_id', (SELECT id FROM assets WHERE kind = 'fall_protection' LIMIT 1),
       'serial_raw', 'HACK', 'reason', 'because')) $$);

DO $$ BEGIN
  PERFORM pg_temp.want('and nobody rewrites an inspection directly',
    has_table_privilege('authenticated', 'public.fp_inspections', 'UPDATE'), false);
  PERFORM pg_temp.want('nor deletes one',
    has_table_privilege('authenticated', 'public.fp_inspections', 'DELETE'), false);
  PERFORM pg_temp.want('nor edits the audit trail',
    has_table_privilege('authenticated', 'public.fp_record_audit', 'UPDATE'), false);
END $$;
