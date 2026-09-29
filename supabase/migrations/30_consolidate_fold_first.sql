-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — consolidate_to_one_account(), made safe to run.
-- Idempotent; safe to re-run. Run AFTER 29_fp_tag_stock_field.sql.
--
-- 10 wrote this for the day two accounts had to become one. It has not been
-- run since, the schema grew around it, and it had three defects:
--
--   1. It MOVED items into the kept account and only then tried to fold
--      same-serial duplicates. assets_account_kind_serial_uq fires on the move,
--      so two accounts holding one serial made it fail outright; the fold below
--      the move could never run.
--
--   2. It moved eight tables and deleted every emptied account. Eleven other
--      tables hang off accounts with ON DELETE CASCADE — jobs, tag writes, tag
--      links, tag stock, certificate views, photos, both audits, known networks,
--      the parts catalogue, custom equipment types — and were silently deleted
--      with the account. Two others lost their account (SET NULL).
--
--   3. Folding work orders re-pointed ladder inspections and usage but not
--      fall-protection records or jobs, so the delete either failed on
--      fp_inspections' foreign key or took the jobs with it. And it deleted any
--      item with no inspection, which also removed items that had only had a
--      tag written (fp_tag_writes cascades).
--
-- Now: items are folded FIRST, across accounts, with everything that points at
-- them re-pointed; then every account-scoped table moves; collisions on the
-- small unique keys are merged, and the one it cannot merge safely (two
-- accounts' own equipment types with the same slug) stops it with a message.
--
-- ⚠ It REFUSES while any account sits under an umbrella (18). The umbrella
-- shape exists to keep companies apart, and this function's whole job is to
-- put everything in one account — on today's live database that would merge
-- Nate's and Michael's companies. Unlink the accounts first if that is really
-- what is meant.
--
-- Folding two items keeps one certificate code. Tags carrying the other one
-- still resolve on the certificate site through the serial they also carry
-- (17: our links are ?t=<ref>&s=<serial>), but the code itself stops matching.
-- ═══════════════════════════════════════════════════════════════════════════

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
