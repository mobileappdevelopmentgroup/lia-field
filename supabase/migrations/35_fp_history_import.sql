-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — importing fall-protection history from the office.
-- Idempotent; safe to re-run. Run AFTER 34_vehicle_inventory.sql.
--
-- Until now the only way past records got in was a one-off SQL import (Nate's
-- Google Sheets, 2026-09-28). The office's CSV import only knew ladders. This
-- is the write path for a spreadsheet of past fall-protection inspections, so
-- that the phones recognise those items the first time a tech taps or types
-- them — rather than only once each has been inspected again with the app.
--
-- Rules, all load-bearing:
--
--   * THE SERIAL IS THE ASSIGNED NUMBER. Batavia identifies equipment by the
--     number it assigns, not the manufacturer's (decided 2026-10-14). The
--     manufacturer's serial, when the file has one, is kept beside it in
--     fp_inspections.mfr_serial and never used to match.
--
--   * HISTORY NEVER OVERWRITES FIELD WORK. A row whose item already has a
--     record on that date is skipped and reported, not superseded. record_fp_
--     inspection versions on (item, date); an import re-run, or a spreadsheet
--     that overlaps what the phones already sent, must not push a tech's
--     signed-off inspection into history behind a line from a spreadsheet.
--
--   * NOT ATTRIBUTED TO WHOEVER CLICKS IMPORT. collected_by and tech_user_id
--     are left empty; collector_name is the inspector the file names, else
--     "Imported history". The certificate names the lead and the umbrella, as
--     every certificate does (19) — the attribution trigger stamps them.
--
--   * NO CHECKLIST IS INVENTED. A spreadsheet says pass or fail; it does not
--     say which of a type's nine checks were looked at. Nothing is pinned and
--     no check rows are written — a certificate showing nine ticked checks
--     nobody recorded would be worse than one showing none. A failed row
--     carries the file's reason, or "Failed (imported history)".
--
--   * NO DUE DATE IN THE FILE. The office does not keep one; it is the
--     inspection date + 1 year, the rule every other write path uses, so an
--     imported item comes up due (or overdue) on the phone like any other.
--
--   * ONE BATCH, ONE UNDO. Every row carries source = 'import:history:<batch>' and
--     undo_fp_history_import(batch) removes the batch — refusing outright if
--     anything has been recorded against one of its items since, because at
--     that point it is no longer a clean undo.
--
-- Lead only, and it follows impersonation (require_lead_account), so the
-- office imports a subcontractor's history while acting as them. The phone's
-- catalogue (account_snapshot) is per account: history imported into the
-- wrong account is invisible to the phones that need it.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.fp_inspections ADD COLUMN IF NOT EXISTS mfr_serial text;

COMMENT ON COLUMN public.fp_inspections.mfr_serial IS
  'The manufacturer''s serial, when it is not the number the item is known by. '
  'Kept for reference; never used to find an item.';

CREATE INDEX IF NOT EXISTS fp_inspections_source_idx
  ON public.fp_inspections (account_id, source) WHERE source LIKE 'import:%';

-- ── The import ──────────────────────────────────────────────────────────────
-- p = { "batch": "<label>", "rows": [ { serial, inspection_date, result, ... } ] }
-- Returns { batch, imported, skipped: [ { row, serial, reason } ] }.
-- Rows are independent: a bad row is reported and the rest still land.
CREATE OR REPLACE FUNCTION public.import_fp_history(p jsonb)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_account  uuid := public.require_lead_account();
  v_batch    text := nullif(btrim(coalesce(p->>'batch', '')), '');
  v_src      text;
  r          jsonb;
  v_n        integer := 0;
  v_row      integer;
  v_ok       integer := 0;
  v_skipped  jsonb := '[]'::jsonb;
  v_serial   text;
  v_date     date;
  v_res      text;
  v_pass     boolean;
  v_type_id  uuid;
  v_type_nm  text;
  v_mfr      text;
  v_model    text;
  v_model_id uuid;
  v_asset    uuid;
  v_label    text;
  v_mm       integer;
  v_yy       integer;
  v_insp     text;
BEGIN
  IF v_batch IS NULL THEN RAISE EXCEPTION 'Name this import (batch)'; END IF;
  IF length(v_batch) > 80 OR v_batch !~ '^[A-Za-z0-9 ._:-]+$' THEN
    RAISE EXCEPTION 'A batch name is letters, digits, spaces and . _ : - only, up to 80';
  END IF;
  IF jsonb_typeof(p->'rows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'No rows'; END IF;
  IF jsonb_array_length(p->'rows') > 2000 THEN
    RAISE EXCEPTION 'At most 2000 rows at a time — send the file in parts';
  END IF;
  -- Its own prefix: undo and the batch list reach only what this function
  -- wrote, never 'import:nate-google-sheets-2026-09-28' or a later hand import.
  v_src := 'import:history:' || v_batch;

  FOR r IN SELECT * FROM jsonb_array_elements(p->'rows') LOOP
    v_n := v_n + 1;
    v_row := coalesce(nullif(r->>'row', '')::integer, v_n);
    v_serial := nullif(btrim(coalesce(r->>'serial', '')), '');

    BEGIN
      IF v_serial IS NULL OR public.serial_key(v_serial) = '' THEN
        RAISE EXCEPTION 'No serial';
      END IF;
      IF length(v_serial) > 64 THEN RAISE EXCEPTION 'Serial is longer than 64 characters'; END IF;

      -- ISO only. 01/02/2025 is the 2nd of January to Postgres and the 1st of
      -- February to half the spreadsheets it came from; the office converts a
      -- date only when the file's format leaves no doubt.
      IF coalesce(r->>'inspection_date', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'Inspection date "%" is not YYYY-MM-DD', coalesce(r->>'inspection_date', '');
      END IF;
      BEGIN
        v_date := (r->>'inspection_date')::date;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'Inspection date "%" is not a date', r->>'inspection_date';
      END;
      IF v_date IS NULL THEN RAISE EXCEPTION 'No inspection date'; END IF;
      IF v_date > current_date THEN RAISE EXCEPTION 'Inspection date % is in the future', v_date; END IF;
      IF v_date < date '1990-01-01' THEN RAISE EXCEPTION 'Inspection date % is before 1990', v_date; END IF;

      v_res := lower(btrim(coalesce(r->>'result', '')));
      v_pass := CASE
        WHEN v_res IN ('pass', 'passed', 'p', 'yes', 'y', 'ok', 'true', 'in service') THEN true
        WHEN v_res IN ('fail', 'failed', 'f', 'no', 'n', 'false', 'removed', 'out of service',
                       'condemned', 'destroyed') THEN false
        ELSE NULL END;
      IF v_pass IS NULL THEN
        RAISE EXCEPTION 'Result "%" is not pass or fail', coalesce(r->>'result', '');
      END IF;

      v_type_id := NULL; v_type_nm := NULL;
      IF nullif(btrim(coalesce(r->>'equipment_type', '')), '') IS NOT NULL THEN
        -- A name Lia does not know does not cost the row its history: it is
        -- kept in the file's words with no type, and the phone asks the tech
        -- to pick one the first time the item is opened. The office preview
        -- lists these before anything is sent.
        v_type_id := public.fp_type_for(v_account, r->>'equipment_type');
        SELECT name INTO v_type_nm FROM public.fp_equipment_types WHERE id = v_type_id;
      END IF;

      v_mm := nullif(r->>'mfg_month', '')::integer;
      v_yy := nullif(r->>'mfg_year', '')::integer;
      IF v_mm IS NOT NULL AND (v_mm < 1 OR v_mm > 12) THEN RAISE EXCEPTION 'Manufacture month % is not 1–12', v_mm; END IF;
      IF v_yy IS NOT NULL AND (v_yy < 1900 OR v_yy > extract(year FROM current_date)::integer) THEN
        RAISE EXCEPTION 'Manufacture year % is not possible', v_yy;
      END IF;

      -- The item, by its assigned number.
      INSERT INTO public.assets (account_id, kind, serial_raw, serial_key)
      VALUES (v_account, 'fall_protection', v_serial, public.serial_key(v_serial))
      ON CONFLICT (account_id, kind, serial_key) DO NOTHING
      RETURNING id INTO v_asset;
      IF v_asset IS NULL THEN
        SELECT id INTO v_asset FROM public.assets
         WHERE account_id = v_account AND kind = 'fall_protection'
           AND serial_key = public.serial_key(v_serial);
      END IF;

      IF EXISTS (SELECT 1 FROM public.fp_inspections
                  WHERE asset_id = v_asset AND inspection_date = v_date AND NOT is_deleted) THEN
        RAISE EXCEPTION 'Already has a record on %', v_date;
      END IF;

      -- The printed tag number, if the file has one and the item has none.
      -- Uniqueness is the write path's job, not an index's (see 17).
      v_label := nullif(btrim(coalesce(r->>'tag_label', '')), '');
      IF v_label IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.assets a
                    WHERE a.account_id = v_account AND a.id <> v_asset
                      AND a.tag_label_key = public.serial_key(v_label)) THEN
          RAISE EXCEPTION 'Tag % is already on another item', v_label;
        END IF;
        UPDATE public.assets SET tag_label = v_label, updated_at = clock_timestamp()
         WHERE id = v_asset AND coalesce(tag_label, '') = '';
      END IF;

      v_mfr   := nullif(btrim(coalesce(r->>'manufacturer', '')), '');
      v_model := nullif(btrim(coalesce(r->>'model', '')), '');
      v_model_id := NULL;
      IF v_mfr IS NOT NULL AND v_model IS NOT NULL THEN
        INSERT INTO public.fp_models (account_id, manufacturer, model, item_type, created_by)
        VALUES (v_account, v_mfr, v_model, v_type_nm, auth.uid())
        ON CONFLICT (coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
                     lower(manufacturer), lower(model)) DO NOTHING;
        SELECT id INTO v_model_id FROM public.fp_models
         WHERE account_id = v_account AND lower(manufacturer) = lower(v_mfr) AND lower(model) = lower(v_model);
      END IF;

      v_insp := nullif(btrim(coalesce(r->>'inspector', '')), '');

      INSERT INTO public.fp_inspections (
        account_id, asset_id, work_order_id, inspection_date, next_due_date,
        tech_user_id, collected_by, collector_name, model_id, equipment_type_id,
        item_type, description, manufacturer, model, mfr_serial, lot_number,
        mfg_month, mfg_year, status, template_id, template_version,
        overall_pass, discard_reason, discard_note,
        version, is_current, source, captured_at
      ) VALUES (
        v_account, v_asset, left(nullif(btrim(coalesce(r->>'work_order_id', '')), ''), 64),
        v_date, v_date + interval '1 year',
        NULL, NULL, left(coalesce(v_insp, 'Imported history'), 120), v_model_id, v_type_id,
        coalesce(v_type_nm, nullif(btrim(coalesce(r->>'equipment_type', '')), '')),
        left(nullif(btrim(coalesce(r->>'description', '')), ''), 500),
        v_mfr, v_model, left(nullif(btrim(coalesce(r->>'mfr_serial', '')), ''), 64),
        left(nullif(btrim(coalesce(r->>'lot_number', '')), ''), 64),
        v_mm, v_yy, public.fp_default_status(v_pass, NULL), NULL, NULL,
        v_pass,
        CASE WHEN v_pass THEN NULL
             ELSE 'Failed: ' || coalesce(left(nullif(btrim(coalesce(r->>'reason', '')), ''), 500),
                                         '(imported history — no reason recorded)') END,
        left(nullif(btrim(coalesce(r->>'notes', '')), ''), 1000),
        1, true, v_src, NULL
      );
      v_ok := v_ok + 1;
    EXCEPTION WHEN others THEN
      v_skipped := v_skipped || jsonb_build_object('row', v_row, 'serial', v_serial, 'reason', SQLERRM);
    END;
  END LOOP;

  RETURN json_build_object('batch', v_batch, 'imported', v_ok, 'skipped', v_skipped);
END;
$$;

REVOKE ALL ON FUNCTION public.import_fp_history(jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.import_fp_history(jsonb) TO authenticated;

-- ── Undo ────────────────────────────────────────────────────────────────────
-- Removes one batch. Refuses if any item it created or touched has a record
-- that is not from this batch dated on or after the imported one, or if an
-- imported record has since been corrected (a newer version) or billed to BSI.
-- Items the batch created and nothing else uses go too.
CREATE OR REPLACE FUNCTION public.undo_fp_history_import(p_batch text)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_src     text := 'import:history:' || btrim(coalesce(p_batch, ''));
  v_ids     uuid[];
  v_rows    integer;
  v_assets  integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.fp_inspections
                  WHERE account_id = v_account AND source = v_src) THEN
    RAISE EXCEPTION 'No import called "%" in this account', p_batch;
  END IF;

  IF EXISTS (SELECT 1 FROM public.fp_inspections i
              WHERE i.account_id = v_account AND i.source = v_src
                AND (i.bsi_pushed_at IS NOT NULL OR NOT i.is_current OR i.is_deleted
                     OR EXISTS (SELECT 1 FROM public.fp_inspections n WHERE n.supersedes = i.id))) THEN
    RAISE EXCEPTION 'Some of these records have been corrected or billed since — undo refused';
  END IF;

  SELECT array_agg(DISTINCT asset_id) INTO v_ids FROM public.fp_inspections
   WHERE account_id = v_account AND source = v_src;

  DELETE FROM public.fp_inspections WHERE account_id = v_account AND source = v_src;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- An item goes only if the import is all it ever was: no other record, no
  -- tag link, written tag or photo, nothing in another table pointing at it.
  DELETE FROM public.assets a
   WHERE a.id = ANY (v_ids)
     AND NOT EXISTS (SELECT 1 FROM public.fp_inspections i WHERE i.asset_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM public.inspections i WHERE i.asset_id = a.id)
     AND coalesce(a.tag_url, '') = '' AND coalesce(a.nfc_tag_uid, '') = ''
     AND NOT EXISTS (SELECT 1 FROM public.fp_tag_stock s WHERE s.asset_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM public.fp_external_records x WHERE x.asset_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM public.fp_tag_links l WHERE l.asset_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM public.fp_tag_writes w WHERE w.asset_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM public.fp_record_audit au WHERE au.asset_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM public.certificate_views v WHERE v.asset_id = a.id);
  GET DIAGNOSTICS v_assets = ROW_COUNT;

  RETURN json_build_object('batch', p_batch, 'records_removed', v_rows, 'items_removed', v_assets);
END;
$$;

REVOKE ALL ON FUNCTION public.undo_fp_history_import(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.undo_fp_history_import(text) TO authenticated;

-- ── What has been imported ──────────────────────────────────────────────────
-- For the office screen: one row per batch in the account being acted as.
CREATE OR REPLACE FUNCTION public.fp_history_imports()
RETURNS TABLE (batch text, records integer, first_date date, last_date date, imported_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT substr(i.source, 16), count(*)::integer, min(i.inspection_date), max(i.inspection_date),
         max(i.uploaded_at)
    FROM public.fp_inspections i
   WHERE i.account_id = public.require_lead_account()
     AND i.source LIKE 'import:history:%'
     AND NOT i.is_deleted
   GROUP BY i.source
   ORDER BY max(i.uploaded_at) DESC;
$$;

REVOKE ALL ON FUNCTION public.fp_history_imports() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fp_history_imports() TO authenticated;
