-- ═══════════════════════════════════════════════════════════════════
-- Lia Fall Protection — safe to re-run; all statements are idempotent
--
-- Run AFTER 05_rep_and_attribution.sql.
--
-- Fall protection is a second scope of work, not a variant of a ladder: entirely
-- different part numbers, different per-item attributes, per-item pass/fail
-- checks that vary by model, and mandatory photo evidence when an item is
-- condemned. It gets its own tables, but shares the infrastructure that already
-- exists — assets, accounts, work orders, versioning, RLS.
--
-- Ladders and fall protection are always on separate work orders, so nothing
-- here needs a scope discriminator beyond assets.kind.
-- ═══════════════════════════════════════════════════════════════════

-- ── The running master catalogue of manufacturer + model ─────────────────────
-- Accumulates as techs type. Drives autocomplete and the quick-tap buttons,
-- mirroring how the ladder parts library already works.
CREATE TABLE IF NOT EXISTS public.fp_models (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid REFERENCES public.accounts(id) ON DELETE CASCADE, -- NULL = shared
  manufacturer         text NOT NULL,
  model                text NOT NULL,
  item_type            text,
  -- Only some items have an impact indicator. The check is shown for a model
  -- only when this is true, rather than being driven by a hardcoded list.
  has_impact_indicator boolean NOT NULL DEFAULT false,
  favorited            boolean NOT NULL DEFAULT false,
  sort_order           integer,
  created_by           uuid REFERENCES auth.users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- account_id is nullable (a shared catalogue entry), and NULLs do not compare
-- equal in a plain unique constraint — so key on a coalesced sentinel.
CREATE UNIQUE INDEX IF NOT EXISTS fp_models_uq ON public.fp_models (
  coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
  lower(manufacturer), lower(model)
);
CREATE INDEX IF NOT EXISTS fp_models_account_idx ON public.fp_models(account_id);

-- ── Check templates, versioned ───────────────────────────────────────────────
-- Authored in Lia Desktop against a model. An inspection pins the template
-- version it was performed against, so editing a template later can never
-- rewrite what a historical certificate says the tech was asked.
CREATE TABLE IF NOT EXISTS public.fp_check_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id     uuid NOT NULL REFERENCES public.fp_models(id) ON DELETE CASCADE,
  version      integer NOT NULL DEFAULT 1,
  published_at timestamptz,
  created_by   uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fp_check_templates_uq') THEN
    ALTER TABLE public.fp_check_templates ADD CONSTRAINT fp_check_templates_uq UNIQUE (model_id, version);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.fp_template_checks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.fp_check_templates(id) ON DELETE CASCADE,
  ord         integer NOT NULL DEFAULT 0,
  code        text,
  prompt      text NOT NULL,
  required    boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS fp_template_checks_tpl_idx ON public.fp_template_checks(template_id);

-- ── Inspections ──────────────────────────────────────────────────────────────
-- Same versioning shape as public.inspections: append-only, supersede rather
-- than overwrite, one current row per (asset, date).
CREATE TABLE IF NOT EXISTS public.fp_inspections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  asset_id         uuid NOT NULL REFERENCES public.assets(id),
  work_order_id    text,
  work_order_uuid  uuid REFERENCES public.work_orders(id),

  inspection_date  date NOT NULL DEFAULT current_date,
  next_due_date    date,                    -- always inspection_date + 1 year

  -- Who: the responsible rep, and separately whoever actually collected it.
  rep_number       text,
  tech_user_id     uuid REFERENCES auth.users(id),
  collected_by     uuid REFERENCES auth.users(id),
  collector_name   text,

  -- The item itself.
  model_id         uuid REFERENCES public.fp_models(id),
  item_type        text,
  description      text,
  manufacturer     text,
  model            text,
  lot_number       text,
  mfg_month        integer CHECK (mfg_month IS NULL OR mfg_month BETWEEN 1 AND 12),
  mfg_year         integer CHECK (mfg_year  IS NULL OR mfg_year BETWEEN 1900 AND 2200),
  -- pass | fail | 'inspection overdue'. The CHECK is added in 07_fp_status.sql,
  -- after any pre-existing values have been normalized.
  status           text,
  nfc_tag_serial   text,

  -- Which checklist this was performed against.
  template_id      uuid REFERENCES public.fp_check_templates(id),
  template_version integer,

  -- Any failed check fails the whole item, and a failed item must be discarded
  -- with a reason on record.
  overall_pass     boolean NOT NULL DEFAULT true,
  discard_reason   text,

  version          integer NOT NULL DEFAULT 1,
  supersedes       uuid REFERENCES public.fp_inspections(id),
  is_current       boolean NOT NULL DEFAULT true,
  is_deleted       boolean NOT NULL DEFAULT false,
  source           text,
  captured_at      timestamptz,
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fp_discard_requires_reason') THEN
    ALTER TABLE public.fp_inspections ADD CONSTRAINT fp_discard_requires_reason
      CHECK (overall_pass OR discard_reason IS NOT NULL);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS fp_inspections_current_uq
  ON public.fp_inspections (asset_id, inspection_date)
  WHERE is_current AND NOT is_deleted;

CREATE INDEX IF NOT EXISTS fp_inspections_account_idx ON public.fp_inspections(account_id);
CREATE INDEX IF NOT EXISTS fp_inspections_asset_idx   ON public.fp_inspections(asset_id);
CREATE INDEX IF NOT EXISTS fp_inspections_wo_idx      ON public.fp_inspections(work_order_id);
CREATE INDEX IF NOT EXISTS fp_inspections_due_idx     ON public.fp_inspections(next_due_date);

-- ── Per-inspection check results ─────────────────────────────────────────────
-- prompt is denormalized on purpose: a certificate must show the question the
-- tech was actually asked, not whatever the template says today.
CREATE TABLE IF NOT EXISTS public.fp_inspection_checks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fp_inspection_id  uuid NOT NULL REFERENCES public.fp_inspections(id) ON DELETE CASCADE,
  ord               integer NOT NULL DEFAULT 0,
  code              text,
  prompt            text NOT NULL,
  result            boolean,
  source            text NOT NULL DEFAULT 'template' CHECK (source IN ('template', 'adhoc')),
  note              text
);
CREATE INDEX IF NOT EXISTS fp_inspection_checks_insp_idx ON public.fp_inspection_checks(fp_inspection_id);

-- ── Photo evidence ───────────────────────────────────────────────────────────
-- The files live in Supabase Storage; this table is the index. Photos upload on
-- a queue separate from the inspection data, so a failed photo cannot block the
-- inspection itself — which is why "a photo exists" is not a DB constraint.
CREATE TABLE IF NOT EXISTS public.inspection_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  subject_kind text NOT NULL DEFAULT 'fp_inspection' CHECK (subject_kind IN ('fp_inspection', 'inspection')),
  subject_id   uuid NOT NULL,
  storage_path text NOT NULL,
  sha256       text,
  bytes        integer,
  width        integer,
  height       integer,
  captured_at  timestamptz,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  uploaded_by  uuid REFERENCES auth.users(id),
  expires_at   timestamptz
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspection_photos_path_uq') THEN
    ALTER TABLE public.inspection_photos ADD CONSTRAINT inspection_photos_path_uq UNIQUE (storage_path);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS inspection_photos_subject_idx ON public.inspection_photos(subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS inspection_photos_expiry_idx  ON public.inspection_photos(expires_at);

-- Retention is stated in the privacy policy, so it is enforced rather than
-- promised. The period lives in app_settings so there is one source for it.
CREATE OR REPLACE FUNCTION public.set_photo_expiry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_days integer;
BEGIN
  IF NEW.expires_at IS NULL THEN
    SELECT coalesce(value::integer, 730) INTO v_days
      FROM public.app_settings WHERE key = 'photo_retention_days';
    NEW.expires_at := coalesce(NEW.uploaded_at, now()) + make_interval(days => coalesce(v_days, 730));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inspection_photos_set_expiry ON public.inspection_photos;
CREATE TRIGGER inspection_photos_set_expiry
  BEFORE INSERT ON public.inspection_photos
  FOR EACH ROW EXECUTE FUNCTION public.set_photo_expiry();

-- Returns the storage paths that are past retention. Deleting the row here does
-- not delete the file — the caller removes it from Storage, then this row.
CREATE OR REPLACE FUNCTION public.expired_photos(p_limit integer DEFAULT 500)
RETURNS TABLE (id uuid, storage_path text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT id, storage_path FROM public.inspection_photos
   WHERE expires_at IS NOT NULL AND expires_at <= now()
   ORDER BY expires_at LIMIT p_limit;
$$;

-- ── Status ───────────────────────────────────────────────────────────────────
-- Recorded statuses are pass, fail and 'inspection overdue'. The first two are
-- facts about the inspection; the third is a state a tech may find an item
-- already in. What a certificate *displays* is derived — see fp_effective_status
-- in 07_fp_status.sql — because a passing item goes overdue on its own.
CREATE OR REPLACE FUNCTION public.fp_default_status(p_overall_pass boolean, p_recorded text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_recorded = 'inspection overdue' THEN 'inspection overdue'
    WHEN p_overall_pass IS false THEN 'fail'
    ELSE 'pass'
  END;
$$;

-- ── The write path ───────────────────────────────────────────────────────────
-- Mirrors record_inspection(): resolves the asset and the catalogue entry,
-- supersedes any current row for the same item and date, and writes the checks
-- with their prompts denormalized.
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
  v_prev     public.fp_inspections%ROWTYPE;
  v_id       uuid;
  v_version  integer := 1;
  v_rep      text;
  v_who      text;
  v_checks   jsonb := coalesce(p->'checks', '[]'::jsonb);
  v_chk      jsonb;
  v_pass     boolean := true;
  v_reason   text := nullif(trim(coalesce(p->>'discard_reason','')), '');
  v_ord      integer := 0;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_serial = '' THEN RAISE EXCEPTION 'A serial number is required'; END IF;

  SELECT account_id INTO v_account FROM public.account_members WHERE user_id = v_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  v_rep := public.account_rep_number(v_account);
  SELECT coalesce(nullif(p->>'tech_name',''), u.name, u.email)
    INTO v_who FROM public.users u WHERE u.id = v_user_id;
  v_who := coalesce(v_who, 'Lia Import');

  -- Any failed check fails the item. Computed here rather than trusted from the
  -- client, so the overall assessment can never disagree with the checks.
  FOR v_chk IN SELECT * FROM jsonb_array_elements(v_checks) LOOP
    IF (v_chk->>'result') IS NOT NULL AND (v_chk->>'result')::boolean = false THEN
      v_pass := false;
    END IF;
  END LOOP;

  IF NOT v_pass AND v_reason IS NULL THEN
    RAISE EXCEPTION 'A failed item must be discarded with a reason on record';
  END IF;

  -- Catalogue entry, created on first sight of a manufacturer+model.
  IF v_mfr IS NOT NULL AND v_model IS NOT NULL THEN
    INSERT INTO public.fp_models (account_id, manufacturer, model, item_type,
                                  has_impact_indicator, created_by)
    VALUES (v_account, v_mfr, v_model, nullif(p->>'item_type',''),
            coalesce((p->>'has_impact_indicator')::boolean, false), v_user_id)
    ON CONFLICT (coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 lower(manufacturer), lower(model))
    DO NOTHING;

    SELECT id INTO v_model_id FROM public.fp_models
     WHERE account_id IS NOT DISTINCT FROM v_account
       AND lower(manufacturer) = lower(v_mfr) AND lower(model) = lower(v_model);
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
    model_id, item_type, description, manufacturer, model,
    lot_number, mfg_month, mfg_year, status, nfc_tag_serial,
    template_id, template_version, overall_pass, discard_reason,
    version, supersedes, is_current, source, captured_at
  ) VALUES (
    v_account, v_asset,
    coalesce(nullif(p->>'work_order_id',''), v_prev.work_order_id),
    v_date,
    -- An inspection is valid for one year.
    coalesce((p->>'next_due_date')::date, v_date + interval '1 year'),
    v_rep, v_user_id, v_user_id, v_who,
    coalesce(v_model_id, v_prev.model_id),
    coalesce(nullif(p->>'item_type',''),    v_prev.item_type),
    coalesce(nullif(p->>'description',''),  v_prev.description),
    coalesce(v_mfr,   v_prev.manufacturer),
    coalesce(v_model, v_prev.model),
    coalesce(nullif(p->>'lot_number',''),   v_prev.lot_number),
    coalesce((p->>'mfg_month')::integer,    v_prev.mfg_month),
    coalesce((p->>'mfg_year')::integer,     v_prev.mfg_year),
    -- Derived from the checks unless the tech explicitly recorded that the item
    -- was already out of date when they found it.
    public.fp_default_status(v_pass, nullif(p->>'status','')),
    coalesce(nullif(p->>'nfc_tag_serial',''), v_prev.nfc_tag_serial),
    coalesce((p->>'template_id')::uuid,     v_prev.template_id),
    coalesce((p->>'template_version')::integer, v_prev.template_version),
    v_pass, v_reason,
    v_version, v_prev.id, true,
    coalesce(p->>'source', 'field'),
    coalesce((p->>'captured_at')::timestamptz, now())
  )
  RETURNING id INTO v_id;

  FOR v_chk IN SELECT * FROM jsonb_array_elements(v_checks) LOOP
    INSERT INTO public.fp_inspection_checks (fp_inspection_id, ord, code, prompt, result, source, note)
    VALUES (
      v_id,
      coalesce((v_chk->>'ord')::integer, v_ord),
      nullif(v_chk->>'code',''),
      coalesce(nullif(v_chk->>'prompt',''), '(no prompt recorded)'),
      (v_chk->>'result')::boolean,
      coalesce(nullif(v_chk->>'source',''), 'template'),
      nullif(v_chk->>'note','')
    );
    v_ord := v_ord + 1;
  END LOOP;

  RETURN v_id;
END;
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.fp_models            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fp_check_templates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fp_template_checks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fp_inspections       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fp_inspection_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inspection_photos    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fp_models_select" ON public.fp_models;
CREATE POLICY "fp_models_select" ON public.fp_models
  FOR SELECT USING (account_id IS NULL OR account_id = public.my_account_id());

DROP POLICY IF EXISTS "fp_templates_select" ON public.fp_check_templates;
CREATE POLICY "fp_templates_select" ON public.fp_check_templates
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.fp_models m WHERE m.id = model_id
      AND (m.account_id IS NULL OR m.account_id = public.my_account_id())));

DROP POLICY IF EXISTS "fp_template_checks_select" ON public.fp_template_checks;
CREATE POLICY "fp_template_checks_select" ON public.fp_template_checks
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.fp_check_templates t
      JOIN public.fp_models m ON m.id = t.model_id
     WHERE t.id = template_id
       AND (m.account_id IS NULL OR m.account_id = public.my_account_id())));

DROP POLICY IF EXISTS "fp_inspections_select" ON public.fp_inspections;
CREATE POLICY "fp_inspections_select" ON public.fp_inspections
  FOR SELECT USING (account_id = public.my_account_id());

DROP POLICY IF EXISTS "fp_inspection_checks_select" ON public.fp_inspection_checks;
CREATE POLICY "fp_inspection_checks_select" ON public.fp_inspection_checks
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.fp_inspections i
     WHERE i.id = fp_inspection_id AND i.account_id = public.my_account_id()));

DROP POLICY IF EXISTS "inspection_photos_select" ON public.inspection_photos;
CREATE POLICY "inspection_photos_select" ON public.inspection_photos
  FOR SELECT USING (account_id = public.my_account_id());

-- No INSERT/UPDATE/DELETE policies: record_fp_inspection() is the only way in,
-- so a client cannot flip is_current, forge an overall_pass, or bypass the
-- "a failed item needs a discard reason" rule.
REVOKE ALL ON public.fp_models, public.fp_check_templates, public.fp_template_checks,
              public.fp_inspections, public.fp_inspection_checks, public.inspection_photos
  FROM anon, authenticated;
GRANT SELECT ON public.fp_models, public.fp_check_templates, public.fp_template_checks,
                public.fp_inspections, public.fp_inspection_checks, public.inspection_photos
  TO authenticated;

-- ── Public certificate view ──────────────────────────────────────────────────
DROP VIEW IF EXISTS public.fall_protection_public;
CREATE VIEW public.fall_protection_public AS
  SELECT
    coalesce(a.serial_raw, '')                          AS serial_num,
    a.serial_key,
    a.public_ref,
    public.certificate_url(a.public_ref, 'fall_protection') AS certificate_url,
    i.inspection_date,
    i.next_due_date,
    i.item_type,
    i.description,
    i.manufacturer,
    i.model,
    i.lot_number,
    i.mfg_month,
    i.mfg_year,
    i.status,
    i.rep_number,
    i.overall_pass,
    i.version,
    i.created_at
    -- Deliberately absent: discard_reason, photos, collected_by, collector_name
    -- and work_order_id. Condemnation evidence and who collected a record are
    -- internal; the public certificate shows pass/fail and nothing more.
  FROM public.fp_inspections i
  JOIN public.assets a ON a.id = i.asset_id
  WHERE i.is_current AND NOT i.is_deleted
  ORDER BY a.serial_key, i.inspection_date DESC;

GRANT SELECT ON public.fall_protection_public TO anon;
GRANT SELECT ON public.fall_protection_public TO authenticated;

-- The checks a certificate displays, with the prompts as they were asked.
DROP VIEW IF EXISTS public.fall_protection_checks_public;
CREATE VIEW public.fall_protection_checks_public AS
  SELECT a.public_ref, i.inspection_date, c.ord, c.prompt, c.result
    FROM public.fp_inspection_checks c
    JOIN public.fp_inspections i ON i.id = c.fp_inspection_id
    JOIN public.assets a         ON a.id = i.asset_id
   WHERE i.is_current AND NOT i.is_deleted
   ORDER BY a.public_ref, i.inspection_date DESC, c.ord;

GRANT SELECT ON public.fall_protection_checks_public TO anon;
GRANT SELECT ON public.fall_protection_checks_public TO authenticated;
