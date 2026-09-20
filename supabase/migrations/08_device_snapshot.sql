-- ═══════════════════════════════════════════════════════════════════
-- Lia Device Snapshot — safe to re-run; idempotent
--
-- Run AFTER 07_fp_status.sql.
--
-- The read model behind the on-device cache. A tech taps an NFC tag, scans a
-- barcode or types a serial, and last year's record comes straight up — no
-- typing, no round trip, no signal required. Most items have been inspected for
-- years; making the tech re-enter them is the work this removes.
--
-- Scoped to the ACCOUNT, not the tech: items cross boundaries and crews, so a
-- sub-tech gets the same catalogue the lead has. That is what the RLS on
-- assets/inspections already enforces — this function just serves it in one
-- shape the device can store.
--
-- Both scopes come down together. Ladder records are ~86 bytes and fall
-- protection ~231, so even 100k items is ~22 MB — well inside IndexedDB.
-- ═══════════════════════════════════════════════════════════════════

-- Cheap change detection. An asset's row moves whenever its current inspection
-- does, so the client can ask "what changed since X" instead of re-downloading.
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS assets_updated_idx ON public.assets(updated_at, id);

-- clock_timestamp(), NOT now(): now() is the TRANSACTION start time, so a write
-- and the trigger it fires would share a timestamp with the caller's own
-- "what time is it" read, and the delta would silently skip the record.
CREATE OR REPLACE FUNCTION public.touch_asset_from_inspection()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE public.assets SET updated_at = clock_timestamp() WHERE id = NEW.asset_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inspections_touch_asset ON public.inspections;
CREATE TRIGGER inspections_touch_asset
  AFTER INSERT OR UPDATE ON public.inspections
  FOR EACH ROW EXECUTE FUNCTION public.touch_asset_from_inspection();

DROP TRIGGER IF EXISTS fp_inspections_touch_asset ON public.fp_inspections;
CREATE TRIGGER fp_inspections_touch_asset
  AFTER INSERT OR UPDATE ON public.fp_inspections
  FOR EACH ROW EXECUTE FUNCTION public.touch_asset_from_inspection();

-- ── The snapshot ─────────────────────────────────────────────────────────────
-- One row per item the account knows about, carrying its CURRENT record. Keyset
-- paginated on (updated_at, id) so a large first sync comes down in pages and a
-- delta is a short call.
--
-- p_since NULL  → everything (first sync)
-- p_since ts    → only what changed after ts (delta)
CREATE OR REPLACE FUNCTION public.account_snapshot(
  p_since          timestamptz DEFAULT NULL,
  p_limit          integer     DEFAULT 2000,
  p_after_updated  timestamptz DEFAULT NULL,
  p_after_id       uuid        DEFAULT NULL
)
RETURNS TABLE (
  asset_id      uuid,
  serial_key    text,
  serial_raw    text,
  kind          text,
  nfc_tag_uid   text,
  public_ref    text,
  -- shared
  last_inspected date,
  next_due       date,
  tech_name      text,
  rep_number     text,
  -- ladder
  brand          text,
  ladder_type    text,
  length         text,
  lubricated     boolean,
  has_leveler    boolean,
  has_claw       boolean,
  has_vrung      boolean,
  -- fall protection
  manufacturer   text,
  model          text,
  item_type      text,
  description    text,
  lot_number     text,
  mfg_month      integer,
  mfg_year       integer,
  status         text,
  overall_pass   boolean,
  is_deleted     boolean,
  updated_at     timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT
    a.id, a.serial_key, a.serial_raw, a.kind, a.nfc_tag_uid, a.public_ref,
    coalesce(li.inspection_date, fi.inspection_date),
    coalesce(li.next_due_date,   fi.next_due_date),
    coalesce(li.tech_name,       fi.collector_name),
    coalesce(li.rep_number,      fi.rep_number),
    li.brand, li.type, li.length,
    li.lubricated, li.has_leveler, li.has_claw, li.has_vrung,
    fi.manufacturer, fi.model, fi.item_type, fi.description,
    fi.lot_number, fi.mfg_month, fi.mfg_year, fi.status, fi.overall_pass,
    coalesce(li.is_deleted, fi.is_deleted, false),
    a.updated_at
  FROM public.assets a
  LEFT JOIN LATERAL (
    SELECT * FROM public.inspections i
     WHERE i.asset_id = a.id AND i.is_current
     ORDER BY i.inspection_date DESC LIMIT 1
  ) li ON a.kind = 'ladder'
  LEFT JOIN LATERAL (
    SELECT * FROM public.fp_inspections f
     WHERE f.asset_id = a.id AND f.is_current
     ORDER BY f.inspection_date DESC LIMIT 1
  ) fi ON a.kind = 'fall_protection'
  WHERE a.account_id = public.my_account_id()
    AND (p_since IS NULL OR a.updated_at > p_since)
    AND (
      p_after_updated IS NULL
      OR (a.updated_at, a.id) > (p_after_updated, p_after_id)
    )
  ORDER BY a.updated_at, a.id
  LIMIT greatest(1, least(coalesce(p_limit, 2000), 5000));
$$;

-- How big is the sync going to be, and how fresh is the device? Called before a
-- first sync so the app can show progress instead of a blank wait.
CREATE OR REPLACE FUNCTION public.account_snapshot_meta(p_since timestamptz DEFAULT NULL)
RETURNS json LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT json_build_object(
    'total',    (SELECT count(*) FROM public.assets WHERE account_id = public.my_account_id()),
    'changed',  (SELECT count(*) FROM public.assets
                  WHERE account_id = public.my_account_id()
                    AND (p_since IS NULL OR updated_at > p_since)),
    'ladders',  (SELECT count(*) FROM public.assets
                  WHERE account_id = public.my_account_id() AND kind = 'ladder'),
    'fp',       (SELECT count(*) FROM public.assets
                  WHERE account_id = public.my_account_id() AND kind = 'fall_protection'),
    'server_now', clock_timestamp(),
    -- What the client stores and passes back as p_since next time.
    --
    -- Deliberately backdated. A row's updated_at is stamped when the statement
    -- runs, but the row only becomes visible when its transaction COMMITS — so a
    -- device syncing in that gap would never see it again. The overlap re-sends a
    -- little already-seen data instead, which costs nothing: records are keyed by
    -- asset_id on the device, so re-applying one is a no-op.
    --
    -- Taken from the server, so a phone with a wrong clock cannot skip records.
    'next_since', clock_timestamp() - interval '2 minutes'
  );
$$;

-- ── A failed check is its own explanation ────────────────────────────────────
-- The tech should not have to type why an item failed — the check he tapped
-- already says it. discard_reason is now composed from the failed checks, and a
-- free-text note is optional on top.
ALTER TABLE public.fp_inspections ADD COLUMN IF NOT EXISTS discard_note text;

COMMENT ON COLUMN public.fp_inspections.discard_reason IS
  'Composed from the failed checks by record_fp_inspection. Not typed by the tech.';
COMMENT ON COLUMN public.fp_inspections.discard_note IS
  'Optional free text the tech adds alongside the photo.';

-- ── Who may call this ────────────────────────────────────────────────────────
-- These are SECURITY DEFINER, so they bypass RLS and lean entirely on
-- my_account_id(). With no JWT that is NULL and `account_id = NULL` matches
-- nothing, so anon already gets an empty set — but Postgres grants EXECUTE to
-- PUBLIC by default, so revoke it explicitly rather than resting on that.
REVOKE ALL ON FUNCTION public.account_snapshot(timestamptz, integer, timestamptz, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.account_snapshot_meta(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_snapshot(timestamptz, integer, timestamptz, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_snapshot_meta(timestamptz) TO authenticated;
