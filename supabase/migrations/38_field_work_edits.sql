-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — the office adds a ladder to a work order, and fall-protection
-- corrections follow an impersonation session. Idempotent; safe to re-run.
-- Run AFTER 37_fp_serial_pool_tags.sql.
--
-- Field Work (26) let the office correct, delete and restore what the field
-- sent in. Two things were still missing:
--
--   * ADDING. A tech radios in a ladder he never logged. The only write path
--     that could create one was record_inspection(), which is the phone's: it
--     takes `source` from the payload, demands no reason, writes no audit row,
--     and SILENTLY SUPERSEDES a same-day record for that serial. Used from the
--     office it would replace a tech's ladder with nothing on the trail saying
--     so. add_inspection_office() is the office's own door: a lead only, a
--     typed reason, an audit row, `source = 'office_add'` set here and never
--     by the client, and it REFUSES when the item already has a record that
--     day — that is a correction, and the screen sends the lead there.
--
--   * FALL PROTECTION UNDER IMPERSONATION. amend/delete/restore_fp_inspection
--     (15) resolve the account with require_lead(), which predates
--     impersonation and hands back the caller's OWN account. Field Work lists
--     the account being acted as, so correcting a subcontractor's harness from
--     Batavia found "No such inspection". The ladder versions moved to
--     require_lead_account() in 26; these are re-emitted verbatim with that one
--     line changed. require_lead_account() also refuses a removed lead, which
--     require_lead() did not.
--
-- There is deliberately NO office path for adding a fall-protection
-- inspection. An FP record is the tech's answers to a checklist on the day; an
-- office-created one would be a certificate for an inspection nobody did. Past
-- work goes in through the history import (35), which is marked as such.
--
-- Changes no existing row.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The ladder audit trail learns "add" ──────────────────────────────────
ALTER TABLE public.inspection_audit DROP CONSTRAINT IF EXISTS inspection_audit_action_check;
ALTER TABLE public.inspection_audit ADD CONSTRAINT inspection_audit_action_check
  CHECK (action IN ('amend','delete','restore','add'));

-- ── 2. Adding a ladder from the office ──────────────────────────────────────
-- Credited to whoever entered it — collected_by and collector_name are the
-- office user — because that is the truth about where the record came from.
-- The certificate still names the lead (19's trigger), as every record does.
CREATE OR REPLACE FUNCTION public.add_inspection_office(p jsonb) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_serial  text := btrim(coalesce(p->>'serial_num', ''));
  v_wo      text := nullif(btrim(coalesce(p->>'work_order_id', '')), '');
  v_reason  text := nullif(btrim(coalesce(p->>'reason', '')), '');
  v_date    date := coalesce(nullif(p->>'inspection_date', '')::date, current_date);
  v_asset   uuid;
  v_id      uuid;
  v_who     text;
  v_rep     text;
BEGIN
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Say why this record is being added'; END IF;
  IF v_serial = '' THEN RAISE EXCEPTION 'A serial number is required'; END IF;
  IF length(v_serial) > 64 THEN RAISE EXCEPTION 'That serial number is too long'; END IF;
  IF v_wo IS NULL THEN RAISE EXCEPTION 'A work order number is required'; END IF;
  IF length(v_wo) > 64 THEN RAISE EXCEPTION 'That work order number is too long'; END IF;
  IF p ? 'parts' AND jsonb_typeof(p->'parts') <> 'array' THEN
    RAISE EXCEPTION 'Parts must be a list';
  END IF;

  v_rep := public.account_rep_number(v_account);
  SELECT coalesce(u.name, u.email) INTO v_who FROM public.users u WHERE u.id = auth.uid();

  INSERT INTO public.assets (account_id, kind, serial_raw, serial_key)
  VALUES (v_account, 'ladder', v_serial, public.serial_key(v_serial))
  ON CONFLICT (account_id, kind, serial_key) DO NOTHING
  RETURNING id INTO v_asset;
  IF v_asset IS NULL THEN
    SELECT id INTO v_asset FROM public.assets
     WHERE account_id = v_account AND kind = 'ladder'
       AND serial_key = public.serial_key(v_serial);
  END IF;

  -- One record per item per day. If the field already has it, this is a
  -- correction; if it was deleted, it is a restore. Either way, not an add —
  -- adding would bury the field's version under an office one with no trail.
  IF EXISTS (SELECT 1 FROM public.inspections
              WHERE asset_id = v_asset AND inspection_date = v_date
                AND is_current AND NOT is_deleted) THEN
    RAISE EXCEPTION '% already has a record for %; correct that one instead', v_serial, v_date;
  END IF;
  IF EXISTS (SELECT 1 FROM public.inspections
              WHERE asset_id = v_asset AND inspection_date = v_date AND is_deleted) THEN
    RAISE EXCEPTION '% has a deleted record for %; restore that one instead', v_serial, v_date;
  END IF;

  INSERT INTO public.inspections (
    serial_num, inspection_date, tech_name, work_order_id, next_due_date, notes,
    brand, type, length, account_id, asset_id, tech_user_id,
    version, supersedes, is_current, source, captured_at,
    lubricated, has_leveler, has_claw, has_vrung,
    rep_number, collected_by, collector_name, parts
  ) VALUES (
    v_serial, v_date, coalesce(v_who, 'Lia Office'), v_wo,
    v_date + interval '1 year',
    nullif(p->>'notes', ''),
    nullif(btrim(coalesce(p->>'brand', '')), ''),
    nullif(btrim(coalesce(p->>'type', '')), ''),
    nullif(btrim(coalesce(p->>'length', '')), ''),
    v_account, v_asset, auth.uid(),
    1, NULL, true, 'office_add', now(),
    (p->>'lubricated')::boolean, (p->>'has_leveler')::boolean,
    (p->>'has_claw')::boolean,   (p->>'has_vrung')::boolean,
    v_rep, auth.uid(), v_who,
    coalesce(p->'parts', '[]'::jsonb)
  )
  RETURNING id INTO v_id;

  INSERT INTO public.inspection_audit
    (account_id, inspection_id, serial_num, action, reason, before, after, actor_id, actor_name)
  VALUES (v_account, v_id, v_serial, 'add', v_reason, NULL,
          (SELECT row_to_json(i)::jsonb FROM public.inspections i WHERE i.id = v_id),
          auth.uid(), v_who);

  RETURN (SELECT row_to_json(i) FROM public.inspections i WHERE i.id = v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.add_inspection_office(jsonb) FROM PUBLIC, anon;
GRANT  ALL ON FUNCTION public.add_inspection_office(jsonb) TO authenticated;

-- ── 3. Fall-protection corrections follow the account being acted as ───────
-- Verbatim from 15_fp_records.sql except `require_lead()` →
-- `require_lead_account()`.

CREATE OR REPLACE FUNCTION public.amend_fp_inspection(p jsonb) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_id      uuid := nullif(p->>'inspection_id','')::uuid;
  v_reason  text := nullif(btrim(coalesce(p->>'reason','')), '');
  v_prev    public.fp_inspections%ROWTYPE;
  v_new     uuid;
  v_who     text;
  v_type_id uuid;
  v_type_nm text;
BEGIN
  -- A correction with no reason is indistinguishable from tampering six months
  -- later. It is the one field that cannot be skipped.
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Say why this record is being corrected'; END IF;

  SELECT * INTO v_prev FROM public.fp_inspections
   WHERE id = v_id AND account_id = v_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such inspection'; END IF;
  IF v_prev.is_deleted THEN RAISE EXCEPTION 'That record was deleted; restore it before correcting it'; END IF;

  SELECT coalesce(u.name, u.email) INTO v_who FROM public.users u WHERE u.id = auth.uid();

  IF nullif(p->>'equipment_type','') IS NOT NULL THEN
    v_type_id := public.fp_type_for(v_account, p->>'equipment_type');
    SELECT name INTO v_type_nm FROM public.fp_equipment_types WHERE id = v_type_id;
  END IF;

  UPDATE public.fp_inspections SET is_current = false, updated_at = now() WHERE id = v_prev.id;

  INSERT INTO public.fp_inspections (
    account_id, asset_id, work_order_id, inspection_date, next_due_date,
    rep_number, tech_user_id, collected_by, collector_name,
    model_id, equipment_type_id, item_type, description, manufacturer, model,
    lot_number, mfg_month, mfg_year, status, nfc_tag_serial, tag_url,
    template_id, template_version, overall_pass, discard_reason, discard_note,
    version, supersedes, is_current, source, captured_at
  ) VALUES (
    v_account, v_prev.asset_id,
    coalesce(nullif(p->>'work_order_id',''), v_prev.work_order_id),
    coalesce((p->>'inspection_date')::date, v_prev.inspection_date),
    coalesce((p->>'next_due_date')::date, v_prev.next_due_date),
    v_prev.rep_number, v_prev.tech_user_id, v_prev.collected_by,
    -- Who COLLECTED it does not change because somebody corrected a typo. The
    -- corrector is recorded in the audit row, which is where they belong.
    v_prev.collector_name,
    v_prev.model_id, coalesce(v_type_id, v_prev.equipment_type_id),
    coalesce(v_type_nm, nullif(p->>'item_type',''), v_prev.item_type),
    coalesce(p->>'description', v_prev.description),
    coalesce(nullif(p->>'manufacturer',''), v_prev.manufacturer),
    coalesce(nullif(p->>'model',''), v_prev.model),
    coalesce(p->>'lot_number', v_prev.lot_number),
    coalesce((p->>'mfg_month')::integer, v_prev.mfg_month),
    coalesce((p->>'mfg_year')::integer, v_prev.mfg_year),
    v_prev.status, v_prev.nfc_tag_serial, v_prev.tag_url,
    v_prev.template_id, v_prev.template_version,
    v_prev.overall_pass, v_prev.discard_reason,
    coalesce(p->>'discard_note', v_prev.discard_note),
    v_prev.version + 1, v_prev.id, true,
    -- Recorded as a correction, so a certificate can never present an amended
    -- record as though a tech had answered the questions that way on the day.
    'office_amend',
    v_prev.captured_at
  )
  RETURNING id INTO v_new;

  -- The checks come across unchanged: this corrects the ITEM's details, not
  -- what the tech found. Changing an answer is re-inspecting, and that is a new
  -- inspection rather than an amendment.
  INSERT INTO public.fp_inspection_checks
    (fp_inspection_id, ord, code, prompt, answer, answer_style, pass_answer, result, source, note)
  SELECT v_new, ord, code, prompt, answer, answer_style, pass_answer, result, source, note
    FROM public.fp_inspection_checks WHERE fp_inspection_id = v_prev.id;

  INSERT INTO public.fp_record_audit
    (account_id, asset_id, inspection_id, action, reason, before, after, actor_id, actor_name)
  VALUES (v_account, v_prev.asset_id, v_new, 'amend', v_reason,
          row_to_json(v_prev)::jsonb,
          (SELECT row_to_json(i)::jsonb FROM public.fp_inspections i WHERE i.id = v_new),
          auth.uid(), v_who);

  RETURN (SELECT row_to_json(i) FROM public.fp_inspections i WHERE i.id = v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.amend_fp_inspection(jsonb) FROM PUBLIC, anon;
GRANT  ALL ON FUNCTION public.amend_fp_inspection(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_fp_inspection(p jsonb) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_id      uuid := nullif(p->>'inspection_id','')::uuid;
  v_reason  text := nullif(btrim(coalesce(p->>'reason','')), '');
  v_row     public.fp_inspections%ROWTYPE;
  v_who     text;
BEGIN
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Say why this record is being deleted'; END IF;

  SELECT * INTO v_row FROM public.fp_inspections
   WHERE id = v_id AND account_id = v_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such inspection'; END IF;

  SELECT coalesce(u.name, u.email) INTO v_who FROM public.users u WHERE u.id = auth.uid();

  UPDATE public.fp_inspections
     SET is_deleted = true, is_current = false, updated_at = now()
   WHERE id = v_id;

  -- `is_current` is per inspection DATE, not per item — the unique index is
  -- (asset_id, inspection_date). So deleting a record restores the previous
  -- VERSION of that same date, if there is one. Other dates are already current
  -- in their own right and must not be touched: promoting last year's record
  -- here would leave the item with two current rows for one date's worth of
  -- work and quietly change what every other query returns.
  UPDATE public.fp_inspections SET is_current = true, updated_at = now()
   WHERE id = (SELECT i.id FROM public.fp_inspections i
                WHERE i.asset_id = v_row.asset_id
                  AND i.inspection_date = v_row.inspection_date
                  AND NOT i.is_deleted AND i.id <> v_id
                ORDER BY i.version DESC LIMIT 1);

  INSERT INTO public.fp_record_audit
    (account_id, asset_id, inspection_id, action, reason, before, actor_id, actor_name)
  VALUES (v_account, v_row.asset_id, v_id, 'delete', v_reason,
          row_to_json(v_row)::jsonb, auth.uid(), v_who);

  RETURN json_build_object('deleted', v_id, 'asset_id', v_row.asset_id);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_fp_inspection(jsonb) FROM PUBLIC, anon;
GRANT  ALL ON FUNCTION public.delete_fp_inspection(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.restore_fp_inspection(p jsonb) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_id      uuid := nullif(p->>'inspection_id','')::uuid;
  v_row     public.fp_inspections%ROWTYPE;
  v_who     text;
BEGIN
  SELECT * INTO v_row FROM public.fp_inspections
   WHERE id = v_id AND account_id = v_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such inspection'; END IF;

  SELECT coalesce(u.name, u.email) INTO v_who FROM public.users u WHERE u.id = auth.uid();

  -- Only one current row per item and date — the partial unique index enforces
  -- it, so anything newer stands down first.
  UPDATE public.fp_inspections SET is_current = false, updated_at = now()
   WHERE asset_id = v_row.asset_id AND inspection_date = v_row.inspection_date
     AND is_current AND NOT is_deleted;

  UPDATE public.fp_inspections
     SET is_deleted = false, is_current = true, updated_at = now()
   WHERE id = v_id;

  INSERT INTO public.fp_record_audit
    (account_id, asset_id, inspection_id, action, reason, actor_id, actor_name)
  VALUES (v_account, v_row.asset_id, v_id, 'restore',
          coalesce(nullif(p->>'reason',''), 'Restored'), auth.uid(), v_who);

  RETURN json_build_object('restored', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.restore_fp_inspection(jsonb) FROM PUBLIC, anon;
GRANT  ALL ON FUNCTION public.restore_fp_inspection(jsonb) TO authenticated;
