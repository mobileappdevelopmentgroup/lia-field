-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — spare numbers that are also tags, and numbers the sheet says are used.
-- Idempotent; safe to re-run. Run AFTER 36_fp_serial_pool.sql.
--
-- 36 assumed a spare number was a number and nothing else. The first real
-- list (Nate, 2026-10-15: FP161282–FP161399) is a block of his own tag numbers,
-- each with a Google Sheet, and Lia already holds every one of them from the
-- 2026-09-28 import: 53 blank in his tag stock, 58 the TAG LABEL of an item
-- with a certificate. Under 36 all of them would have gone in as free:
--
--   * 36 looked for a used number only in assets.serial_key. Those 58 items
--     carry the number as tag_label (their serial is the manufacturer's), so
--     the phone would have handed FP161282 to a second, unrelated item.
--   * A blank in tag stock stayed there. One tech typing FP161395 opens a new
--     item with it as a tag; another, pressing "Defective, no tag", opens a
--     different one with it as a serial.
--
-- So, decided 2026-10-15: loading a number as a spare TAKES IT OUT of tag
-- stock — the lead is saying it will not go on a tag — and a number that is
-- any item's serial OR tag label goes in used.
--
-- The sheet also says which numbers are spent (a row filled in), including
-- seven Lia has no item for because they were used after the import. Those go
-- in used too, with no item: used_at set, asset_id null. "Free" is therefore
-- now `asset_id IS NULL AND used_at IS NULL`, everywhere 36 said
-- `asset_id IS NULL`.
-- ═══════════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS public.fp_serial_pool_free_idx;
CREATE INDEX IF NOT EXISTS fp_serial_pool_free2_idx
  ON public.fp_serial_pool (account_id, serial_key) WHERE asset_id IS NULL AND used_at IS NULL;

-- ── A number an item carries, as serial or tag label, is used ──────────────
CREATE OR REPLACE FUNCTION public.fp_serial_pool_use() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.kind <> 'fall_protection' THEN RETURN NEW; END IF;
  UPDATE public.fp_serial_pool p
     SET asset_id = NEW.id, used_at = coalesce(p.used_at, now())
   WHERE p.account_id = NEW.account_id
     AND p.asset_id IS DISTINCT FROM NEW.id
     AND ((coalesce(NEW.serial_key, '') <> ''    AND p.serial_key = NEW.serial_key)
       OR (coalesce(NEW.tag_label_key, '') <> '' AND p.serial_key = NEW.tag_label_key));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fp_serial_pool_use_t ON public.assets;
CREATE TRIGGER fp_serial_pool_use_t
  AFTER INSERT OR UPDATE OF serial_key, tag_label ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.fp_serial_pool_use();

-- ── The office loads the list ───────────────────────────────────────────────
-- p = { serials: [...free...], used: [...the sheet says spent...], source }.
-- Lead only, into the account being acted as. 36's callers sent only
-- `serials`, and still work.
CREATE OR REPLACE FUNCTION public.add_fp_serial_pool(p jsonb) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_account   uuid := public.require_lead_account();
  v_source    text := left(nullif(trim(coalesce(p->>'source', '')), ''), 200);
  v_raw       text;
  v_is_used   boolean;
  v_serial    text;
  v_key       text;
  v_asset     uuid;
  v_pool      public.fp_serial_pool%ROWTYPE;
  v_n         integer;
  v_added     integer := 0;
  v_dup       integer := 0;
  v_on_item   integer := 0;
  v_on_sheet  integer := 0;
  v_now_used  integer := 0;
  v_unstocked integer := 0;
  v_seen      text[] := '{}';
BEGIN
  IF jsonb_typeof(p->'serials') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'serials must be a list'; END IF;
  IF p ? 'used' AND jsonb_typeof(p->'used') <> 'array' THEN RAISE EXCEPTION 'used must be a list'; END IF;
  IF jsonb_array_length(p->'serials') + coalesce(jsonb_array_length(p->'used'), 0) > 5000 THEN
    RAISE EXCEPTION 'At most 5000 numbers at a time';
  END IF;

  -- Used first, so a number listed both ways counts as used.
  FOR v_raw, v_is_used IN
    SELECT u, true  FROM jsonb_array_elements_text(coalesce(p->'used', '[]'::jsonb)) u
    UNION ALL
    SELECT s, false FROM jsonb_array_elements_text(p->'serials') s
  LOOP
    v_serial := left(trim(v_raw), 64);
    v_key := public.serial_key(v_serial);
    CONTINUE WHEN coalesce(v_key, '') = '';
    IF v_key = ANY (v_seen) THEN v_dup := v_dup + 1; CONTINUE; END IF;
    v_seen := v_seen || v_key;

    -- It will not go on a tag now: out of the blank stock either way.
    DELETE FROM public.fp_tag_stock
     WHERE account_id = v_account AND tag_label_key = v_key AND asset_id IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_unstocked := v_unstocked + v_n;

    SELECT * INTO v_pool FROM public.fp_serial_pool
     WHERE account_id = v_account AND serial_key = v_key LIMIT 1;
    IF FOUND THEN
      -- A later sheet saying a free (or phone-held) number is now spent.
      IF v_is_used AND v_pool.asset_id IS NULL AND v_pool.used_at IS NULL THEN
        UPDATE public.fp_serial_pool
           SET used_at = now(), reserved_by = NULL, reserved_at = NULL
         WHERE id = v_pool.id;
        v_now_used := v_now_used + 1;
      ELSE
        v_dup := v_dup + 1;
      END IF;
      CONTINUE;
    END IF;

    SELECT id INTO v_asset FROM public.assets
     WHERE account_id = v_account AND kind = 'fall_protection'
       AND (serial_key = v_key OR tag_label_key = v_key)
     ORDER BY (serial_key = v_key) DESC LIMIT 1;

    INSERT INTO public.fp_serial_pool (account_id, serial, source, asset_id, used_at)
    VALUES (v_account, v_serial, coalesce(v_source, 'office'), v_asset,
            CASE WHEN v_asset IS NOT NULL OR v_is_used THEN now() END);
    IF v_asset IS NOT NULL THEN v_on_item := v_on_item + 1;
    ELSIF v_is_used THEN v_on_sheet := v_on_sheet + 1;
    ELSE v_added := v_added + 1; END IF;
    v_asset := NULL;
  END LOOP;

  RETURN json_build_object('added', v_added, 'already_listed', v_dup,
                           'already_on_an_item', v_on_item, 'used_on_sheet', v_on_sheet,
                           'now_used', v_now_used, 'taken_from_tag_stock', v_unstocked);
END;
$$;

-- ── A phone takes numbers to spend offline (36, free = unused) ─────────────
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
   WHERE p.account_id = v_account AND p.asset_id IS NULL AND p.used_at IS NULL AND p.reserved_by IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.account_members m
                      WHERE m.user_id = p.reserved_by AND m.account_id = v_account AND m.removed_at IS NULL);

  SELECT count(*) INTO v_have FROM public.fp_serial_pool p
   WHERE p.account_id = v_account AND p.reserved_by = v_uid AND p.asset_id IS NULL AND p.used_at IS NULL;

  IF v_have < v_want THEN
    UPDATE public.fp_serial_pool p SET reserved_by = v_uid, reserved_at = now()
     WHERE p.id IN (
       SELECT f.id FROM public.fp_serial_pool f
        WHERE f.account_id = v_account AND f.asset_id IS NULL AND f.used_at IS NULL AND f.reserved_by IS NULL
        ORDER BY public.fp_serial_pool_order(f.serial_key)
        LIMIT v_want - v_have
        FOR UPDATE SKIP LOCKED);
  END IF;

  RETURN QUERY
  SELECT p.serial, p.reserved_at FROM public.fp_serial_pool p
   WHERE p.account_id = v_account AND p.reserved_by = v_uid AND p.asset_id IS NULL AND p.used_at IS NULL
   ORDER BY public.fp_serial_pool_order(p.serial_key);
END;
$$;

-- ── What the office sees (36, free = unused) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.fp_serial_pool_summary() RETURNS json
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_account uuid := public.require_lead_account();
BEGIN
  RETURN json_build_object(
    'free',     (SELECT count(*) FROM public.fp_serial_pool WHERE account_id = v_account AND asset_id IS NULL AND used_at IS NULL AND reserved_by IS NULL),
    'reserved', (SELECT count(*) FROM public.fp_serial_pool WHERE account_id = v_account AND asset_id IS NULL AND used_at IS NULL AND reserved_by IS NOT NULL),
    'used',     (SELECT count(*) FROM public.fp_serial_pool WHERE account_id = v_account AND (asset_id IS NOT NULL OR used_at IS NOT NULL)),
    'next',     (SELECT serial FROM public.fp_serial_pool WHERE account_id = v_account AND asset_id IS NULL AND used_at IS NULL AND reserved_by IS NULL
                  ORDER BY public.fp_serial_pool_order(serial_key) LIMIT 1),
    'holders',  coalesce((SELECT json_agg(h ORDER BY h.name) FROM (
                  SELECT coalesce(nullif(u.name, ''), u.email, 'Unknown') AS name, count(*) AS numbers,
                         string_agg(p.serial, ', ' ORDER BY public.fp_serial_pool_order(p.serial_key)) AS serials
                    FROM public.fp_serial_pool p LEFT JOIN public.users u ON u.id = p.reserved_by
                   WHERE p.account_id = v_account AND p.asset_id IS NULL AND p.used_at IS NULL AND p.reserved_by IS NOT NULL
                   GROUP BY 1) h), '[]'::json)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.add_fp_serial_pool(jsonb)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reserve_fp_serials(integer)     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_serial_pool_summary()        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_serial_pool_use()            FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_fp_serial_pool(jsonb)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_fp_serials(integer)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_serial_pool_summary()     TO authenticated;
