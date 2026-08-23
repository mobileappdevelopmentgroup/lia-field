-- ═══════════════════════════════════════════════════════════════════
-- Lia Fall Protection Authoring — safe to re-run; idempotent
--
-- Run AFTER 08_device_snapshot.sql.
--
-- Writes for the catalogue screen in Lia Office. Both are SECURITY DEFINER for
-- the same reason every other write path is: the tables have no INSERT or
-- UPDATE policy, so a client cannot edit a checklist directly.
--
-- Only a LEAD may author. A sub-tech is a collection point — letting one change
-- what every other tech is asked would be a quiet way to weaken an inspection.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.require_lead()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE v_account uuid; v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT account_id, role INTO v_account, v_role
    FROM public.account_members WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;
  IF v_role <> 'lead' THEN
    RAISE EXCEPTION 'Only a lead technician can change the catalogue';
  END IF;
  RETURN v_account;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_fp_model(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.require_lead();
  v_id      uuid := nullif(p->>'id','')::uuid;
  v_mfr     text := nullif(trim(coalesce(p->>'manufacturer','')), '');
  v_model   text := nullif(trim(coalesce(p->>'model','')), '');
BEGIN
  IF v_mfr IS NULL OR v_model IS NULL THEN
    RAISE EXCEPTION 'A manufacturer and model are required';
  END IF;

  IF v_id IS NOT NULL THEN
    UPDATE public.fp_models
       SET manufacturer = v_mfr,
           model = v_model,
           item_type = nullif(p->>'item_type',''),
           has_impact_indicator = coalesce((p->>'has_impact_indicator')::boolean, false)
     WHERE id = v_id AND account_id = v_account;
    IF NOT FOUND THEN RAISE EXCEPTION 'That model is not on your account'; END IF;
    RETURN v_id;
  END IF;

  INSERT INTO public.fp_models (account_id, manufacturer, model, item_type,
                                has_impact_indicator, created_by)
  VALUES (v_account, v_mfr, v_model, nullif(p->>'item_type',''),
          coalesce((p->>'has_impact_indicator')::boolean, false), auth.uid())
  ON CONFLICT (coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
               lower(manufacturer), lower(model))
  DO UPDATE SET item_type = EXCLUDED.item_type,
                has_impact_indicator = EXCLUDED.has_impact_indicator
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Publishing always creates a NEW version rather than editing the current one.
-- Inspections pin the version they were performed against, so a past
-- certificate keeps showing the questions that were actually asked.
CREATE OR REPLACE FUNCTION public.publish_fp_checks(p_model_id uuid, p_checks jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.require_lead();
  v_version integer;
  v_tpl     uuid;
  v_chk     jsonb;
  v_ord     integer := 0;
  v_count   integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.fp_models
                  WHERE id = p_model_id AND account_id = v_account) THEN
    RAISE EXCEPTION 'That model is not on your account';
  END IF;

  SELECT coalesce(max(version), 0) + 1 INTO v_version
    FROM public.fp_check_templates WHERE model_id = p_model_id;

  INSERT INTO public.fp_check_templates (model_id, version, published_at, created_by)
  VALUES (p_model_id, v_version, now(), auth.uid())
  RETURNING id INTO v_tpl;

  FOR v_chk IN SELECT * FROM jsonb_array_elements(coalesce(p_checks, '[]'::jsonb)) LOOP
    CONTINUE WHEN nullif(trim(coalesce(v_chk->>'prompt','')), '') IS NULL;
    INSERT INTO public.fp_template_checks (template_id, ord, code, prompt, required)
    VALUES (v_tpl, v_ord, nullif(v_chk->>'code',''),
            trim(v_chk->>'prompt'),
            coalesce((v_chk->>'required')::boolean, true));
    v_ord := v_ord + 1;
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'A published checklist needs at least one check';
  END IF;

  RETURN json_build_object('version', v_version, 'checks', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.save_fp_model(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.publish_fp_checks(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.require_lead() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_fp_model(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_fp_checks(uuid, jsonb) TO authenticated;
