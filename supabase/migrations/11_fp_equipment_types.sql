-- ═══════════════════════════════════════════════════════════════════
-- Lia Fall Protection Equipment Types — safe to re-run; idempotent
--
-- Run AFTER 10_consolidate_account.sql.
--
-- WHY THIS EXISTS
--
-- 06_fall_protection.sql hung checklists off a MODEL (manufacturer + model).
-- That is wrong for how the inspection actually works: a body harness gets the
-- harness checks whoever made it, and the manufacturer, model, lot number and
-- date of manufacture are DATA RECORDED ABOUT the item, not what selects the
-- questions. The checklist is a property of the EQUIPMENT TYPE.
--
-- So equipment type becomes the owner of a checklist. The model-level template
-- from 06/09 is kept and now acts as an OVERRIDE: if a specific model has its
-- own published checklist it wins, otherwise the type's checklist applies.
--
-- TWO ANSWER STYLES
--
-- Most checks are "pass / fail" on a component. Two are yes/no questions, and
-- one of those is INVERTED — "has the impact indicator been activated?" fails
-- on YES. Recording that in a plain result boolean would print `true` next to
-- that question on a certificate, which reads as "yes, it was activated" while
-- meaning the exact opposite.
--
-- So a check carries how it is answered and which answer passes:
--
--   answer_style  'pass_fail' → the answer reads Pass / Fail
--                 'yes_no'    → the answer reads Yes / No
--   pass_answer   the answer value that constitutes a pass
--   answer        what the tech actually said (true = Pass or Yes)
--   result        the derived verdict: (answer = pass_answer)
--
-- result is COMPUTED HERE, never taken from the client, for the same reason
-- overall_pass is: the verdict and the answer can then never disagree.
--
-- NOT EQUIPPED
--
-- The sheet marks the impact indicator per type as equipped (e) or not
-- equipped (na). A type with no indicator simply does not carry the check —
-- there is no third "N/A" state for a tech to leave unanswered.
-- ═══════════════════════════════════════════════════════════════════

-- ── The equipment type catalogue ─────────────────────────────────────────────
-- account_id NULL = a shared type every account sees, which is how the standard
-- fourteen ship. An account may add its own on top.
CREATE TABLE IF NOT EXISTS public.fp_equipment_types (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  slug       text NOT NULL,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fp_equipment_types_uq ON public.fp_equipment_types (
  coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(slug)
);
CREATE INDEX IF NOT EXISTS fp_equipment_types_account_idx ON public.fp_equipment_types(account_id);

-- ── Templates can now hang off a type as well as a model ─────────────────────
ALTER TABLE public.fp_check_templates
  ADD COLUMN IF NOT EXISTS equipment_type_id uuid REFERENCES public.fp_equipment_types(id) ON DELETE CASCADE;

-- model_id was NOT NULL when a template could only belong to a model.
ALTER TABLE public.fp_check_templates ALTER COLUMN model_id DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fp_template_owner_one') THEN
    ALTER TABLE public.fp_check_templates ADD CONSTRAINT fp_template_owner_one
      CHECK ((model_id IS NULL) <> (equipment_type_id IS NULL));
  END IF;
END $$;

-- fp_check_templates_uq is UNIQUE (model_id, version) and NULLs never collide,
-- so it does not constrain type-owned rows. They need their own.
CREATE UNIQUE INDEX IF NOT EXISTS fp_check_templates_type_uq
  ON public.fp_check_templates (equipment_type_id, version)
  WHERE equipment_type_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS fp_check_templates_type_idx
  ON public.fp_check_templates(equipment_type_id);

-- ── Answer style on the template and on the recorded result ──────────────────
ALTER TABLE public.fp_template_checks
  ADD COLUMN IF NOT EXISTS answer_style text NOT NULL DEFAULT 'pass_fail',
  ADD COLUMN IF NOT EXISTS pass_answer  boolean NOT NULL DEFAULT true;

ALTER TABLE public.fp_inspection_checks
  ADD COLUMN IF NOT EXISTS answer       boolean,
  ADD COLUMN IF NOT EXISTS answer_style text NOT NULL DEFAULT 'pass_fail',
  ADD COLUMN IF NOT EXISTS pass_answer  boolean NOT NULL DEFAULT true;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fp_template_answer_style') THEN
    ALTER TABLE public.fp_template_checks ADD CONSTRAINT fp_template_answer_style
      CHECK (answer_style IN ('pass_fail', 'yes_no'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fp_inspection_answer_style') THEN
    ALTER TABLE public.fp_inspection_checks ADD CONSTRAINT fp_inspection_answer_style
      CHECK (answer_style IN ('pass_fail', 'yes_no'));
  END IF;
END $$;

-- ── The inspection records which type it was performed as ────────────────────
ALTER TABLE public.fp_inspections
  ADD COLUMN IF NOT EXISTS equipment_type_id uuid REFERENCES public.fp_equipment_types(id);

-- The hyperlink read off the tag at the time of THIS inspection. Declared here
-- rather than in 12_tag_links.sql, which is where everything else about tag
-- links lives, because record_fp_inspection() below is what writes it and a
-- function cannot reference a column added by a later file. 12 builds the
-- index, the item-level copy and the external-record tables on top of it.
ALTER TABLE public.fp_inspections
  ADD COLUMN IF NOT EXISTS tag_url text;

CREATE INDEX IF NOT EXISTS fp_inspections_type_idx ON public.fp_inspections(equipment_type_id);

COMMENT ON COLUMN public.fp_inspections.item_type IS
  'Display text, denormalized from the equipment type at capture time so a '
  'certificate keeps saying what the item was inspected as even if the type '
  'is later renamed.';

-- ── Resolving which checklist applies ────────────────────────────────────────
-- Precedence: a model's OWN published checklist wins; otherwise the equipment
-- type's. A lead authors a model's list by starting from the type's baseline
-- and adding to it, so "the model overrides the type" and "the model extends
-- the type" are the same operation — see fp_checks_for_authoring below.
CREATE OR REPLACE FUNCTION public.fp_current_template(
  p_model_id           uuid DEFAULT NULL,
  p_equipment_type_id  uuid DEFAULT NULL
)
RETURNS uuid LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(
    -- The model's own list, if it has been given one.
    (SELECT id FROM public.fp_check_templates
      WHERE p_model_id IS NOT NULL AND model_id = p_model_id AND published_at IS NOT NULL
      ORDER BY version DESC LIMIT 1),
    -- Otherwise the type's.
    (SELECT id FROM public.fp_check_templates
      WHERE p_equipment_type_id IS NOT NULL AND equipment_type_id = p_equipment_type_id
        AND published_at IS NOT NULL
      ORDER BY version DESC LIMIT 1));
$$;

-- The checks a capture screen should show, in order.
CREATE OR REPLACE FUNCTION public.fp_current_checks(
  p_model_id          uuid DEFAULT NULL,
  p_equipment_type_id uuid DEFAULT NULL
)
RETURNS TABLE (
  template_id  uuid,
  version      integer,
  ord          integer,
  code         text,
  prompt       text,
  answer_style text,
  pass_answer  boolean,
  required     boolean
)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT t.id, t.version, c.ord, c.code, c.prompt, c.answer_style, c.pass_answer, c.required
    FROM public.fp_check_templates t
    JOIN public.fp_template_checks c ON c.template_id = t.id
   WHERE t.id = public.fp_current_template(p_model_id, p_equipment_type_id)
   ORDER BY c.ord;
$$;

-- What the authoring screen opens with for a model: its own list if it has one,
-- otherwise its type's, so "add a check to this model" starts from the standard
-- checklist rather than a blank page.
CREATE OR REPLACE FUNCTION public.fp_checks_for_authoring(p_model_id uuid)
RETURNS TABLE (
  ord          integer,
  code         text,
  prompt       text,
  answer_style text,
  pass_answer  boolean,
  required     boolean,
  inherited    boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_own uuid; v_type uuid; v_account uuid;
BEGIN
  -- SECURITY DEFINER bypasses RLS, so the account check has to be explicit.
  -- Without it any authenticated tech could pass another account's model id and
  -- read its checklists.
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT account_id INTO v_account FROM public.account_members WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fp_models
                  WHERE id = p_model_id
                    AND (account_id = v_account OR account_id IS NULL)) THEN
    RAISE EXCEPTION 'That model is not on your account';
  END IF;

  SELECT id INTO v_own FROM public.fp_check_templates
   WHERE model_id = p_model_id AND published_at IS NOT NULL
   ORDER BY version DESC LIMIT 1;

  IF v_own IS NOT NULL THEN
    RETURN QUERY
      SELECT c.ord, c.code, c.prompt, c.answer_style, c.pass_answer, c.required, false
        FROM public.fp_template_checks c WHERE c.template_id = v_own ORDER BY c.ord;
    RETURN;
  END IF;

  -- No list of its own — fall back to the type the catalogue entry names.
  SELECT public.fp_type_for(v_account, m.item_type) INTO v_type
    FROM public.fp_models m WHERE m.id = p_model_id;

  RETURN QUERY
    SELECT c.ord, c.code, c.prompt, c.answer_style, c.pass_answer, c.required, true
      FROM public.fp_template_checks c
     WHERE c.template_id = public.fp_current_template(NULL, v_type)
     ORDER BY c.ord;
END;
$$;

-- ── Looking a type up by slug or name ────────────────────────────────────────
-- An account's own type always beats the shared one of the same slug, so an
-- account that edits a standard checklist gets its edit and everyone else keeps
-- the standard.
CREATE OR REPLACE FUNCTION public.fp_type_for(p_account uuid, p_key text)
RETURNS uuid LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT id FROM public.fp_equipment_types
   WHERE is_active
     AND (account_id = p_account OR account_id IS NULL)
     AND (lower(slug) = lower(trim(coalesce(p_key, '')))
          OR lower(name) = lower(trim(coalesce(p_key, ''))))
   ORDER BY (account_id IS NULL)     -- false (own) sorts before true (shared)
   LIMIT 1;
$$;

-- ── Authoring ────────────────────────────────────────────────────────────────
-- Lead-only, same as 09_fp_authoring.sql: a sub-tech is a collection point, and
-- letting one weaken what every other tech is asked would be a quiet way to
-- weaken an inspection.

CREATE OR REPLACE FUNCTION public.save_fp_equipment_type(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.require_lead();
  v_id      uuid := nullif(p->>'id','')::uuid;
  v_name    text := nullif(trim(coalesce(p->>'name','')), '');
  v_slug    text := lower(regexp_replace(coalesce(nullif(trim(coalesce(p->>'slug','')), ''), v_name), '[^a-zA-Z0-9]+', '_', 'g'));
BEGIN
  IF v_name IS NULL THEN RAISE EXCEPTION 'An equipment type needs a name'; END IF;
  v_slug := trim(both '_' from v_slug);

  IF v_id IS NOT NULL THEN
    UPDATE public.fp_equipment_types
       SET name = v_name,
           sort_order = coalesce((p->>'sort_order')::integer, sort_order),
           is_active  = coalesce((p->>'is_active')::boolean, is_active)
     WHERE id = v_id AND account_id = v_account;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That equipment type is not on your account — it is a shared type, edit its checklist to fork it';
    END IF;
    RETURN v_id;
  END IF;

  INSERT INTO public.fp_equipment_types (account_id, slug, name, sort_order, created_by)
  VALUES (v_account, v_slug, v_name, coalesce((p->>'sort_order')::integer, 999), auth.uid())
  ON CONFLICT (coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(slug))
  DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Shared by both publish paths. Always writes a NEW version — an inspection
-- pins the version it was performed against, so editing a checklist can never
-- rewrite what a past certificate says the tech was asked.
CREATE OR REPLACE FUNCTION public.fp_publish_template(
  p_model_id uuid, p_type_id uuid, p_checks jsonb
)
RETURNS json LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_version integer;
  v_tpl     uuid;
  v_chk     jsonb;
  v_ord     integer := 0;
  v_count   integer := 0;
  v_style   text;
BEGIN
  SELECT coalesce(max(version), 0) + 1 INTO v_version
    FROM public.fp_check_templates
   WHERE model_id IS NOT DISTINCT FROM p_model_id
     AND equipment_type_id IS NOT DISTINCT FROM p_type_id;

  INSERT INTO public.fp_check_templates (model_id, equipment_type_id, version, published_at, created_by)
  VALUES (p_model_id, p_type_id, v_version, now(), auth.uid())
  RETURNING id INTO v_tpl;

  FOR v_chk IN SELECT * FROM jsonb_array_elements(coalesce(p_checks, '[]'::jsonb)) LOOP
    CONTINUE WHEN nullif(trim(coalesce(v_chk->>'prompt','')), '') IS NULL;
    v_style := lower(coalesce(nullif(v_chk->>'answer_style',''), 'pass_fail'));
    IF v_style NOT IN ('pass_fail', 'yes_no') THEN
      RAISE EXCEPTION 'Unknown answer style "%" on check "%"', v_style, v_chk->>'prompt';
    END IF;
    INSERT INTO public.fp_template_checks
      (template_id, ord, code, prompt, answer_style, pass_answer, required)
    VALUES (
      v_tpl, v_ord,
      nullif(v_chk->>'code',''),
      trim(v_chk->>'prompt'),
      v_style,
      coalesce((v_chk->>'pass_answer')::boolean, true),
      coalesce((v_chk->>'required')::boolean, true));
    v_ord := v_ord + 1;
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'A published checklist needs at least one check';
  END IF;

  RETURN json_build_object('version', v_version, 'checks', v_count, 'template_id', v_tpl);
END;
$$;

-- Replaces the 09_fp_authoring.sql version, which could not carry answer style.
CREATE OR REPLACE FUNCTION public.publish_fp_checks(p_model_id uuid, p_checks jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_account uuid := public.require_lead();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.fp_models
                  WHERE id = p_model_id AND account_id = v_account) THEN
    RAISE EXCEPTION 'That model is not on your account';
  END IF;
  RETURN public.fp_publish_template(p_model_id, NULL, p_checks);
END;
$$;

-- Publishing against a SHARED type forks it onto the account first. One
-- account's edit must not rewrite the standard checklist for every other.
CREATE OR REPLACE FUNCTION public.publish_fp_type_checks(p_type_id uuid, p_checks jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.require_lead();
  v_src     public.fp_equipment_types%ROWTYPE;
  v_target  uuid;
BEGIN
  SELECT * INTO v_src FROM public.fp_equipment_types WHERE id = p_type_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such equipment type'; END IF;

  IF v_src.account_id = v_account THEN
    v_target := v_src.id;
  ELSIF v_src.account_id IS NULL THEN
    INSERT INTO public.fp_equipment_types (account_id, slug, name, sort_order, created_by)
    VALUES (v_account, v_src.slug, v_src.name, v_src.sort_order, auth.uid())
    ON CONFLICT (coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(slug))
    DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_target;
  ELSE
    RAISE EXCEPTION 'That equipment type is not on your account';
  END IF;

  RETURN public.fp_publish_template(NULL, v_target, p_checks);
END;
$$;

-- ── The write path, updated ──────────────────────────────────────────────────
-- Replaces the 06_fall_protection.sql version. What changed:
--
--   • resolves and records the equipment type, and denormalizes its name
--   • takes prompt, answer_style and pass_answer FROM THE PINNED TEMPLATE for
--     any check whose code is in it, rather than from the client. Otherwise a
--     client could send pass_answer=true alongside "yes, the impact indicator
--     was activated" and turn a failed item into a passing certificate.
--   • derives result from (answer = pass_answer)
--   • refuses a record with an unanswered required check — "all must pass" is
--     meaningless if a check can simply be left out
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

  SELECT account_id INTO v_account FROM public.account_members WHERE user_id = v_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

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

-- ── The standard fourteen ────────────────────────────────────────────────────
-- Shared types (account_id NULL) so every account gets them. Idempotent: a type
-- that already has a published checklist is left alone, so re-running the
-- migration does not spawn a v2 and does not undo an account's own edits.
--
-- Two prompts expand abbreviations from the source sheet and are worth a second
-- look before this is treated as final wording, since they print on a
-- certificate: "arrester encloser ext" is rendered "Arrester enclosure
-- exterior", and "warning center not ext" is rendered "Warning center not
-- extended". Obvious misspellings were corrected: swagging→swaging,
-- kermantle→kernmantle, puches→pouches, horzontal→horizontal.
CREATE OR REPLACE FUNCTION public.fp_seed_standard_types()
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $seed$
DECLARE
  v_defs jsonb := '[
  {
    "slug": "crane_lift_sling",
    "name": "Crane lift sling",
    "sort_order": 1,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "webbing",
        "prompt": "Webbing / rope / cable",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "stitching",
        "prompt": "Stitching / swaging",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "loop_protectors",
        "prompt": "Loop protectors / thimble",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "snap_hooks",
        "prompt": "Snap hooks / carabiners",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "tie_off_adaptor",
    "name": "Tie off adaptor",
    "sort_order": 2,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "impact_indicator",
        "prompt": "Has the impact indicator been activated?",
        "answer_style": "yes_no",
        "pass_answer": false,
        "required": true
      },
      {
        "code": "webbing",
        "prompt": "Webbing / rope / cable",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "stitching",
        "prompt": "Stitching / swaging",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "wear_pad",
        "prompt": "Wear pad / wear sleeve",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "o_rings",
        "prompt": "O-rings / D-rings",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "rescue_device_r550",
    "name": "Rescue device — R550",
    "sort_order": 3,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "impact_indicator",
        "prompt": "Has the impact indicator been activated?",
        "answer_style": "yes_no",
        "pass_answer": false,
        "required": true
      },
      {
        "code": "stitching",
        "prompt": "Stitching / swaging",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "snap_hooks",
        "prompt": "Snap hooks / carabiners",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "kernmantle_lifeline",
        "prompt": "Kernmantle rope lifeline",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "housing_hub",
        "prompt": "Housing / rescue hub",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "working_mechanism",
        "prompt": "Working mechanism",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "camming_cleats",
        "prompt": "Camming cleats / pigtail",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "temporary_horizontal_lifeline",
    "name": "Temporary horizontal lifeline",
    "sort_order": 4,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "impact_indicator",
        "prompt": "Has the impact indicator been activated?",
        "answer_style": "yes_no",
        "pass_answer": false,
        "required": true
      },
      {
        "code": "webbing",
        "prompt": "Webbing / rope / cable",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "stitching",
        "prompt": "Stitching / swaging",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "loop_protectors",
        "prompt": "Loop protectors / thimble",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "snap_hooks",
        "prompt": "Snap hooks / carabiners",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "energy_absorber",
        "prompt": "Energy absorber",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "lifeline_tensioner",
        "prompt": "Lifeline tensioner",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "vertical_lifeline_arrester",
    "name": "Vertical lifelines and fall arresters",
    "sort_order": 5,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "impact_indicator",
        "prompt": "Has the impact indicator been activated?",
        "answer_style": "yes_no",
        "pass_answer": false,
        "required": true
      },
      {
        "code": "snap_hooks",
        "prompt": "Snap hooks / carabiners",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "working_mechanism",
        "prompt": "Working mechanism",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "arrester_enclosure",
        "prompt": "Arrester enclosure exterior",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "rope_retainer",
        "prompt": "Rope retainer",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "rope_lifeline",
        "prompt": "Rope lifeline",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "splices_thimbles",
        "prompt": "Splices / thimbles",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "positioning_lanyard",
    "name": "Positioning lanyard",
    "sort_order": 6,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "webbing",
        "prompt": "Webbing / rope / cable",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "stitching",
        "prompt": "Stitching / swaging",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "loop_protectors",
        "prompt": "Loop protectors / thimble",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "snap_hooks",
        "prompt": "Snap hooks / carabiners",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "energy_absorber",
        "prompt": "Energy absorber",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "positioning_strap",
    "name": "Positioning strap",
    "sort_order": 7,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "warning_center",
        "prompt": "Warning center not extended",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "strap_material",
        "prompt": "Strap material",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "rivets_bolts",
        "prompt": "Rivets / bolts",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "snaphooks",
        "prompt": "Snaphooks",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "self_rescue_device",
    "name": "Self rescue device",
    "sort_order": 8,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "impact_indicator",
        "prompt": "Has the impact indicator been activated?",
        "answer_style": "yes_no",
        "pass_answer": false,
        "required": true
      },
      {
        "code": "locking_pin",
        "prompt": "Locking pin and button",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "d_rings",
        "prompt": "D-ring(s)",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "device_housing",
        "prompt": "Device housing",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "rescue_cable",
        "prompt": "Assisted rescue cable",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "rescue_handle",
        "prompt": "Assisted rescue handle",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "self_rescue_with_bag",
    "name": "Self rescue with bag",
    "sort_order": 9,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "impact_indicator",
        "prompt": "Has the impact indicator been activated?",
        "answer_style": "yes_no",
        "pass_answer": false,
        "required": true
      },
      {
        "code": "locking_pin",
        "prompt": "Locking pin and button",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "d_rings",
        "prompt": "D-ring(s)",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "device_housing",
        "prompt": "Device housing",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "rescue_cable",
        "prompt": "Assisted rescue cable",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "rescue_handle",
        "prompt": "Assisted rescue handle",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "bag",
        "prompt": "Bag",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "pole_climbing_device",
    "name": "Pole climbing device",
    "sort_order": 10,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "warning_center",
        "prompt": "Warning center not extended",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "strap_material",
        "prompt": "Strap material",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "rivets_bolts",
        "prompt": "Rivets / bolts",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "snaphooks",
        "prompt": "Snaphooks",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "stopping_cleat",
        "prompt": "Stopping cleat",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "srl",
    "name": "SRL (self-retracting lifeline)",
    "sort_order": 11,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "impact_indicator",
        "prompt": "Has the impact indicator been activated?",
        "answer_style": "yes_no",
        "pass_answer": false,
        "required": true
      },
      {
        "code": "webbing",
        "prompt": "Webbing / rope / cable",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "loop_protectors",
        "prompt": "Loop protectors / thimble",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "housing_hub",
        "prompt": "Housing / rescue hub",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "working_mechanism",
        "prompt": "Working mechanism",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "energy_absorber",
        "prompt": "Energy absorber",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "body_harness",
    "name": "Body harness",
    "sort_order": 12,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "impact_indicator",
        "prompt": "Has the impact indicator been activated?",
        "answer_style": "yes_no",
        "pass_answer": false,
        "required": true
      },
      {
        "code": "webbing",
        "prompt": "Webbing / rope / cable",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "stitching",
        "prompt": "Stitching / swaging",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "o_rings",
        "prompt": "O-rings / D-rings",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "top_bottom_connectors",
        "prompt": "Top and bottom connectors",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "buckles",
        "prompt": "Buckles",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "trauma_strap",
        "prompt": "Suspension trauma strap",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "strap_keepers",
        "prompt": "Strap keepers / lanyard",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "lanyard",
    "name": "Lanyard",
    "sort_order": 13,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "impact_indicator",
        "prompt": "Has the impact indicator been activated?",
        "answer_style": "yes_no",
        "pass_answer": false,
        "required": true
      },
      {
        "code": "webbing",
        "prompt": "Webbing / rope / cable",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "stitching",
        "prompt": "Stitching / swaging",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "loop_protectors",
        "prompt": "Loop protectors / thimble",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "snap_hooks",
        "prompt": "Snap hooks / carabiners",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "energy_absorber",
        "prompt": "Energy absorber",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  },
  {
    "slug": "climbing_belt",
    "name": "Climbing belt",
    "sort_order": 14,
    "checks": [
      {
        "code": "labels",
        "prompt": "Are all labels and markings present, secured and legible?",
        "answer_style": "yes_no",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "d_rings",
        "prompt": "D-ring(s)",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "buckles",
        "prompt": "Buckles",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "leather_stitching",
        "prompt": "Leather and stitching",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      },
      {
        "code": "tool_pouches",
        "prompt": "Tool pouches / accessories",
        "answer_style": "pass_fail",
        "pass_answer": true,
        "required": true
      }
    ]
  }
]'::jsonb;
  v_def  jsonb;
  v_id   uuid;
  v_n    integer := 0;
BEGIN
  FOR v_def IN SELECT * FROM jsonb_array_elements(v_defs) LOOP
    INSERT INTO public.fp_equipment_types (account_id, slug, name, sort_order)
    VALUES (NULL, v_def->>'slug', v_def->>'name', (v_def->>'sort_order')::integer)
    ON CONFLICT (coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(slug))
    DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order
    RETURNING id INTO v_id;

    -- Only publish a baseline if this type has never had one.
    IF NOT EXISTS (SELECT 1 FROM public.fp_check_templates
                    WHERE equipment_type_id = v_id AND published_at IS NOT NULL) THEN
      PERFORM public.fp_publish_template(NULL, v_id, v_def->'checks');
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$seed$;

SELECT public.fp_seed_standard_types();

-- ── The device catalogue ─────────────────────────────────────────────────────
-- Every type with its current checklist, in one call, so the field app can hold
-- the whole thing offline. A tech has no signal in a stairwell; the checklist
-- has to already be on the phone.
CREATE OR REPLACE FUNCTION public.fp_type_catalog()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_account uuid;
  v_out     jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT account_id INTO v_account FROM public.account_members WHERE user_id = auth.uid();

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

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.fp_equipment_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fp_equipment_types_select" ON public.fp_equipment_types;
CREATE POLICY "fp_equipment_types_select" ON public.fp_equipment_types
  FOR SELECT USING (account_id IS NULL OR account_id = public.my_account_id());

-- Templates may now be owned by a type as well as a model, so the policy from
-- 06_fall_protection.sql (model-only) would hide every type checklist.
DROP POLICY IF EXISTS "fp_templates_select" ON public.fp_check_templates;
CREATE POLICY "fp_templates_select" ON public.fp_check_templates
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.fp_models m WHERE m.id = model_id
              AND (m.account_id IS NULL OR m.account_id = public.my_account_id()))
    OR EXISTS (SELECT 1 FROM public.fp_equipment_types et WHERE et.id = equipment_type_id
              AND (et.account_id IS NULL OR et.account_id = public.my_account_id())));

DROP POLICY IF EXISTS "fp_template_checks_select" ON public.fp_template_checks;
CREATE POLICY "fp_template_checks_select" ON public.fp_template_checks
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.fp_check_templates t
     WHERE t.id = template_id
       AND (EXISTS (SELECT 1 FROM public.fp_models m WHERE m.id = t.model_id
                      AND (m.account_id IS NULL OR m.account_id = public.my_account_id()))
         OR EXISTS (SELECT 1 FROM public.fp_equipment_types et WHERE et.id = t.equipment_type_id
                      AND (et.account_id IS NULL OR et.account_id = public.my_account_id())))));

-- No INSERT/UPDATE/DELETE policy: the publish functions are the only way in.
REVOKE ALL ON public.fp_equipment_types FROM anon, authenticated;
GRANT SELECT ON public.fp_equipment_types TO authenticated;

-- fp_publish_template bypasses require_lead() by design — it is the shared body
-- of the two publish functions, which check first. It must not be callable on
-- its own, or any tech could republish any checklist.
REVOKE ALL ON FUNCTION public.fp_publish_template(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fp_seed_standard_types() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.save_fp_equipment_type(jsonb)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.publish_fp_type_checks(uuid, jsonb)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_type_catalog()                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_checks_for_authoring(uuid)          FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_fp_equipment_type(jsonb)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_fp_type_checks(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_type_catalog()                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_checks_for_authoring(uuid)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_current_checks(uuid, uuid)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_current_template(uuid, uuid)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_type_for(uuid, text)             TO authenticated;

-- ── Public certificate: the answer, rendered as it was asked ─────────────────
-- A certificate must show what the tech was asked AND what he said. "Has the
-- impact indicator been activated? — No" is the truthful rendering of a pass on
-- that check; printing "Pass" against a yes/no question is not.
DROP VIEW IF EXISTS public.fall_protection_checks_public;
CREATE VIEW public.fall_protection_checks_public AS
  SELECT a.public_ref, i.inspection_date, c.ord, c.prompt,
         c.answer_style,
         c.answer,
         CASE
           WHEN c.answer IS NULL THEN NULL
           WHEN c.answer_style = 'yes_no' THEN CASE WHEN c.answer THEN 'Yes' ELSE 'No' END
           ELSE CASE WHEN c.answer THEN 'Pass' ELSE 'Fail' END
         END AS answer_label,
         c.result
    FROM public.fp_inspection_checks c
    JOIN public.fp_inspections i ON i.id = c.fp_inspection_id
    JOIN public.assets a         ON a.id = i.asset_id
   WHERE i.is_current AND NOT i.is_deleted
   ORDER BY a.public_ref, i.inspection_date DESC, c.ord;

GRANT SELECT ON public.fall_protection_checks_public TO anon;
GRANT SELECT ON public.fall_protection_checks_public TO authenticated;
