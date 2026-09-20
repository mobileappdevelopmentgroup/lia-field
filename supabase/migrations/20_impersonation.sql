-- ═══════════════════════════════════════════════════════════════════════════
-- Lia Impersonation — safe to re-run; idempotent
--
-- Run AFTER 19_certificate_attribution.sql.
--
-- The umbrella needs to work *inside* a subcontractor's account: to show a new
-- lead how the job is done, to fix something on their behalf, to see exactly
-- what they see when they call about a problem.
--
-- How it works: `my_account_id()` — which every RLS policy and every write path
-- already funnels through — returns the impersonated account while a session is
-- active. Nothing else changes. That is the whole point: the office sees and
-- does precisely what that subcontractor would, with no second code path that
-- could drift from the real one.
--
-- The rules this holds to:
--
--   DOWNWARD ONLY.   You may act as an account beneath yours in the tree.
--                    Never a sibling, never upward. A subcontractor can never
--                    impersonate anybody — the grant is checked against the
--                    caller's REAL account, which impersonation cannot change.
--   LEADS ONLY.      A field person cannot impersonate.
--   IT EXPIRES.      60 minutes by default, 8 hours at most. A forgotten
--                    session is the dangerous one: writing a customer's
--                    certificate into the wrong company by accident.
--   IT IS RECORDED.  Every session is a row that is never deleted, carrying who
--                    acted, as whom, why, and for how long.
--   THE TRUTH IS KEPT. Records written while impersonating still store the REAL
--                    person as the collector, and now also the session id. The
--                    certificate names the lead — which is correct, because the
--                    work was done on that lead's behalf — while the office can
--                    always see who actually pressed the buttons.
-- ═══════════════════════════════════════════════════════════════════════════

-- The account references are nullable and SET NULL on delete, deliberately.
-- consolidate_to_one_account() merges companies and removes the account that
-- loses — but the WORK done under a session survives that merge, and the rows
-- recording it point back here. Cascading would delete the answer to "who
-- actually did this?" for records that still exist. The session outlives the
-- account: who acted, as whom, why and when are kept regardless.
CREATE TABLE IF NOT EXISTS public.impersonation_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_account uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  account_id    uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  account_name  text,          -- kept verbatim, so a merged-away account is still named
  reason        text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ended_at      timestamptz
);

-- Bring a table created by an earlier run of this migration into line.
DO $$
BEGIN
  ALTER TABLE public.impersonation_sessions ADD COLUMN IF NOT EXISTS account_name text;
  ALTER TABLE public.impersonation_sessions ALTER COLUMN actor_account DROP NOT NULL;
  ALTER TABLE public.impersonation_sessions ALTER COLUMN account_id    DROP NOT NULL;

  ALTER TABLE public.impersonation_sessions DROP CONSTRAINT IF EXISTS impersonation_sessions_actor_account_fkey;
  ALTER TABLE public.impersonation_sessions DROP CONSTRAINT IF EXISTS impersonation_sessions_account_id_fkey;
  ALTER TABLE public.impersonation_sessions
    ADD CONSTRAINT impersonation_sessions_actor_account_fkey
    FOREIGN KEY (actor_account) REFERENCES public.accounts(id) ON DELETE SET NULL;
  ALTER TABLE public.impersonation_sessions
    ADD CONSTRAINT impersonation_sessions_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;
END $$;

CREATE INDEX IF NOT EXISTS impersonation_active_idx
  ON public.impersonation_sessions(actor_user_id, expires_at)
  WHERE ended_at IS NULL;

ALTER TABLE public.impersonation_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "impersonation_read" ON public.impersonation_sessions;
CREATE POLICY "impersonation_read" ON public.impersonation_sessions
  FOR SELECT TO authenticated
  USING (actor_user_id = auth.uid() OR public.is_developer());

-- No INSERT/UPDATE/DELETE policy and no grants: the log is written only by the
-- SECURITY DEFINER functions below. An actor cannot edit their own audit trail.
REVOKE ALL ON public.impersonation_sessions FROM anon, authenticated;
GRANT SELECT ON public.impersonation_sessions TO authenticated;

-- The return type changes if an earlier version of this migration ran, and
-- Postgres will not replace a function with a different return type.
DROP FUNCTION IF EXISTS public.active_impersonation();

-- ── The caller's real identity, which impersonation cannot touch ────────────
CREATE OR REPLACE FUNCTION public.my_real_account_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT account_id FROM public.account_members WHERE user_id = auth.uid();
$$;

-- SETOF, not a bare composite: a function returning a composite always yields
-- ONE row in FROM, even when it found nothing, so `EXISTS (SELECT 1 FROM …)`
-- would be true forever and everyone would look permanently impersonated.
CREATE OR REPLACE FUNCTION public.active_impersonation()
RETURNS SETOF public.impersonation_sessions LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT * FROM public.impersonation_sessions
   WHERE actor_user_id = auth.uid()
     AND ended_at IS NULL
     AND expires_at > now()
   ORDER BY started_at DESC
   LIMIT 1;
$$;

-- ── The choke point ─────────────────────────────────────────────────────────
-- Same signature and meaning as before; it now answers "which account am I
-- working in", which is the question every caller was really asking.
CREATE OR REPLACE FUNCTION public.my_account_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT coalesce(
    (SELECT s.account_id FROM public.active_impersonation() s),
    (SELECT account_id FROM public.account_members WHERE user_id = auth.uid())
  );
$$;

CREATE OR REPLACE FUNCTION public.is_impersonating()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.active_impersonation());
$$;

-- ── Starting and stopping ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.start_impersonation(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_real    uuid;
  v_role    text;
  v_target  uuid := (p->>'account_id')::uuid;
  v_reason  text := nullif(btrim(coalesce(p->>'reason', '')), '');
  v_minutes integer := coalesce((p->>'minutes')::integer, 60);
  v_id      uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_target IS NULL THEN RAISE EXCEPTION 'account_id is required'; END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required: this is recorded against the work done as them.';
  END IF;

  -- The REAL account, deliberately: otherwise an active session could be used
  -- to start a further one, walking sideways through the tree.
  SELECT m.account_id, m.role INTO v_real, v_role
    FROM public.account_members m WHERE m.user_id = v_uid;
  IF v_real IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;
  IF v_role IS DISTINCT FROM 'lead' THEN
    RAISE EXCEPTION 'Only a lead can act as another account';
  END IF;
  IF v_target = v_real THEN
    RAISE EXCEPTION 'That is your own account';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_descendants(v_real) d WHERE d.account_id = v_target) THEN
    RAISE EXCEPTION 'You can only act as an account beneath your own';
  END IF;

  v_minutes := greatest(1, least(v_minutes, 480));   -- 8 hours, hard ceiling

  -- One at a time. Two overlapping sessions would make "which account am I in"
  -- a matter of ordering.
  UPDATE public.impersonation_sessions SET ended_at = now()
   WHERE actor_user_id = v_uid AND ended_at IS NULL;

  INSERT INTO public.impersonation_sessions
    (actor_user_id, actor_account, account_id, account_name, reason, expires_at)
  VALUES (v_uid, v_real, v_target,
          (SELECT name FROM public.accounts WHERE id = v_target),
          v_reason, now() + make_interval(mins => v_minutes))
  RETURNING id INTO v_id;

  RETURN json_build_object(
    'id', v_id,
    'account_id', v_target,
    'account_name', (SELECT name FROM public.accounts WHERE id = v_target),
    'expires_at', (SELECT expires_at FROM public.impersonation_sessions WHERE id = v_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.stop_impersonation()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE public.impersonation_sessions SET ended_at = now()
   WHERE actor_user_id = auth.uid() AND ended_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN json_build_object('ended', v_n);
END;
$$;

-- What the interface needs in order to say, loudly, whose account this is.
-- An office screen that looks identical whether or not a session is running is
-- how a certificate ends up in the wrong company.
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

REVOKE ALL ON FUNCTION public.start_impersonation(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stop_impersonation()       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_context()               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_real_account_id()       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_impersonating()         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.active_impersonation()     FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.start_impersonation(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stop_impersonation()       TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_context()               TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_real_account_id()       TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_impersonating()         TO authenticated;

-- ── The record says it was done under impersonation ─────────────────────────
-- Inferring it later from "the collector is not a member of this account" is
-- the kind of reconstruction that is wrong once and then trusted forever.
ALTER TABLE public.inspections    ADD COLUMN IF NOT EXISTS impersonation_id uuid REFERENCES public.impersonation_sessions(id) ON DELETE SET NULL;
ALTER TABLE public.fp_inspections ADD COLUMN IF NOT EXISTS impersonation_id uuid REFERENCES public.impersonation_sessions(id) ON DELETE SET NULL;

-- Extends 19's trigger function rather than adding a second trigger, so the
-- order of stamping stays obvious.
CREATE OR REPLACE FUNCTION public.stamp_attribution()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_num text; v_name text;
BEGIN
  IF NEW.rep_number IS NULL THEN
    SELECT r.rep_number, r.rep_name INTO v_num, v_name FROM public.account_rep(NEW.account_id) r;
    NEW.rep_number := v_num;
    IF NEW.rep_name IS NULL THEN NEW.rep_name := v_name; END IF;

  ELSIF NEW.rep_name IS NULL THEN
    SELECT coalesce(u.name, u.email) INTO NEW.rep_name
      FROM public.account_members m
      JOIN public.users u ON u.id = m.user_id
     WHERE m.rep_number = NEW.rep_number
     ORDER BY (m.account_id = NEW.account_id) DESC
     LIMIT 1;

    IF NEW.rep_name IS NULL THEN
      SELECT r.rep_name INTO NEW.rep_name FROM public.account_rep(NEW.account_id) r;
    END IF;
  END IF;

  IF NEW.verified_by IS NULL THEN
    NEW.verified_by := public.account_verifier(NEW.account_id);
  END IF;

  IF NEW.impersonation_id IS NULL THEN
    SELECT s.id INTO NEW.impersonation_id FROM public.active_impersonation() s;
  END IF;

  RETURN NEW;
END;
$$;

-- The public views are NOT touched here. Whether the office was acting on a
-- subcontractor's behalf is internal; the certificate says what it said before,
-- because the work genuinely was done for that subcontractor.
