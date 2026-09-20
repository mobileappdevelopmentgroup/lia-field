-- Removing somebody from a crew.
-- Runs after 19_onboarding_test.sql, on the tree those tests built.
--
-- The properties that matter:
--   • removal ends ACCESS and keeps the WORK — a certificate issued in March
--     was true in March
--   • a lead cannot be removed: their number is on every certificate the
--     account issues
--   • nobody removes themselves
--   • a removed person is still visible to their lead, marked, rather than
--     silently vanishing
--   • rehiring restores the same membership rather than splitting their work
--     across two accounts

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/23_crew_removal.sql

-- Nate's crew member has already recorded work in the earlier tests.
DO $$
BEGIN
  -- Two by now: one from the umbrella tests, one from the attribution tests.
  PERFORM pg_temp.want('the crew member has work to their name',
    (SELECT count(*)::int FROM inspections
      WHERE collected_by = '1a000000-0000-0000-0000-000000000004'), 2);
END $$;

-- ── Who may remove ──────────────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- the crew member
SELECT pg_temp.want_error('a field person cannot remove anybody',
  $$SELECT remove_crew_member('{"user_id":"1a000000-0000-0000-0000-000000000002"}'::jsonb)$$);

SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate, their lead
SELECT pg_temp.want_error('a lead cannot remove themselves',
  $$SELECT remove_crew_member('{"user_id":"1a000000-0000-0000-0000-000000000002"}'::jsonb)$$);

SELECT pg_temp.want_error('somebody on another account cannot be removed',
  $$SELECT remove_crew_member('{"user_id":"1a000000-0000-0000-0000-000000000003"}'::jsonb)$$);

-- ── Removing the crew member ────────────────────────────────────────────────
DO $$
DECLARE v json; v_nate uuid;
BEGIN
  SELECT account_id INTO v_nate FROM account_members
   WHERE user_id = '1a000000-0000-0000-0000-000000000002';

  v := remove_crew_member('{"user_id":"1a000000-0000-0000-0000-000000000004",
                            "reason":"left the company"}'::jsonb);

  PERFORM pg_temp.want('they are removed', (v->>'removed')::boolean, true);
  PERFORM pg_temp.want('and the answer says their work was kept',
                       (v->>'records_kept')::int, 3);   -- 2 ladder + 1 fall protection

  -- The work itself, untouched: same account, same certificate, same rep.
  PERFORM pg_temp.want('their inspection is still on the account',
    (SELECT account_id FROM inspections WHERE serial_num = 'NATE-2'), v_nate);
  PERFORM pg_temp.want('still naming the lead on the certificate',
    (SELECT rep_name FROM inspections WHERE serial_num = 'NATE-2'), 'Nate Dobbs');
  PERFORM pg_temp.want('and still recording who collected it',
    (SELECT collector_name FROM inspections WHERE serial_num = 'NATE-2'), 'Crew Hand');

  -- The lead can still see them, marked — not silently gone.
  PERFORM pg_temp.want('they are still listed for the lead',
    (SELECT count(*)::int FROM json_array_elements(team_members()) x
      WHERE x->>'name' = 'Crew Hand'), 1);
  PERFORM pg_temp.want('marked as removed',
    (SELECT (x->>'removed_at') IS NOT NULL FROM json_array_elements(team_members()) x
      WHERE x->>'name' = 'Crew Hand'), true);
  PERFORM pg_temp.want('with the reason kept',
    (SELECT x->>'removed_reason' FROM json_array_elements(team_members()) x
      WHERE x->>'name' = 'Crew Hand'), 'left the company');
END $$;

-- ── What removal actually costs them: access ────────────────────────────────
DO $$
BEGIN
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000004', true);
  PERFORM pg_temp.want('their account resolves to nothing', my_account_id(), NULL::uuid);
  PERFORM pg_temp.want('so they can see nothing',
                       (SELECT count(*)::int FROM visible_account_ids()), 0);
END $$;

-- The phone's next sync stops here rather than filing work into an account
-- they are no longer on.
--
-- As its own statement, deliberately: set_config(..., true) inside a DO block
-- is transaction-local, and psql commits each statement, so the next one would
-- run as whoever the last plain SET named.
SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- the removed crew member
SELECT pg_temp.want_error('and their next upload is refused',
  $$SELECT record_inspection('{"serial_num":"AFTER-REMOVAL-1"}'::jsonb)$$);

-- ── A lead is not removable this way ────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000001';   -- Batavia, acting as Nate
DO $$
DECLARE v_nate uuid;
BEGIN
  SELECT account_id INTO v_nate FROM account_members
   WHERE user_id = '1a000000-0000-0000-0000-000000000002';
  PERFORM start_impersonation(json_build_object(
    'account_id', v_nate, 'reason', 'tidying his crew')::jsonb);
END $$;

SELECT pg_temp.want_error('even the umbrella cannot remove a lead this way',
  $$SELECT remove_crew_member('{"user_id":"1a000000-0000-0000-0000-000000000002"}'::jsonb)$$);

-- ── Rehiring ────────────────────────────────────────────────────────────────
DO $$
DECLARE v_nate uuid;
BEGIN
  SELECT account_id INTO v_nate FROM account_members
   WHERE user_id = '1a000000-0000-0000-0000-000000000002';

  -- The umbrella is still acting as Nate, which is the point: it is his crew.
  PERFORM restore_crew_member('{"user_id":"1a000000-0000-0000-0000-000000000004"}'::jsonb);

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000004', true);
  PERFORM pg_temp.want('they are back on the same account', my_account_id(), v_nate);
  PERFORM pg_temp.want('and their old work is still theirs',
    (SELECT count(*)::int FROM inspections WHERE collected_by = '1a000000-0000-0000-0000-000000000004'), 2);
END $$;

-- Adding somebody who was removed is a rehire, not a second account: their
-- records live under this account and would not follow them anywhere else.
DO $$
DECLARE v_nate uuid; v_out uuid;
BEGIN
  SELECT account_id INTO v_nate FROM account_members
   WHERE user_id = '1a000000-0000-0000-0000-000000000002';

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);   -- Nate
  PERFORM remove_crew_member('{"user_id":"1a000000-0000-0000-0000-000000000004"}'::jsonb);

  v_out := add_crew_member('{"user_id":"1a000000-0000-0000-0000-000000000004",
             "email":"crew@sub.test","name":"Crew Hand"}'::jsonb);

  PERFORM pg_temp.want('adding them again restores the same membership', v_out, v_nate);
  PERFORM pg_temp.want('one membership row, not two',
    (SELECT count(*)::int FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000004'), 1);
  PERFORM pg_temp.want('and they can work again',
    (SELECT removed_at IS NULL FROM account_members
      WHERE user_id = '1a000000-0000-0000-0000-000000000004'), true);
END $$;

-- ── Re-running the migration changes nothing ────────────────────────────────
\ir ../migrations/23_crew_removal.sql

DO $$
BEGIN
  -- Scoped to the person this file has been moving in and out: the scratch
  -- database carries every account the whole suite built.
  PERFORM pg_temp.want('re-running leaves the rehired crew member in place',
    (SELECT count(*)::int FROM account_members
      WHERE user_id = '1a000000-0000-0000-0000-000000000004' AND removed_at IS NULL), 1);
  PERFORM pg_temp.want('and the removal columns survive the re-run',
    (SELECT count(*)::int FROM information_schema.columns
      WHERE table_name = 'account_members'
        AND column_name IN ('removed_at','removed_by','removed_reason')), 3);
END $$;

\echo
\echo 'All crew removal assertions passed.'
