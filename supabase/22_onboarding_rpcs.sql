-- ═══════════════════════════════════════════════════════════════════════════
-- Lia Onboarding from the office — safe to re-run; idempotent
--
-- Run AFTER 21_impersonation_write_paths.sql.
--
-- 18 created a subcontractor through `create_subcontractor()`, which is
-- deliberately unreachable from any client: it is provisioning, run in the SQL
-- editor. This adds the office's own door to the same room, with the checks
-- that a SQL editor does not need because a person is reading the file.
--
-- Two functions, and the difference between them is who they are for:
--
--   add_subcontractor()   the UMBRELLA onboards a company beneath it.
--   my_subcontractors()   what that screen lists.
--
-- Crew are already covered: `add_crew_member()` (18) for adding one, and
-- `team_members()` (16) for listing them. Both follow the working context, so
-- the office acting as a subcontractor adds THEIR crew — which is the point of
-- acting as them — while `invited_by` records who really did it.
--
-- ── Why only a root account may do this ────────────────────────────────────
-- The caller's account must have no parent. Batavia onboards subcontractors;
-- a subcontractor hires crew, not companies. Nothing in the schema forbids
-- deeper nesting — account_descendants() recurses, and the tests cover it — but
-- allowing a lead to create companies under themselves invents an org chart
-- nobody asked for, and un-inventing it later means moving accounts that by
-- then hold work. Relaxing this is one line; the reverse is a data migration.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Crew, added into the account being worked in ────────────────────────────
-- 18's version resolved the account with its own membership lookup, the same
-- shape 21 had to correct everywhere else: the office acting as Michael added
-- a hand to the OFFICE's account instead of Michael's, silently. It now takes
-- the account from my_account_id(), so it follows the session.
--
-- The role check moves with it. When acting as somebody you are not a member of
-- that account at all, so "are you its lead" cannot be the question — the
-- session already answered it: start_impersonation() admits only a lead, and
-- only downward. Signed in as yourself, the old check stands.
CREATE OR REPLACE FUNCTION public.add_crew_member(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_account uuid;
  v_role    text;
  v_user    uuid := (p->>'user_id')::uuid;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_account := public.my_account_id();
  IF v_account IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  IF NOT public.is_impersonating() THEN
    SELECT role INTO v_role FROM public.account_members WHERE user_id = v_caller;
    IF v_role IS DISTINCT FROM 'lead' THEN
      RAISE EXCEPTION 'Only a lead can add crew members';
    END IF;
  END IF;

  IF v_user IS NULL THEN RAISE EXCEPTION 'user_id is required (their id from Auth → Users)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user) THEN
    RAISE EXCEPTION 'No such user. Invite them in Supabase first (Auth → Users → Invite user).';
  END IF;
  IF EXISTS (SELECT 1 FROM public.account_members WHERE user_id = v_user) THEN
    RAISE EXCEPTION 'That person already belongs to an account. Moving them is a data migration, not an invitation.';
  END IF;

  INSERT INTO public.users (id, email, name, credits)
  VALUES (v_user, p->>'email', nullif(btrim(coalesce(p->>'name','')), ''), 0)
  ON CONFLICT (id) DO UPDATE
    SET email = coalesce(EXCLUDED.email, public.users.email),
        name  = coalesce(EXCLUDED.name,  public.users.name);

  -- invited_by is the REAL person, always: it is the answer to "who put them
  -- here", which acting as somebody must not be able to launder.
  INSERT INTO public.account_members (user_id, account_id, role, desktop_access, rep_number, invited_by)
  VALUES (v_user, v_account, 'tech', false, NULL, v_caller)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN v_account;
END;
$$;

REVOKE ALL ON FUNCTION public.add_crew_member(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_crew_member(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.add_subcontractor(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_real    uuid;
  v_role    text;
  v_parent_parent uuid;
  v_user    uuid := nullif(p->>'user_id', '')::uuid;
  v_email   text := nullif(btrim(coalesce(p->>'email', '')), '');
  v_name    text := nullif(btrim(coalesce(p->>'name', '')), '');
  v_rep     text := nullif(btrim(coalesce(p->>'rep_number', '')), '');
  v_credits integer := coalesce((p->>'credits')::integer, 0);
  v_account uuid;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- The REAL account, and not while acting as somebody else: creating a company
  -- under a company you are only borrowing is never what was meant.
  IF public.is_impersonating() THEN
    RAISE EXCEPTION 'Stop acting as another company before adding a subcontractor.';
  END IF;

  SELECT m.account_id, m.role INTO v_real, v_role
    FROM public.account_members m WHERE m.user_id = v_caller;
  IF v_real IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;
  IF v_role IS DISTINCT FROM 'lead' THEN
    RAISE EXCEPTION 'Only a lead can add a subcontractor';
  END IF;

  SELECT parent_account_id INTO v_parent_parent FROM public.accounts WHERE id = v_real;
  IF v_parent_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Only the umbrella account can take on subcontractors. Add a crew member instead.';
  END IF;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Their user id is required — invite them in Supabase first, then copy it from Auth → Users.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user) THEN
    RAISE EXCEPTION 'No such user. Invite them in Supabase first (Auth → Users → Invite user).';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'A company name is required: it is what the account is called.';
  END IF;
  IF v_rep IS NULL THEN
    RAISE EXCEPTION 'Their technician number is required: it is what the certificate names.';
  END IF;

  -- Already somewhere in the system. Moving an existing account is a data
  -- migration — its records do not follow a membership — so it is refused here
  -- rather than half-done.
  IF EXISTS (SELECT 1 FROM public.account_members WHERE user_id = v_user) THEN
    RAISE EXCEPTION 'That person already belongs to an account. Moving them is a data migration, not an invitation.';
  END IF;

  v_account := public.create_subcontractor(v_user, coalesce(v_email, ''), v_name, v_rep, v_real, v_credits);

  RETURN json_build_object(
    'account_id', v_account,
    'name',       v_name,
    'rep_number', v_rep,
    'credits',    v_credits);
END;
$$;

-- What the Subcontractors screen lists. Read from the REAL account: these are
-- the companies you took on, not the ones whoever you are acting as took on.
CREATE OR REPLACE FUNCTION public.my_subcontractors()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE v_real uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_real := public.my_real_account_id();

  RETURN (
    SELECT coalesce(json_agg(json_build_object(
             'account_id', a.id,
             'name',       a.name,
             'credits',    a.credits,
             'lead',       l.name,
             'lead_email', l.email,
             'rep_number', l.rep_number,
             'members',    (SELECT count(*) FROM public.account_members m WHERE m.account_id = a.id),
             'records',    (SELECT count(*) FROM public.inspections i WHERE i.account_id = a.id)
                         + (SELECT count(*) FROM public.fp_inspections f WHERE f.account_id = a.id),
             'last_at',    (SELECT max(i.created_at) FROM public.inspections i WHERE i.account_id = a.id)
           ) ORDER BY a.name), '[]'::json)
      FROM public.accounts a
      LEFT JOIN LATERAL (
        SELECT u.name, u.email, m.rep_number
          FROM public.account_members m JOIN public.users u ON u.id = m.user_id
         WHERE m.account_id = a.id AND m.role = 'lead'
         ORDER BY m.rep_number NULLS LAST LIMIT 1
      ) l ON true
     WHERE a.parent_account_id = v_real);
END;
$$;

REVOKE ALL ON FUNCTION public.add_subcontractor(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_subcontractors()      FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_subcontractor(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_subcontractors()      TO authenticated;

-- create_subcontractor() itself stays unreachable from a client: add_subcontractor
-- is the checked door, and it calls it as the definer.
REVOKE ALL ON FUNCTION public.create_subcontractor(uuid, text, text, text, uuid, integer)
  FROM PUBLIC, anon, authenticated;

-- ── What the office needs in order to draw the right doors ──────────────────
-- Extends 20's my_context() with two facts the screens ask of it:
--
--   role          whether to offer a Team screen at all. A field person has no
--                 business on one, and hiding a card is cheaper than an error.
--   is_umbrella   whether this account takes on subcontractors. Offering it by
--                 "do you already have some" would make the FIRST one
--                 impossible to add.
--
-- Both describe the caller's REAL account. Acting as a subcontractor does not
-- make you their lead, and must not offer you their doors.
CREATE OR REPLACE FUNCTION public.my_context()
RETURNS json LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT json_build_object(
    'account_id',      public.my_account_id(),
    'account_name',    (SELECT name FROM public.accounts WHERE id = public.my_account_id()),
    'real_account_id', public.my_real_account_id(),
    'real_account_name', (SELECT name FROM public.accounts WHERE id = public.my_real_account_id()),
    'impersonating',   public.is_impersonating(),
    'expires_at',      (SELECT expires_at FROM public.active_impersonation()),
    'reason',          (SELECT reason FROM public.active_impersonation()),
    'role',            (SELECT role FROM public.account_members WHERE user_id = auth.uid()),
    'is_umbrella',     (SELECT a.parent_account_id IS NULL
                          FROM public.accounts a WHERE a.id = public.my_real_account_id()),
    'can_act_as',      coalesce((
       SELECT json_agg(json_build_object('account_id', a.id, 'name', a.name) ORDER BY a.name)
         FROM public.accounts a
         JOIN public.account_descendants(public.my_real_account_id()) d ON d.account_id = a.id
        WHERE a.id <> public.my_real_account_id()
          AND EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = auth.uid() AND m.role = 'lead')
     ), '[]'::json)
  );
$$;

REVOKE ALL ON FUNCTION public.my_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_context() TO authenticated;
