-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — numbers for defective equipment that has no tag.
-- Idempotent; safe to re-run. Run AFTER 35_fp_history_import.sql.
--
-- Field report, 2026-10-14: an item found defective with no tag on it still
-- needs a number to be recorded and removed under, and putting an NFC tag on a
-- harness that is about to be thrown away wastes the tag. Batavia keeps a
-- spreadsheet of assigned serial numbers that are not tied to any tag. Those
-- numbers come in here, and the phone hands out the next one.
--
-- The number IS the item's serial — Batavia's assigned number is the primary
-- identifier (2026-10-14). No tag label, no link: the item carries no tag.
--
-- TWO PHONES, NO SIGNAL, ONE NUMBER
--
-- "The next free number" cannot be decided at the moment of the tap: the tap
-- happens in a plant room, and two techs on the same job would both be handed
-- the same one. So a phone RESERVES a few numbers while it has signal
-- (reserve_fp_serials) and spends them offline. A reserved number belongs to
-- that tech until it is used; nobody else is ever given it.
--
-- USED IS DERIVED, NOT TYPED
--
-- As with tag stock (28), a number is used when an item in the account is
-- given it as its serial, by whatever write path. The trigger does it.
--
-- Uniqueness is not enforced by index, for the reason 28 gives: consolidating
-- accounts can legitimately bring two copies of one number together. Loading
-- is idempotent instead.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fp_serial_pool (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  serial       text NOT NULL,
  serial_key   text GENERATED ALWAYS AS (public.serial_key(serial)) STORED,
  reserved_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reserved_at  timestamptz,
  asset_id     uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  used_at      timestamptz,
  source       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fp_serial_pool_key_idx
  ON public.fp_serial_pool (account_id, serial_key);
CREATE INDEX IF NOT EXISTS fp_serial_pool_free_idx
  ON public.fp_serial_pool (account_id, serial_key) WHERE asset_id IS NULL;

ALTER TABLE public.fp_serial_pool ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fp_serial_pool_read ON public.fp_serial_pool;
CREATE POLICY fp_serial_pool_read ON public.fp_serial_pool
  FOR SELECT TO authenticated USING (public.can_see(account_id));

REVOKE ALL ON public.fp_serial_pool FROM anon, authenticated;
GRANT SELECT ON public.fp_serial_pool TO authenticated;

-- Natural order: BAT-99 before BAT-100. Length first, then the key.
CREATE OR REPLACE FUNCTION public.fp_serial_pool_order(p_key text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT lpad(length(coalesce(p_key, ''))::text, 4, '0') || coalesce(p_key, '') $$;

-- ── A number given to an item is used ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fp_serial_pool_use() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.kind <> 'fall_protection' OR coalesce(NEW.serial_key, '') = '' THEN RETURN NEW; END IF;
  UPDATE public.fp_serial_pool p
     SET asset_id = NEW.id, used_at = coalesce(p.used_at, now())
   WHERE p.account_id = NEW.account_id
     AND p.serial_key = NEW.serial_key
     AND p.asset_id IS DISTINCT FROM NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fp_serial_pool_use_t ON public.assets;
CREATE TRIGGER fp_serial_pool_use_t
  AFTER INSERT OR UPDATE OF serial_key ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.fp_serial_pool_use();

-- ── The office loads the spreadsheet ────────────────────────────────────────
-- p = { serials: ["BAT-1001", ...], source: "free text" }. Lead only, into the
-- account being acted as. A number already in the pool is skipped; one already
-- on an item goes in as used, so it is never handed out.
CREATE OR REPLACE FUNCTION public.add_fp_serial_pool(p jsonb) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_source  text := left(nullif(trim(coalesce(p->>'source', '')), ''), 200);
  v_raw     text;
  v_serial  text;
  v_key     text;
  v_asset   uuid;
  v_added   integer := 0;
  v_dup     integer := 0;
  v_on_item integer := 0;
  v_seen    text[] := '{}';
BEGIN
  IF jsonb_typeof(p->'serials') <> 'array' THEN RAISE EXCEPTION 'serials must be a list'; END IF;
  IF jsonb_array_length(p->'serials') > 5000 THEN
    RAISE EXCEPTION 'At most 5000 numbers at a time';
  END IF;

  FOR v_raw IN SELECT jsonb_array_elements_text(p->'serials') LOOP
    v_serial := left(trim(v_raw), 64);
    v_key := public.serial_key(v_serial);
    CONTINUE WHEN coalesce(v_key, '') = '';
    IF v_key = ANY (v_seen) OR EXISTS (SELECT 1 FROM public.fp_serial_pool
                                        WHERE account_id = v_account AND serial_key = v_key) THEN
      v_dup := v_dup + 1;
      CONTINUE;
    END IF;
    v_seen := v_seen || v_key;

    SELECT id INTO v_asset FROM public.assets
     WHERE account_id = v_account AND kind = 'fall_protection' AND serial_key = v_key LIMIT 1;
    INSERT INTO public.fp_serial_pool (account_id, serial, source, asset_id, used_at)
    VALUES (v_account, v_serial, coalesce(v_source, 'office'), v_asset,
            CASE WHEN v_asset IS NOT NULL THEN now() END);
    IF v_asset IS NOT NULL THEN v_on_item := v_on_item + 1; ELSE v_added := v_added + 1; END IF;
    v_asset := NULL;
  END LOOP;

  RETURN json_build_object('added', v_added, 'already_listed', v_dup, 'already_on_an_item', v_on_item);
END;
$$;

-- ── A phone takes numbers to spend offline ──────────────────────────────────
-- Tops the caller's unused reservations up to p_count (1–20) from the free
-- numbers, lowest first, and returns everything the caller holds. Never takes
-- another tech's: SKIP LOCKED plus the reserved_by test means two phones
-- reserving at once each get different numbers. Reservations held by somebody
-- no longer on the crew go back to the pool first.
CREATE OR REPLACE FUNCTION public.reserve_fp_serials(p_count integer DEFAULT 5)
RETURNS TABLE (serial text, reserved_at timestamptz)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid;
  v_want    integer := greatest(1, least(coalesce(p_count, 5), 20));
  v_have    integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_account := public.my_account_id();
  IF v_account IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  UPDATE public.fp_serial_pool p SET reserved_by = NULL, reserved_at = NULL
   WHERE p.account_id = v_account AND p.asset_id IS NULL AND p.reserved_by IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.account_members m
                      WHERE m.user_id = p.reserved_by AND m.account_id = v_account AND m.removed_at IS NULL);

  SELECT count(*) INTO v_have FROM public.fp_serial_pool p
   WHERE p.account_id = v_account AND p.reserved_by = v_uid AND p.asset_id IS NULL;

  IF v_have < v_want THEN
    UPDATE public.fp_serial_pool p SET reserved_by = v_uid, reserved_at = now()
     WHERE p.id IN (
       SELECT f.id FROM public.fp_serial_pool f
        WHERE f.account_id = v_account AND f.asset_id IS NULL AND f.reserved_by IS NULL
        ORDER BY public.fp_serial_pool_order(f.serial_key)
        LIMIT v_want - v_have
        FOR UPDATE SKIP LOCKED);
  END IF;

  RETURN QUERY
  SELECT p.serial, p.reserved_at FROM public.fp_serial_pool p
   WHERE p.account_id = v_account AND p.reserved_by = v_uid AND p.asset_id IS NULL
   ORDER BY public.fp_serial_pool_order(p.serial_key);
END;
$$;

-- ── What the office sees ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fp_serial_pool_summary() RETURNS json
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_account uuid := public.require_lead_account();
BEGIN
  RETURN json_build_object(
    'free',     (SELECT count(*) FROM public.fp_serial_pool WHERE account_id = v_account AND asset_id IS NULL AND reserved_by IS NULL),
    'reserved', (SELECT count(*) FROM public.fp_serial_pool WHERE account_id = v_account AND asset_id IS NULL AND reserved_by IS NOT NULL),
    'used',     (SELECT count(*) FROM public.fp_serial_pool WHERE account_id = v_account AND asset_id IS NOT NULL),
    'next',     (SELECT serial FROM public.fp_serial_pool WHERE account_id = v_account AND asset_id IS NULL AND reserved_by IS NULL
                  ORDER BY public.fp_serial_pool_order(serial_key) LIMIT 1),
    'holders',  coalesce((SELECT json_agg(h ORDER BY h.name) FROM (
                  SELECT coalesce(nullif(u.name, ''), u.email, 'Unknown') AS name, count(*) AS numbers,
                         string_agg(p.serial, ', ' ORDER BY public.fp_serial_pool_order(p.serial_key)) AS serials
                    FROM public.fp_serial_pool p LEFT JOIN public.users u ON u.id = p.reserved_by
                   WHERE p.account_id = v_account AND p.asset_id IS NULL AND p.reserved_by IS NOT NULL
                   GROUP BY 1) h), '[]'::json)
  );
END;
$$;

-- ── consolidate_to_one_account(), re-emitted from 34 ────────────────────────
-- Verbatim from 34_vehicle_inventory.sql except the two lines marked "36":
-- the pool follows a folded item and moves with the account, rather than
-- cascading away with the emptied one.
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
  UPDATE public.fp_serial_pool    t SET asset_id = f.keep_id FROM _lia_fold f WHERE t.asset_id = f.id;  -- 36
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
  UPDATE public.fp_serial_pool    SET account_id = v_keep WHERE account_id <> v_keep;  -- 36
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

  -- 34: vehicle inventory. Load-outs clash like any catalogue (tombstoned);
  -- trucks and warehouses are real places, so a clashing name is kept and
  -- marked with the company it came from instead.
  UPDATE public.stock_loadouts s SET is_deleted = true, updated_at = now()
    FROM (SELECT id, row_number() OVER (PARTITION BY name_key
                                        ORDER BY (account_id = v_keep) DESC, created_at, id) AS rn
            FROM public.stock_loadouts WHERE NOT is_deleted) r
   WHERE s.id = r.id AND r.rn > 1;
  UPDATE public.stock_loadouts SET account_id = v_keep WHERE account_id <> v_keep;
  UPDATE public.stock_locations l
     SET name = left(l.name, 30) || ' (' || left(coalesce(a.name, 'merged'), 17) || ' ' || r.rn || ')',
         updated_at = now()
    FROM (SELECT id, row_number() OVER (PARTITION BY name_key
                                        ORDER BY (account_id = v_keep) DESC, created_at, id) AS rn
            FROM public.stock_locations) r, public.accounts a
   WHERE l.id = r.id AND r.rn > 1 AND a.id = l.account_id;
  UPDATE public.stock_locations SET account_id = v_keep WHERE account_id <> v_keep;
  UPDATE public.stock_levels    SET account_id = v_keep WHERE account_id <> v_keep;
  UPDATE public.stock_moves     SET account_id = v_keep WHERE account_id <> v_keep;
  DELETE FROM public.stock_settings WHERE account_id <> v_keep;

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

REVOKE ALL ON FUNCTION public.add_fp_serial_pool(jsonb)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reserve_fp_serials(integer)     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_serial_pool_summary()        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_serial_pool_use()            FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_fp_serial_pool(jsonb)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_fp_serials(integer)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_serial_pool_summary()     TO authenticated;
