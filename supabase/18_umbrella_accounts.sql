-- ═══════════════════════════════════════════════════════════════════════════
-- Lia Umbrella Accounts — safe to re-run; idempotent
--
-- Run AFTER 17_tag_write.sql.
--
-- Batavia holds the contracts and parses the work out to lead subcontractors,
-- each of whom runs their own operation and hires their own field people.
-- Until now an account was flat: one company, its members, and everything
-- scoped by account_id. That cannot express "Batavia's contract, Michael's
-- crew" — and two leads inside one account would see each other's work.
--
-- So accounts gain a parent, and visibility runs in TWO DIRECTIONS:
--
--   WORK FLOWS UP.      Batavia sees every record its subcontractors produce.
--                       A subcontractor sees only their own — never a sibling's,
--                       never the umbrella's.
--   CATALOGUE FLOWS DOWN. An equipment type or model defined by Batavia is
--                       usable by every subcontractor under it, the same way a
--                       NULL account_id row is shared by everybody. A
--                       subcontractor's own catalogue entry stays theirs.
--
-- Getting these backwards is the whole risk: expand the catalogue upward and a
-- sub's private entry leaks sideways through the umbrella; expand work downward
-- and one subcontractor reads another's inspections.
--
-- ⚠️ This migration changes NOTHING on its own. Every existing account has a
-- NULL parent, so can_see() and can_use_catalog() both collapse to exactly the
-- old "= my_account_id()" behaviour. The hierarchy only starts existing when
-- accounts are linked — see supabase/ops/.
--
-- WRITES ARE NOT EXPANDED HERE. The umbrella can read a subcontractor's work;
-- it cannot record an inspection as them. Corrections are a separate, narrower
-- grant made in 19.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The parent link ─────────────────────────────────────────────────────────
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS parent_account_id uuid REFERENCES public.accounts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS accounts_parent_idx
  ON public.accounts(parent_account_id) WHERE parent_account_id IS NOT NULL;

-- ON DELETE RESTRICT, not CASCADE: deleting Batavia must never silently delete
-- every subcontractor account and, through their own cascades, their records.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_parent_not_self') THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_parent_not_self
      CHECK (parent_account_id IS NULL OR parent_account_id <> id);
  END IF;
END $$;

-- A cycle would make every walk below run forever. The CHECK above catches the
-- one-step case; this catches A → B → A.
CREATE OR REPLACE FUNCTION public.accounts_no_cycle()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_seen uuid[] := ARRAY[NEW.id];
  v_at   uuid   := NEW.parent_account_id;
BEGIN
  WHILE v_at IS NOT NULL LOOP
    IF v_at = ANY(v_seen) THEN
      RAISE EXCEPTION 'Account hierarchy cycle: % cannot be under %', NEW.id, NEW.parent_account_id;
    END IF;
    v_seen := v_seen || v_at;
    IF array_length(v_seen, 1) > 20 THEN
      RAISE EXCEPTION 'Account hierarchy deeper than 20 — refusing';
    END IF;
    SELECT parent_account_id INTO v_at FROM public.accounts WHERE id = v_at;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_no_cycle_trg ON public.accounts;
CREATE TRIGGER accounts_no_cycle_trg
  BEFORE INSERT OR UPDATE OF parent_account_id ON public.accounts
  FOR EACH ROW WHEN (NEW.parent_account_id IS NOT NULL)
  EXECUTE FUNCTION public.accounts_no_cycle();

-- ── Walking the tree ────────────────────────────────────────────────────────
-- Both walks INCLUDE the starting account, so an account with no parent and no
-- children resolves to itself and every rule below behaves as it did before.

-- Self and everything under it. This is the umbrella's reach.
CREATE OR REPLACE FUNCTION public.account_descendants(p_account uuid)
RETURNS TABLE (account_id uuid) LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  WITH RECURSIVE tree AS (
    SELECT a.id FROM public.accounts a WHERE a.id = p_account
    UNION
    SELECT a.id FROM public.accounts a JOIN tree t ON a.parent_account_id = t.id
  )
  SELECT id FROM tree;
$$;

-- Self and everything above it. This is what a subcontractor inherits.
CREATE OR REPLACE FUNCTION public.account_ancestors(p_account uuid)
RETURNS TABLE (account_id uuid) LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  WITH RECURSIVE chain AS (
    SELECT a.id, a.parent_account_id FROM public.accounts a WHERE a.id = p_account
    UNION
    SELECT a.id, a.parent_account_id FROM public.accounts a JOIN chain c ON a.id = c.parent_account_id
  )
  SELECT id FROM chain;
$$;

-- The top of the tree — the organisation that stands behind the certificate.
CREATE OR REPLACE FUNCTION public.account_root(p_account uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE v_at uuid := p_account; v_parent uuid; v_depth integer := 0;
BEGIN
  LOOP
    SELECT parent_account_id INTO v_parent FROM public.accounts WHERE id = v_at;
    EXIT WHEN v_parent IS NULL;
    v_at := v_parent;
    v_depth := v_depth + 1;
    EXIT WHEN v_depth > 20;   -- the trigger prevents cycles; this is the belt
  END LOOP;
  RETURN v_at;
END;
$$;

-- ── What the caller may see ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.visible_account_ids()
RETURNS TABLE (account_id uuid) LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT d.account_id FROM public.account_descendants(public.my_account_id()) d;
$$;

CREATE OR REPLACE FUNCTION public.catalog_account_ids()
RETURNS TABLE (account_id uuid) LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT a.account_id FROM public.account_ancestors(public.my_account_id()) a;
$$;

-- The two predicates every policy below is written in terms of.
CREATE OR REPLACE FUNCTION public.can_see(p_account uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT p_account IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.visible_account_ids() v WHERE v.account_id = p_account);
$$;

-- NULL means shared by everyone — the fourteen standard equipment types.
CREATE OR REPLACE FUNCTION public.can_use_catalog(p_account uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT p_account IS NULL
      OR EXISTS (SELECT 1 FROM public.catalog_account_ids() c WHERE c.account_id = p_account);
$$;

REVOKE ALL ON FUNCTION public.account_descendants(uuid)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.account_ancestors(uuid)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.account_root(uuid)         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.visible_account_ids()      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.catalog_account_ids()      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_see(uuid)              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_use_catalog(uuid)      FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.account_descendants(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_ancestors(uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_root(uuid)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.visible_account_ids()     TO authenticated;
GRANT EXECUTE ON FUNCTION public.catalog_account_ids()     TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_see(uuid)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_use_catalog(uuid)     TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Work flows UP — the umbrella reads its subcontractors' records
-- ═══════════════════════════════════════════════════════════════════════════
-- Every one of these previously read `account_id = public.my_account_id()`.
-- can_see() is that same test plus descendants, so an unlinked account is
-- unaffected.

DROP POLICY IF EXISTS "assets_select_own" ON public.assets;
CREATE POLICY "assets_select_own" ON public.assets
  FOR SELECT USING (public.can_see(account_id));

DROP POLICY IF EXISTS "inspections_select_own" ON public.inspections;
CREATE POLICY "inspections_select_own" ON public.inspections
  FOR SELECT USING (public.can_see(account_id));

DROP POLICY IF EXISTS "work_orders_select_own" ON public.work_orders;
CREATE POLICY "work_orders_select_own" ON public.work_orders
  FOR SELECT USING (public.can_see(account_id));

DROP POLICY IF EXISTS "accounts_select_own" ON public.accounts;
CREATE POLICY "accounts_select_own" ON public.accounts
  FOR SELECT USING (public.can_see(id));

-- The office asks "who actually did this?" — so the umbrella must be able to
-- read its subcontractors' memberships. This is the back-office half of the
-- attribution rule: the field person is recorded and visible here, and kept
-- off the certificate.
DROP POLICY IF EXISTS "account_members_select_own" ON public.account_members;
CREATE POLICY "account_members_select_own" ON public.account_members
  FOR SELECT USING (public.can_see(account_id));

DROP POLICY IF EXISTS "fp_inspections_select" ON public.fp_inspections;
CREATE POLICY "fp_inspections_select" ON public.fp_inspections
  FOR SELECT USING (public.can_see(account_id));

DROP POLICY IF EXISTS "fp_inspection_checks_select" ON public.fp_inspection_checks;
CREATE POLICY "fp_inspection_checks_select" ON public.fp_inspection_checks
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.fp_inspections i
     WHERE i.id = fp_inspection_id AND public.can_see(i.account_id)));

DROP POLICY IF EXISTS "inspection_photos_select" ON public.inspection_photos;
CREATE POLICY "inspection_photos_select" ON public.inspection_photos
  FOR SELECT USING (public.can_see(account_id));

DROP POLICY IF EXISTS "fp_tag_links_read" ON public.fp_tag_links;
CREATE POLICY "fp_tag_links_read" ON public.fp_tag_links
  FOR SELECT TO authenticated USING (public.can_see(account_id));

DROP POLICY IF EXISTS "fp_external_read" ON public.fp_external_records;
CREATE POLICY "fp_external_read" ON public.fp_external_records
  FOR SELECT TO authenticated USING (public.can_see(account_id));

DROP POLICY IF EXISTS "fp_tag_writes_read" ON public.fp_tag_writes;
CREATE POLICY "fp_tag_writes_read" ON public.fp_tag_writes
  FOR SELECT USING (public.can_see(account_id));

DROP POLICY IF EXISTS "fp_record_audit_read" ON public.fp_record_audit;
CREATE POLICY "fp_record_audit_read" ON public.fp_record_audit
  FOR SELECT TO authenticated USING (public.can_see(account_id));

DROP POLICY IF EXISTS "jobs_select_own" ON public.jobs;
CREATE POLICY "jobs_select_own" ON public.jobs
  FOR SELECT USING (public.can_see(account_id));

DROP POLICY IF EXISTS "job_assignees_select_own" ON public.job_assignees;
CREATE POLICY "job_assignees_select_own" ON public.job_assignees
  FOR SELECT USING (job_id IN (SELECT id FROM public.jobs WHERE public.can_see(account_id)));

DROP POLICY IF EXISTS "certificate_views_read" ON public.certificate_views;
CREATE POLICY "certificate_views_read" ON public.certificate_views
  FOR SELECT TO authenticated USING (public.can_see(account_id) OR public.is_developer());

-- Support tickets are deliberately NOT expanded. A ticket is a conversation
-- between one person and the developer; the umbrella reading its
-- subcontractors' support threads is a different decision from reading their
-- work, and nobody has made it.

-- ═══════════════════════════════════════════════════════════════════════════
-- Catalogue flows DOWN — a subcontractor inherits the umbrella's entries
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "fp_models_select" ON public.fp_models;
CREATE POLICY "fp_models_select" ON public.fp_models
  FOR SELECT USING (public.can_use_catalog(account_id));

DROP POLICY IF EXISTS "fp_equipment_types_select" ON public.fp_equipment_types;
CREATE POLICY "fp_equipment_types_select" ON public.fp_equipment_types
  FOR SELECT USING (public.can_use_catalog(account_id));

DROP POLICY IF EXISTS "fp_templates_select" ON public.fp_check_templates;
CREATE POLICY "fp_templates_select" ON public.fp_check_templates
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.fp_models m WHERE m.id = model_id
              AND public.can_use_catalog(m.account_id))
    OR EXISTS (SELECT 1 FROM public.fp_equipment_types et WHERE et.id = equipment_type_id
              AND public.can_use_catalog(et.account_id)));

DROP POLICY IF EXISTS "fp_template_checks_select" ON public.fp_template_checks;
CREATE POLICY "fp_template_checks_select" ON public.fp_template_checks
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.fp_check_templates t
     WHERE t.id = template_id
       AND (EXISTS (SELECT 1 FROM public.fp_models m WHERE m.id = t.model_id
                      AND public.can_use_catalog(m.account_id))
         OR EXISTS (SELECT 1 FROM public.fp_equipment_types et WHERE et.id = t.equipment_type_id
                      AND public.can_use_catalog(et.account_id)))));

-- Network labels on the Certificate Views screen are reference data a lead
-- maintains, so they inherit downward like the catalogue.
DROP POLICY IF EXISTS "known_networks_read" ON public.known_networks;
CREATE POLICY "known_networks_read" ON public.known_networks
  FOR SELECT TO authenticated USING (public.can_use_catalog(account_id));

-- ── Onboarding a lead subcontractor ─────────────────────────────────────────
-- One call, because this will be done repeatedly and the failure mode of doing
-- it by hand is an account in the wrong place in the tree — which is invisible
-- until somebody sees work they should not.
--
--   SELECT public.create_subcontractor(
--     '<their auth.users id>', 'them@example.com', 'Their Company', '738',
--     '<umbrella account id>');
--
-- Their credits start at 0: they are billed on their own account, and a
-- balance is set deliberately rather than inherited by accident.
CREATE OR REPLACE FUNCTION public.create_subcontractor(
  p_user_id    uuid,
  p_email      text,
  p_name       text,
  p_rep_number text,
  p_parent     uuid,
  p_credits    integer DEFAULT 0
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid;
  v_existing uuid;
BEGIN
  IF p_rep_number IS NULL OR btrim(p_rep_number) = '' THEN
    RAISE EXCEPTION 'A lead subcontractor needs their technician number: it is what the certificate names.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'No auth.users row for % — invite them first.', p_user_id;
  END IF;
  IF p_parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_parent) THEN
    RAISE EXCEPTION 'Umbrella account % does not exist.', p_parent;
  END IF;

  SELECT account_id INTO v_existing FROM public.account_members WHERE user_id = p_user_id;

  IF v_existing IS NULL THEN
    INSERT INTO public.accounts (name, credits, parent_account_id)
    VALUES (coalesce(nullif(btrim(p_name), ''), p_email), p_credits, p_parent)
    RETURNING id INTO v_account;

    INSERT INTO public.users (id, email, name, credits)
    VALUES (p_user_id, p_email, p_name, 0)
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name;

    INSERT INTO public.account_members (user_id, account_id, role, desktop_access, rep_number)
    VALUES (p_user_id, v_account, 'lead', true, btrim(p_rep_number));
  ELSE
    -- Already provisioned. Settle the parts this call is authoritative for and
    -- leave the account where it is: moving an account that already holds work
    -- is a data migration, not a provisioning call.
    v_account := v_existing;
    UPDATE public.account_members
       SET role = 'lead', desktop_access = true, rep_number = btrim(p_rep_number)
     WHERE user_id = p_user_id;
    UPDATE public.accounts SET parent_account_id = p_parent
     WHERE id = v_account AND parent_account_id IS NULL AND p_parent IS NOT NULL;
  END IF;

  RETURN v_account;
END;
$$;

-- ── Onboarding a field person under a lead ──────────────────────────────────
-- The lead does this for their own crew. A sub-sub-contractor is a 'tech' in
-- the lead's account: they inherit the catalogue, their work counts toward the
-- account, and they carry NO rep number — the certificate names the lead.
CREATE OR REPLACE FUNCTION public.add_crew_member(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_account uuid;
  v_role    text;
  v_user    uuid := (p->>'user_id')::uuid;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT account_id, role INTO v_account, v_role
    FROM public.account_members WHERE user_id = v_caller;
  IF v_account IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;
  IF v_role IS DISTINCT FROM 'lead' THEN
    RAISE EXCEPTION 'Only a lead can add crew members';
  END IF;
  IF v_user IS NULL THEN RAISE EXCEPTION 'user_id is required (their id from Auth → Users)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user) THEN
    RAISE EXCEPTION 'No auth.users row for % — invite them first.', v_user;
  END IF;

  INSERT INTO public.users (id, email, name, credits)
  VALUES (v_user, p->>'email', nullif(btrim(coalesce(p->>'name','')), ''), 0)
  ON CONFLICT (id) DO UPDATE
    SET email = coalesce(EXCLUDED.email, public.users.email),
        name  = coalesce(EXCLUDED.name,  public.users.name);

  INSERT INTO public.account_members (user_id, account_id, role, desktop_access, rep_number, invited_by)
  VALUES (v_user, v_account, 'tech', false, NULL, v_caller)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN v_account;
END;
$$;

-- create_subcontractor is provisioning, done by whoever administers the
-- umbrella through the SQL editor — not reachable from a client.
REVOKE ALL ON FUNCTION public.create_subcontractor(uuid, text, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_crew_member(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_crew_member(jsonb) TO authenticated;
