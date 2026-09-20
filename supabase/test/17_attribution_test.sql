-- Who a certificate names.
-- Runs after 16_umbrella_test.sql, and reuses the tree it built:
--   Batavia (umbrella) → Nate Dobbs (734) → Crew Hand
--                      → Michael Dobbs (738)
--
-- The properties that matter:
--   • the certificate names the LEAD, even when a crew member did the work
--   • it names the umbrella as the organisation behind it
--   • who actually did the work is still on the row, for the office
--   • the public views never publish the collector's name
--   • a rep number carried forward keeps ITS OWN name, not the current lead's
--   • rows written before this migration are backfilled

\set ON_ERROR_STOP on

\ir _helpers.sql

-- A row written the old way: rep_number stamped, no name, no organisation.
-- This is what the live database looks like when 19 arrives.
SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate
SELECT record_inspection('{"serial_num":"OLD-1","work_order_id":"WO-OLD"}'::jsonb);

\ir ../19_certificate_attribution.sql

-- ── Backfill ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM pg_temp.want('a pre-existing row is given the name behind its number',
    (SELECT rep_name FROM inspections WHERE serial_num = 'OLD-1'), 'Nate Dobbs');
  PERFORM pg_temp.want('and the organisation that stands behind it',
    (SELECT verified_by FROM inspections WHERE serial_num = 'OLD-1'), 'Batavia');
END $$;

-- ── A crew member's work names the lead ─────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- Crew Hand, under Nate
SELECT record_inspection('{"serial_num":"CREW-1","work_order_id":"WO-C1"}'::jsonb);

DO $$
BEGIN
  PERFORM pg_temp.want('the certificate names the lead, not the field person',
    (SELECT rep_name FROM inspections WHERE serial_num = 'CREW-1'), 'Nate Dobbs');
  PERFORM pg_temp.want('with the lead''s number',
    (SELECT rep_number FROM inspections WHERE serial_num = 'CREW-1'), '734');
  PERFORM pg_temp.want('and the umbrella as verifier',
    (SELECT verified_by FROM inspections WHERE serial_num = 'CREW-1'), 'Batavia');

  -- The back office half. This is what the umbrella looks at when a customer
  -- asks who inspected their ladder.
  PERFORM pg_temp.want('who really did it is still recorded',
    (SELECT collector_name FROM inspections WHERE serial_num = 'CREW-1'), 'Crew Hand');
  PERFORM pg_temp.want('by user id as well',
    (SELECT collected_by FROM inspections WHERE serial_num = 'CREW-1'),
    '1a000000-0000-0000-0000-000000000004'::uuid);
END $$;

-- ── The public view publishes the lead and nothing else ─────────────────────
DO $$
BEGIN
  PERFORM pg_temp.want('the public certificate shows the lead as the technician',
    (SELECT tech_name FROM ladder_inspections_public WHERE serial_num = 'CREW-1'), 'Nate Dobbs');
  PERFORM pg_temp.want('and says who verified it',
    (SELECT verified_by FROM ladder_inspections_public WHERE serial_num = 'CREW-1'), 'Batavia');

  -- The collector must not be reachable through the view at all: it is granted
  -- to anon, so "not rendered by the site" is not the same as "not published".
  PERFORM pg_temp.want('the collector is not a column of the public view',
    (SELECT count(*)::int FROM information_schema.columns
      WHERE table_name = 'ladder_inspections_public'
        AND column_name IN ('collector_name', 'collected_by', 'tech_user_id')), 0);
  PERFORM pg_temp.want('nor of the fall protection view',
    (SELECT count(*)::int FROM information_schema.columns
      WHERE table_name = 'fall_protection_public'
        AND column_name IN ('collector_name', 'collected_by', 'tech_user_id')), 0);
END $$;

-- ── Fall protection takes the same path ─────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- Crew Hand
DO $$
DECLARE v_checks jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt, 'answer', pass_answer))
    INTO v_checks FROM fp_current_checks(NULL, fp_type_for(NULL, 'body_harness'));
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'FPCREW-1', 'equipment_type', 'body_harness',
    'inspection_date', '2026-09-19', 'work_order_id', 'WO-C1', 'checks', v_checks));

  -- The serial lives on the asset; fp_inspections points at it.
  PERFORM pg_temp.want('an FP certificate names the lead too',
    (SELECT i.rep_name FROM fp_inspections i JOIN assets a ON a.id = i.asset_id
      WHERE a.serial_raw = 'FPCREW-1'), 'Nate Dobbs');
  PERFORM pg_temp.want('and the umbrella',
    (SELECT i.verified_by FROM fp_inspections i JOIN assets a ON a.id = i.asset_id
      WHERE a.serial_raw = 'FPCREW-1'), 'Batavia');
  PERFORM pg_temp.want('the collector is still the crew member',
    (SELECT i.collector_name FROM fp_inspections i JOIN assets a ON a.id = i.asset_id
      WHERE a.serial_raw = 'FPCREW-1'), 'Crew Hand');
  PERFORM pg_temp.want('and the public FP view shows the lead',
    (SELECT tech_name FROM fall_protection_public WHERE serial_num = 'FPCREW-1'), 'Nate Dobbs');
END $$;

-- ── A number carried forward keeps its own name ─────────────────────────────
-- What a correction does: the superseding row keeps the rep of the row it
-- replaces, so fixing a typo cannot move responsibility onto whoever fixed it.
-- Here 734 is carried onto a row in MICHAEL's account; it must still resolve to
-- Nate, not to Michael, and not to Michael's number.
DO $$
DECLARE v_michael uuid; v_asset uuid;
BEGIN
  SELECT account_id INTO v_michael FROM account_members
   WHERE user_id = '1a000000-0000-0000-0000-000000000003';
  SELECT id INTO v_asset FROM assets WHERE serial_raw = 'MIKE-1';

  -- version 2: MIKE-1 already has version 1, and (asset_id, version) is unique.
  INSERT INTO inspections (serial_num, inspection_date, tech_name, account_id, asset_id,
                           tech_user_id, rep_number, is_current, version)
  VALUES ('CARRIED-1', current_date, 'someone', v_michael, v_asset,
          '1a000000-0000-0000-0000-000000000003', '734', false, 2);

  PERFORM pg_temp.want('a carried-forward number keeps the name that holds it',
    (SELECT rep_name FROM inspections WHERE serial_num = 'CARRIED-1'), 'Nate Dobbs');
  PERFORM pg_temp.want('and the number is not replaced by the account''s own lead',
    (SELECT rep_number FROM inspections WHERE serial_num = 'CARRIED-1'), '734');
END $$;

-- ── An unlinked account stands behind its own work ──────────────────────────
DO $$
DECLARE v_alone uuid;
BEGIN
  SELECT account_id INTO v_alone FROM account_members
   WHERE user_id = '1a000000-0000-0000-0000-000000000005';
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000005', true);
  PERFORM record_inspection('{"serial_num":"ALONE-1"}'::jsonb);

  PERFORM pg_temp.want('with no umbrella, the account itself is the verifier',
    (SELECT verified_by FROM inspections WHERE serial_num = 'ALONE-1'), 'Unrelated Co');
END $$;

-- ── Re-running the migration changes nothing ────────────────────────────────
\ir ../19_certificate_attribution.sql

DO $$
BEGIN
  PERFORM pg_temp.want('re-running leaves attribution alone',
    (SELECT rep_name FROM inspections WHERE serial_num = 'CREW-1'), 'Nate Dobbs');
  PERFORM pg_temp.want('and does not duplicate rows',
    (SELECT count(*)::int FROM inspections WHERE serial_num = 'CREW-1'), 1);
END $$;

\echo
\echo 'All attribution assertions passed.'
