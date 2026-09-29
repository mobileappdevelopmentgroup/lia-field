-- Acting as a subcontractor.
-- Runs after 17_attribution_test.sql, on the tree those tests built:
--   Batavia (umbrella) → Nate Dobbs (734) → Crew Hand
--                      → Michael Dobbs (738)
--   Unrelated Co (no parent, nobody's business)
--
-- The properties that matter:
--   • the umbrella can act downward, and everything then behaves as that
--     subcontractor — same policies, same write paths
--   • nobody can act sideways, upward, or as themselves
--   • a field person cannot act as anyone
--   • a session cannot be used to start another (no walking the tree)
--   • it expires
--   • the work recorded names the subcontractor's lead on the certificate,
--     and the REAL person in the back office

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/20_impersonation.sql
\ir ../migrations/21_impersonation_write_paths.sql

-- ── Who may act as whom ─────────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate, a subcontractor
SELECT pg_temp.want_error('a subcontractor cannot act as a sibling',
  $$SELECT start_impersonation(json_build_object(
      'account_id', (SELECT account_id FROM account_members
                      WHERE user_id = '1a000000-0000-0000-0000-000000000003'),
      'reason', 'curiosity')::jsonb)$$);

SELECT pg_temp.want_error('nor as the umbrella above them',
  $$SELECT start_impersonation(json_build_object(
      'account_id', (SELECT account_id FROM account_members
                      WHERE user_id = '1a000000-0000-0000-0000-000000000001'),
      'reason', 'curiosity')::jsonb)$$);

SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- a field person
SELECT pg_temp.want_error('a field person cannot act as anyone',
  $$SELECT start_impersonation(json_build_object(
      'account_id', (SELECT account_id FROM account_members
                      WHERE user_id = '1a000000-0000-0000-0000-000000000002'),
      'reason', 'training')::jsonb)$$);

SET lia.uid = '1a000000-0000-0000-0000-000000000001';   -- Batavia
SELECT pg_temp.want_error('a reason is required',
  $$SELECT start_impersonation(json_build_object(
      'account_id', (SELECT account_id FROM account_members
                      WHERE user_id = '1a000000-0000-0000-0000-000000000002'))::jsonb)$$);

SELECT pg_temp.want_error('the umbrella cannot act as itself',
  $$SELECT start_impersonation(json_build_object(
      'account_id', (SELECT account_id FROM account_members
                      WHERE user_id = '1a000000-0000-0000-0000-000000000001'),
      'reason', 'no')::jsonb)$$);

SELECT pg_temp.want_error('nor as an unrelated account outside the tree',
  $$SELECT start_impersonation(json_build_object(
      'account_id', (SELECT account_id FROM account_members
                      WHERE user_id = '1a000000-0000-0000-0000-000000000005'),
      'reason', 'no')::jsonb)$$);

-- ── Acting as Michael ───────────────────────────────────────────────────────
DO $$
DECLARE v_michael uuid; v_batavia uuid; v_out json;
BEGIN
  SELECT account_id INTO v_michael FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000003';
  SELECT account_id INTO v_batavia FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000001';

  PERFORM pg_temp.want('before starting, the office is in its own account',
                       my_account_id(), v_batavia);

  v_out := start_impersonation(json_build_object(
    'account_id', v_michael, 'reason', 'showing Michael how a job is recorded')::jsonb);

  PERFORM pg_temp.want('the session names the account',
                       (v_out->>'account_name'), 'Michael Dobbs');
  PERFORM pg_temp.want('now every query runs in his account',
                       my_account_id(), v_michael);
  PERFORM pg_temp.want('the real account is still knowable',
                       my_real_account_id(), v_batavia);
  PERFORM pg_temp.want('and the interface can tell it is happening',
                       is_impersonating(), true);
  PERFORM pg_temp.want('what the office can see follows the account being acted as',
                       can_see(v_michael), true);
END $$;

-- The work: recorded as Michael's company, by the office.
SELECT record_inspection('{"serial_num":"IMP-1","work_order_id":"WO-IMP"}'::jsonb);

DO $$
DECLARE v_michael uuid;
BEGIN
  SELECT account_id INTO v_michael FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000003';

  PERFORM pg_temp.want('the record belongs to the subcontractor',
    (SELECT account_id FROM inspections WHERE serial_num = 'IMP-1'), v_michael);
  PERFORM pg_temp.want('the certificate names THEIR lead',
    (SELECT rep_name FROM inspections WHERE serial_num = 'IMP-1'), 'Michael Dobbs');
  PERFORM pg_temp.want('with their number',
    (SELECT rep_number FROM inspections WHERE serial_num = 'IMP-1'), '738');

  -- The back office half: who actually pressed the buttons.
  PERFORM pg_temp.want('the real person is recorded as the collector',
    (SELECT collected_by FROM inspections WHERE serial_num = 'IMP-1'),
    '1a000000-0000-0000-0000-000000000001'::uuid);
  PERFORM pg_temp.want('and the session is stamped on the row',
    (SELECT impersonation_id IS NOT NULL FROM inspections WHERE serial_num = 'IMP-1'), true);
  PERFORM pg_temp.want('the session says why',
    (SELECT s.reason FROM inspections i
       JOIN impersonation_sessions s ON s.id = i.impersonation_id
      WHERE i.serial_num = 'IMP-1'), 'showing Michael how a job is recorded');
END $$;

-- ── A session cannot be used to walk the tree ───────────────────────────────
-- Still acting as Michael. The grant is checked against the REAL account, so
-- this must fail exactly as it did before the session started.
SELECT pg_temp.want_error('an active session cannot start another sideways',
  $$SELECT start_impersonation(json_build_object(
      'account_id', (SELECT account_id FROM account_members
                      WHERE user_id = '1a000000-0000-0000-0000-000000000005'),
      'reason', 'no')::jsonb)$$);

-- ── Stopping ────────────────────────────────────────────────────────────────
DO $$
DECLARE v_batavia uuid;
BEGIN
  SELECT account_id INTO v_batavia FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000001';
  PERFORM stop_impersonation();

  PERFORM pg_temp.want('stopping returns the office to its own account',
                       my_account_id(), v_batavia);
  PERFORM pg_temp.want('and it is no longer impersonating', is_impersonating(), false);
  PERFORM pg_temp.want('the session is closed, not deleted',
    (SELECT count(*)::int FROM impersonation_sessions WHERE ended_at IS NOT NULL), 1);
  PERFORM pg_temp.want('and the record it produced still points at it',
    (SELECT impersonation_id IS NOT NULL FROM inspections WHERE serial_num = 'IMP-1'), true);
END $$;

-- ── Expiry ──────────────────────────────────────────────────────────────────
DO $$
DECLARE v_michael uuid; v_batavia uuid;
BEGIN
  SELECT account_id INTO v_michael FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000003';
  SELECT account_id INTO v_batavia FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000001';

  PERFORM start_impersonation(json_build_object(
    'account_id', v_michael, 'reason', 'expiry check')::jsonb);
  PERFORM pg_temp.want('a fresh session is active', my_account_id(), v_michael);

  -- Wind it back rather than waiting an hour.
  UPDATE impersonation_sessions SET expires_at = now() - interval '1 minute'
   WHERE actor_user_id = '1a000000-0000-0000-0000-000000000001' AND ended_at IS NULL;

  PERFORM pg_temp.want('an expired session stops applying', my_account_id(), v_batavia);
  PERFORM pg_temp.want('and is not reported as active', is_impersonating(), false);
END $$;

-- ── Only a lead, and only downward: the offer list says so ──────────────────
DO $$
DECLARE v json;
BEGIN
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000001', true);   -- Batavia
  v := my_context();
  PERFORM pg_temp.want('the office is offered both subcontractors',
                       json_array_length(v->'can_act_as'), 2);

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);   -- Nate
  v := my_context();
  PERFORM pg_temp.want('a subcontractor is offered nobody',
                       json_array_length(v->'can_act_as'), 0);

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000004', true);   -- field person
  v := my_context();
  PERFORM pg_temp.want('and a field person nobody',
                       json_array_length(v->'can_act_as'), 0);
END $$;

-- ── Re-running the migrations changes nothing ───────────────────────────────
\ir ../migrations/20_impersonation.sql
\ir ../migrations/21_impersonation_write_paths.sql

DO $$
BEGIN
  PERFORM pg_temp.want('re-running keeps the audit trail',
    (SELECT count(*)::int FROM impersonation_sessions), 2);
  PERFORM pg_temp.want('and the work recorded under it',
    (SELECT count(*)::int FROM inspections WHERE serial_num = 'IMP-1'), 1);
END $$;

\echo
\echo 'All impersonation assertions passed.'
