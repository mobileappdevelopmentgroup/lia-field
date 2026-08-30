-- ═══════════════════════════════════════════════════════════════════════════
-- 15 — Managing fall-protection records from the office
--
-- Run after 14_certificate_views.sql. Idempotent, like every file here.
--
-- Until now a fall-protection record could only be created, from a phone. If a
-- tech typed a serial wrong, picked the wrong equipment type, or recorded an
-- item that was never inspected, there was no way to fix it: the certificate
-- said what it said.
--
-- ── The rule these functions are built around ───────────────────────────────
-- A certificate is a safety document. It says a harness was inspected on a date
-- and passed. So nothing here DESTROYS one:
--
--   correcting  supersedes. The old row stays, marked not-current, and the new
--               one points back at it. The history of what the record used to
--               say is itself part of the record.
--   deleting    marks is_deleted and requires a reason. The row remains, and
--               remains auditable.
--
-- An UPDATE that silently rewrote what a certificate says, with no trace, is
-- exactly the capability an inspection record must not have — it would make
-- every certificate unfalsifiable after the fact.
--
-- Every correction is written to fp_record_audit with who, when and why.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fp_record_audit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  asset_id     uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  inspection_id uuid,
  action       text NOT NULL CHECK (action IN ('amend', 'delete', 'restore', 'asset_edit')),
  reason       text NOT NULL,
  -- The row as it stood before. Enough to reconstruct what the certificate said
  -- if anybody ever asks why it changed.
  before       jsonb,
  after        jsonb,
  actor_id     uuid REFERENCES auth.users(id),
  actor_name   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fp_record_audit_asset_idx ON public.fp_record_audit(asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fp_record_audit_account_idx ON public.fp_record_audit(account_id, created_at DESC);

ALTER TABLE public.fp_record_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fp_record_audit_read" ON public.fp_record_audit;
CREATE POLICY "fp_record_audit_read" ON public.fp_record_audit
  FOR SELECT TO authenticated USING (account_id = public.my_account_id());
REVOKE ALL ON public.fp_record_audit FROM anon, authenticated;
GRANT SELECT ON public.fp_record_audit TO authenticated;

-- Only a lead corrects a safety record. A tech records what he inspected; going
-- back and changing what a certificate says is a different act.
-- require_lead() is defined in 09_fp_authoring.sql and is NOT redefined here.
--
-- An earlier draft of this file re-created it, which was a mistake worth
-- recording: the signature matched, so CREATE OR REPLACE succeeded silently and
-- quietly replaced 09's version on every already-migrated database. 09's
-- distinguishes "you have no account at all" from "you are not the lead"; the
-- replacement collapsed both into one message, so a user with no membership was
-- told to ask for a promotion he did not need.
--
-- The general rule: a later migration must not CREATE OR REPLACE a function an
-- earlier one owns unless it is deliberately changing it, because the failure
-- is invisible — no error, no notice, just different behaviour afterwards.

-- ── Browsing ────────────────────────────────────────────────────────────────
-- One page of the account's fall-protection items with their current state.
-- Search matches a serial, a tag, a certificate code, a model or a manufacturer,
-- because the office does not know in advance which of those it is holding.
CREATE OR REPLACE FUNCTION public.fp_records(
  p_search text    DEFAULT NULL,
  p_status text    DEFAULT NULL,          -- pass | fail | 'inspection overdue' | due_soon
  p_limit  integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_account uuid := public.my_account_id();
  v_q       text := nullif(btrim(coalesce(p_search, '')), '');
  v_key     text := public.serial_key(coalesce(p_search, ''));
  v_out     json;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT json_build_object(
    'total', (SELECT count(*) FROM public.assets a
               WHERE a.account_id = v_account AND a.kind = 'fall_protection'),
    'rows', coalesce(json_agg(r), '[]'::json)
  ) INTO v_out
  FROM (
    SELECT a.id AS asset_id, a.serial_raw, a.serial_key, a.public_ref,
           a.nfc_tag_uid, a.tag_url,
           i.id AS inspection_id, i.inspection_date, i.next_due_date,
           i.item_type, i.manufacturer, i.model, i.lot_number,
           i.mfg_month, i.mfg_year, i.description,
           i.overall_pass, i.status, i.discard_reason,
           public.fp_effective_status(i.overall_pass, i.next_due_date, i.status) AS effective_status,
           i.collector_name, i.rep_number, i.work_order_id, i.source, i.version,
           (SELECT count(*) FROM public.fp_inspections h
             WHERE h.asset_id = a.id AND NOT h.is_deleted) AS history_count
      FROM public.assets a
      LEFT JOIN LATERAL (
        SELECT * FROM public.fp_inspections f
         WHERE f.asset_id = a.id AND f.is_current AND NOT f.is_deleted
         ORDER BY f.inspection_date DESC LIMIT 1
      ) i ON true
     WHERE a.account_id = v_account
       AND a.kind = 'fall_protection'
       AND (v_q IS NULL
            OR a.serial_key LIKE '%' || v_key || '%'
            OR upper(coalesce(a.public_ref, '')) = upper(v_q)
            OR upper(coalesce(a.nfc_tag_uid, '')) LIKE '%' || upper(v_q) || '%'
            OR coalesce(i.manufacturer, '') ILIKE '%' || v_q || '%'
            OR coalesce(i.model, '') ILIKE '%' || v_q || '%'
            OR coalesce(i.item_type, '') ILIKE '%' || v_q || '%')
       AND (p_status IS NULL
            OR (p_status = 'due_soon'
                AND i.next_due_date IS NOT NULL
                AND i.next_due_date BETWEEN current_date AND current_date + 60)
            OR public.fp_effective_status(i.overall_pass, i.next_due_date, i.status) = p_status)
     ORDER BY coalesce(i.inspection_date, '1900-01-01') DESC, a.serial_key
     LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
     OFFSET greatest(0, coalesce(p_offset, 0))
  ) r;

  RETURN v_out;
END;
$$;

-- Everything known about one item: identity, every inspection including
-- superseded and deleted ones, what tag links have claimed about it, and who
-- has corrected it.
CREATE OR REPLACE FUNCTION public.fp_record_detail(p_asset_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE v_account uuid := public.my_account_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.assets
                  WHERE id = p_asset_id AND account_id = v_account) THEN
    RAISE EXCEPTION 'No such item';
  END IF;

  RETURN json_build_object(
    'asset', (SELECT row_to_json(a) FROM (
        SELECT id, serial_raw, serial_key, public_ref, nfc_tag_uid, tag_url, created_at
          FROM public.assets WHERE id = p_asset_id) a),
    -- Superseded and deleted rows are INCLUDED. The history of what a record
    -- used to say is part of the record; hiding it would defeat the point of
    -- never destroying one.
    'history', (SELECT coalesce(json_agg(h ORDER BY h.inspection_date DESC, h.version DESC), '[]'::json)
      FROM (
        SELECT i.id, i.inspection_date, i.next_due_date, i.item_type, i.manufacturer,
               i.model, i.lot_number, i.mfg_month, i.mfg_year, i.description,
               i.overall_pass, i.status, i.discard_reason, i.discard_note,
               i.collector_name, i.rep_number, i.work_order_id, i.source,
               i.version, i.is_current, i.is_deleted, i.supersedes,
               i.tag_url, i.created_at,
               (SELECT coalesce(json_agg(json_build_object(
                         'ord', c.ord, 'prompt', c.prompt, 'answer', c.answer,
                         'answer_style', c.answer_style, 'result', c.result)
                       ORDER BY c.ord), '[]'::json)
                  FROM public.fp_inspection_checks c WHERE c.fp_inspection_id = i.id) AS checks
          FROM public.fp_inspections i
         WHERE i.asset_id = p_asset_id
      ) h),
    'claims', (SELECT coalesce(json_agg(x ORDER BY x.created_at DESC), '[]'::json)
      FROM (SELECT source_url, fetched_at, claimed_inspection_date, claimed_pass,
                   claimed_result_text, claimed, created_at
              FROM public.fp_external_records WHERE asset_id = p_asset_id) x),
    'audit', (SELECT coalesce(json_agg(x ORDER BY x.created_at DESC), '[]'::json)
      FROM (SELECT action, reason, actor_name, created_at
              FROM public.fp_record_audit WHERE asset_id = p_asset_id) x)
  );
END;
$$;

-- ── Correcting an inspection ────────────────────────────────────────────────
-- Supersedes rather than updates. The old row stays exactly as it was, marked
-- not-current; the new one carries the corrected values and points back at it.
CREATE OR REPLACE FUNCTION public.amend_fp_inspection(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.require_lead();
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

-- ── Deleting a mistaken record ──────────────────────────────────────────────
-- Marks it, keeps it. An inspection that never happened must stop appearing on
-- a certificate; it must not stop existing.
CREATE OR REPLACE FUNCTION public.delete_fp_inspection(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.require_lead();
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

-- Undo. A record deleted by mistake is itself a mistake worth being able to fix.
CREATE OR REPLACE FUNCTION public.restore_fp_inspection(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.require_lead();
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

-- ── Correcting the item's identity ──────────────────────────────────────────
-- A serial typed wrong on the very first inspection follows the item forever.
-- Changing it rewrites how every certificate for that item is addressed, which
-- is why it is a lead's call and is audited like any other correction.
CREATE OR REPLACE FUNCTION public.update_fp_asset(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.require_lead();
  v_id      uuid := nullif(p->>'asset_id','')::uuid;
  v_reason  text := nullif(btrim(coalesce(p->>'reason','')), '');
  v_serial  text := nullif(btrim(coalesce(p->>'serial_raw','')), '');
  v_before  public.assets%ROWTYPE;
  v_who     text;
BEGIN
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Say why this item is being changed'; END IF;

  SELECT * INTO v_before FROM public.assets
   WHERE id = v_id AND account_id = v_account AND kind = 'fall_protection' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such item'; END IF;

  IF v_serial IS NOT NULL AND public.serial_key(v_serial) <> v_before.serial_key
     AND EXISTS (SELECT 1 FROM public.assets
                  WHERE account_id = v_account AND kind = 'fall_protection'
                    AND serial_key = public.serial_key(v_serial)) THEN
    RAISE EXCEPTION 'Another item already has serial %', v_serial;
  END IF;

  SELECT coalesce(u.name, u.email) INTO v_who FROM public.users u WHERE u.id = auth.uid();

  UPDATE public.assets SET
    serial_raw  = coalesce(v_serial, serial_raw),
    serial_key  = CASE WHEN v_serial IS NULL THEN serial_key ELSE public.serial_key(v_serial) END,
    nfc_tag_uid = coalesce(nullif(p->>'nfc_tag_uid',''), nfc_tag_uid),
    tag_url     = coalesce(nullif(p->>'tag_url',''), tag_url),
    updated_at  = clock_timestamp()
  WHERE id = v_id;

  -- public_ref is deliberately NOT changeable. It is printed on tags already in
  -- the field; changing it would make every one of them point at nothing.

  INSERT INTO public.fp_record_audit
    (account_id, asset_id, action, reason, before, after, actor_id, actor_name)
  VALUES (v_account, v_id, 'asset_edit', v_reason,
          row_to_json(v_before)::jsonb,
          (SELECT row_to_json(a)::jsonb FROM public.assets a WHERE a.id = v_id),
          auth.uid(), v_who);

  RETURN (SELECT row_to_json(a) FROM public.assets a WHERE a.id = v_id);
END;
$$;

-- ── What still has to reach BSI ─────────────────────────────────────────────
-- The office bills through BSI, so an inspection that never got there is
-- unbilled work. Marked per inspection rather than per work order because a
-- run can partly succeed — the web app is flaky, which is the whole reason the
-- ladder importer has retries and verification passes.
ALTER TABLE public.fp_inspections ADD COLUMN IF NOT EXISTS bsi_pushed_at timestamptz;
ALTER TABLE public.fp_inspections ADD COLUMN IF NOT EXISTS bsi_box_ref   text;

CREATE OR REPLACE FUNCTION public.fp_pending_bsi(p_work_order text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE v_account uuid := public.my_account_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN (
    SELECT coalesce(json_agg(x ORDER BY x.work_order_id, x.serial_num), '[]'::json)
    FROM (
      SELECT i.id AS inspection_id, i.work_order_id,
             a.serial_raw AS serial_num, i.item_type, i.manufacturer, i.model,
             i.inspection_date, i.overall_pass, i.discard_reason
        FROM public.fp_inspections i
        JOIN public.assets a ON a.id = i.asset_id
       WHERE i.account_id = v_account
         AND i.is_current AND NOT i.is_deleted
         AND i.bsi_pushed_at IS NULL
         AND i.work_order_id IS NOT NULL
         AND (p_work_order IS NULL OR i.work_order_id = p_work_order)
    ) x);
END;
$$;

-- Called by the importer once a box has actually landed on the work order.
-- Takes the box reference so a later run can tell what it already did.
CREATE OR REPLACE FUNCTION public.mark_fp_bsi_pushed(p jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.my_account_id();
  v_n       integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  WITH upd AS (
    UPDATE public.fp_inspections i
       SET bsi_pushed_at = now(),
           bsi_box_ref = coalesce(e->>'box_ref', i.bsi_box_ref),
           updated_at = now()
      FROM jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) e
     WHERE i.id = (e->>'inspection_id')::uuid
       AND i.account_id = v_account
    RETURNING 1)
  SELECT count(*) INTO v_n FROM upd;
  RETURN v_n;
END;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.fp_records(text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_record_detail(uuid)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.amend_fp_inspection(jsonb)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_fp_inspection(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_fp_inspection(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_fp_asset(jsonb)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_pending_bsi(text)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_fp_bsi_pushed(jsonb)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.require_lead()              FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fp_records(text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_record_detail(uuid)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.amend_fp_inspection(jsonb)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_fp_inspection(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_fp_inspection(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_fp_asset(jsonb)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_pending_bsi(text)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_fp_bsi_pushed(jsonb)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.require_lead()              TO authenticated;
