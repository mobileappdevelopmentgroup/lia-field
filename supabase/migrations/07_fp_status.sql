-- ═══════════════════════════════════════════════════════════════════
-- Lia Fall Protection Status — safe to re-run; idempotent
--
-- Run AFTER 06_fall_protection.sql.
--
-- The recorded statuses are: pass, fail, inspection overdue.
--
-- Two of those are facts, one is a consequence of the calendar. An item
-- recorded as 'pass' becomes overdue on its own, with nobody editing it — so a
-- stored 'inspection overdue' is a snapshot that is wrong the moment the date
-- moves past it. It is still accepted (a tech may genuinely find an item that
-- was already out of date), but what the certificate shows is DERIVED:
--
--   fail                → the item failed; never expires into anything else
--   next_due_date < now → inspection overdue, whatever was recorded
--   otherwise           → pass
--
-- So the recorded value is what the tech asserted, and effective_status is what
-- is true today.
-- ═══════════════════════════════════════════════════════════════════

-- Normalize anything already stored before pinning the constraint down.
UPDATE public.fp_inspections
   SET status = lower(trim(status))
 WHERE status IS NOT NULL AND status <> lower(trim(status));

UPDATE public.fp_inspections
   SET status = 'inspection overdue'
 WHERE status IN ('overdue', 'inspection_overdue', 'expired');

-- Anything that still does not match is cleared rather than guessed at, and
-- reported so it can be looked at.
DO $$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM public.fp_inspections
   WHERE status IS NOT NULL AND status NOT IN ('pass', 'fail', 'inspection overdue');
  IF v_bad > 0 THEN
    RAISE NOTICE 'fp_inspections rows with an unrecognized status: % — cleared to NULL', v_bad;
    UPDATE public.fp_inspections SET status = NULL
     WHERE status IS NOT NULL AND status NOT IN ('pass', 'fail', 'inspection overdue');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fp_status_allowed') THEN
    ALTER TABLE public.fp_inspections ADD CONSTRAINT fp_status_allowed
      CHECK (status IS NULL OR status IN ('pass', 'fail', 'inspection overdue'));
  END IF;
END $$;

-- What is true today, as opposed to what was recorded on the day.
CREATE OR REPLACE FUNCTION public.fp_effective_status(
  p_overall_pass boolean,
  p_next_due     date,
  p_recorded     text DEFAULT NULL
)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    -- A failed item is failed for good. It does not become merely "overdue"
    -- once its due date passes.
    WHEN p_overall_pass IS false OR p_recorded = 'fail' THEN 'fail'
    WHEN p_next_due IS NOT NULL AND p_next_due < current_date THEN 'inspection overdue'
    ELSE 'pass'
  END;
$$;

-- ── Public view gains the derived status ─────────────────────────────────────
DROP VIEW IF EXISTS public.fall_protection_public;
CREATE VIEW public.fall_protection_public AS
  SELECT
    coalesce(a.serial_raw, '')                              AS serial_num,
    a.serial_key,
    a.public_ref,
    public.certificate_url(a.public_ref, 'fall_protection') AS certificate_url,
    i.inspection_date,
    i.next_due_date,
    i.item_type,
    i.description,
    i.manufacturer,
    i.model,
    i.lot_number,
    i.mfg_month,
    i.mfg_year,
    i.status,                                                -- what was recorded
    public.fp_effective_status(i.overall_pass, i.next_due_date, i.status)
                                                            AS effective_status,
    i.rep_number,
    i.overall_pass,
    i.version,
    i.created_at
  FROM public.fp_inspections i
  JOIN public.assets a ON a.id = i.asset_id
  WHERE i.is_current AND NOT i.is_deleted
  ORDER BY a.serial_key, i.inspection_date DESC;

GRANT SELECT ON public.fall_protection_public TO anon;
GRANT SELECT ON public.fall_protection_public TO authenticated;
