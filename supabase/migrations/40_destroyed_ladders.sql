-- Lia — destroyed ladders on the certificate; safe to re-run, idempotent
--
-- Needs 01–39 (24 for inspections.parts).
--
-- ── Why ────────────────────────────────────────────────────────────────────
-- A ladder that is not worth repairing is marked "Do not fix / Destroy": the
-- tech books one of BSI's cut-and-destroy parts instead of repairs —
-- PMCD (cut and destroy), PMCD1–PMCD6 (the same, with the reason: UV-damaged
-- rails, ladder-rack damage, boom-truck damage, repair cost prohibitive,
-- misuse or abuse, no regular maintenance) or TRL-3 (destroy, remove ladder).
-- Real imports carry them (PMCD4 on ladder 1135318, June 2026). Until now the
-- certificate showed such a ladder as VALID for a year — a customer scanning
-- it was told a ladder that had been cut up was good to use.
--
-- ── What ───────────────────────────────────────────────────────────────────
-- Nothing new is captured: the phone already stores the parts it books
-- (inspections.parts, 24), and Lia Office sends them from 1.15.12. The
-- disposition is DERIVED from those parts, so it cannot disagree with what
-- was billed, and a correction that removes the destroy part un-destroys the
-- ladder. ladder_inspections_public gains, at the end (CREATE OR REPLACE
-- VIEW can only append, and keeps the grants):
--   destroyed       boolean  — the record books a destroy part
--   destroy_reason  text     — plain words for the customer
--   tag_label, tag_label_key — the number printed on the tag, so a customer
--                              can look a ladder up by what is on its tag
--
-- Records written before parts were stored (office imports before 1.15.12,
-- phone records before 24) say nothing about destruction and stay as they
-- were. The list of codes is field-app/js/parts-catalog.js's; the drift test
-- is field-app/test/destroy-codes.test.mjs.

-- The customer-facing reason for the first destroy part a record books, or
-- NULL. A specific reason (PMCD1–6) beats the generic PMCD. A part booked with
-- quantity 0 is not booked.
CREATE OR REPLACE FUNCTION public.ladder_destroy_reason(p_parts jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT d.reason
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_parts) = 'array' THEN p_parts ELSE '[]'::jsonb END)
           WITH ORDINALITY AS e(part, n)
    JOIN (VALUES
      ('PMCD',  'Cut and destroyed'),
      ('PMCD1', 'Cut and destroyed: UV-damaged rails'),
      ('PMCD2', 'Cut and destroyed: ladder-rack damage'),
      ('PMCD3', 'Cut and destroyed: boom-truck damage'),
      ('PMCD4', 'Cut and destroyed: repair cost prohibitive'),
      ('PMCD5', 'Cut and destroyed: misuse or abuse'),
      ('PMCD6', 'Cut and destroyed: no regular maintenance'),
      ('TRL3',  'Destroyed and removed')
    ) AS d(code, reason)
      ON d.code = public.serial_key(CASE jsonb_typeof(e.part)
                                      WHEN 'object' THEN coalesce(e.part->>'name', e.part->>'searchTerm', e.part->>'part')
                                      WHEN 'string' THEN e.part #>> '{}'
                                    END)
   WHERE NOT (jsonb_typeof(e.part) = 'object' AND coalesce(e.part->>'qty', '') ~ '^\s*0+\s*$')
   ORDER BY (d.code = 'PMCD'), e.n
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.ladder_destroy_reason(jsonb) IS
  'Why a ladder record is a destruction (BSI part PMCD, PMCD1–6 or TRL-3 booked), or NULL. Mirrors the DESTROY entries in field-app/js/parts-catalog.js.';

CREATE OR REPLACE VIEW public.ladder_inspections_public AS
  SELECT
    coalesce(a.serial_raw, i.serial_num) AS serial_num,
    a.serial_key,
    i.inspection_date,
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
    public.certificate_url(a.public_ref, a.kind) AS certificate_url,
    -- 40 — appended; everything above is 19's, unchanged.
    (public.ladder_destroy_reason(i.parts) IS NOT NULL) AS destroyed,
    public.ladder_destroy_reason(i.parts)               AS destroy_reason,
    a.tag_label,
    a.tag_label_key
  FROM public.inspections i
  LEFT JOIN public.assets a ON a.id = i.asset_id
  WHERE i.is_current AND NOT i.is_deleted
  ORDER BY i.serial_num, i.inspection_date DESC;

GRANT SELECT ON public.ladder_inspections_public TO anon;
GRANT SELECT ON public.ladder_inspections_public TO authenticated;

-- Called by the view on anon's behalf, so anon needs it; it reads only its
-- argument.
GRANT EXECUTE ON FUNCTION public.ladder_destroy_reason(jsonb) TO anon, authenticated;
