-- Umbrella accounts: Batavia over lead subcontractors, each with their own crew.
-- Runs after 15_tag_write_test.sql.
--
-- The properties that matter:
--   • work flows UP: the umbrella reads a subcontractor's records
--   • it never flows SIDEWAYS: one subcontractor cannot read another's
--   • catalogue flows DOWN: a subcontractor inherits the umbrella's entries,
--     and a sibling's private entry stays private
--   • an unlinked account behaves exactly as it did before this migration
--   • the hierarchy cannot be made to loop
--   • a lead adds their own crew; a tech cannot

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../18_umbrella_accounts.sql

INSERT INTO auth.users(id, email) VALUES
  ('1a000000-0000-0000-0000-000000000001', 'office@batavia.test'),
  ('1a000000-0000-0000-0000-000000000002', 'nate@sub.test'),
  ('1a000000-0000-0000-0000-000000000003', 'michael@sub.test'),
  ('1a000000-0000-0000-0000-000000000004', 'crew@sub.test'),
  ('1a000000-0000-0000-0000-000000000005', 'outsider@elsewhere.test')
ON CONFLICT DO NOTHING;

-- ── The tree ────────────────────────────────────────────────────────────────
DO $$
DECLARE v_umbrella uuid; v_nate uuid; v_michael uuid;
BEGIN
  v_umbrella := create_lia_user('1a000000-0000-0000-0000-000000000001', 'office@batavia.test', 'Batavia', -1, NULL, 'lead', '001');
  v_nate     := create_subcontractor('1a000000-0000-0000-0000-000000000002',    'nate@sub.test',    'Nate Dobbs',    '734', v_umbrella);
  v_michael  := create_subcontractor('1a000000-0000-0000-0000-000000000003', 'michael@sub.test', 'Michael Dobbs', '738', v_umbrella);

  PERFORM pg_temp.want('the umbrella is the root of a subcontractor',
                       account_root(v_nate), v_umbrella);
  PERFORM pg_temp.want('the umbrella is its own root',
                       account_root(v_umbrella), v_umbrella);
  PERFORM pg_temp.want('the umbrella reaches both subcontractors and itself',
                       (SELECT count(*)::int FROM account_descendants(v_umbrella)), 3);
  PERFORM pg_temp.want('a subcontractor reaches only itself',
                       (SELECT count(*)::int FROM account_descendants(v_nate)), 1);
  PERFORM pg_temp.want('a subcontractor inherits from itself and the umbrella',
                       (SELECT count(*)::int FROM account_ancestors(v_nate)), 2);

  -- Provisioning is what sets the rep number; it is not optional for a lead.
  PERFORM pg_temp.want('the subcontractor lead carries their own number',
                       (SELECT rep_number FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002'), '734');
  PERFORM pg_temp.want('and gets desktop access',
                       (SELECT desktop_access FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002'), true);
END $$;

SELECT pg_temp.want_error('a lead subcontractor cannot be created without a number',
  $$SELECT create_subcontractor('1a000000-0000-0000-0000-000000000005', 'x@y.test', 'No Number', '', NULL)$$);

SELECT pg_temp.want_error('an account cannot be its own parent',
  $$UPDATE accounts SET parent_account_id = id WHERE name = 'Nate Dobbs'$$);

SELECT pg_temp.want_error('the hierarchy cannot be made to loop',
  $$UPDATE accounts SET parent_account_id = (SELECT id FROM accounts WHERE name = 'Nate Dobbs')
     WHERE name = 'Batavia'$$);

-- ── A crew member under Nate ────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate
DO $$
DECLARE v_account uuid;
BEGIN
  v_account := add_crew_member(jsonb_build_object(
    'user_id', '1a000000-0000-0000-0000-000000000004', 'email', 'crew@sub.test', 'name', 'Crew Hand'));

  PERFORM pg_temp.want('the crew member lands in the lead''s account',
                       v_account, (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002'));
  PERFORM pg_temp.want('as a tech', (SELECT role FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000004'), 'tech');
  PERFORM pg_temp.want('with no rep number of their own — the certificate names the lead',
                       (SELECT rep_number FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000004'), NULL::text);
  PERFORM pg_temp.want('and no desktop access',
                       (SELECT desktop_access FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000004'), false);
END $$;

SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- the crew member
SELECT pg_temp.want_error('a tech cannot add crew',
  $$SELECT add_crew_member('{"user_id":"1a000000-0000-0000-0000-000000000005","email":"x@y.test"}'::jsonb)$$);

-- ── Work: one inspection in each subcontractor's account ────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate
SELECT record_inspection('{"serial_num":"NATE-1","work_order_id":"WO-N1"}'::jsonb);
SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- Nate's crew member
SELECT record_inspection('{"serial_num":"NATE-2","work_order_id":"WO-N1"}'::jsonb);
SET lia.uid = '1a000000-0000-0000-0000-000000000003';   -- Michael
SELECT record_inspection('{"serial_num":"MIKE-1","work_order_id":"WO-M1"}'::jsonb);

-- can_see() is what every read policy is written in terms of, so assert it
-- directly: the scratch database runs as the table owner, where RLS is not
-- enforced, and a policy that is never exercised proves nothing.
DO $$
DECLARE v_nate uuid; v_michael uuid; v_umbrella uuid;
BEGIN
  SELECT account_id INTO v_nate     FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002';
  SELECT account_id INTO v_michael  FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000003';
  SELECT account_id INTO v_umbrella FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000001';

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000001', true);   -- Batavia
  PERFORM pg_temp.want('the umbrella sees a subcontractor''s work',  can_see(v_nate),     true);
  PERFORM pg_temp.want('and the other one''s',                       can_see(v_michael),  true);
  PERFORM pg_temp.want('and its own',                                can_see(v_umbrella), true);

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);   -- Nate
  PERFORM pg_temp.want('a subcontractor sees their own work',        can_see(v_nate),     true);
  PERFORM pg_temp.want('NOT a sibling''s',                           can_see(v_michael),  false);
  PERFORM pg_temp.want('NOT the umbrella''s',                        can_see(v_umbrella), false);

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000004', true);   -- Nate's crew
  PERFORM pg_temp.want('a crew member sees their lead''s account',   can_see(v_nate),     true);
  PERFORM pg_temp.want('and nothing sideways',                       can_see(v_michael),  false);

  -- Catalogue runs the other way.
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);   -- Nate
  PERFORM pg_temp.want('a subcontractor uses the umbrella''s catalogue',
                       can_use_catalog(v_umbrella), true);
  PERFORM pg_temp.want('and the shared catalogue (NULL account)',
                       can_use_catalog(NULL), true);
  PERFORM pg_temp.want('but NOT a sibling''s catalogue',
                       can_use_catalog(v_michael), false);

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000001', true);   -- Batavia
  PERFORM pg_temp.want('the umbrella does NOT inherit a subcontractor''s catalogue',
                       can_use_catalog(v_nate), false);
END $$;

-- ── The reads the office actually performs ──────────────────────────────────
DO $$
DECLARE v_umbrella uuid; v_nate uuid;
BEGIN
  SELECT account_id INTO v_umbrella FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000001';
  SELECT account_id INTO v_nate     FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002';

  PERFORM pg_temp.want('three inspections exist across the tree',
    (SELECT count(*)::int FROM inspections WHERE account_id IN (SELECT account_id FROM account_descendants(v_umbrella))), 3);
  PERFORM pg_temp.want('two of them are Nate''s operation',
    (SELECT count(*)::int FROM inspections WHERE account_id = v_nate), 2);

  -- The field person is kept, for the office. Who took the reading is a
  -- question the umbrella must be able to answer later.
  PERFORM pg_temp.want('the crew member is recorded as the collector',
    (SELECT collector_name FROM inspections WHERE serial_num = 'NATE-2'), 'Crew Hand');
  PERFORM pg_temp.want('and their user id is kept too',
    (SELECT collected_by FROM inspections WHERE serial_num = 'NATE-2'), '1a000000-0000-0000-0000-000000000004'::uuid);
END $$;

-- ── An unlinked account is untouched ────────────────────────────────────────
-- The live database is entirely unlinked at the moment this migration lands,
-- so "no parent behaves as before" is the property that makes applying it safe.
DO $$
DECLARE v_alone uuid;
BEGIN
  v_alone := create_lia_user('1a000000-0000-0000-0000-000000000005', 'outsider@elsewhere.test', 'Unrelated Co', 0, NULL, 'lead', '999');
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000005', true);
  PERFORM pg_temp.want('an unlinked account sees itself',     can_see(v_alone), true);
  PERFORM pg_temp.want('and is its own root',                 account_root(v_alone), v_alone);
  PERFORM pg_temp.want('and sees nothing in the other tree',
    can_see((SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002')), false);
  -- Still three: the umbrella's reach is unchanged by an account that was
  -- never put under it. An unlinked account is nobody's business but its own.
  PERFORM pg_temp.want('and the umbrella cannot see it',      (SELECT count(*)::int FROM account_descendants(
    (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000001'))), 3);
END $$;

-- ── Re-running the migration changes nothing ────────────────────────────────
\ir ../18_umbrella_accounts.sql

DO $$
DECLARE v_umbrella uuid;
BEGIN
  SELECT account_id INTO v_umbrella FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.want('re-running leaves the tree alone',
                       (SELECT count(*)::int FROM account_descendants(v_umbrella)), 3);
  PERFORM pg_temp.want('and the inspections',
                       (SELECT count(*)::int FROM inspections WHERE serial_num LIKE 'NATE-%'), 2);
END $$;

\echo
\echo 'All umbrella assertions passed.'
