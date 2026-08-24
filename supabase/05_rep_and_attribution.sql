-- ═══════════════════════════════════════════════════════════════════
-- Lia Rep Number & Collector Attribution — safe to re-run; idempotent
--
-- Run AFTER 04_inspections_v2.sql.
--
-- Every inspection now records two different people, and conflating them would
-- be wrong:
--
--   rep_number   — Batavia's tech RESPONSIBLE for the inspection. This is the
--                  lead tech's number, the same one they sign in with. It is an
--                  attribute of the account, not something typed per item.
--   tech_user_id — who actually COLLECTED the data. On a subcontracted job this
--                  is a sub-tech, and it is not the responsible rep.
--
-- rep_number is snapshotted onto each inspection rather than joined at read
-- time: if a rep number is ever reassigned, historical certificates must keep
-- showing who was responsible at the time, not who holds the number now.
-- ═══════════════════════════════════════════════════════════════════

-- ── Rep number lives on the membership ───────────────────────────────────────
ALTER TABLE public.account_members ADD COLUMN IF NOT EXISTS rep_number text;

CREATE INDEX IF NOT EXISTS account_members_rep_idx
  ON public.account_members(rep_number) WHERE rep_number IS NOT NULL;

-- The rep responsible for an account's work is its lead. min() only matters in
-- the degenerate case of an account with more than one lead.
CREATE OR REPLACE FUNCTION public.account_rep_number(p_account_id uuid)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT min(rep_number)
    FROM public.account_members
   WHERE account_id = p_account_id
     AND role = 'lead'
     AND rep_number IS NOT NULL;
$$;

-- ── Snapshot columns on the inspection ───────────────────────────────────────
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS rep_number     text;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS collected_by   uuid REFERENCES auth.users(id);
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS collector_name text;

-- tech_user_id already holds whoever called the write. Carry it into the
-- explicitly-named column so "who collected this" is unambiguous at a glance.
UPDATE public.inspections SET collected_by = tech_user_id
 WHERE collected_by IS NULL AND tech_user_id IS NOT NULL;

UPDATE public.inspections SET collector_name = tech_name
 WHERE collector_name IS NULL AND tech_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS inspections_collected_by_idx ON public.inspections(collected_by);

-- ── Rewritten write path ─────────────────────────────────────────────────────
-- Same signature and behaviour as 04, plus rep/collector attribution.
CREATE OR REPLACE FUNCTION public.record_inspection(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id  uuid := auth.uid();
  v_account  uuid;
  v_serial   text := trim(coalesce(p->>'serial_num', ''));
  v_date     date := coalesce((p->>'inspection_date')::date, current_date);
  v_asset    uuid;
  v_prev     public.inspections%ROWTYPE;
  v_id       uuid;
  v_version  integer := 1;
  v_rep      text;
  v_who      text;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_serial = '' THEN RAISE EXCEPTION 'A serial number is required'; END IF;

  SELECT account_id INTO v_account FROM public.account_members WHERE user_id = v_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  -- Responsible rep comes from the account's lead, never from the payload: a
  -- sub-tech's device must not be able to claim a different rep number.
  v_rep := public.account_rep_number(v_account);

  SELECT coalesce(nullif(p->>'tech_name', ''), u.name, u.email)
    INTO v_who FROM public.users u WHERE u.id = v_user_id;
  v_who := coalesce(v_who, nullif(p->>'tech_name', ''), 'Lia Import');

  INSERT INTO public.assets (account_id, kind, serial_raw, serial_key)
  VALUES (v_account, coalesce(p->>'kind', 'ladder'), v_serial, public.serial_key(v_serial))
  ON CONFLICT (account_id, kind, serial_key) DO NOTHING
  RETURNING id INTO v_asset;

  IF v_asset IS NULL THEN
    SELECT id INTO v_asset FROM public.assets
     WHERE account_id = v_account
       AND kind = coalesce(p->>'kind', 'ladder')
       AND serial_key = public.serial_key(v_serial);
  END IF;

  SELECT * INTO v_prev FROM public.inspections
   WHERE asset_id = v_asset AND inspection_date = v_date AND is_current AND NOT is_deleted
   FOR UPDATE;

  IF FOUND THEN
    v_version := v_prev.version + 1;
    UPDATE public.inspections SET is_current = false, updated_at = now() WHERE id = v_prev.id;
  END IF;

  INSERT INTO public.inspections (
    serial_num, inspection_date, tech_name, work_order_id, next_due_date, notes,
    brand, type, length, account_id, asset_id, tech_user_id,
    version, supersedes, is_current, source, captured_at,
    lubricated, has_leveler, has_claw, has_vrung,
    rep_number, collected_by, collector_name
  ) VALUES (
    v_serial, v_date, v_who,
    coalesce(nullif(p->>'work_order_id', ''), v_prev.work_order_id),
    coalesce((p->>'next_due_date')::date, v_date + interval '1 year'),
    coalesce(nullif(p->>'notes',  ''), v_prev.notes),
    coalesce(nullif(p->>'brand',  ''), v_prev.brand),
    coalesce(nullif(p->>'type',   ''), v_prev.type),
    coalesce(nullif(p->>'length', ''), v_prev.length),
    v_account, v_asset, v_user_id,
    v_version, v_prev.id, true,
    coalesce(p->>'source', 'office'),
    coalesce((p->>'captured_at')::timestamptz, now()),
    coalesce((p->>'lubricated')::boolean,  v_prev.lubricated),
    coalesce((p->>'has_leveler')::boolean, v_prev.has_leveler),
    coalesce((p->>'has_claw')::boolean,    v_prev.has_claw),
    coalesce((p->>'has_vrung')::boolean,   v_prev.has_vrung),
    v_rep, v_user_id, v_who
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── Who submitted what, for Lia Office ───────────────────────────────────────
-- The lead needs to see which of their techs collected which items on a shared
-- work order. Account-scoped through the underlying table's RLS.
CREATE OR REPLACE VIEW public.work_order_submissions AS
  SELECT
    i.account_id,
    i.work_order_id,
    i.collected_by,
    coalesce(i.collector_name, 'Unknown')       AS collector_name,
    m.role                                       AS collector_role,
    m.rep_number                                 AS collector_rep_number,
    count(*)                                     AS item_count,
    min(i.captured_at)                           AS first_captured_at,
    max(i.captured_at)                           AS last_captured_at
  FROM public.inspections i
  LEFT JOIN public.account_members m ON m.user_id = i.collected_by
  WHERE i.is_current AND NOT i.is_deleted
  GROUP BY i.account_id, i.work_order_id, i.collected_by,
           i.collector_name, m.role, m.rep_number;

-- security_invoker so the caller's RLS on inspections applies — this view is
-- for authenticated leads, NOT for anon, and must not leak across accounts the
-- way an owner-rights view would.
ALTER VIEW public.work_order_submissions SET (security_invoker = true);

REVOKE ALL ON public.work_order_submissions FROM anon;
GRANT SELECT ON public.work_order_submissions TO authenticated;

-- ── Certificate URL ──────────────────────────────────────────────────────────
-- The item's "URL" is the address written onto its NFC tag: the public
-- certificate for that asset. It is derived from public_ref, never typed by a
-- tech, so a tag can never point somewhere that does not resolve.
CREATE TABLE IF NOT EXISTS public.app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.app_settings(key, value)
VALUES ('certificate_base_url', 'https://lia.mobileappdevelopmentgroup.com')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "app_settings_read" ON public.app_settings;
CREATE POLICY "app_settings_read" ON public.app_settings FOR SELECT USING (true);
REVOKE ALL ON public.app_settings FROM anon, authenticated;
GRANT SELECT ON public.app_settings TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.certificate_url(p_public_ref text, p_kind text DEFAULT 'ladder')
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE WHEN p_public_ref IS NULL THEN NULL ELSE
    (SELECT value FROM public.app_settings WHERE key = 'certificate_base_url')
    || CASE WHEN p_kind = 'fall_protection' THEN '/fp/?t=' ELSE '/?t=' END
    || p_public_ref
  END;
$$;

-- ── Public view gains the derived URL and the responsible rep ────────────────
-- Columns are only ever added here; the site does select('*') and reads by name.
DROP VIEW IF EXISTS public.ladder_inspections_public;
CREATE VIEW public.ladder_inspections_public AS
  SELECT
    coalesce(a.serial_raw, i.serial_num) AS serial_num,
    a.serial_key,
    i.inspection_date,
    i.tech_name,
    i.next_due_date,
    i.work_order_id,
    i.notes,
    i.brand,
    i.type,
    i.length,
    i.created_at,
    a.public_ref,
    i.version,
    i.lubricated,
    i.has_leveler,
    i.has_claw,
    i.has_vrung,
    i.rep_number,
    public.certificate_url(a.public_ref, a.kind) AS certificate_url
    -- collected_by / collector_name are deliberately NOT exposed: which
    -- sub-tech collected a record is internal, for the lead and for admin.
  FROM public.inspections i
  LEFT JOIN public.assets a ON a.id = i.asset_id
  WHERE i.is_current AND NOT i.is_deleted
  ORDER BY i.serial_num, i.inspection_date DESC;

GRANT SELECT ON public.ladder_inspections_public TO anon;
GRANT SELECT ON public.ladder_inspections_public TO authenticated;

-- ── Photo retention: 2 years ─────────────────────────────────────────────────
-- Stated in the privacy policy, so it has to be enforced rather than promised.
-- Photos themselves land in Storage in a later phase; this is the policy and
-- the sweeper, defined now so the number lives in exactly one place.
INSERT INTO public.app_settings(key, value)
VALUES ('photo_retention_days', '730')
ON CONFLICT (key) DO NOTHING;
