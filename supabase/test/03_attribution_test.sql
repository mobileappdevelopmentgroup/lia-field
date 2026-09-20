-- Rep number and collector attribution. Runs after 02_inspections_test.sql.

\set ON_ERROR_STOP on
\set ACME '11111111-1111-1111-1111-111111111111'
\set SUB  '33333333-3333-3333-3333-333333333333'

\ir _helpers.sql

-- A sub-tech under Acme: collects data, no desktop access, no rep number of
-- their own. This is the subcontracting case.
INSERT INTO auth.users(id, email) VALUES (:'SUB', 'sub@acme.com') ON CONFLICT DO NOTHING;
INSERT INTO public.users(id, email, name) VALUES (:'SUB', 'sub@acme.com', 'Sub Tech')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.account_members(user_id, account_id, role, desktop_access)
SELECT :'SUB', m.account_id, 'tech', false
  FROM public.account_members m WHERE m.user_id = :'ACME'
ON CONFLICT (user_id) DO NOTHING;

\ir ../migrations/05_rep_and_attribution.sql

-- Give the lead a rep number, the way an admin would.
UPDATE public.account_members SET rep_number = 'BTV-4471' WHERE user_id = :'ACME';

DO $$ BEGIN
  PERFORM pg_temp.want('the account resolves its lead''s rep number',
    public.account_rep_number((SELECT account_id FROM account_members WHERE user_id='11111111-1111-1111-1111-111111111111')),
    'BTV-4471');
END $$;

-- ── A sub-tech's capture is attributed to both people ────────────────────────
SET lia.uid = '33333333-3333-3333-3333-333333333333';
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := record_inspection(jsonb_build_object(
    'serial_num','SN-500','inspection_date','2026-04-01','work_order_id','WO-ATTR1'));

  PERFORM pg_temp.want('the responsible rep is the LEAD''s number, not the sub-tech''s',
    (SELECT rep_number FROM inspections WHERE id = v_id), 'BTV-4471');
  PERFORM pg_temp.want('the collector is the sub-tech who actually captured it',
    (SELECT collected_by FROM inspections WHERE id = v_id),
    '33333333-3333-3333-3333-333333333333'::uuid);
  PERFORM pg_temp.want('the collector is named for display',
    (SELECT collector_name FROM inspections WHERE id = v_id), 'Sub Tech');
END $$;

-- A device must not be able to claim a rep number it does not own.
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := record_inspection(jsonb_build_object(
    'serial_num','SN-501','inspection_date','2026-04-01','rep_number','BTV-9999'));
  PERFORM pg_temp.want('a payload cannot override the rep number',
    (SELECT rep_number FROM inspections WHERE id = v_id), 'BTV-4471');
END $$;

-- ── The lead can see who submitted what ──────────────────────────────────────
SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$ BEGIN
  PERFORM record_inspection(jsonb_build_object(
    'serial_num','SN-502','inspection_date','2026-04-01','work_order_id','WO-ATTR1'));

  -- A dedicated work order, so rows written by earlier test files cannot be
  -- counted here.
  PERFORM pg_temp.want('two different people contributed to this work order',
    (SELECT count(*)::int FROM work_order_submissions WHERE work_order_id = 'WO-ATTR1'), 2);
  PERFORM pg_temp.want('the sub-tech''s contribution is counted',
    (SELECT item_count::int FROM work_order_submissions
      WHERE work_order_id='WO-ATTR1' AND collector_name='Sub Tech'), 1);
  PERFORM pg_temp.want('and their role is visible to the lead',
    (SELECT collector_role FROM work_order_submissions
      WHERE work_order_id='WO-ATTR1' AND collector_name='Sub Tech'), 'tech');
  PERFORM pg_temp.want('the lead is shown with their rep number',
    (SELECT collector_rep_number FROM work_order_submissions
      WHERE work_order_id='WO-ATTR1' AND collector_role='lead'), 'BTV-4471');
END $$;

-- ── The certificate URL is derived, never typed ──────────────────────────────
DO $$
DECLARE v_ref text; v_url text;
BEGIN
  SELECT public_ref INTO v_ref FROM assets WHERE serial_key = 'SN500';
  v_url := certificate_url(v_ref, 'ladder');
  PERFORM pg_temp.want('the ladder certificate URL is built from public_ref',
    v_url, 'https://lia.mobileappdevelopmentgroup.com/?t=' || v_ref);
  PERFORM pg_temp.want('fall protection gets its own path prefix',
    certificate_url(v_ref, 'fall_protection'),
    'https://lia.mobileappdevelopmentgroup.com/fp/?t=' || v_ref);
  PERFORM pg_temp.want('no public_ref means no URL rather than a broken one',
    certificate_url(NULL), NULL::text);

  PERFORM pg_temp.want('the public view exposes the derived URL',
    (SELECT certificate_url FROM ladder_inspections_public WHERE serial_key='SN500'), v_url);
END $$;

-- ── Retention lives in one place ─────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('photo retention is 2 years',
    (SELECT value FROM app_settings WHERE key='photo_retention_days'), '730');
END $$;

-- ── Idempotency ──────────────────────────────────────────────────────────────
\ir ../migrations/05_rep_and_attribution.sql
DO $$ BEGIN
  PERFORM pg_temp.want('re-running the migration preserves the rep number',
    (SELECT rep_number FROM account_members WHERE user_id='11111111-1111-1111-1111-111111111111'),
    'BTV-4471');
  PERFORM pg_temp.want('re-running the migration does not duplicate settings',
    (SELECT count(*)::int FROM app_settings WHERE key='certificate_base_url'), 1);
END $$;

-- ── Who collected what stays internal ────────────────────────────────────────
SET ROLE anon;
DO $$ BEGIN
  PERFORM pg_temp.want('the public certificate does not name the sub-tech who collected it',
    (SELECT count(*)::int FROM information_schema.columns
      WHERE table_name='ladder_inspections_public'
        AND column_name IN ('collected_by','collector_name')), 0);
  PERFORM pg_temp.want_error('anon cannot read the submissions view',
    $q$ SELECT count(*) FROM work_order_submissions $q$);
END $$;
RESET ROLE;

\echo ''
\echo 'All attribution assertions passed.'
