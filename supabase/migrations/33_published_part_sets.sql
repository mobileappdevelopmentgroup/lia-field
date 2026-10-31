-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — part sets the office publishes to the field.
-- Idempotent; safe to re-run. Run AFTER 32_fp_photos.sql.
--
-- Different sites use different parts. Lia Field keeps more than one set of
-- quick-tap buttons ("Main" plus any a tech makes), and this lets the office
-- publish named sets too — "Ford plant", "Hospital" — so a crew arrives at a
-- site with the right buttons without anybody pinning them by hand.
--
-- HOW IT FITS WHAT IS THERE
--
--   * "Main" is still 27's starred parts (account_parts.favorited). Nothing
--     here changes it.
--   * A published set is a name and an ordered list of part numbers. The
--     quantity per tap belongs to the PART (account_parts.default_qty), not the
--     set: a ×2 part is ×2 whichever buttons it is on.
--   * On the phone a published set is read-only. A tech who wants it different
--     copies it into a set of their own, so the office republishing never
--     overwrites a change somebody made, and a tech's change never pretends to
--     be the office's.
--
-- DIRECTION
--
-- Same as every catalogue (18, 27): sets flow DOWN. Batavia's sets reach every
-- crew beneath it; a subcontractor's own sets are theirs alone, and a sibling
-- never sees them.
--
-- CONSOLIDATION
--
-- consolidate_to_one_account() (30) moves every account-scoped table by name
-- and deletes the emptied accounts, so a table it does not know about is
-- silently cascaded away. It is re-emitted at the bottom of this file —
-- extracted mechanically from 30, with one block added for this table.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.account_part_sets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  name_key    text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  -- Ordered part numbers: the order is the button order.
  parts       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parts) = 'array'),
  ord         integer,
  is_deleted  boolean NOT NULL DEFAULT false,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One live set per name per account. Partial, so a deleted "Ford plant" does
-- not stop a new one being made with the same name.
CREATE UNIQUE INDEX IF NOT EXISTS account_part_sets_name_uq
  ON public.account_part_sets (account_id, name_key) WHERE NOT is_deleted;

ALTER TABLE public.account_part_sets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_part_sets_read ON public.account_part_sets;
CREATE POLICY account_part_sets_read ON public.account_part_sets
  FOR SELECT TO authenticated USING (public.can_use_catalog(account_id));

REVOKE INSERT, UPDATE, DELETE ON public.account_part_sets FROM authenticated;
GRANT  SELECT ON public.account_part_sets TO authenticated;

-- ── Authoring ───────────────────────────────────────────────────────────────
-- Takes every set the office is showing and makes the account match: a set
-- with an id is updated (so renaming keeps it the same set on every phone), one
-- without is created, and one that is no longer in the payload is soft-deleted.
--
-- Uses require_lead_account() (26), so it follows an impersonation session the
-- same way save_account_parts() does.
CREATE OR REPLACE FUNCTION public.save_account_part_sets(p jsonb) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_sets    jsonb := coalesce(p->'sets', '[]'::jsonb);
  v_keep    uuid[] := '{}';
  v_id      uuid;
  v_name    text;
  v_parts   jsonb;
  v_n       integer := 0;
  v_i       integer := 0;
  e         jsonb;
BEGIN
  IF jsonb_typeof(v_sets) <> 'array' THEN
    RAISE EXCEPTION 'sets must be a list';
  END IF;

  -- Names are checked before anything is written, so a clash leaves the
  -- account exactly as it was rather than half-saved.
  IF (SELECT count(*) <> count(DISTINCT lower(btrim(x->>'name')))
        FROM jsonb_array_elements(v_sets) x) THEN
    RAISE EXCEPTION 'Two sets have the same name';
  END IF;

  FOR e IN SELECT * FROM jsonb_array_elements(v_sets) LOOP
    v_i := v_i + 1;
    v_name := btrim(coalesce(e->>'name', ''));
    IF v_name = '' THEN RAISE EXCEPTION 'A set needs a name'; END IF;
    IF length(v_name) > 40 THEN RAISE EXCEPTION 'Set names are 40 characters at most'; END IF;

    -- Trimmed, empties dropped, order kept. The same part twice — in any
    -- case — keeps its first position and spelling.
    SELECT coalesce(jsonb_agg(pn ORDER BY n), '[]'::jsonb) INTO v_parts
      FROM (SELECT btrim(x.v) AS pn, x.n,
                   row_number() OVER (PARTITION BY upper(btrim(x.v)) ORDER BY x.n) AS rk
              FROM jsonb_array_elements_text(coalesce(e->'parts', '[]'::jsonb))
                   WITH ORDINALITY AS x(v, n)
             WHERE btrim(x.v) <> '') q
     WHERE rk = 1;

    v_id := NULL;
    IF nullif(e->>'id', '') IS NOT NULL THEN
      UPDATE public.account_part_sets
         SET name = v_name, parts = v_parts, ord = v_i, is_deleted = false, updated_at = now()
       WHERE id = (e->>'id')::uuid AND account_id = v_account
      RETURNING id INTO v_id;
    END IF;
    IF v_id IS NULL THEN
      INSERT INTO public.account_part_sets (account_id, name, parts, ord, created_by)
      VALUES (v_account, v_name, v_parts, v_i, auth.uid())
      RETURNING id INTO v_id;
    END IF;

    v_keep := v_keep || v_id;
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.account_part_sets
     SET is_deleted = true, updated_at = now()
   WHERE account_id = v_account AND NOT is_deleted AND NOT (id = ANY (v_keep));

  RETURN json_build_object('saved', v_n,
    'sets', (SELECT coalesce(json_agg(json_build_object('id', id, 'name', name) ORDER BY ord), '[]'::json)
               FROM public.account_part_sets WHERE account_id = v_account AND NOT is_deleted));
END;
$$;
REVOKE ALL ON FUNCTION public.save_account_part_sets(jsonb) FROM PUBLIC;
GRANT  ALL ON FUNCTION public.save_account_part_sets(jsonb) TO authenticated;

-- ── What a phone (and the office) pulls ─────────────────────────────────────
-- Every live set the caller's account may use: its own, then its umbrella's.
-- Small, so a phone refetches it whole on every sync and replaces what it had
-- — a set missing from the answer is a set the office removed.
--
-- `mine` says whether the set belongs to the caller's own account. The office
-- edits only its own; an umbrella's sets are shown to a subcontractor's office
-- as inherited.
CREATE OR REPLACE FUNCTION public.account_part_sets_catalog()
RETURNS TABLE (id uuid, name text, parts jsonb, ord integer, mine boolean, updated_at timestamptz)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_account uuid := public.my_account_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT s.id, s.name, s.parts, s.ord, (s.account_id = v_account), s.updated_at
    FROM public.account_part_sets s
   WHERE public.can_use_catalog(s.account_id) AND NOT s.is_deleted
   ORDER BY (s.account_id = v_account) DESC, s.ord NULLS LAST, s.name;
END;
$$;
REVOKE ALL ON FUNCTION public.account_part_sets_catalog() FROM PUBLIC;
GRANT  ALL ON FUNCTION public.account_part_sets_catalog() TO authenticated;

-- ── consolidate_to_one_account(), re-emitted from 30 ────────────────────────
-- Verbatim from 30_consolidate_fold_first.sql except the block marked "33".
CREATE OR REPLACE FUNCTION public.consolidate_to_one_account(
  p_lead_user  uuid,
  p_account_name text DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_keep      uuid;
  v_credits   integer;
  v_unlimited boolean;
  v_moved     integer;
  v_adopted   integer;
  v_fp        integer;
  v_folded    integer;
  v_dropped   integer;
  v_clash     text;
BEGIN
  SELECT account_id INTO v_keep FROM public.account_members WHERE user_id = p_lead_user;
  IF v_keep IS NULL THEN
    RAISE EXCEPTION 'That user has no account — run create_lia_user for them first';
  END IF;

  IF EXISTS (SELECT 1 FROM public.accounts WHERE parent_account_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Accounts are arranged under an umbrella; consolidating would merge separate companies. Refusing — unlink them first if that is really intended.';
  END IF;

  SELECT string_agg(s, ', ') INTO v_clash FROM (
    SELECT lower(slug) AS s FROM public.fp_equipment_types
     WHERE account_id IS NOT NULL GROUP BY lower(slug) HAVING count(*) > 1) x;
  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION 'More than one account defines its own equipment type "%"; merge those by hand first', v_clash;
  END IF;

  -- Credits: unlimited anywhere wins, otherwise sum them. Summing is the
  -- conservative choice — these balances were bought.
  SELECT bool_or(credits = -1), sum(GREATEST(credits, 0))
    INTO v_unlimited, v_credits FROM public.accounts;

  UPDATE public.accounts
     SET credits = CASE WHEN v_unlimited THEN -1 ELSE coalesce(v_credits, 0) END,
         name = coalesce(nullif(p_account_name, ''), name)
   WHERE id = v_keep;

  -- Everyone joins it. The nominated user leads; everyone else collects.
  UPDATE public.account_members
     SET account_id = v_keep,
         role = CASE WHEN user_id = p_lead_user THEN 'lead' ELSE 'tech' END,
         desktop_access = (user_id = p_lead_user)
   WHERE account_id <> v_keep OR user_id = p_lead_user;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  -- ── 1. Items: fold same-serial duplicates BEFORE anything moves ──────────
  -- The kept account's own item wins, then the oldest.
  DROP TABLE IF EXISTS _lia_fold;
  CREATE TEMP TABLE _lia_fold ON COMMIT DROP AS
    SELECT id, keep_id, dense_rank() OVER (PARTITION BY keep_id ORDER BY id) AS k
      FROM (SELECT id, first_value(id) OVER (
                     PARTITION BY kind, serial_key
                     ORDER BY (account_id = v_keep) DESC NULLS LAST, created_at, id) AS keep_id
              FROM public.assets) r
     WHERE id <> keep_id;

  -- Identifiers the survivor lacks come across; a tag on either still resolves.
  UPDATE public.assets a
     SET tag_label   = coalesce(a.tag_label, l.tag_label),
         nfc_tag_uid = coalesce(a.nfc_tag_uid, l.nfc_tag_uid),
         tag_url     = coalesce(a.tag_url, l.tag_url)
    FROM (SELECT DISTINCT ON (f.keep_id) f.keep_id, x.tag_label, x.nfc_tag_uid, x.tag_url
            FROM _lia_fold f JOIN public.assets x ON x.id = f.id
           ORDER BY f.keep_id, x.created_at) l
   WHERE a.id = l.keep_id;

  -- One current record per item per day: the newest stays current, the rest
  -- are superseded — which is what a second capture would have done anyway.
  WITH g AS (
    SELECT i.id, row_number() OVER (PARTITION BY coalesce(f.keep_id, i.asset_id), i.inspection_date
                                    ORDER BY i.created_at DESC, i.id DESC) AS rn
      FROM public.inspections i LEFT JOIN _lia_fold f ON f.id = i.asset_id
     WHERE i.is_current AND NOT i.is_deleted
       AND coalesce(f.keep_id, i.asset_id) IN (SELECT keep_id FROM _lia_fold))
  UPDATE public.inspections i SET is_current = false, updated_at = now()
    FROM g WHERE i.id = g.id AND g.rn > 1;

  WITH g AS (
    SELECT i.id, row_number() OVER (PARTITION BY coalesce(f.keep_id, i.asset_id), i.inspection_date
                                    ORDER BY i.created_at DESC, i.id DESC) AS rn
      FROM public.fp_inspections i LEFT JOIN _lia_fold f ON f.id = i.asset_id
     WHERE i.is_current AND NOT i.is_deleted
       AND coalesce(f.keep_id, i.asset_id) IN (SELECT keep_id FROM _lia_fold))
  UPDATE public.fp_inspections i SET is_current = false, updated_at = now()
    FROM g WHERE i.id = g.id AND g.rn > 1;

  -- Ladder records are unique on (item, day, version) and that constraint is
  -- checked row by row, so versions are moved clear of each other before the
  -- re-point and renumbered 1..n per day afterwards.
  UPDATE public.inspections i SET version = i.version + 10000000 * f.k
    FROM _lia_fold f WHERE i.asset_id = f.id;

  UPDATE public.inspections       t SET asset_id = f.keep_id FROM _lia_fold f WHERE t.asset_id = f.id;
  UPDATE public.fp_inspections    t SET asset_id = f.keep_id FROM _lia_fold f WHERE t.asset_id = f.id;
  UPDATE public.certificate_views t SET asset_id = f.keep_id FROM _lia_fold f WHERE t.asset_id = f.id;
  UPDATE public.fp_external_records t SET asset_id = f.keep_id FROM _lia_fold f WHERE t.asset_id = f.id;
  UPDATE public.fp_record_audit   t SET asset_id = f.keep_id FROM _lia_fold f WHERE t.asset_id = f.id;
  UPDATE public.fp_tag_links      t SET asset_id = f.keep_id FROM _lia_fold f WHERE t.asset_id = f.id;
  UPDATE public.fp_tag_stock      t SET asset_id = f.keep_id FROM _lia_fold f WHERE t.asset_id = f.id;
  UPDATE public.fp_tag_writes     t SET asset_id = f.keep_id FROM _lia_fold f WHERE t.asset_id = f.id;

  WITH r AS (
    SELECT id, row_number() OVER (PARTITION BY asset_id, inspection_date ORDER BY version, created_at, id) AS rn
      FROM public.inspections WHERE asset_id IN (SELECT keep_id FROM _lia_fold))
  UPDATE public.inspections i SET version = r.rn + 2000000000 - 10000000 FROM r WHERE i.id = r.id;
  UPDATE public.inspections SET version = version - (2000000000 - 10000000)
   WHERE asset_id IN (SELECT keep_id FROM _lia_fold) AND version > 1000000000;

  DELETE FROM public.assets WHERE id IN (SELECT id FROM _lia_fold);
  GET DIAGNOSTICS v_folded = ROW_COUNT;

  -- Nothing can clash now.
  UPDATE public.assets SET account_id = v_keep WHERE account_id IS DISTINCT FROM v_keep;
  UPDATE public.inspections SET account_id = v_keep WHERE account_id IS DISTINCT FROM v_keep;
  GET DIAGNOSTICS v_adopted = ROW_COUNT;
  UPDATE public.fp_inspections SET account_id = v_keep WHERE account_id IS DISTINCT FROM v_keep;
  GET DIAGNOSTICS v_fp = ROW_COUNT;

  -- ── 2. Work orders and jobs ───────────────────────────────────────────────
  -- Two accounts may each hold the same work order number — that namespacing
  -- is the point of UNIQUE (account, wo_key). Keep the one actually charged
  -- (earliest wins on a tie), re-point EVERYTHING at it, drop the rest. Never
  -- charge twice for what is now one order.
  DROP TABLE IF EXISTS _lia_wo;
  CREATE TEMP TABLE _lia_wo ON COMMIT DROP AS
    SELECT id, keep_id FROM (
      SELECT id, first_value(id) OVER (
               PARTITION BY wo_key
               ORDER BY (charged_at IS NULL), charged_at NULLS LAST, created_at, id) AS keep_id
        FROM public.work_orders) r
     WHERE id <> keep_id;

  -- A job per work order per account: fold jobs the same way, keeping every
  -- assignment.
  DROP TABLE IF EXISTS _lia_jobs;
  CREATE TEMP TABLE _lia_jobs ON COMMIT DROP AS
    SELECT id, keep_id FROM (
      SELECT id, first_value(id) OVER (
               PARTITION BY wo_key ORDER BY (account_id = v_keep) DESC, created_at, id) AS keep_id
        FROM public.jobs) r
     WHERE id <> keep_id;
  INSERT INTO public.job_assignees (job_id, user_id, assigned_by, assigned_at)
  SELECT j.keep_id, a.user_id, a.assigned_by, a.assigned_at
    FROM public.job_assignees a JOIN _lia_jobs j ON j.id = a.job_id
  ON CONFLICT (job_id, user_id) DO NOTHING;
  DELETE FROM public.jobs WHERE id IN (SELECT id FROM _lia_jobs);

  UPDATE public.usage_log      t SET work_order_uuid = w.keep_id FROM _lia_wo w WHERE t.work_order_uuid = w.id;
  UPDATE public.inspections    t SET work_order_uuid = w.keep_id FROM _lia_wo w WHERE t.work_order_uuid = w.id;
  UPDATE public.fp_inspections t SET work_order_uuid = w.keep_id FROM _lia_wo w WHERE t.work_order_uuid = w.id;
  UPDATE public.jobs           t SET work_order_uuid = w.keep_id FROM _lia_wo w WHERE t.work_order_uuid = w.id;
  DELETE FROM public.work_orders WHERE id IN (SELECT id FROM _lia_wo);

  UPDATE public.work_orders SET account_id = v_keep WHERE account_id IS DISTINCT FROM v_keep;
  UPDATE public.jobs        SET account_id = v_keep WHERE account_id IS DISTINCT FROM v_keep;
  UPDATE public.usage_log   SET account_id = v_keep WHERE account_id IS DISTINCT FROM v_keep;

  -- ── 3. Catalogues ─────────────────────────────────────────────────────────
  -- Models: one per manufacturer + model; records and model checklists follow.
  DROP TABLE IF EXISTS _lia_models;
  CREATE TEMP TABLE _lia_models ON COMMIT DROP AS
    SELECT id, keep_id FROM (
      SELECT id, first_value(id) OVER (
               PARTITION BY lower(manufacturer), lower(model)
               ORDER BY (account_id = v_keep) DESC, created_at, id) AS keep_id
        FROM public.fp_models WHERE account_id IS NOT NULL) r
     WHERE id <> keep_id;
  UPDATE public.fp_inspections     t SET model_id = m.keep_id FROM _lia_models m WHERE t.model_id = m.id;
  UPDATE public.fp_check_templates t SET model_id = m.keep_id FROM _lia_models m WHERE t.model_id = m.id;
  DELETE FROM public.fp_models WHERE id IN (SELECT id FROM _lia_models);
  UPDATE public.fp_models SET account_id = v_keep WHERE account_id IS NOT NULL AND account_id <> v_keep;

  -- Custom equipment types: clashes were refused above, so this is a move.
  UPDATE public.fp_equipment_types SET account_id = v_keep WHERE account_id IS NOT NULL AND account_id <> v_keep;

  -- Parts: the kept account's entry wins.
  DELETE FROM public.account_parts p USING (
    SELECT id, row_number() OVER (PARTITION BY part_key
                                  ORDER BY (account_id = v_keep) DESC, created_at, id) AS rn
      FROM public.account_parts) r
   WHERE p.id = r.id AND r.rn > 1;
  UPDATE public.account_parts SET account_id = v_keep WHERE account_id <> v_keep;

  -- ── 4. Everything else scoped to an account ──────────────────────────────
  -- Tag links are one row per link per account: fold the sightings together.
  WITH r AS (
    SELECT id, first_value(id) OVER (PARTITION BY tag_url_key
                                     ORDER BY (account_id = v_keep) DESC, first_seen_at, id) AS keep_id
      FROM public.fp_tag_links),
  agg AS (
    SELECT r.keep_id, sum(l.seen_count) AS seen, min(l.first_seen_at) AS first_seen,
           max(l.last_seen_at) AS last_seen
      FROM r JOIN public.fp_tag_links l ON l.id = r.id GROUP BY r.keep_id HAVING count(*) > 1)
  UPDATE public.fp_tag_links l
     SET seen_count = agg.seen, first_seen_at = agg.first_seen, last_seen_at = agg.last_seen
    FROM agg WHERE l.id = agg.keep_id;
  DELETE FROM public.fp_tag_links l USING (
    SELECT id, row_number() OVER (PARTITION BY tag_url_key
                                  ORDER BY (account_id = v_keep) DESC, first_seen_at, id) AS rn
      FROM public.fp_tag_links) r
   WHERE l.id = r.id AND r.rn > 1;
  UPDATE public.fp_tag_links SET account_id = v_keep WHERE account_id <> v_keep;

  -- Claimed records: one per link per claimed date.
  DELETE FROM public.fp_external_records e USING (
    SELECT id, row_number() OVER (
             PARTITION BY source_url_key, coalesce(claimed_inspection_date, '1970-01-01'::date)
             ORDER BY (account_id = v_keep) DESC, created_at, id) AS rn
      FROM public.fp_external_records) r
   WHERE e.id = r.id AND r.rn > 1;
  UPDATE public.fp_external_records SET account_id = v_keep WHERE account_id <> v_keep;

  UPDATE public.fp_tag_stock      SET account_id = v_keep WHERE account_id <> v_keep;
  UPDATE public.fp_tag_writes     SET account_id = v_keep WHERE account_id <> v_keep;
  UPDATE public.fp_record_audit   SET account_id = v_keep WHERE account_id <> v_keep;
  UPDATE public.inspection_audit  SET account_id = v_keep WHERE account_id <> v_keep;
  UPDATE public.inspection_photos SET account_id = v_keep WHERE account_id <> v_keep;
  UPDATE public.certificate_views SET account_id = v_keep WHERE account_id IS NOT NULL AND account_id <> v_keep;
  UPDATE public.known_networks    SET account_id = v_keep WHERE account_id IS NOT NULL AND account_id <> v_keep;
  UPDATE public.support_tickets   SET account_id = v_keep WHERE account_id IS NOT NULL AND account_id <> v_keep;

  -- 33: published part sets. A clash on a live name keeps the kept account's
  -- set; the other is tombstoned rather than dropped, like every catalogue.
  UPDATE public.account_part_sets s SET is_deleted = true, updated_at = now()
    FROM (SELECT id, row_number() OVER (PARTITION BY name_key
                                        ORDER BY (account_id = v_keep) DESC, created_at, id) AS rn
            FROM public.account_part_sets WHERE NOT is_deleted) r
   WHERE s.id = r.id AND r.rn > 1;
  UPDATE public.account_part_sets SET account_id = v_keep WHERE account_id <> v_keep;

  -- Only accounts nobody belongs to any more, and nothing is left in them.
  DELETE FROM public.accounts
   WHERE id <> v_keep
     AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = accounts.id);
  GET DIAGNOSTICS v_dropped = ROW_COUNT;

  RETURN json_build_object(
    'account_id',        v_keep,
    'members',           v_moved,
    'inspections_moved', v_adopted,
    'fp_moved',          v_fp,
    'items_folded',      v_folded,
    'accounts_removed',  v_dropped,
    'credits',           (SELECT credits FROM public.accounts WHERE id = v_keep)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.consolidate_to_one_account(uuid, text) FROM PUBLIC, anon, authenticated;
