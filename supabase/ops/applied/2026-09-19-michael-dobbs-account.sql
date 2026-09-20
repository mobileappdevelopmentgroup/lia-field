-- ═══════════════════════════════════════════════════════════════════════════
-- Provision Michael Dobbs as a SECOND COMPANY, and set both leads' rep numbers.
--
-- Not a migration. Provisioning for two named people, run once in the Supabase
-- SQL editor. It carries no number in the 01–17 sequence because replaying the
-- migrations on a fresh database must not recreate somebody's account.
--
-- Why a separate account: Michael (California) and Nate (Pennsylvania) are
-- different companies. Every table is scoped by account_id and RLS enforces it,
-- so the account boundary is the ONLY place separation actually happens. Two
-- leads inside one account would share assets, work orders, jobs, tickets and
-- techs — and account_rep_number() takes min(rep_number) across an account's
-- leads, which would print one company's number on the other's certificates.
--
-- The fourteen equipment types are shared (account_id IS NULL), so the new
-- account has a full catalogue on first sync. Per-account overrides do not
-- carry across; there are none for Batavia at the time of writing.
--
-- Safe to re-run. Every step is a no-op once it has been applied.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Before ───────────────────────────────────────────────────────────────
-- Captured into a temp table rather than selected: the Supabase SQL editor
-- displays only the LAST result set of a paste, so an early SELECT is invisible.
-- Step 4 reports before and after together, as one result.
CREATE TEMP TABLE _before ON COMMIT DROP AS
SELECT u.email, m.role, m.desktop_access, m.rep_number, a.name AS account,
       a.credits, m.account_id
  FROM public.users u
  JOIN public.account_members m ON m.user_id = u.id
  JOIN public.accounts a       ON a.id = m.account_id
 WHERE u.email IN ('dciladders@gmail.com', 'nathandobbs@me.com');

-- ── 2. Michael → his own account ────────────────────────────────────────────
DO $$
DECLARE
  c_user     constant uuid := '5085df63-6e29-4088-af9f-24ae1be29334';
  c_email    constant text := 'dciladders@gmail.com';
  c_name     constant text := 'Michael Dobbs';
  c_rep      constant text := '738';
  c_batavia  constant uuid := '265882ec-0c13-44ef-9648-4b0a73375bf5';
  v_account  uuid;
  v_records  integer;
  v_new      uuid;
BEGIN
  -- The uuid must be his auth.users id. create_lia_user() would happily write
  -- a users row for an id that does not exist there, and he would then get
  -- "No account — contact your administrator" on his first sync.
  PERFORM 1 FROM auth.users WHERE id = c_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No auth.users row for %. Invite him first (Auth → Users → Invite user).', c_user;
  END IF;

  SELECT account_id INTO v_account FROM public.account_members WHERE user_id = c_user;

  IF v_account IS NULL THEN
    -- Never provisioned. Passing NULL for the account is what gives him his
    -- own; the account takes its name from p_name and its credits from
    -- p_credits (-1 = unlimited, same arrangement as Batavia).
    v_account := public.create_lia_user(c_user, c_email, c_name, -1, NULL, 'lead', c_rep);
    RAISE NOTICE 'Created account % for %', v_account, c_name;

  ELSIF v_account = c_batavia THEN
    -- An earlier attempt put him in Batavia's account. Move him out.
    -- Records do NOT move with a membership: they carry their own account_id.
    -- If he recorded anything, stop — that needs a decision, not a guess.
    SELECT count(*) INTO v_records FROM public.inspections WHERE tech_user_id = c_user;
    IF v_records > 0 THEN
      RAISE EXCEPTION
        'Michael has % inspection(s) under Batavia. Moving his membership would leave them in Batavia''s data. Decide what happens to them first.',
        v_records;
    END IF;

    INSERT INTO public.accounts (name, credits) VALUES (c_name, -1) RETURNING id INTO v_new;
    UPDATE public.account_members SET account_id = v_new WHERE user_id = c_user;
    v_account := v_new;
    RAISE NOTICE 'Moved % out of Batavia into new account %', c_name, v_account;

  ELSE
    RAISE NOTICE 'Already in his own account %', v_account;
  END IF;

  -- Idempotent settling of everything else. create_lia_user() leaves an
  -- existing membership alone (ON CONFLICT DO NOTHING), so a first attempt
  -- that made him a 'tech' would otherwise stick.
  UPDATE public.account_members
     SET role = 'lead', desktop_access = true, rep_number = c_rep
   WHERE user_id = c_user
     AND (role IS DISTINCT FROM 'lead'
       OR desktop_access IS DISTINCT FROM true
       OR rep_number IS DISTINCT FROM c_rep);

  UPDATE public.users SET name = c_name, email = c_email
   WHERE id = c_user AND (name IS DISTINCT FROM c_name OR email IS DISTINCT FROM c_email);

  UPDATE public.accounts SET name = c_name, credits = -1
   WHERE id = v_account AND (name IS DISTINCT FROM c_name OR credits IS DISTINCT FROM -1);

  IF v_account = c_batavia THEN
    RAISE EXCEPTION 'Refusing to finish: % is still in Batavia''s account.', c_name;
  END IF;
END $$;

-- ── 3. Nate's rep number ────────────────────────────────────────────────────
DO $$
DECLARE
  c_rep  constant text := '734';
  v_user uuid;
BEGIN
  SELECT id INTO v_user FROM public.users WHERE email = 'nathandobbs@me.com';
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No users row for nathandobbs@me.com — check the address before setting a rep number.';
  END IF;

  UPDATE public.account_members SET rep_number = c_rep
   WHERE user_id = v_user AND rep_number IS DISTINCT FROM c_rep;
END $$;

-- ── 4. After — ONE result set, because the editor only shows the last ───────
-- Expect, in order:
--   before/…   one row per person as they were when this started
--   member/…   Michael: lead, rep 738, desktop yes, account "Michael Dobbs"
--              Nate:    lead, rep 734, desktop yes, account "Batavia"
--              Their account_id values MUST DIFFER — that is the separation.
--   leads/…    exactly 1 lead per account
--   data/…     Batavia still has its 1,724 inspections; Michael's is a new
--              account and starts at 0
SELECT * FROM (
  SELECT 1 AS ord, 'before'::text AS what,
         coalesce(b.email, '(nobody provisioned yet)') AS subject,
         coalesce(b.account || ' · ' || b.role || ' · rep ' || coalesce(b.rep_number, '—')
                  || ' · ' || b.account_id::text, '') AS detail
    FROM _before b
  UNION ALL
  SELECT 2, 'member', u.email,
         a.name || ' · ' || m.role || ' · rep ' || coalesce(m.rep_number, '—')
         || ' · desktop ' || CASE WHEN m.desktop_access THEN 'yes' ELSE 'no' END
         || ' · credits ' || a.credits || ' · ' || m.account_id::text
    FROM public.users u
    JOIN public.account_members m ON m.user_id = u.id
    JOIN public.accounts a       ON a.id = m.account_id
   WHERE u.email IN ('dciladders@gmail.com', 'nathandobbs@me.com')
  UNION ALL
  SELECT 3, 'leads', a.name,
         count(*) FILTER (WHERE m.role = 'lead') || ' lead(s), ' || count(*) || ' member(s)'
    FROM public.accounts a
    JOIN public.account_members m ON m.account_id = a.id
   GROUP BY a.name
  UNION ALL
  SELECT 4, 'data', a.name, count(i.id) || ' inspection(s)'
    FROM public.accounts a
    LEFT JOIN public.inspections i ON i.account_id = a.id
   GROUP BY a.name
) x
ORDER BY ord, subject;

-- ── How to run this in the Supabase SQL editor ──────────────────────────────
-- There is no COMMIT below, on purpose. The editor runs the whole paste in one
-- session and the open transaction is rolled back when that session ends, so:
--
--   PASS 1 — paste and run exactly as it is. Nothing is kept. You get the four
--            result sets above, and any RAISE EXCEPTION fires here where it
--            costs nothing. This is the dry run.
--   PASS 2 — if pass 1 looked right, add COMMIT; as the last line and run it
--            again. That one applies.
--
-- Pass 1 proving clean does not guarantee pass 2 will: they are separate
-- transactions and the second re-reads the database. Read pass 2's output too.
