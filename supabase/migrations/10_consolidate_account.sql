-- ═══════════════════════════════════════════════════════════════════
-- Lia — consolidate everything onto one account. OPTIONAL, and only for a
-- single-company deployment. Run AFTER 09, and only if the description below
-- matches your situation.
--
-- The backfill in 03 gives every existing user their OWN account, because from
-- inside the database there is no way to tell whether two users are colleagues
-- or two unrelated customers. For Batavia they are all colleagues, and one
-- account per tech is wrong in a way that quietly breaks things:
--
--   * each tech has a separate credit balance, so one work order can be charged
--     more than once
--   * techs cannot see each other's equipment catalogue
--   * multi-tech merge does not work at all — it is account-scoped, and two
--     techs on one work order would be in different accounts
--
-- This puts every user on one account, makes one of them the lead, and adopts
-- any inspection the backfill could not attribute.
--
-- Do NOT run this if the users in this database belong to different companies.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.consolidate_to_one_account(
  p_lead_user  uuid,
  p_account_name text DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_keep     uuid;
  v_credits  integer;
  v_unlimited boolean;
  v_moved    integer;
  v_adopted  integer;
  v_fp       integer;
  v_dropped  integer;
BEGIN
  SELECT account_id INTO v_keep FROM public.account_members WHERE user_id = p_lead_user;
  IF v_keep IS NULL THEN
    RAISE EXCEPTION 'That user has no account — run create_lia_user for them first';
  END IF;

  -- Credits: unlimited anywhere wins, otherwise sum them. Summing is the
  -- conservative choice — these balances were bought.
  SELECT bool_or(credits = -1), sum(GREATEST(credits, 0))
    INTO v_unlimited, v_credits FROM public.accounts;

  UPDATE public.accounts
     SET credits = CASE WHEN v_unlimited THEN -1 ELSE coalesce(v_credits, 0) END,
         name = coalesce(nullif(p_account_name, ''), name)
   WHERE id = v_keep;

  -- Everyone joins it. The nominated user leads; everyone else collects.
  UPDATE public.account_members
     SET account_id = v_keep,
         role = CASE WHEN user_id = p_lead_user THEN 'lead' ELSE 'tech' END,
         desktop_access = (user_id = p_lead_user)
   WHERE account_id <> v_keep OR user_id = p_lead_user;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  -- Everything the backfill either attributed elsewhere or could not place.
  UPDATE public.assets SET account_id = v_keep WHERE account_id IS DISTINCT FROM v_keep;
  UPDATE public.inspections SET account_id = v_keep WHERE account_id IS DISTINCT FROM v_keep;
  GET DIAGNOSTICS v_adopted = ROW_COUNT;
  UPDATE public.fp_inspections SET account_id = v_keep WHERE account_id IS DISTINCT FROM v_keep;
  GET DIAGNOSTICS v_fp = ROW_COUNT;
  -- Work orders are unique on (account, wo_key), and two accounts may each hold
  -- the same number — that namespacing is the point of the constraint. Merging
  -- them makes those collide, so fold duplicates instead of failing: keep the
  -- row that was actually charged (earliest wins on a tie), re-point everything
  -- at it, and drop the loser. Never charge twice for what is now one order.
  UPDATE public.work_orders w SET account_id = v_keep
   WHERE w.account_id IS DISTINCT FROM v_keep
     AND NOT EXISTS (SELECT 1 FROM public.work_orders k
                      WHERE k.account_id = v_keep AND k.wo_key = w.wo_key);

  WITH survivors AS (
    SELECT DISTINCT ON (wo_key) wo_key, id
      FROM public.work_orders
     WHERE account_id = v_keep OR account_id IS DISTINCT FROM v_keep
     ORDER BY wo_key, (charged_at IS NULL), charged_at NULLS LAST, created_at, id
  ), losers AS (
    SELECT w.id, s.id AS keep_id
      FROM public.work_orders w JOIN survivors s ON s.wo_key = w.wo_key
     WHERE w.id <> s.id
  )
  UPDATE public.usage_log u SET work_order_uuid = l.keep_id
    FROM losers l WHERE u.work_order_uuid = l.id;

  WITH survivors AS (
    SELECT DISTINCT ON (wo_key) wo_key, id
      FROM public.work_orders
     ORDER BY wo_key, (charged_at IS NULL), charged_at NULLS LAST, created_at, id
  ), losers AS (
    SELECT w.id, s.id AS keep_id
      FROM public.work_orders w JOIN survivors s ON s.wo_key = w.wo_key
     WHERE w.id <> s.id
  )
  UPDATE public.inspections i SET work_order_uuid = l.keep_id
    FROM losers l WHERE i.work_order_uuid = l.id;

  WITH survivors AS (
    SELECT DISTINCT ON (wo_key) wo_key, id
      FROM public.work_orders
     ORDER BY wo_key, (charged_at IS NULL), charged_at NULLS LAST, created_at, id
  )
  DELETE FROM public.work_orders w
   USING survivors s
   WHERE s.wo_key = w.wo_key AND w.id <> s.id;

  UPDATE public.work_orders SET account_id = v_keep WHERE account_id IS DISTINCT FROM v_keep;
  UPDATE public.usage_log SET account_id = v_keep WHERE account_id IS DISTINCT FROM v_keep;
  UPDATE public.fp_models SET account_id = v_keep WHERE account_id IS NOT NULL AND account_id <> v_keep;

  -- An asset's identity is (account, kind, serial), so consolidating can create
  -- duplicates that were legitimately distinct before. Fold them together.
  WITH ranked AS (
    SELECT id, kind, serial_key,
           first_value(id) OVER (PARTITION BY kind, serial_key ORDER BY created_at, id) AS keep_id
      FROM public.assets WHERE account_id = v_keep
  )
  UPDATE public.inspections i SET asset_id = r.keep_id
    FROM ranked r WHERE i.asset_id = r.id AND r.id <> r.keep_id;

  WITH ranked AS (
    SELECT id, kind, serial_key,
           first_value(id) OVER (PARTITION BY kind, serial_key ORDER BY created_at, id) AS keep_id
      FROM public.assets WHERE account_id = v_keep
  )
  UPDATE public.fp_inspections f SET asset_id = r.keep_id
    FROM ranked r WHERE f.asset_id = r.id AND r.id <> r.keep_id;

  DELETE FROM public.assets a
   WHERE a.account_id = v_keep
     AND NOT EXISTS (SELECT 1 FROM public.inspections i WHERE i.asset_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM public.fp_inspections f WHERE f.asset_id = a.id);

  -- Two inspections of the same item on the same day can now collide on the
  -- partial unique index. Keep the newest as current and supersede the rest,
  -- which is exactly what a second capture would have done anyway.
  WITH dupes AS (
    SELECT id, row_number() OVER (PARTITION BY asset_id, inspection_date
                                  ORDER BY created_at DESC, id DESC) AS rn
      FROM public.inspections WHERE is_current AND NOT is_deleted
  )
  UPDATE public.inspections i SET is_current = false, updated_at = now()
    FROM dupes d WHERE i.id = d.id AND d.rn > 1;

  DELETE FROM public.accounts
   WHERE id <> v_keep
     AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = accounts.id);
  GET DIAGNOSTICS v_dropped = ROW_COUNT;

  RETURN json_build_object(
    'account_id',        v_keep,
    'members',           v_moved,
    'inspections_moved', v_adopted,
    'fp_moved',          v_fp,
    'accounts_removed',  v_dropped,
    'credits',           (SELECT credits FROM public.accounts WHERE id = v_keep)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.consolidate_to_one_account(uuid, text) FROM PUBLIC, anon, authenticated;
