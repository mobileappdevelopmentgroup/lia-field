-- ═══════════════════════════════════════════════════════════════════════════
-- Lia Certificate Attribution — safe to re-run; idempotent
--
-- Run AFTER 18_umbrella_accounts.sql.
--
-- What a certificate says about who is responsible:
--
--   the organisation   the umbrella at the top of the tree — Batavia
--   the technician     the LEAD SUBCONTRACTOR for that area — never the person
--                      who physically took the reading
--
-- Who actually did the work is still recorded, in full, on every row
-- (`tech_user_id`, `collected_by`, `collector_name`). The office needs to
-- answer "who inspected this?" months later. That answer simply never reaches
-- the customer.
--
-- ⚠️ THIS FIXES A LIVE DISCLOSURE. Until now the public views published the
-- COLLECTOR's name as `tech_name` — `ladder_inspections_public` selected
-- `i.tech_name` (set to the caller's name by record_inspection) and
-- `fall_protection_public` selected `i.collector_name AS tech_name`. Both are
-- readable by anon with the publishable key. After this migration `tech_name`
-- carries the responsible LEAD's name, so the existing certificate sites show
-- the right person the moment it is applied — no redeploy needed, and no
-- window where a field person's name is public.
--
-- The column is kept rather than renamed for exactly that reason: the sites do
-- select('*') and read by name, and a rename would blank the field until S3
-- caught up.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Snapshot columns ────────────────────────────────────────────────────────
-- Frozen at write time, like rep_number already is: if a lead's number or name
-- changes, or a subcontractor moves under a different umbrella, certificates
-- already issued must keep saying what was true when they were issued.
ALTER TABLE public.inspections    ADD COLUMN IF NOT EXISTS rep_name    text;
ALTER TABLE public.inspections    ADD COLUMN IF NOT EXISTS verified_by text;
ALTER TABLE public.fp_inspections ADD COLUMN IF NOT EXISTS rep_name    text;
ALTER TABLE public.fp_inspections ADD COLUMN IF NOT EXISTS verified_by text;

-- ── Who is responsible for an account's work ────────────────────────────────
-- The account's lead. min() only matters in the degenerate case of two leads,
-- which 18 exists to make unnecessary.
CREATE OR REPLACE FUNCTION public.account_rep(p_account uuid)
RETURNS TABLE (rep_number text, rep_name text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT m.rep_number, coalesce(u.name, u.email)
    FROM public.account_members m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.account_id = p_account
     AND m.role = 'lead'
   ORDER BY m.rep_number NULLS LAST
   LIMIT 1;
$$;

-- The organisation the certificate is issued under: the root of the tree. An
-- account with no parent stands behind its own work, which is what every
-- account did before 18.
CREATE OR REPLACE FUNCTION public.account_verifier(p_account uuid)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT a.name FROM public.accounts a WHERE a.id = public.account_root(p_account);
$$;

REVOKE ALL ON FUNCTION public.account_rep(uuid)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.account_verifier(uuid)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_rep(uuid)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_verifier(uuid) TO authenticated;

-- ── Stamped by a trigger, not by each write path ────────────────────────────
-- A trigger rather than an edit to record_inspection/record_fp_inspection,
-- because there are already four write paths (two record_*, amend_*, restore_*)
-- and there will be more. A rule enforced in one place cannot be forgotten by
-- the fifth.
--
-- It only ever FILLS IN what the write left NULL. amend_fp_inspection carries
-- the previous row's rep_number forward on purpose — correcting a typo must not
-- move responsibility to whoever fixed it — and this must not override that.
CREATE OR REPLACE FUNCTION public.stamp_attribution()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_num text; v_name text;
BEGIN
  IF NEW.rep_number IS NULL THEN
    SELECT r.rep_number, r.rep_name INTO v_num, v_name FROM public.account_rep(NEW.account_id) r;
    NEW.rep_number := v_num;
    IF NEW.rep_name IS NULL THEN NEW.rep_name := v_name; END IF;

  ELSIF NEW.rep_name IS NULL THEN
    -- Carried forward from a superseded row: name the person who HELD that
    -- number, not whoever holds the lead role now.
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

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inspections_attribution    ON public.inspections;
CREATE TRIGGER inspections_attribution
  BEFORE INSERT ON public.inspections
  FOR EACH ROW EXECUTE FUNCTION public.stamp_attribution();

DROP TRIGGER IF EXISTS fp_inspections_attribution ON public.fp_inspections;
CREATE TRIGGER fp_inspections_attribution
  BEFORE INSERT ON public.fp_inspections
  FOR EACH ROW EXECUTE FUNCTION public.stamp_attribution();

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Existing rows already carry rep_number. Resolve the NAME that goes with it,
-- and the organisation. This is a reconstruction, not a recording: it says who
-- holds that number today. It is the best available answer for records written
-- before the name was stored, and it is applied once — the trigger keeps every
-- later row honest.
UPDATE public.inspections i
   SET rep_name = sub.name
  FROM (SELECT m.rep_number, coalesce(u.name, u.email) AS name
          FROM public.account_members m JOIN public.users u ON u.id = m.user_id
         WHERE m.rep_number IS NOT NULL) sub
 WHERE i.rep_name IS NULL AND i.rep_number IS NOT NULL AND i.rep_number = sub.rep_number;

UPDATE public.fp_inspections i
   SET rep_name = sub.name
  FROM (SELECT m.rep_number, coalesce(u.name, u.email) AS name
          FROM public.account_members m JOIN public.users u ON u.id = m.user_id
         WHERE m.rep_number IS NOT NULL) sub
 WHERE i.rep_name IS NULL AND i.rep_number IS NOT NULL AND i.rep_number = sub.rep_number;

UPDATE public.inspections i SET verified_by = public.account_verifier(i.account_id)
 WHERE i.verified_by IS NULL AND i.account_id IS NOT NULL;

UPDATE public.fp_inspections i SET verified_by = public.account_verifier(i.account_id)
 WHERE i.verified_by IS NULL AND i.account_id IS NOT NULL;

-- ── The public ladder certificate ───────────────────────────────────────────
-- Recreated in full; a view's column list cannot be extended in place.
-- tech_name now carries the RESPONSIBLE LEAD, not the collector. collected_by
-- and collector_name remain unexposed, as before.
DROP VIEW IF EXISTS public.ladder_inspections_public;
CREATE VIEW public.ladder_inspections_public AS
  SELECT
    coalesce(a.serial_raw, i.serial_num) AS serial_num,
    a.serial_key,
    i.inspection_date,
    -- The lead responsible. Falls back to the stored collector name ONLY for
    -- rows written before this migration that carry no rep at all, so an old
    -- certificate does not lose its technician field entirely.
    coalesce(i.rep_name, i.tech_name)    AS tech_name,
    i.rep_name,
    i.rep_number,
    i.verified_by,
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
    public.certificate_url(a.public_ref, a.kind) AS certificate_url
  FROM public.inspections i
  LEFT JOIN public.assets a ON a.id = i.asset_id
  WHERE i.is_current AND NOT i.is_deleted
  ORDER BY i.serial_num, i.inspection_date DESC;

GRANT SELECT ON public.ladder_inspections_public TO anon;
GRANT SELECT ON public.ladder_inspections_public TO authenticated;

-- ── The public fall-protection certificate ──────────────────────────────────
DROP VIEW IF EXISTS public.fall_protection_public;
CREATE VIEW public.fall_protection_public AS
  SELECT
    a.serial_raw    AS serial_num,
    a.serial_key,
    a.public_ref,
    a.tag_url,
    a.tag_label,
    a.tag_label_key,
    i.inspection_date,
    i.next_due_date,
    coalesce(i.rep_name, i.collector_name) AS tech_name,
    i.rep_name,
    i.rep_number,
    i.verified_by,
    i.manufacturer,
    i.model,
    i.item_type,
    i.description,
    i.lot_number,
    i.mfg_month,
    i.mfg_year,
    i.status,
    i.overall_pass,
    i.discard_reason,
    i.work_order_id,
    i.created_at,
    public.certificate_url(a.public_ref, 'fall_protection') AS certificate_url,
    public.fp_tag_url(a.public_ref, a.serial_raw)           AS tag_write_url
  FROM public.assets a
  JOIN public.fp_inspections i ON i.asset_id = a.id AND i.is_current AND NOT i.is_deleted
  WHERE a.kind = 'fall_protection';

GRANT SELECT ON public.fall_protection_public TO anon;
GRANT SELECT ON public.fall_protection_public TO authenticated;
