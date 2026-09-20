-- ═══════════════════════════════════════════════════════════════════════════
-- Lia Impersonation — the write paths follow it too; safe to re-run
--
-- Run AFTER 20_impersonation.sql.
--
-- 20 made `my_account_id()` answer "which account am I working in". But the
-- write paths never asked it: each resolved the account itself with
--
--     SELECT account_id INTO v_account FROM account_members WHERE user_id = …
--
-- so recording an inspection while acting as a subcontractor would have filed
-- it under the office's own account — the worst possible outcome, because it
-- looks like it worked.
--
-- Each function below is REPRODUCED VERBATIM from the migration that defines
-- it, with exactly one change: the account comes from my_account_id(). They
-- were extracted mechanically rather than retyped, so nothing else can drift.
-- When not impersonating, my_account_id() returns the same membership lookup
-- these functions did, so behaviour is unchanged.
--
-- WHAT FOLLOWS THE SESSION            recording ladder and FP inspections,
--                                     what an import costs and who is billed,
--                                     the catalogue pulled, writing our tags
--
-- WHAT DELIBERATELY DOES NOT          support tickets — a ticket is from the
--                                     person who wrote it, not the account
--                                     they were acting as
--
-- NOT YET COVERED                     catalogue authoring (09, 11) and tag
--                                     links (12). Editing a subcontractor's
--                                     catalogue while acting as them writes to
--                                     the office's own catalogue instead. Do
--                                     that work signed in as yourself until
--                                     these are brought across.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── record_inspection — the ladder write path
-- Verbatim from 05_rep_and_attribution.sql; the only change is the account lookup.
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
    rep_number, collected_by, collector_name
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
    v_rep, v_user_id, v_who
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── record_fp_inspection — the fall-protection write path
-- Verbatim from 11_fp_equipment_types.sql; the only change is the account lookup.
CREATE OR REPLACE FUNCTION public.record_fp_inspection(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id  uuid := auth.uid();
  v_account  uuid;
  v_serial   text := trim(coalesce(p->>'serial_num', ''));
  v_date     date := coalesce((p->>'inspection_date')::date, current_date);
  v_mfr      text := nullif(trim(coalesce(p->>'manufacturer','')), '');
  v_model    text := nullif(trim(coalesce(p->>'model','')), '');
  v_asset    uuid;
  v_model_id uuid;
  v_type_id  uuid;
  v_type_nm  text;
  v_prev     public.fp_inspections%ROWTYPE;
  v_id       uuid;
  v_version  integer := 1;
  v_rep      text;
  v_who      text;
  v_checks   jsonb := coalesce(p->'checks', '[]'::jsonb);
  v_chk      jsonb;
  v_pass     boolean := true;
  v_failed   text[] := '{}';
  v_reason   text;
  v_note     text := nullif(trim(coalesce(p->>'discard_note','')), '');
  v_ord      integer := 0;
  v_tpl      uuid;
  v_tplver   integer;
  v_code     text;
  v_prompt   text;
  v_style    text;
  v_passans  boolean;
  v_answer   boolean;
  v_result   boolean;
  v_source   text;
  v_seen     text[] := '{}';
  v_missing  text[];
  -- Checks are scored BEFORE the parent row exists, so they accumulate here
  -- rather than being inserted with a null parent and back-filled.
  v_scored   jsonb := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_serial = '' THEN RAISE EXCEPTION 'A serial number is required'; END IF;

  -- Follows the account being acted as; identical when not impersonating.
  v_account := public.my_account_id();
  IF v_account IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  v_rep := public.account_rep_number(v_account);
  SELECT coalesce(nullif(p->>'tech_name',''), u.name, u.email)
    INTO v_who FROM public.users u WHERE u.id = v_user_id;
  v_who := coalesce(v_who, 'Lia Import');

  -- Equipment type: an explicit id wins, else resolve the slug or name.
  v_type_id := nullif(p->>'equipment_type_id','')::uuid;
  IF v_type_id IS NULL THEN
    v_type_id := public.fp_type_for(v_account, coalesce(nullif(p->>'equipment_type',''),
                                                        nullif(p->>'item_type','')));
  END IF;
  SELECT name INTO v_type_nm FROM public.fp_equipment_types WHERE id = v_type_id;

  -- Catalogue entry, created on first sight of a manufacturer+model.
  IF v_mfr IS NOT NULL AND v_model IS NOT NULL THEN
    INSERT INTO public.fp_models (account_id, manufacturer, model, item_type,
                                  has_impact_indicator, created_by)
    VALUES (v_account, v_mfr, v_model,
            coalesce(v_type_nm, nullif(p->>'item_type','')),
            coalesce((p->>'has_impact_indicator')::boolean, false), v_user_id)
    ON CONFLICT (coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 lower(manufacturer), lower(model))
    DO NOTHING;

    SELECT id INTO v_model_id FROM public.fp_models
     WHERE account_id IS NOT DISTINCT FROM v_account
       AND lower(manufacturer) = lower(v_mfr) AND lower(model) = lower(v_model);
  END IF;

  -- The template the CLIENT performed against, not necessarily today's. A tech
  -- works offline for a day; the checklist may have been republished since.
  -- Validating against the pinned version is what makes that record still valid.
  v_tpl := nullif(p->>'template_id','')::uuid;
  IF v_tpl IS NULL THEN
    v_tpl := public.fp_current_template(v_model_id, v_type_id);
  END IF;
  SELECT version INTO v_tplver FROM public.fp_check_templates WHERE id = v_tpl;

  -- ── Score the checks ──────────────────────────────────────────────────────
  FOR v_chk IN SELECT * FROM jsonb_array_elements(v_checks) LOOP
    v_code := nullif(v_chk->>'code','');

    -- Template values are authoritative where the check is in the template.
    v_prompt := NULL;
    IF v_tpl IS NOT NULL AND v_code IS NOT NULL THEN
      SELECT c.prompt, c.answer_style, c.pass_answer
        INTO v_prompt, v_style, v_passans
        FROM public.fp_template_checks c
       WHERE c.template_id = v_tpl AND c.code = v_code
       LIMIT 1;
    END IF;

    IF v_prompt IS NOT NULL THEN
      v_source := 'template';
      v_seen := v_seen || v_code;
    ELSE
      v_source  := 'adhoc';
      v_prompt  := coalesce(nullif(v_chk->>'prompt',''), '(no prompt recorded)');
      v_style   := lower(coalesce(nullif(v_chk->>'answer_style',''), 'pass_fail'));
      v_passans := coalesce((v_chk->>'pass_answer')::boolean, true);
      IF v_style NOT IN ('pass_fail', 'yes_no') THEN v_style := 'pass_fail'; END IF;
    END IF;

    -- The tech answers; the verdict is derived. A client cannot send an answer
    -- and a contradicting result.
    IF (v_chk ? 'answer') AND (v_chk->>'answer') IS NOT NULL THEN
      v_answer := (v_chk->>'answer')::boolean;
    ELSIF (v_chk->>'result') IS NOT NULL THEN
      -- Older clients send only a pass/fail verdict; back-fill the answer.
      v_answer := CASE WHEN (v_chk->>'result')::boolean THEN v_passans ELSE NOT v_passans END;
    ELSE
      v_answer := NULL;
    END IF;

    v_result := CASE WHEN v_answer IS NULL THEN NULL ELSE (v_answer = v_passans) END;

    IF v_result IS FALSE THEN
      v_pass := false;
      v_failed := v_failed || v_prompt;
    END IF;

    v_scored := v_scored || jsonb_build_object(
      'ord',          coalesce((v_chk->>'ord')::integer, v_ord),
      'code',         v_code,
      'prompt',       v_prompt,
      'answer',       v_answer,
      'answer_style', v_style,
      'pass_answer',  v_passans,
      'result',       v_result,
      'source',       v_source,
      'note',         nullif(v_chk->>'note',''));
    v_ord := v_ord + 1;
  END LOOP;

  -- "All must pass" only means something if all were actually asked.
  IF v_tpl IS NOT NULL THEN
    SELECT array_agg(c.prompt) INTO v_missing
      FROM public.fp_template_checks c
     WHERE c.template_id = v_tpl AND c.required
       AND NOT (c.code = ANY (v_seen));
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'Unanswered required check(s): %', array_to_string(v_missing, '; ');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_checks) e
              WHERE NOT (e ? 'answer') AND (e->>'result') IS NULL) THEN
    RAISE EXCEPTION 'Every check must be answered before an item can be recorded';
  END IF;

  -- The reason IS the failed checks. Nothing for the tech to type.
  IF NOT v_pass THEN
    v_reason := 'Failed: ' || array_to_string(v_failed, '; ');
  END IF;

  INSERT INTO public.assets (account_id, kind, serial_raw, serial_key)
  VALUES (v_account, 'fall_protection', v_serial, public.serial_key(v_serial))
  ON CONFLICT (account_id, kind, serial_key) DO NOTHING
  RETURNING id INTO v_asset;

  IF v_asset IS NULL THEN
    SELECT id INTO v_asset FROM public.assets
     WHERE account_id = v_account AND kind = 'fall_protection'
       AND serial_key = public.serial_key(v_serial);
  END IF;

  IF nullif(p->>'nfc_tag_serial','') IS NOT NULL THEN
    UPDATE public.assets SET nfc_tag_uid = p->>'nfc_tag_serial' WHERE id = v_asset;
  END IF;

  SELECT * INTO v_prev FROM public.fp_inspections
   WHERE asset_id = v_asset AND inspection_date = v_date AND is_current AND NOT is_deleted
   FOR UPDATE;

  IF FOUND THEN
    v_version := v_prev.version + 1;
    UPDATE public.fp_inspections SET is_current = false, updated_at = now() WHERE id = v_prev.id;
  END IF;

  INSERT INTO public.fp_inspections (
    account_id, asset_id, work_order_id, inspection_date, next_due_date,
    rep_number, tech_user_id, collected_by, collector_name,
    model_id, equipment_type_id, item_type, description, manufacturer, model,
    lot_number, mfg_month, mfg_year, status, nfc_tag_serial, tag_url,
    template_id, template_version, overall_pass, discard_reason, discard_note,
    version, supersedes, is_current, source, captured_at
  ) VALUES (
    v_account, v_asset,
    coalesce(nullif(p->>'work_order_id',''), v_prev.work_order_id),
    v_date,
    coalesce((p->>'next_due_date')::date, v_date + interval '1 year'),
    v_rep, v_user_id, v_user_id, v_who,
    coalesce(v_model_id, v_prev.model_id),
    coalesce(v_type_id, v_prev.equipment_type_id),
    coalesce(v_type_nm, nullif(p->>'item_type',''), v_prev.item_type),
    coalesce(nullif(p->>'description',''),  v_prev.description),
    coalesce(v_mfr,   v_prev.manufacturer),
    coalesce(v_model, v_prev.model),
    coalesce(nullif(p->>'lot_number',''),   v_prev.lot_number),
    coalesce((p->>'mfg_month')::integer,    v_prev.mfg_month),
    coalesce((p->>'mfg_year')::integer,     v_prev.mfg_year),
    public.fp_default_status(v_pass, nullif(p->>'status','')),
    coalesce(nullif(p->>'nfc_tag_serial',''), v_prev.nfc_tag_serial),
    -- Not carried over from the previous inspection: this column says which link
    -- the tech read THIS time. An item that has been re-tagged, or one tapped
    -- from a phone that read no link at all, must not inherit last year's.
    nullif(p->>'tag_url',''),
    coalesce(v_tpl, v_prev.template_id),
    coalesce(v_tplver, v_prev.template_version),
    v_pass, v_reason, coalesce(v_note, v_prev.discard_note),
    v_version, v_prev.id, true,
    coalesce(p->>'source', 'field'),
    coalesce((p->>'captured_at')::timestamptz, now())
  )
  RETURNING id INTO v_id;

  INSERT INTO public.fp_inspection_checks
    (fp_inspection_id, ord, code, prompt, answer, answer_style, pass_answer, result, source, note)
  SELECT v_id,
         (e->>'ord')::integer,
         nullif(e->>'code',''),
         e->>'prompt',
         (e->>'answer')::boolean,
         e->>'answer_style',
         (e->>'pass_answer')::boolean,
         (e->>'result')::boolean,
         e->>'source',
         nullif(e->>'note','')
    FROM jsonb_array_elements(v_scored) e;

  RETURN v_id;
END;
$$;

-- ── preflight_work_order — what an import will cost
-- Verbatim from 03_accounts_billing.sql; the only change is the account lookup.
CREATE OR REPLACE FUNCTION public.preflight_work_order(p_wo_number text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_account_id uuid;
  v_credits    integer;
  v_key        text;
  v_charged    boolean := false;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_key := public.wo_key(p_wo_number);
  IF v_key = '' THEN RAISE EXCEPTION 'A work order number is required'; END IF;

  -- Follows the account being acted as; identical when not impersonating.
  v_account_id := public.my_account_id();
  IF v_account_id IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  SELECT credits INTO v_credits FROM public.accounts WHERE id = v_account_id;

  SELECT (charged_at IS NOT NULL) INTO v_charged
  FROM public.work_orders WHERE account_id = v_account_id AND wo_key = v_key;

  RETURN json_build_object(
    'credits',         v_credits,
    'already_charged', COALESCE(v_charged, false),
    -- true when this import will not cost anything: already paid, or unlimited
    'free',            COALESCE(v_charged, false) OR v_credits = -1,
    'can_run',         COALESCE(v_charged, false) OR v_credits = -1 OR v_credits > 0
  );
END;
$$;

-- ── charge_work_order — who is billed for it
-- Verbatim from 03_accounts_billing.sql; the only change is the account lookup.
CREATE OR REPLACE FUNCTION public.charge_work_order(
  p_wo_number text,
  p_scope     text DEFAULT 'ladder'
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_account_id uuid;
  v_key        text;
  v_credits    integer;
  v_new        integer;
  v_wo_id      uuid;
  v_charged_at timestamptz;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_key := public.wo_key(p_wo_number);
  IF v_key = '' THEN RAISE EXCEPTION 'A work order number is required'; END IF;

  -- Follows the account being acted as; identical when not impersonating.
  v_account_id := public.my_account_id();
  IF v_account_id IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  -- Lock the account row first. Two imports finishing at the same moment must
  -- not both read the same balance and both debit it.
  SELECT credits INTO v_credits FROM public.accounts WHERE id = v_account_id FOR UPDATE;

  INSERT INTO public.work_orders (account_id, wo_number, wo_key, scope, created_by)
  VALUES (v_account_id, p_wo_number, v_key, p_scope, v_user_id)
  ON CONFLICT (account_id, wo_key) DO NOTHING
  RETURNING id INTO v_wo_id;

  IF v_wo_id IS NULL THEN
    SELECT id, charged_at INTO v_wo_id, v_charged_at
    FROM public.work_orders WHERE account_id = v_account_id AND wo_key = v_key;
  END IF;

  -- Already paid for. This is the whole point: edits, re-runs, and merging more
  -- techs' data into an existing work order are free.
  IF v_charged_at IS NOT NULL THEN
    RETURN json_build_object(
      'charged', false, 'reason', 'already_paid',
      'credits', v_credits, 'work_order_id', v_wo_id
    );
  END IF;

  IF v_credits = -1 THEN
    UPDATE public.work_orders
       SET charged_at = now(), charged_by = v_user_id, credits_charged = 0, updated_at = now()
     WHERE id = v_wo_id;
    INSERT INTO public.usage_log(user_id, account_id, work_order_id, work_order_uuid, credits_before, credits_after)
    VALUES (v_user_id, v_account_id, p_wo_number, v_wo_id, -1, -1);
    RETURN json_build_object('charged', true, 'credits', -1, 'work_order_id', v_wo_id);
  END IF;

  IF v_credits <= 0 THEN
    RAISE EXCEPTION 'No import credits remaining — contact your administrator';
  END IF;

  v_new := v_credits - 1;
  UPDATE public.accounts SET credits = v_new WHERE id = v_account_id;
  UPDATE public.work_orders
     SET charged_at = now(), charged_by = v_user_id, credits_charged = 1, updated_at = now()
   WHERE id = v_wo_id;

  INSERT INTO public.usage_log(user_id, account_id, work_order_id, work_order_uuid, credits_before, credits_after)
  VALUES (v_user_id, v_account_id, p_wo_number, v_wo_id, v_credits, v_new);

  RETURN json_build_object('charged', true, 'credits', v_new, 'work_order_id', v_wo_id);
END;
$$;

-- ── fp_type_catalog — which catalogue the device pulls
-- Verbatim from 11_fp_equipment_types.sql; the only change is the account lookup.
CREATE OR REPLACE FUNCTION public.fp_type_catalog()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_account uuid;
  v_out     jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  -- Follows the account being acted as; identical when not impersonating.
  v_account := public.my_account_id();

  -- Ordered NUMERICALLY: t->>'sort_order' is text, so 10 would sort before 2.
  SELECT coalesce(jsonb_agg(t ORDER BY (t->>'sort_order')::integer, t->>'name'), '[]'::jsonb)
    INTO v_out
    FROM (
      SELECT jsonb_build_object(
               'id',         et.id,
               'slug',       et.slug,
               'name',       et.name,
               'sort_order', et.sort_order,
               'template_id',      tpl.template_id,
               'template_version', tpl.version,
               'checks', coalesce(tpl.checks, '[]'::jsonb)
             ) AS t
        FROM public.fp_equipment_types et
        LEFT JOIN LATERAL (
          SELECT c.template_id, c.version,
                 jsonb_agg(jsonb_build_object(
                   'ord', c.ord, 'code', c.code, 'prompt', c.prompt,
                   'answer_style', c.answer_style, 'pass_answer', c.pass_answer,
                   'required', c.required) ORDER BY c.ord) AS checks
            FROM public.fp_current_checks(NULL, et.id) c
           GROUP BY c.template_id, c.version
        ) tpl ON true
       WHERE et.is_active
         AND (et.account_id = v_account OR et.account_id IS NULL)
         -- An account's own type shadows the shared one of the same slug.
         AND NOT (et.account_id IS NULL AND EXISTS (
               SELECT 1 FROM public.fp_equipment_types own
                WHERE own.account_id = v_account AND own.is_active
                  AND lower(own.slug) = lower(et.slug)))
    ) s;

  RETURN v_out;
END;
$$;

-- ── record_fp_tag_write — which account a written tag belongs to
-- Verbatim from 17_tag_write.sql; the only change is the account lookup.
CREATE OR REPLACE FUNCTION public.record_fp_tag_write(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_account uuid;
  v_asset   public.assets%ROWTYPE;
  v_label   text := nullif(btrim(coalesce(p->>'tag_label','')), '');
  v_uid     text := nullif(btrim(coalesce(p->>'nfc_tag_uid','')), '');
  v_url     text := nullif(btrim(coalesce(p->>'tag_url','')), '');
  v_client  text := nullif(p->>'client_id','');
  v_clash   uuid;
  v_id      uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  -- Follows the account being acted as; identical when not impersonating.
  v_account := public.my_account_id();
  IF v_account IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  SELECT * INTO v_asset FROM public.assets
   WHERE account_id = v_account
     AND ( (nullif(p->>'asset_id','') IS NOT NULL AND id = (p->>'asset_id')::uuid)
        OR (nullif(p->>'serial_num','') IS NOT NULL
            AND kind = 'fall_protection' AND serial_key = public.serial_key(p->>'serial_num'))
        OR (nullif(p->>'public_ref','') IS NOT NULL AND public_ref = upper(p->>'public_ref')) )
   LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such item'; END IF;

  -- A label already on a DIFFERENT item is refused rather than moved. Moving it
  -- would leave the other item unfindable by the label printed on its own tag.
  IF v_label IS NOT NULL THEN
    SELECT id INTO v_clash FROM public.assets
     WHERE account_id = v_account AND tag_label_key = public.serial_key(v_label)
       AND id <> v_asset.id;
    IF FOUND THEN
      RAISE EXCEPTION 'Tag label % is already on another item', v_label;
    END IF;
  END IF;

  -- Same for the chip id. A hardware uid is physically unique — two tags cannot
  -- share one — so a uid already on a DIFFERENT item means somebody has tagged
  -- the wrong thing, and letting it through would make both items resolve
  -- arbitrarily on a tap.
  --
  -- Enforced here rather than with a unique index on purpose: an index would
  -- have to hold for rows already in the live database, and there is no
  -- guarantee it does. Refusing new duplicates fixes the problem going forward
  -- without a migration that can fail on data nobody has looked at.
  IF v_uid IS NOT NULL THEN
    SELECT id INTO v_clash FROM public.assets
     WHERE account_id = v_account
       AND upper(regexp_replace(coalesce(nfc_tag_uid,''), '[^A-Fa-f0-9]', '', 'g'))
         = upper(regexp_replace(v_uid, '[^A-Fa-f0-9]', '', 'g'))
       AND coalesce(nfc_tag_uid,'') <> ''
       AND id <> v_asset.id;
    IF FOUND THEN
      RAISE EXCEPTION 'That tag is already on another item';
    END IF;
  END IF;

  -- The URL is rebuilt server-side rather than trusted from the payload. A
  -- client that sent a link to somewhere else would otherwise make this table
  -- claim we wrote it.
  v_url := coalesce(public.fp_tag_url(v_asset.public_ref, v_asset.serial_raw), v_url);

  INSERT INTO public.fp_tag_writes (
    account_id, asset_id, client_id, tag_label, nfc_tag_uid, tag_url,
    serial_num, public_ref, prev_label, prev_uid, written_by)
  VALUES (
    v_account, v_asset.id, v_client, v_label, v_uid, v_url,
    v_asset.serial_raw, v_asset.public_ref, v_asset.tag_label, v_asset.nfc_tag_uid, v_user)
  ON CONFLICT (account_id, client_id) WHERE client_id IS NOT NULL
    DO UPDATE SET written_at = public.fp_tag_writes.written_at
  RETURNING id INTO v_id;

  -- The item learns its new tag. Only ever set, never cleared by a write that
  -- knew less: a phone that could not read the chip id must not wipe the one
  -- already on record.
  UPDATE public.assets SET
    tag_label   = coalesce(v_label, tag_label),
    nfc_tag_uid = coalesce(v_uid, nfc_tag_uid),
    tag_url     = v_url,
    updated_at  = now()
   WHERE id = v_asset.id;

  RETURN json_build_object(
    'id', v_id, 'asset_id', v_asset.id,
    'tag_label', coalesce(v_label, v_asset.tag_label),
    'tag_url', v_url);
END;
$$;
