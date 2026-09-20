-- Onboarding from the office.
-- Runs after 18_impersonation_test.sql, on the tree those tests built:
--   Batavia (umbrella) → Nate Dobbs (734) → Crew Hand
--                      → Michael Dobbs (738)
--
-- The properties that matter:
--   • only the umbrella takes on subcontractors; a subcontractor hires crew
--   • a company cannot be created while acting as another company
--   • the things a certificate depends on are refused if missing
--   • somebody who already has an account is refused, not moved
--   • the listing shows each company's lead, number and how much they have done
--   • a lead adding crew adds their OWN crew, whoever they are acting as

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../22_onboarding_rpcs.sql

INSERT INTO auth.users(id, email) VALUES
  ('1a000000-0000-0000-0000-000000000006', 'newsub@sub.test'),
  ('1a000000-0000-0000-0000-000000000007', 'newcrew@sub.test')
ON CONFLICT DO NOTHING;

-- ── Who may take on a subcontractor ─────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate, a subcontractor
SELECT pg_temp.want_error('a subcontractor cannot take on subcontractors',
  $$SELECT add_subcontractor('{"user_id":"1a000000-0000-0000-0000-000000000006",
      "email":"newsub@sub.test","name":"Sub Of A Sub","rep_number":"900"}'::jsonb)$$);

SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- a field person
SELECT pg_temp.want_error('a field person certainly cannot',
  $$SELECT add_subcontractor('{"user_id":"1a000000-0000-0000-0000-000000000006",
      "email":"newsub@sub.test","name":"Nope","rep_number":"901"}'::jsonb)$$);

-- ── What a certificate depends on is not optional ───────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000001';   -- Batavia
SELECT pg_temp.want_error('a technician number is required',
  $$SELECT add_subcontractor('{"user_id":"1a000000-0000-0000-0000-000000000006",
      "email":"newsub@sub.test","name":"No Number"}'::jsonb)$$);

SELECT pg_temp.want_error('a company name is required',
  $$SELECT add_subcontractor('{"user_id":"1a000000-0000-0000-0000-000000000006",
      "email":"newsub@sub.test","rep_number":"902"}'::jsonb)$$);

SELECT pg_temp.want_error('the person must have been invited first',
  $$SELECT add_subcontractor('{"user_id":"1a000000-0000-0000-0000-0000000000ff",
      "email":"ghost@sub.test","name":"Ghost Co","rep_number":"903"}'::jsonb)$$);

SELECT pg_temp.want_error('somebody who already has an account is refused, not moved',
  $$SELECT add_subcontractor('{"user_id":"1a000000-0000-0000-0000-000000000004",
      "email":"crew@sub.test","name":"Poaching","rep_number":"904"}'::jsonb)$$);

-- ── Not while acting as somebody else ───────────────────────────────────────
DO $$
DECLARE v_michael uuid;
BEGIN
  SELECT account_id INTO v_michael FROM account_members
   WHERE user_id = '1a000000-0000-0000-0000-000000000003';
  PERFORM start_impersonation(json_build_object(
    'account_id', v_michael, 'reason', 'onboarding check')::jsonb);
END $$;

SELECT pg_temp.want_error('a company cannot be created while acting as another',
  $$SELECT add_subcontractor('{"user_id":"1a000000-0000-0000-0000-000000000006",
      "email":"newsub@sub.test","name":"While Acting","rep_number":"905"}'::jsonb)$$);

SELECT stop_impersonation();

-- ── The real thing ──────────────────────────────────────────────────────────
DO $$
DECLARE v json; v_acct uuid; v_batavia uuid;
BEGIN
  SELECT account_id INTO v_batavia FROM account_members
   WHERE user_id = '1a000000-0000-0000-0000-000000000001';

  v := add_subcontractor('{"user_id":"1a000000-0000-0000-0000-000000000006",
        "email":"newsub@sub.test","name":"Third Company","rep_number":"742","credits":25}'::jsonb);
  v_acct := (v->>'account_id')::uuid;

  PERFORM pg_temp.want('the company is created', (v->>'name'), 'Third Company');
  PERFORM pg_temp.want('with the number that will be on its certificates',
                       (v->>'rep_number'), '742');
  PERFORM pg_temp.want('and the balance it was given', (v->>'credits')::integer, 25);
  PERFORM pg_temp.want('it hangs under the umbrella',
    (SELECT parent_account_id FROM accounts WHERE id = v_acct), v_batavia);
  PERFORM pg_temp.want('their person is its lead',
    (SELECT role FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000006'), 'lead');
  PERFORM pg_temp.want('with desktop access',
    (SELECT desktop_access FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000006'), true);
  PERFORM pg_temp.want('and the umbrella can now act as them',
    (SELECT count(*)::int FROM account_descendants(v_batavia)), 4);
END $$;

-- ── The listing ─────────────────────────────────────────────────────────────
DO $$
DECLARE v json;
BEGIN
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000001', true);   -- Batavia
  v := my_subcontractors();

  PERFORM pg_temp.want('all three companies are listed', json_array_length(v), 3);
  PERFORM pg_temp.want('each with the lead who answers for it',
    (SELECT json_agg(x->>'lead') FROM json_array_elements(v) x)::text,
    '["Michael Dobbs", "Nate Dobbs", "Third Company"]');
  PERFORM pg_temp.want('and their numbers',
    (SELECT json_agg(x->>'rep_number') FROM json_array_elements(v) x)::text,
    '["738", "734", "742"]');
  -- Nate's crew recorded against his account in the earlier tests; a brand new
  -- company has done nothing yet. That difference is the point of the column.
  PERFORM pg_temp.want('a new company shows no work yet',
    (SELECT (x->>'records')::int FROM json_array_elements(v) x WHERE x->>'name' = 'Third Company'), 0);
  PERFORM pg_temp.want('and an established one shows theirs',
    (SELECT (x->>'records')::int > 0 FROM json_array_elements(v) x WHERE x->>'name' = 'Nate Dobbs'), true);

  -- A subcontractor has none of their own.
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);   -- Nate
  PERFORM pg_temp.want('a subcontractor lists nobody beneath them',
                       json_array_length(my_subcontractors()), 0);
END $$;

-- ── Crew follows the account being acted as ─────────────────────────────────
-- The office, acting as Michael, adds one of MICHAEL's people — that is what
-- acting as him means — while invited_by still records who really did it.
DO $$
DECLARE v_michael uuid; v_acct uuid;
BEGIN
  SELECT account_id INTO v_michael FROM account_members
   WHERE user_id = '1a000000-0000-0000-0000-000000000003';

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000001', true);   -- Batavia
  PERFORM start_impersonation(json_build_object(
    'account_id', v_michael, 'reason', 'setting Michael up with his first hand')::jsonb);

  v_acct := add_crew_member('{"user_id":"1a000000-0000-0000-0000-000000000007",
              "email":"newcrew@sub.test","name":"Mikes Hand"}'::jsonb);

  PERFORM pg_temp.want('the crew member lands in the account being acted as',
                       v_acct, v_michael);
  PERFORM pg_temp.want('and who really added them is recorded',
    (SELECT invited_by FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000007'),
    '1a000000-0000-0000-0000-000000000001'::uuid);
  PERFORM pg_temp.want('the team screen shows them as Michael''s',
    (SELECT count(*)::int FROM json_array_elements(team_members()) x
      WHERE x->>'name' = 'Mikes Hand'), 1);

  PERFORM stop_impersonation();

  PERFORM pg_temp.want('and they are NOT on the umbrella''s own team',
    (SELECT count(*)::int FROM json_array_elements(team_members()) x
      WHERE x->>'name' = 'Mikes Hand'), 0);
END $$;

-- ── What the office draws its screens from ──────────────────────────────────
DO $$
DECLARE v json;
BEGIN
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000001', true);   -- Batavia
  v := my_context();
  PERFORM pg_temp.want('the umbrella is told it is one', (v->>'is_umbrella')::boolean, true);
  PERFORM pg_temp.want('and that it leads',              (v->>'role'), 'lead');

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);   -- Nate
  v := my_context();
  PERFORM pg_temp.want('a subcontractor is not offered the door', (v->>'is_umbrella')::boolean, false);
  PERFORM pg_temp.want('but still leads their own crew',          (v->>'role'), 'lead');

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000004', true);   -- field person
  v := my_context();
  PERFORM pg_temp.want('a field person is neither', (v->>'role'), 'tech');

  -- Acting as somebody does not hand you their doors.
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000001', true);
  PERFORM start_impersonation(json_build_object(
    'account_id', (SELECT account_id FROM account_members
                    WHERE user_id = '1a000000-0000-0000-0000-000000000002'),
    'reason', 'checking what the screens offer')::jsonb);
  v := my_context();
  PERFORM pg_temp.want('while acting, the umbrella flag still describes YOUR account',
                       (v->>'is_umbrella')::boolean, true);
  PERFORM pg_temp.want('and the account being worked in is theirs',
                       (v->>'account_name'), 'Nate Dobbs');
  PERFORM stop_impersonation();
END $$;

-- ── Re-running the migration changes nothing ────────────────────────────────
\ir ../22_onboarding_rpcs.sql

DO $$
BEGIN
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000001', true);
  PERFORM pg_temp.want('re-running leaves the companies alone',
                       json_array_length(my_subcontractors()), 3);
END $$;

\echo
\echo 'All onboarding assertions passed.'
