-- ═══════════════════════════════════════════════════════════════════
-- Lia Accounts & Billing — safe to re-run; all statements are idempotent
--
-- Replaces the per-user credit model with a per-account one, and replaces
-- consume_credit() with a work-order-scoped charge that can only ever fire
-- once per work order.
--
-- Run AFTER 01_licensing.sql. Run 04_inspections_v2.sql after this.
--
-- What changes, and why:
--   * Credits move from users.credits to accounts.credits, so a lead tech and
--     their sub-techs draw from one pool.
--   * A work order is charged once, on the first successful import. Re-running,
--     editing, or merging more techs' data into the same work order is free.
--     consume_credit() had no idempotency at all — calling it twice for the
--     same work order debited twice.
--   * Uniqueness is (account_id, wo_key), so two customers may legitimately
--     hold the same work order number without blocking each other.
-- ═══════════════════════════════════════════════════════════════════

-- ── Accounts ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  plan       text NOT NULL DEFAULT 'pay-per-use',
  credits    integer NOT NULL DEFAULT 0,   -- -1 = unlimited (unchanged sentinel)
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Membership: which users belong to which account, and what they may do ─────
-- A sub-tech is a collection point only: desktop_access = false keeps them out
-- of Lia Office entirely.
CREATE TABLE IF NOT EXISTS public.account_members (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  role           text NOT NULL DEFAULT 'lead' CHECK (role IN ('lead', 'tech')),
  desktop_access boolean NOT NULL DEFAULT true,
  -- Batavia's technician number for the responsible lead. Declared here rather
  -- than only in 05, because create_lia_user() below writes it and cannot
  -- depend on a later migration having run.
  rep_number     text,
  invited_by     uuid REFERENCES auth.users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.account_members ADD COLUMN IF NOT EXISTS rep_number text;
CREATE INDEX IF NOT EXISTS account_members_account_idx ON public.account_members(account_id);

-- ── Backfill: one account per existing user, carrying their balance across ────
-- Idempotent: only touches users who have no membership yet.
DO $$
DECLARE
  r          record;
  v_account  uuid;
BEGIN
  FOR r IN
    SELECT u.* FROM public.users u
    WHERE NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.user_id = u.id)
  LOOP
    INSERT INTO public.accounts (name, plan, credits)
    VALUES (COALESCE(NULLIF(r.name, ''), r.email), r.plan, r.credits)
    RETURNING id INTO v_account;

    INSERT INTO public.account_members (user_id, account_id, role, desktop_access)
    VALUES (r.id, v_account, 'lead', true);
  END LOOP;
END $$;

-- users.credits is now legacy. It is deliberately NOT dropped: an older Lia
-- Office still in the field reads it through get_my_profile(), and dropping it
-- would break that install. accounts.credits is the authority.
COMMENT ON COLUMN public.users.credits IS
  'LEGACY as of 03_accounts_billing.sql — accounts.credits is the authority. Kept for older clients.';

-- ── Provisioning a user, after this migration ────────────────────────────────
-- The backfill above only covers users who already existed. create_lia_user()
-- as written in 01_licensing.sql inserts a users row and nothing else, so every
-- tech onboarded AFTER this migration would have no account, my_account_id()
-- would be NULL, and nothing would work for them — no billing, no catalogue, no
-- inspections. Replace it so provisioning always produces a usable account.
--
-- p_account_id joins an existing account (a sub-tech under a lead). Omitted, the
-- user gets their own account and is its lead.
-- The 01_licensing.sql version takes four arguments. CREATE OR REPLACE with a
-- different signature creates a SECOND function rather than replacing it, and
-- then every four-argument call is ambiguous and fails. Drop it explicitly.
DROP FUNCTION IF EXISTS public.create_lia_user(uuid, text, text, integer);

CREATE OR REPLACE FUNCTION public.create_lia_user(
  p_id         uuid,
  p_email      text,
  p_name       text    DEFAULT NULL,
  p_credits    integer DEFAULT 0,
  p_account_id uuid    DEFAULT NULL,
  p_role       text    DEFAULT 'lead',
  p_rep_number text    DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_account uuid;
BEGIN
  INSERT INTO public.users(id, email, name, credits)
  VALUES (p_id, p_email, p_name, p_credits)
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email, name = EXCLUDED.name, credits = EXCLUDED.credits;

  SELECT account_id INTO v_account FROM public.account_members WHERE user_id = p_id;

  IF v_account IS NULL THEN
    IF p_account_id IS NOT NULL THEN
      v_account := p_account_id;
    ELSE
      INSERT INTO public.accounts (name, credits)
      VALUES (coalesce(nullif(p_name, ''), p_email), p_credits)
      RETURNING id INTO v_account;
    END IF;

    INSERT INTO public.account_members (user_id, account_id, role, desktop_access)
    VALUES (p_id, v_account, coalesce(p_role, 'lead'),
            coalesce(p_role, 'lead') = 'lead')
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  -- Only set on a new membership or when explicitly supplied, so re-running
  -- provisioning cannot silently clear a rep number.
  IF p_rep_number IS NOT NULL THEN
    UPDATE public.account_members SET rep_number = p_rep_number WHERE user_id = p_id;
  END IF;

  RETURN v_account;
END;
$$;

-- ── Work order normalization ──────────────────────────────────────────────────
-- The billing key. Must match the client-side normalization exactly, or the
-- same work order typed two ways would be charged twice.
CREATE OR REPLACE FUNCTION public.wo_key(p_wo_number text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(regexp_replace(coalesce(p_wo_number, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- ── Work orders ───────────────────────────────────────────────────────────────
-- One row per work order per account. charged_at NULL means "claimed but not
-- yet paid for" — a run that was started and then failed.
CREATE TABLE IF NOT EXISTS public.work_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  wo_number       text NOT NULL,           -- as the user typed it, for display
  wo_key          text NOT NULL,           -- normalized, for uniqueness
  scope           text NOT NULL DEFAULT 'ladder' CHECK (scope IN ('ladder', 'fall_protection')),
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  charged_at      timestamptz,
  charged_by      uuid REFERENCES auth.users(id),
  credits_charged integer NOT NULL DEFAULT 0
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_account_key_uq'
  ) THEN
    ALTER TABLE public.work_orders
      ADD CONSTRAINT work_orders_account_key_uq UNIQUE (account_id, wo_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS work_orders_account_idx ON public.work_orders(account_id);
CREATE INDEX IF NOT EXISTS work_orders_charged_idx ON public.work_orders(charged_at DESC);

-- ── usage_log gains account scoping ──────────────────────────────────────────
ALTER TABLE public.usage_log ADD COLUMN IF NOT EXISTS account_id      uuid REFERENCES public.accounts(id);
ALTER TABLE public.usage_log ADD COLUMN IF NOT EXISTS work_order_uuid uuid REFERENCES public.work_orders(id);

CREATE INDEX IF NOT EXISTS usage_log_account_idx ON public.usage_log(account_id);
CREATE INDEX IF NOT EXISTS usage_log_wo_idx      ON public.usage_log(work_order_id);

-- ── Account lookup helper ─────────────────────────────────────────────────────
-- SECURITY DEFINER on purpose: RLS policies on account_members cannot select
-- from account_members without recursing. This function bypasses that.
CREATE OR REPLACE FUNCTION public.my_account_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT account_id FROM public.account_members WHERE user_id = auth.uid();
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_orders     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "accounts_select_own" ON public.accounts;
CREATE POLICY "accounts_select_own" ON public.accounts
  FOR SELECT USING (id = public.my_account_id());

DROP POLICY IF EXISTS "account_members_select_own" ON public.account_members;
CREATE POLICY "account_members_select_own" ON public.account_members
  FOR SELECT USING (account_id = public.my_account_id());

DROP POLICY IF EXISTS "work_orders_select_own" ON public.work_orders;
CREATE POLICY "work_orders_select_own" ON public.work_orders
  FOR SELECT USING (account_id = public.my_account_id());

-- No INSERT/UPDATE/DELETE policies anywhere here. Every write goes through a
-- SECURITY DEFINER function below, so a client cannot grant itself credits or
-- mark a work order paid.
REVOKE ALL ON public.accounts        FROM anon, authenticated;
REVOKE ALL ON public.account_members FROM anon, authenticated;
REVOKE ALL ON public.work_orders     FROM anon, authenticated;
GRANT SELECT ON public.accounts        TO authenticated;
GRANT SELECT ON public.account_members TO authenticated;
GRANT SELECT ON public.work_orders     TO authenticated;

-- ── Preflight: can this import run at all? ────────────────────────────────────
-- Read-only. Called BEFORE the browser launches so a tech with no credits is
-- stopped up front instead of after importing 200 ladders.
CREATE OR REPLACE FUNCTION public.preflight_work_order(p_wo_number text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_account_id uuid;
  v_credits    integer;
  v_key        text;
  v_charged    boolean := false;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_key := public.wo_key(p_wo_number);
  IF v_key = '' THEN RAISE EXCEPTION 'A work order number is required'; END IF;

  SELECT account_id INTO v_account_id FROM public.account_members WHERE user_id = v_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  SELECT credits INTO v_credits FROM public.accounts WHERE id = v_account_id;

  SELECT (charged_at IS NOT NULL) INTO v_charged
  FROM public.work_orders WHERE account_id = v_account_id AND wo_key = v_key;

  RETURN json_build_object(
    'credits',         v_credits,
    'already_charged', COALESCE(v_charged, false),
    -- true when this import will not cost anything: already paid, or unlimited
    'free',            COALESCE(v_charged, false) OR v_credits = -1,
    'can_run',         COALESCE(v_charged, false) OR v_credits = -1 OR v_credits > 0
  );
END;
$$;

-- ── Charge: called ONLY after an import has actually succeeded ────────────────
-- Idempotency comes from the (account_id, wo_key) unique constraint plus the
-- charged_at check, not from application logic.
CREATE OR REPLACE FUNCTION public.charge_work_order(
  p_wo_number text,
  p_scope     text DEFAULT 'ladder'
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_account_id uuid;
  v_key        text;
  v_credits    integer;
  v_new        integer;
  v_wo_id      uuid;
  v_charged_at timestamptz;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_key := public.wo_key(p_wo_number);
  IF v_key = '' THEN RAISE EXCEPTION 'A work order number is required'; END IF;

  SELECT account_id INTO v_account_id FROM public.account_members WHERE user_id = v_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  -- Lock the account row first. Two imports finishing at the same moment must
  -- not both read the same balance and both debit it.
  SELECT credits INTO v_credits FROM public.accounts WHERE id = v_account_id FOR UPDATE;

  INSERT INTO public.work_orders (account_id, wo_number, wo_key, scope, created_by)
  VALUES (v_account_id, p_wo_number, v_key, p_scope, v_user_id)
  ON CONFLICT (account_id, wo_key) DO NOTHING
  RETURNING id INTO v_wo_id;

  IF v_wo_id IS NULL THEN
    SELECT id, charged_at INTO v_wo_id, v_charged_at
    FROM public.work_orders WHERE account_id = v_account_id AND wo_key = v_key;
  END IF;

  -- Already paid for. This is the whole point: edits, re-runs, and merging more
  -- techs' data into an existing work order are free.
  IF v_charged_at IS NOT NULL THEN
    RETURN json_build_object(
      'charged', false, 'reason', 'already_paid',
      'credits', v_credits, 'work_order_id', v_wo_id
    );
  END IF;

  IF v_credits = -1 THEN
    UPDATE public.work_orders
       SET charged_at = now(), charged_by = v_user_id, credits_charged = 0, updated_at = now()
     WHERE id = v_wo_id;
    INSERT INTO public.usage_log(user_id, account_id, work_order_id, work_order_uuid, credits_before, credits_after)
    VALUES (v_user_id, v_account_id, p_wo_number, v_wo_id, -1, -1);
    RETURN json_build_object('charged', true, 'credits', -1, 'work_order_id', v_wo_id);
  END IF;

  IF v_credits <= 0 THEN
    RAISE EXCEPTION 'No import credits remaining — contact your administrator';
  END IF;

  v_new := v_credits - 1;
  UPDATE public.accounts SET credits = v_new WHERE id = v_account_id;
  UPDATE public.work_orders
     SET charged_at = now(), charged_by = v_user_id, credits_charged = 1, updated_at = now()
   WHERE id = v_wo_id;

  INSERT INTO public.usage_log(user_id, account_id, work_order_id, work_order_uuid, credits_before, credits_after)
  VALUES (v_user_id, v_account_id, p_wo_number, v_wo_id, v_credits, v_new);

  RETURN json_build_object('charged', true, 'credits', v_new, 'work_order_id', v_wo_id);
END;
$$;

-- ── Existing RPCs, rewritten to read through the account ─────────────────────
-- Same names, same return shapes, so the current Lia Office renderer keeps
-- working without a change.
CREATE OR REPLACE FUNCTION public.get_my_credits()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE v_credits integer;
BEGIN
  SELECT a.credits INTO v_credits
  FROM public.accounts a
  JOIN public.account_members m ON m.account_id = a.id
  WHERE m.user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'User record not found'; END IF;
  RETURN v_credits;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE r record;
BEGIN
  SELECT u.id, u.email, u.name, a.plan, a.credits, u.created_at,
         a.id   AS account_id,
         a.name AS account_name,
         m.role, m.desktop_access
  INTO r
  FROM public.users u
  JOIN public.account_members m ON m.user_id = u.id
  JOIN public.accounts a        ON a.id = m.account_id
  WHERE u.id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'User record not found'; END IF;
  RETURN row_to_json(r);
END;
$$;

-- ── Deprecated ────────────────────────────────────────────────────────────────
-- consume_credit() is kept for one release because an older Lia Office already
-- installed in the field still calls it. It now debits the account rather than
-- the user row, so an old client cannot double-spend against a new balance.
-- Remove once no pre-billing-rework build is in use.
CREATE OR REPLACE FUNCTION public.consume_credit(p_work_order_id text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result json;
BEGIN
  -- Older builds send the literal 'unknown' when the work order box was left
  -- blank. Under (account_id, wo_key) uniqueness that would become a single
  -- shared bucket: the first blank-WO import charges and every one after it is
  -- free forever. Refuse it rather than leak imports.
  IF public.wo_key(p_work_order_id) IN ('', 'UNKNOWN') THEN
    RAISE EXCEPTION 'A work order number is required. Enter the real work order number, or update Lia Office.';
  END IF;

  v_result := public.charge_work_order(p_work_order_id, 'ladder');
  RETURN (v_result->>'credits')::integer;
END;
$$;

COMMENT ON FUNCTION public.consume_credit(text) IS
  'DEPRECATED — use charge_work_order(). Kept for older Lia Office builds still in the field.';
