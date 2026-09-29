-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — the office's view of tag stock.
-- Idempotent; safe to re-run. Run AFTER 30_consolidate_fold_first.sql.
--
-- Lia Office's Tags screen: every tag the caller's company holds, whether it is
-- still blank or on a piece of equipment, and for the ones in use, what they
-- are on and how that item last fared.
--
-- Visibility is can_see(), like every other read of work: a subcontractor sees
-- its own tags, the umbrella sees every subcontractor's, siblings see nothing
-- of each other's. That is deliberately wider than my_tag_stock() (29), which
-- is what a PHONE recognises as its own — the office looks across companies,
-- a tech's tap must not.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tag_stock_list()
RETURNS TABLE (
  tag_label text, tag_url text, account_name text, holder_name text,
  received_at timestamptz, assigned_at timestamptz,
  serial_num text, item_type text, description text,
  last_inspected date, overall_pass boolean, certificate_url text
)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT s.tag_label, s.tag_url, ac.name, coalesce(u.name, u.email),
         s.received_at, s.assigned_at,
         a.serial_raw, i.item_type, i.description,
         i.inspection_date, i.overall_pass,
         CASE WHEN a.id IS NULL THEN NULL
              ELSE public.certificate_url(a.public_ref, 'fall_protection') END
    FROM public.fp_tag_stock s
    JOIN public.accounts ac ON ac.id = s.account_id
    LEFT JOIN public.users u ON u.id = s.holder_user_id
    LEFT JOIN public.assets a ON a.id = s.asset_id
    LEFT JOIN LATERAL (
      SELECT f.item_type, f.description, f.inspection_date, f.overall_pass
        FROM public.fp_inspections f
       WHERE f.asset_id = a.id AND f.is_current AND NOT f.is_deleted
       ORDER BY f.inspection_date DESC LIMIT 1) i ON true
   WHERE public.can_see(s.account_id)
   ORDER BY s.tag_label;
END;
$$;
REVOKE ALL ON FUNCTION public.tag_stock_list() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.tag_stock_list() TO authenticated;
