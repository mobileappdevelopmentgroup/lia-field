-- 2026-11-12 — the lanyard recorded with serial "Na"
--
-- Gemtor 261L6 lanyard, Nate's account, WO 99218, inspected 2026-10-28, failed
-- (labels). It has no manufacturer serial; the tech typed N/A. Its tag is
-- FP161350, and an item with no serial takes its tag number as the serial —
-- the rule used for the 101 such items in Nate's 2026-09-28 sheet import.
--
-- Does what update_fp_asset() does (that function needs a signed-in lead, and
-- the SQL editor has none): changes serial_raw/serial_key, never public_ref
-- (the tag's link carries it), and writes the same fp_record_audit row.
-- Refuses unless exactly the expected item is found and nothing else in the
-- account already has FP161350 as a serial. Safe to re-run: the second run
-- finds no "Na" item and stops.
--
-- Paste the whole file into Supabase → SQL editor and run.

BEGIN;

DO $$
DECLARE
  v_before public.assets%ROWTYPE;
  n int;
BEGIN
  SELECT count(*) INTO n FROM public.assets
   WHERE public_ref = 'QTT4B8W1S5' AND kind = 'fall_protection'
     AND serial_key = 'NA' AND tag_label_key = 'FP161350';
  IF n <> 1 THEN
    RAISE EXCEPTION 'Expected the one "Na" lanyard (QTT4B8W1S5), found % — nothing changed', n;
  END IF;

  SELECT * INTO v_before FROM public.assets WHERE public_ref = 'QTT4B8W1S5' FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.assets
              WHERE account_id = v_before.account_id AND kind = 'fall_protection'
                AND serial_key = 'FP161350' AND id <> v_before.id) THEN
    RAISE EXCEPTION 'Another item already has serial FP161350 — nothing changed';
  END IF;

  UPDATE public.assets
     SET serial_raw = 'FP161350', serial_key = public.serial_key('FP161350'),
         updated_at = clock_timestamp()
   WHERE id = v_before.id;

  INSERT INTO public.fp_record_audit
    (account_id, asset_id, action, reason, before, after, actor_id, actor_name)
  VALUES (v_before.account_id, v_before.id, 'asset_edit',
          'Serial was typed as "N/A" (no manufacturer serial); set to the tag number FP161350',
          row_to_json(v_before)::jsonb,
          (SELECT row_to_json(a)::jsonb FROM public.assets a WHERE a.id = v_before.id),
          NULL, 'Office (SQL, 2026-11-12)');
END $$;

-- What it is now. Expect one row: FP161350 / QTT4B8W1S5.
SELECT serial_num, public_ref, tag_label, inspection_date, status
  FROM public.fall_protection_public WHERE public_ref = 'QTT4B8W1S5';

COMMIT;
