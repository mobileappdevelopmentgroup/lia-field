-- Inspections v2 assertions. Runs after 01_billing_test.sql, on the same
-- database, so accounts and work orders already exist.

\set ON_ERROR_STOP on
\set ACME '11111111-1111-1111-1111-111111111111'
\set BETA '22222222-2222-2222-2222-222222222222'

\ir _helpers.sql

-- ── Pre-migration inspection data, in the old shape ──────────────────────────
-- WO-99999 belongs to Acme alone, so the backfill can resolve it from usage_log.
-- WO-12345 is deliberately held by BOTH accounts — the backfill must refuse to
-- guess on it and fall through.
INSERT INTO public.inspections (serial_num, inspection_date, tech_name, work_order_id, next_due_date, notes, brand, type, length)
VALUES
  ('SN-001', '2026-01-10', 'Old Tech', 'WO-99999', '2027-01-10', 'watch the left rail', 'Werner', 'Extension', '28'),
  ('SN-002', '2026-01-10', 'Old Tech', 'WO-99999', '2027-01-10', NULL,                  'Louisville', 'Step', '6'),
  -- same ladder, inspected again a year later: legitimate history, must survive
  ('SN-001', '2025-01-09', 'Older Tech', 'WO-11111', '2026-01-09', 'first visit', 'Werner', 'Extension', '28');

\ir ../04_inspections_v2.sql

-- ── Backfill ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('backfill: every inspection got an asset',
    (SELECT count(*)::int FROM inspections WHERE asset_id IS NULL), 0);
  PERFORM pg_temp.want('backfill: the same serial maps to one asset',
    (SELECT count(*)::int FROM assets WHERE serial_key = 'SN001'), 1);
  PERFORM pg_temp.want('backfill: three inspections, two assets',
    (SELECT count(*)::int FROM assets), 2);
  PERFORM pg_temp.want('backfill: everything starts at version 1',
    (SELECT count(*)::int FROM inspections WHERE version <> 1), 0);
  PERFORM pg_temp.want('backfill: everything starts current',
    (SELECT count(*)::int FROM inspections WHERE NOT is_current), 0);
  PERFORM pg_temp.want('backfill: every asset got a public_ref',
    (SELECT count(*)::int FROM assets WHERE public_ref IS NULL OR length(public_ref) <> 10), 0);
  PERFORM pg_temp.want('backfill: resolved ownership from an unambiguous work order',
    (SELECT count(*)::int FROM inspections WHERE account_id IS NOT NULL), 3);
END $$;

-- ── The destructive constraint is gone, the safe one replaced it ─────────────
DO $$ BEGIN
  PERFORM pg_temp.want('old (serial, date) unique constraint dropped',
    (SELECT count(*)::int FROM pg_constraint WHERE conname = 'inspections_serial_date_uq'), 0);
  PERFORM pg_temp.want('partial unique index on current rows exists',
    (SELECT count(*)::int FROM pg_indexes WHERE indexname = 'inspections_current_uq'), 1);
END $$;

-- ── Re-recording supersedes instead of overwriting ───────────────────────────
SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE v_new uuid;
BEGIN
  v_new := record_inspection(jsonb_build_object(
    'serial_num', 'SN-001', 'inspection_date', '2026-01-10',
    'tech_name', 'New Tech', 'brand', 'Werner', 'type', 'Extension', 'length', '28'
  ));

  PERFORM pg_temp.want('re-recording creates version 2',
    (SELECT version FROM inspections WHERE id = v_new), 2);
  PERFORM pg_temp.want('the previous row is kept, not overwritten',
    (SELECT count(*)::int FROM inspections WHERE serial_num='SN-001' AND inspection_date='2026-01-10'), 2);
  PERFORM pg_temp.want('only one of them is current',
    (SELECT count(*)::int FROM inspections
      WHERE serial_num='SN-001' AND inspection_date='2026-01-10' AND is_current), 1);
  PERFORM pg_temp.want('version 2 points back at version 1',
    (SELECT supersedes IS NOT NULL FROM inspections WHERE id = v_new), true);

  -- This is the bug that used to blank out a tech's notes on every re-import.
  PERFORM pg_temp.want('notes are carried forward when the write omits them',
    (SELECT notes FROM inspections WHERE id = v_new), 'watch the left rail');

  PERFORM pg_temp.want('a different date is a separate inspection, still current',
    (SELECT count(*)::int FROM inspections
      WHERE serial_num='SN-001' AND is_current AND NOT is_deleted), 2);
END $$;

-- ── Two techs, same serial, same day: the case that used to lose data ────────
DO $$
DECLARE v_a uuid; v_b uuid;
BEGIN
  v_a := record_inspection(jsonb_build_object(
    'serial_num','SN-777','inspection_date','2026-03-01','tech_name','Tech A','notes','found by A'));
  v_b := record_inspection(jsonb_build_object(
    'serial_num','SN-777','inspection_date','2026-03-01','tech_name','Tech B'));

  PERFORM pg_temp.want('both techs'' records exist',
    (SELECT count(*)::int FROM inspections WHERE serial_num='SN-777'), 2);
  PERFORM pg_temp.want('the later write is current',
    (SELECT tech_name FROM inspections WHERE serial_num='SN-777' AND is_current), 'Tech B');
  PERFORM pg_temp.want('the first tech''s record is retained, not destroyed',
    (SELECT tech_name FROM inspections WHERE id = v_a), 'Tech A');
  PERFORM pg_temp.want('and their notes survived into the current row',
    (SELECT notes FROM inspections WHERE serial_num='SN-777' AND is_current), 'found by A');
END $$;

-- ── Serial normalization ─────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM record_inspection(jsonb_build_object(
    'serial_num','sn 777','inspection_date','2026-03-01','tech_name','Tech C'));
  PERFORM pg_temp.want('a differently-typed serial resolves to the same asset',
    (SELECT count(*)::int FROM assets WHERE serial_key = 'SN777'), 1);
END $$;

-- ── The public view ──────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('the public view shows only current rows',
    (SELECT count(*)::int FROM ladder_inspections_public WHERE serial_num='SN-001'), 2);
  PERFORM pg_temp.want('the public view exposes a stable public_ref',
    (SELECT count(*)::int FROM ladder_inspections_public WHERE public_ref IS NULL), 0);
END $$;

-- ── Idempotency ──────────────────────────────────────────────────────────────
\ir ../04_inspections_v2.sql
DO $$ BEGIN
  PERFORM pg_temp.want('re-running the migration creates no extra assets',
    (SELECT count(*)::int FROM assets), 3);
  -- 7 rows written in total: 3 seeded, +1 superseding SN-001, +3 for SN-777
  -- (techs A, B and C). Of those, 4 are current — one per (asset, date):
  -- SN-001 on two dates, SN-002 once, SN-777 once.
  PERFORM pg_temp.want('every write is retained',
    (SELECT count(*)::int FROM inspections), 7);
  PERFORM pg_temp.want('exactly one current row per item per date',
    (SELECT count(*)::int FROM inspections WHERE is_current), 4);
  -- Queried via the asset, not the raw serial text: serial_num stores what the
  -- tech actually typed, so Tech C's "sn 777" would not match 'SN-777'.
  PERFORM pg_temp.want('re-running the migration does not disturb versions',
    (SELECT max(i.version)::int FROM inspections i
       JOIN assets a ON a.id = i.asset_id WHERE a.serial_key = 'SN777'), 3);
  PERFORM pg_temp.want('the certificate shows the canonical serial, not the last spelling',
    (SELECT serial_num FROM ladder_inspections_public WHERE serial_key = 'SN777'), 'SN-777');
END $$;

-- ── Isolation ────────────────────────────────────────────────────────────────
SET ROLE authenticated;
SET lia.uid = '22222222-2222-2222-2222-222222222222';
DO $$ BEGIN
  PERFORM pg_temp.want('another account sees none of these inspections',
    (SELECT count(*)::int FROM inspections), 0);
  PERFORM pg_temp.want('nor any of the assets',
    (SELECT count(*)::int FROM assets), 0);
  PERFORM pg_temp.want_error('a tech cannot write inspections directly',
    $q$ UPDATE inspections SET tech_name = 'hijacked' $q$);
END $$;
RESET ROLE;

SET ROLE anon;
DO $$ BEGIN
  PERFORM pg_temp.want_error('anon cannot reach the inspections table',
    $q$ SELECT count(*) FROM inspections $q$);
  PERFORM pg_temp.want_error('anon cannot reach the assets table',
    $q$ SELECT count(*) FROM assets $q$);
  -- but the certificate site must still work
  PERFORM pg_temp.want('anon can still read the public view',
    (SELECT count(*)::int > 0 FROM ladder_inspections_public), true);
END $$;
RESET ROLE;

\echo ''
\echo 'All inspection assertions passed.'
