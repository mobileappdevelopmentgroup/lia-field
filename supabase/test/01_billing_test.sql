-- Billing assertions. Every check RAISEs on failure, so a non-zero psql exit
-- means something regressed. Run via supabase/test/run.sh.

\set ON_ERROR_STOP on
\set ACME '11111111-1111-1111-1111-111111111111'
\set BETA '22222222-2222-2222-2222-222222222222'

\ir _helpers.sql

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

-- ── Provisioning after the migration ─────────────────────────────────────────
-- The backfill only covers users who already existed. A tech onboarded later
-- must get a usable account too, or nothing works for them.
INSERT INTO auth.users(id, email) VALUES
  ('44444444-4444-4444-4444-444444444444', 'new@lead.com'),
  ('55555555-5555-5555-5555-555555555555', 'new@sub.com')
ON CONFLICT DO NOTHING;

DO $$
DECLARE v_acct uuid; v_sub uuid;
BEGIN
  v_acct := create_lia_user('44444444-4444-4444-4444-444444444444', 'new@lead.com', 'New Lead', 7);
  PERFORM pg_temp.want('a newly provisioned user gets an account', v_acct IS NOT NULL, true);
  PERFORM pg_temp.want('and is its lead',
    (SELECT role FROM account_members WHERE user_id='44444444-4444-4444-4444-444444444444'), 'lead');
  PERFORM pg_temp.want('with their credits on the account',
    (SELECT credits FROM accounts WHERE id = v_acct), 7);

  PERFORM set_config('lia.uid', '44444444-4444-4444-4444-444444444444', false);
  PERFORM pg_temp.want('and can immediately be billed',
    (charge_work_order('WO-NEW')->>'charged')::boolean, true);

  -- A sub-tech joins the lead's account rather than getting their own.
  v_sub := create_lia_user('55555555-5555-5555-5555-555555555555', 'new@sub.com', 'New Sub', 0,
                           v_acct, 'tech');
  PERFORM pg_temp.want('a sub-tech joins the existing account', v_sub, v_acct);
  PERFORM pg_temp.want('and has no desktop access',
    (SELECT desktop_access FROM account_members WHERE user_id='55555555-5555-5555-5555-555555555555'), false);
  PERFORM pg_temp.want('no extra account was created for them',
    (SELECT count(*)::int FROM accounts), 3);

  -- Re-running provisioning must not wipe a rep number.
  PERFORM create_lia_user('44444444-4444-4444-4444-444444444444', 'new@lead.com', 'New Lead', 7,
                          NULL, 'lead', 'BTV-7777');
  PERFORM create_lia_user('44444444-4444-4444-4444-444444444444', 'new@lead.com', 'New Lead', 7);
  PERFORM pg_temp.want('re-provisioning keeps the rep number',
    (SELECT rep_number FROM account_members WHERE user_id='44444444-4444-4444-4444-444444444444'), 'BTV-7777');
  PERFORM set_config('lia.uid', '11111111-1111-1111-1111-111111111111', false);
END $$;
