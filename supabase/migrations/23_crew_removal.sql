-- ═══════════════════════════════════════════════════════════════════════════
-- Lia Crew Removal — safe to re-run; idempotent
--
-- Run AFTER 22_onboarding_rpcs.sql.
--
-- People leave. Until now the only way to stop somebody signing in was to
-- delete their membership row by hand in the dashboard, which a subcontractor
-- cannot reach and which throws away more than intended.
--
-- ── Removal is soft, and that is not squeamishness ─────────────────────────
-- Their inspections stay exactly where they are. A certificate issued in March
-- was true in March; the equipment was inspected, and by whom is part of the
-- record. What ends is ACCESS: `my_account_id()` stops finding them, so the
-- next sync answers "No account — contact your administrator" and every RLS
-- policy closes at once. Nothing they recorded moves, disappears, or changes
-- who it names.
--
-- Keeping the row also keeps the office's questions answerable: which crew was
-- on this account last spring, who collected this item, what was their role.
-- A deleted row turns those into "Unknown".
--
-- ── What cannot be removed ─────────────────────────────────────────────────
-- A LEAD. Their number is the responsible technician on every certificate the
-- account issues, and `account_rep()` resolves it from the membership. Remove
-- the lead and the account's next certificate has nobody to name. Replacing a
-- lead is a different, deliberate operation — not a button next to "remove".
--
-- Nobody can remove themselves either: a lead who does is locked out of an
-- account only somebody else can let them back into.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.account_members ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE public.account_members ADD COLUMN IF NOT EXISTS removed_by uuid REFERENCES auth.users(id);
ALTER TABLE public.account_members ADD COLUMN IF NOT EXISTS removed_reason text;

CREATE INDEX IF NOT EXISTS account_members_active_idx
  ON public.account_members(account_id) WHERE removed_at IS NULL;

-- ── The choke points learn to ignore a removed member ───────────────────────
-- my_account_id() is what every policy and every write path asks. Once it
-- returns NULL for them, access is gone everywhere at once — there is no
-- second list to keep in step.
CREATE OR REPLACE FUNCTION public.my_real_account_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT account_id FROM public.account_members
   WHERE user_id = auth.uid() AND removed_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.my_account_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT coalesce(
    (SELECT s.account_id FROM public.active_impersonation() s),
    (SELECT account_id FROM public.account_members
      WHERE user_id = auth.uid() AND removed_at IS NULL)
  );
$$;

-- A removed lead must not be picked as the responsible technician either.
CREATE OR REPLACE FUNCTION public.account_rep_number(p_account_id uuid)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT min(rep_number)
    FROM public.account_members
   WHERE account_id = p_account_id
     AND role = 'lead'
     AND removed_at IS NULL
     AND rep_number IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.account_rep(p_account uuid)
RETURNS TABLE (rep_number text, rep_name text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT m.rep_number, coalesce(u.name, u.email)
    FROM public.account_members m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.account_id = p_account
     AND m.role = 'lead'
     AND m.removed_at IS NULL
   ORDER BY m.rep_number NULLS LAST
   LIMIT 1;
$$;

-- ── The crew list shows who is gone, rather than hiding them ────────────────
-- A lead looking at their team needs to see that somebody was removed and
-- when — not find that the person silently vanished from a list they were on
-- last week.
CREATE OR REPLACE FUNCTION public.team_members()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE v_account uuid := public.my_account_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN (
    SELECT coalesce(json_agg(json_build_object(
             'user_id', u.id, 'name', u.name, 'email', u.email,
             'role', m.role, 'rep_number', m.rep_number,
             'removed_at', m.removed_at,
             'removed_reason', m.removed_reason)
             ORDER BY (m.removed_at IS NOT NULL), m.role, u.name), '[]'::json)
      FROM public.account_members m JOIN public.users u ON u.id = m.user_id
     WHERE m.account_id = v_account);
END;
$$;

-- ── Removing ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.remove_crew_member(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_account uuid;
  v_role    text;
  v_user    uuid := nullif(p->>'user_id', '')::uuid;
  v_reason  text := nullif(btrim(coalesce(p->>'reason', '')), '');
  v_target  public.account_members%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_account := public.my_account_id();
  IF v_account IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  -- Acting as a subcontractor is acting as their lead, and the session was
  -- already gated on being one. Signed in as yourself, you must be the lead.
  IF NOT public.is_impersonating() THEN
    SELECT role INTO v_role FROM public.account_members
     WHERE user_id = v_caller AND removed_at IS NULL;
    IF v_role IS DISTINCT FROM 'lead' THEN
      RAISE EXCEPTION 'Only a lead can remove somebody from the crew';
    END IF;
  END IF;

  IF v_user IS NULL THEN RAISE EXCEPTION 'user_id is required'; END IF;
  IF v_user = v_caller THEN
    RAISE EXCEPTION 'You cannot remove yourself. Somebody else would have to let you back in.';
  END IF;

  SELECT * INTO v_target FROM public.account_members WHERE user_id = v_user;
  IF NOT FOUND OR v_target.account_id <> v_account THEN
    RAISE EXCEPTION 'That person is not on this account.';
  END IF;
  IF v_target.role = 'lead' THEN
    RAISE EXCEPTION 'A lead cannot be removed here: their number is the responsible technician on every certificate this account issues.';
  END IF;
  IF v_target.removed_at IS NOT NULL THEN
    RETURN json_build_object('removed', false, 'reason', 'already removed',
                             'removed_at', v_target.removed_at);
  END IF;

  UPDATE public.account_members
     SET removed_at = now(), removed_by = v_caller, removed_reason = v_reason
   WHERE user_id = v_user;

  RETURN json_build_object(
    'removed', true,
    'user_id', v_user,
    'records_kept', (SELECT count(*) FROM public.inspections WHERE collected_by = v_user)
                  + (SELECT count(*) FROM public.fp_inspections WHERE collected_by = v_user));
END;
$$;

-- ── Putting somebody back ───────────────────────────────────────────────────
-- Seasonal crews come back, and a removal made in error should not need a
-- second account — which would split one person's work in two.
CREATE OR REPLACE FUNCTION public.restore_crew_member(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_account uuid;
  v_role    text;
  v_user    uuid := nullif(p->>'user_id', '')::uuid;
  v_target  public.account_members%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_account := public.my_account_id();
  IF v_account IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  IF NOT public.is_impersonating() THEN
    SELECT role INTO v_role FROM public.account_members
     WHERE user_id = v_caller AND removed_at IS NULL;
    IF v_role IS DISTINCT FROM 'lead' THEN
      RAISE EXCEPTION 'Only a lead can put somebody back on the crew';
    END IF;
  END IF;

  SELECT * INTO v_target FROM public.account_members WHERE user_id = v_user;
  IF NOT FOUND OR v_target.account_id <> v_account THEN
    RAISE EXCEPTION 'That person is not on this account.';
  END IF;

  UPDATE public.account_members
     SET removed_at = NULL, removed_by = NULL, removed_reason = NULL
   WHERE user_id = v_user;

  RETURN json_build_object('restored', true, 'user_id', v_user);
END;
$$;

-- ── Adding somebody back who was removed ────────────────────────────────────
-- add_crew_member refuses anybody who already has a membership, which now
-- includes a removed one. Rehiring into the SAME account is a restore; into a
-- different one it stays refused, because their records do not follow them.
CREATE OR REPLACE FUNCTION public.add_crew_member(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_account uuid;
  v_role    text;
  v_user    uuid := (p->>'user_id')::uuid;
  v_existing public.account_members%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_account := public.my_account_id();
  IF v_account IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  IF NOT public.is_impersonating() THEN
    SELECT role INTO v_role FROM public.account_members
     WHERE user_id = v_caller AND removed_at IS NULL;
    IF v_role IS DISTINCT FROM 'lead' THEN
      RAISE EXCEPTION 'Only a lead can add crew members';
    END IF;
  END IF;

  IF v_user IS NULL THEN RAISE EXCEPTION 'user_id is required (their id from Auth → Users)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user) THEN
    RAISE EXCEPTION 'No such user. Invite them in Supabase first (Auth → Users → Invite user).';
  END IF;

  SELECT * INTO v_existing FROM public.account_members WHERE user_id = v_user;
  IF FOUND THEN
    IF v_existing.account_id = v_account AND v_existing.removed_at IS NOT NULL THEN
      UPDATE public.account_members
         SET removed_at = NULL, removed_by = NULL, removed_reason = NULL
       WHERE user_id = v_user;
      RETURN v_account;
    END IF;
    RAISE EXCEPTION 'That person already belongs to an account. Moving them is a data migration, not an invitation.';
  END IF;

  INSERT INTO public.users (id, email, name, credits)
  VALUES (v_user, p->>'email', nullif(btrim(coalesce(p->>'name','')), ''), 0)
  ON CONFLICT (id) DO UPDATE
    SET email = coalesce(EXCLUDED.email, public.users.email),
        name  = coalesce(EXCLUDED.name,  public.users.name);

  INSERT INTO public.account_members (user_id, account_id, role, desktop_access, rep_number, invited_by)
  VALUES (v_user, v_account, 'tech', false, NULL, v_caller);

  RETURN v_account;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_crew_member(jsonb)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_crew_member(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_crew_member(jsonb)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_crew_member(jsonb) TO authenticated;

-- ── What the office needs to draw the screens AS THEM ──────────────────────
-- While acting as a subcontractor, the home screen should show what that
-- subcontractor sees — not what the umbrella sees. `is_umbrella` describes the
-- caller's REAL account and must keep doing so (it is what decides whether the
-- Subcontractors door exists at all), so this adds a second, separate fact:
-- whether the account currently being WORKED IN has anybody beneath it.
--
-- Acting as somebody makes you their lead for the duration — the session was
-- gated on being a lead already — so the role to draw with is 'lead'.
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
    'role',            (SELECT role FROM public.account_members
                         WHERE user_id = auth.uid() AND removed_at IS NULL),
    'is_umbrella',     (SELECT a.parent_account_id IS NULL
                          FROM public.accounts a WHERE a.id = public.my_real_account_id()),
    -- Does the account being worked in have subcontractors of its own?
    'acting_is_umbrella', EXISTS (SELECT 1 FROM public.accounts
                                   WHERE parent_account_id = public.my_account_id()),
    'can_act_as',      coalesce((
       SELECT json_agg(json_build_object('account_id', a.id, 'name', a.name) ORDER BY a.name)
         FROM public.accounts a
         JOIN public.account_descendants(public.my_real_account_id()) d ON d.account_id = a.id
        WHERE a.id <> public.my_real_account_id()
          AND EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = auth.uid() AND m.role = 'lead'
                         AND m.removed_at IS NULL)
     ), '[]'::json)
  );
$$;

REVOKE ALL ON FUNCTION public.my_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_context() TO authenticated;
