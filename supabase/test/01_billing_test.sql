-- Billing assertions. Every check RAISEs on failure, so a non-zero psql exit
-- means something regressed. Run via supabase/test/run.sh.

\set ON_ERROR_STOP on
\set ACME '11111111-1111-1111-1111-111111111111'
\set BETA '22222222-2222-2222-2222-222222222222'

CREATE OR REPLACE FUNCTION pg_temp.want(p_label text, p_got anyelement, p_expect anyelement)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_expect THEN
    RAISE EXCEPTION 'FAIL %: expected %, got %', p_label, p_expect, p_got;
  END IF;
  RAISE NOTICE 'ok  %', p_label;
END;
$$;

-- Refuses, and reports what the error was.
CREATE OR REPLACE FUNCTION pg_temp.want_error(p_label text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE EXCEPTION 'FAIL %: expected an error, but the statement succeeded', p_label;
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
  RAISE NOTICE 'ok  % (%)', p_label, SQLERRM;
END;
$$;

-- ── Pre-migration state: existing users with balances ────────────────────────
INSERT INTO auth.users(id, email) VALUES
  (:'ACME', 'lead@acme.com'),
  (:'BETA', 'boss@beta.com')
ON CONFLICT DO NOTHING;
SELECT create_lia_user(:'ACME', 'lead@acme.com', 'Acme Lead',  3);
SELECT create_lia_user(:'BETA', 'boss@beta.com', 'Beta Boss', -1);

\ir ../03_accounts_billing.sql

-- ── Backfill ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('backfill: one account per user', (SELECT count(*)::int FROM accounts), 2);
  PERFORM pg_temp.want('backfill: credits carried over',
    (SELECT a.credits FROM accounts a JOIN account_members m ON m.account_id=a.id
      WHERE m.user_id='11111111-1111-1111-1111-111111111111'), 3);
  PERFORM pg_temp.want('backfill: unlimited sentinel preserved',
    (SELECT a.credits FROM accounts a JOIN account_members m ON m.account_id=a.id
      WHERE m.user_id='22222222-2222-2222-2222-222222222222'), -1);
END $$;

-- ── Charging ─────────────────────────────────────────────────────────────────
SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$ BEGIN
  PERFORM pg_temp.want('first import charges',
    (charge_work_order('WO-12345')->>'charged')::boolean, true);
  PERFORM pg_temp.want('balance went 3 -> 2', get_my_credits(), 2);

  PERFORM pg_temp.want('re-running the same work order is free',
    (charge_work_order('WO-12345')->>'charged')::boolean, false);
  PERFORM pg_temp.want('balance unchanged after re-run', get_my_credits(), 2);

  -- The normalization is what stops "wo 12345" being billed as a second order.
  PERFORM pg_temp.want('differently-typed same work order is free',
    (charge_work_order('wo 12345')->>'charged')::boolean, false);
  PERFORM pg_temp.want('balance unchanged after reformat', get_my_credits(), 2);

  PERFORM pg_temp.want('a genuinely different work order charges',
    (charge_work_order('WO-99999')->>'charged')::boolean, true);
  PERFORM pg_temp.want('balance went 2 -> 1', get_my_credits(), 1);
END $$;

-- ── Namespacing: two customers may hold the same work order number ───────────
SET lia.uid = '22222222-2222-2222-2222-222222222222';
DO $$ BEGIN
  PERFORM pg_temp.want('another account can claim the same number',
    (charge_work_order('WO-12345')->>'charged')::boolean, true);
  PERFORM pg_temp.want('unlimited account is never debited', get_my_credits(), -1);
END $$;

-- ── Refusals ─────────────────────────────────────────────────────────────────
SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$ BEGIN
  PERFORM pg_temp.want_error('blank work order is refused',
    $q$ SELECT charge_work_order('   ') $q$);
  -- Older clients send the literal 'unknown' for a blank box. Allowing it would
  -- make every blank-work-order import after the first one free.
  PERFORM pg_temp.want_error('deprecated consume_credit refuses the "unknown" bucket',
    $q$ SELECT consume_credit('unknown') $q$);
END $$;

-- ── Running out ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('deprecated consume_credit still works with a real number',
    consume_credit('WO-55555'), 0);
  PERFORM pg_temp.want_error('a new work order is blocked at zero credits',
    $q$ SELECT charge_work_order('WO-88888') $q$);
  -- Someone out of credits must still be able to fix and re-import work they
  -- have already paid for.
  PERFORM pg_temp.want('an already-paid work order still runs at zero credits',
    (charge_work_order('WO-12345')->>'charged')::boolean, false);
END $$;

-- ── Preflight ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('preflight: paid work order is free',
    (preflight_work_order('WO-12345')->>'free')::boolean, true);
  PERFORM pg_temp.want('preflight: new work order at zero credits cannot run',
    (preflight_work_order('WO-88888')->>'can_run')::boolean, false);
END $$;

-- ── Idempotency: the migration must survive being re-run over live data ──────
\ir ../03_accounts_billing.sql
DO $$ BEGIN
  PERFORM pg_temp.want('re-running the migration creates no duplicate accounts',
    (SELECT count(*)::int FROM accounts), 2);
  PERFORM pg_temp.want('re-running the migration does not reset balances',
    (SELECT credits FROM accounts a JOIN account_members m ON m.account_id=a.id
      WHERE m.user_id='11111111-1111-1111-1111-111111111111'), 0);
  PERFORM pg_temp.want('re-running the migration does not re-charge work orders',
    (SELECT count(*)::int FROM work_orders WHERE charged_at IS NOT NULL), 4);
END $$;

-- ── Isolation ────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO authenticated, anon;
SET ROLE authenticated;
SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$ BEGIN
  PERFORM pg_temp.want('a tech sees only their own account''s work orders',
    (SELECT count(*)::int FROM work_orders), 3);
  PERFORM pg_temp.want('a tech sees only their own account',
    (SELECT count(*)::int FROM accounts), 1);
  PERFORM pg_temp.want_error('a tech cannot grant themselves credits',
    $q$ UPDATE accounts SET credits = 9999 $q$);
END $$;
RESET ROLE;

SET ROLE anon;
DO $$ BEGIN
  PERFORM pg_temp.want_error('anon cannot read accounts',    $q$ SELECT count(*) FROM accounts $q$);
  PERFORM pg_temp.want_error('anon cannot read work_orders', $q$ SELECT count(*) FROM work_orders $q$);
END $$;
RESET ROLE;

\echo ''
\echo 'All billing assertions passed.'
