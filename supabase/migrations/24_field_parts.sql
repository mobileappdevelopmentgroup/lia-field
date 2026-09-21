-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — parts on a field record; safe to re-run, idempotent
--
-- Run AFTER 23_crew_removal.sql.
--
-- A ladder captured on the phone carries the parts the tech tapped — that is
-- most of the value of capturing it — but `inspections` had nowhere to put
-- them, so they were dropped on upload and survived only in the CSV the tech
-- exported by hand.
--
-- That is what made "import the field's work into a work order" impossible in
-- the office: the records were there, and every one of them was a ladder with
-- no line items, which is a ladder nobody can bill for.
--
-- Shape: [{"name": "G13", "qty": 2}, …] — the same one the CSV encodes as
-- "(2) G13" and the same one the phone already holds.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS parts jsonb;

-- Re-emitted from 21 with one addition: parts are stored, and carried forward
-- when a record is superseded, like every other field.
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

  -- Follows the account being acted as; identical when not impersonating.
  v_account := public.my_account_id();
  IF v_account IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

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
    rep_number, collected_by, collector_name, parts
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
    v_rep, v_user_id, v_who,
    -- The parts a tech tapped on the phone. Without them a field record
    -- imports into BSI as a ladder with no line items, which is a ladder
    -- nobody can bill for.
    coalesce(p->'parts', v_prev.parts)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Merging a work order in the office reads this, so it has to come back with
-- the parts attached.
COMMENT ON COLUMN public.inspections.parts IS
  'Parts tapped in the field: [{"name","qty"}]. Fed into the BSI import.';
