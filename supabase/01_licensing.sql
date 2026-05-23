-- ═══════════════════════════════════════════════════════════════════
-- Lia Licensing — run this in your Supabase SQL Editor first
-- ═══════════════════════════════════════════════════════════════════

-- Users table (rows created by admin, NOT self-registration)
CREATE TABLE IF NOT EXISTS public.users (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      text UNIQUE NOT NULL,
  name       text,
  plan       text NOT NULL DEFAULT 'pay-per-use',
  credits    integer NOT NULL DEFAULT 0,
  -- credits: -1 = unlimited, 0 = no credits left, N = N imports remaining
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Usage audit log
CREATE TABLE IF NOT EXISTS public.usage_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.users(id),
  work_order_id  text NOT NULL,
  consumed_at    timestamptz NOT NULL DEFAULT now(),
  credits_before integer NOT NULL,
  credits_after  integer NOT NULL
);

-- Enable RLS on both tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_log ENABLE ROW LEVEL SECURITY;

-- Users can only see their own row
CREATE POLICY "users_select_own" ON public.users
  FOR SELECT USING (auth.uid() = id);

-- Users can only see their own log entries
CREATE POLICY "usage_log_select_own" ON public.usage_log
  FOR SELECT USING (auth.uid() = user_id);

-- ── Admin helper: create a Lia user after they sign up in Supabase Auth ──────
-- After creating the auth user (Supabase dashboard → Auth → Users → Invite),
-- run: SELECT create_lia_user('their-auth-uuid', 'email@domain.com', 'Name', 5);
CREATE OR REPLACE FUNCTION public.create_lia_user(
  p_id      uuid,
  p_email   text,
  p_name    text DEFAULT NULL,
  p_credits integer DEFAULT 0
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.users(id, email, name, credits)
  VALUES (p_id, p_email, p_name, p_credits)
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email, name = EXCLUDED.name, credits = EXCLUDED.credits;
END;
$$;

-- ── Atomic credit consumption ─────────────────────────────────────────────────
-- Called by Lia before each import: SELECT consume_credit('WO-123');
-- Returns credits_after (-1 = unlimited, 0+ = remaining balance)
-- Raises exception if balance is 0 — Lia catches this and blocks the import.
CREATE OR REPLACE FUNCTION public.consume_credit(p_work_order_id text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id     uuid;
  v_credits     integer;
  v_credits_new integer;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT credits INTO v_credits
  FROM public.users WHERE id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User record not found — contact your administrator';
  END IF;

  IF v_credits = -1 THEN
    -- Unlimited plan: log but do not decrement
    INSERT INTO public.usage_log(user_id, work_order_id, credits_before, credits_after)
    VALUES (v_user_id, p_work_order_id, -1, -1);
    RETURN -1;
  END IF;

  IF v_credits <= 0 THEN
    RAISE EXCEPTION 'No import credits remaining — contact your administrator';
  END IF;

  v_credits_new := v_credits - 1;
  UPDATE public.users SET credits = v_credits_new WHERE id = v_user_id;

  INSERT INTO public.usage_log(user_id, work_order_id, credits_before, credits_after)
  VALUES (v_user_id, p_work_order_id, v_credits, v_credits_new);

  RETURN v_credits_new;
END;
$$;

-- ── Get current user's credit balance ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_credits()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_credits integer;
BEGIN
  SELECT credits INTO v_credits FROM public.users WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'User record not found'; END IF;
  RETURN v_credits;
END;
$$;

-- ── Get current user's profile ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.users%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.users WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'User record not found'; END IF;
  RETURN row_to_json(r);
END;
$$;
