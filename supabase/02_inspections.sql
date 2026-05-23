-- ═══════════════════════════════════════════════════════════════════
-- Lia Ladder Inspections — run after 01_licensing.sql
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.inspections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_num      text NOT NULL,
  inspection_date date NOT NULL,
  tech_name       text NOT NULL,
  work_order_id   text,
  next_due_date   date,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inspections_serial_idx ON public.inspections(serial_num);
CREATE INDEX IF NOT EXISTS inspections_date_idx   ON public.inspections(inspection_date DESC);

-- Enable RLS — authenticated users can read/insert; anon can only read
ALTER TABLE public.inspections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inspections_select_all" ON public.inspections
  FOR SELECT USING (true);

CREATE POLICY "inspections_insert_auth" ON public.inspections
  FOR INSERT TO authenticated WITH CHECK (true);

-- Grant anon SELECT so the public S3 website can query without login
GRANT SELECT ON public.inspections TO anon;
GRANT SELECT, INSERT ON public.inspections TO authenticated;

-- ── Public view for the S3 inspection report website ─────────────────────────
-- The website queries this view using the anon key (read-only, safe to expose).
CREATE OR REPLACE VIEW public.ladder_inspections_public AS
  SELECT
    serial_num,
    inspection_date,
    tech_name,
    next_due_date,
    work_order_id,
    notes,
    created_at
  FROM public.inspections
  ORDER BY serial_num, inspection_date DESC;

GRANT SELECT ON public.ladder_inspections_public TO anon;
GRANT SELECT ON public.ladder_inspections_public TO authenticated;
