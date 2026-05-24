-- ═══════════════════════════════════════════════════════════════════
-- Lia Ladder Inspections — safe to re-run; all statements are idempotent
-- ═══════════════════════════════════════════════════════════════════

-- ── Table ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inspections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_num      text NOT NULL,
  inspection_date date NOT NULL,
  tech_name       text NOT NULL,
  work_order_id   text,
  next_due_date   date,
  notes           text,
  brand           text,
  type            text,
  length          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Add any columns that may be missing from an earlier schema version
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS work_order_id   text;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS next_due_date   date;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS notes           text;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS brand           text;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS type            text;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS length          text;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS created_at      timestamptz NOT NULL DEFAULT now();

-- ── Unique constraint for upsert (serial + date = one record per inspection) ──
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspections_serial_date_uq'
  ) THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_serial_date_uq UNIQUE (serial_num, inspection_date);
  END IF;
END $$;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS inspections_serial_idx    ON public.inspections(serial_num);
CREATE INDEX IF NOT EXISTS inspections_date_idx      ON public.inspections(inspection_date DESC);
CREATE INDEX IF NOT EXISTS inspections_work_order_idx ON public.inspections(work_order_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.inspections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inspections_select_all"  ON public.inspections;
CREATE POLICY "inspections_select_all" ON public.inspections
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "inspections_insert_auth" ON public.inspections;
CREATE POLICY "inspections_insert_auth" ON public.inspections
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "inspections_update_auth" ON public.inspections;
CREATE POLICY "inspections_update_auth" ON public.inspections
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Grant anon SELECT so the public S3 site can query without login
GRANT SELECT                ON public.inspections TO anon;
GRANT SELECT, INSERT, UPDATE ON public.inspections TO authenticated;

-- ── Public view for the S3 inspection website ─────────────────────────────────
DROP VIEW IF EXISTS public.ladder_inspections_public;
CREATE VIEW public.ladder_inspections_public AS
  SELECT
    serial_num,
    inspection_date,
    tech_name,
    next_due_date,
    work_order_id,
    notes,
    brand,
    type,
    length,
    created_at
  FROM public.inspections
  ORDER BY serial_num, inspection_date DESC;

GRANT SELECT ON public.ladder_inspections_public TO anon;
GRANT SELECT ON public.ladder_inspections_public TO authenticated;
