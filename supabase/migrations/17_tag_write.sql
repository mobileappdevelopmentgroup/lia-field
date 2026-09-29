-- ═══════════════════════════════════════════════════════════════════════════
-- 17 — Writing tags, and finding an item however you are holding it
-- ═══════════════════════════════════════════════════════════════════════════
-- Until now the app could only READ tags. LiaNfc.write() existed and had no
-- caller anywhere. This is the other half: a tech writes our own tag onto a
-- piece of fall-protection equipment, and from then on any of the things
-- printed on, encoded in, or linked from that tag finds the same record.
--
-- ── The five ways in ───────────────────────────────────────────────────────
--   serial_key    the device's own serial, stamped on the equipment
--   tag_label     the human-readable code printed on the TAG        ← new here
--   nfc_tag_uid   the tag chip's hardware id, read on a tap
--   public_ref    the certificate code
--   tag_url_key   the link the tag carries
--
-- tag_label is new and is not the same thing as the serial. The serial belongs
-- to the equipment; the label belongs to the tag stuck on it. A tag can be
-- replaced, and a harness can outlive three of them — so they are separate
-- columns, and a tech holding either one gets the record.
--
-- ── What goes in the URL, and why it is not just the serial ────────────────
-- The tag's link is written as   …/fp/?t=<public_ref>&s=<serial>
--
-- The serial is in there because that is the identifier a human reads off the
-- equipment, and a link that visibly carries it can be checked by eye.
--
-- But the serial is NOT the only thing in there, and that is deliberate.
-- update_fp_asset() lets the office correct a mistyped serial — that is what it
-- is for. A tag whose link carried only the serial would stop resolving the
-- moment somebody fixed a typo, and there is no way to rewrite a tag that is
-- already riveted to a harness in a customer's plant room. public_ref exists
-- precisely because it never changes. So the link carries both: the ref makes
-- it durable, the serial makes it legible, and either resolves on its own.
--
-- Idempotent. Safe to re-run.

-- ── The label on the tag ────────────────────────────────────────────────────
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS tag_label text;

-- Normalized the same way a serial is, and for the same reason: it gets typed,
-- printed and read back inconsistently. Generated rather than written by the
-- app so the two cannot drift.
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS tag_label_key text
  GENERATED ALWAYS AS (public.serial_key(tag_label)) STORED;

-- A label names ONE physical tag, so two items in an account must not claim it.
-- That is enforced in record_fp_tag_write() and update_fp_asset() rather than by
-- a unique index, and the reason is worth stating because the obvious choice is
-- the index.
--
-- consolidate_to_one_account() merges several companies onto one account. Two
-- companies can each legitimately have a tag labelled FP999999, and the moment
-- they are merged a unique index makes that consolidation fail — which is to
-- say, a migration that takes the whole apply down on data nobody has looked
-- at. The same argument applies to nfc_tag_uid. Refusing new duplicates at the
-- write path fixes the problem going forward without that risk; a duplicate
-- that already exists shows up in the office rather than blocking a release.
CREATE INDEX IF NOT EXISTS assets_tag_label_idx
  ON public.assets(account_id, tag_label_key) WHERE tag_label_key <> '';

-- ── The URL a tag carries ───────────────────────────────────────────────────
-- Percent-encoding first, because fp_tag_url depends on it. Deliberately
-- conservative: anything outside the unreserved set is encoded, because a
-- serial is free text off a customer's equipment and legitimately contains
-- '/', '#' and spaces.
CREATE OR REPLACE FUNCTION public.urlencode_serial(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(string_agg(
    CASE WHEN ch ~ '[A-Za-z0-9._~-]' THEN ch
         ELSE '%' || upper(to_hex(ascii(ch))) END, ''), '')
  FROM regexp_split_to_table(coalesce(p, ''), '') AS ch
  WHERE ch <> '';
$$;

-- One place that decides the format, so the writer, the views and the device
-- can never disagree about what a tag should say.
CREATE OR REPLACE FUNCTION public.fp_tag_url(p_public_ref text, p_serial text)
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE WHEN nullif(btrim(coalesce(p_public_ref,'')),'') IS NULL THEN NULL ELSE
    (SELECT value FROM public.app_settings WHERE key = 'certificate_base_url')
    || '/fp/?t=' || p_public_ref
    || CASE WHEN nullif(btrim(coalesce(p_serial,'')),'') IS NULL THEN ''
            ELSE '&s=' || public.urlencode_serial(p_serial) END
  END;
$$;

-- ── What was written, to what, by whom ──────────────────────────────────────
-- Writing a tag is a physical act on a customer's equipment, and the failure
-- mode is a tag that says the wrong thing bolted to a harness nobody will look
-- at again for a year. So every write is recorded: which item, which chip,
-- which label, what URL, and which tech. Without it, "this tag scans as the
-- wrong harness" is unanswerable.
CREATE TABLE IF NOT EXISTS public.fp_tag_writes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  asset_id     uuid NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  client_id    text,                    -- idempotency for the upload queue
  tag_label    text,
  nfc_tag_uid  text,
  tag_url      text NOT NULL,
  serial_num   text,
  public_ref   text,
  -- What it replaced, so a re-tag is visible as a re-tag.
  prev_label   text,
  prev_uid     text,
  written_by   uuid REFERENCES auth.users(id),
  written_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fp_tag_writes_client_uq
  ON public.fp_tag_writes(account_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fp_tag_writes_asset_idx ON public.fp_tag_writes(asset_id, written_at DESC);

ALTER TABLE public.fp_tag_writes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fp_tag_writes_read" ON public.fp_tag_writes;
CREATE POLICY "fp_tag_writes_read" ON public.fp_tag_writes
  FOR SELECT USING (account_id = public.my_account_id());

-- ── Preparing a write ───────────────────────────────────────────────────────
-- Given whatever the tech is holding, says what should go on the tag. The app
-- can build this itself from a cached row when offline; this is the online
-- source of truth, and the one place the format is decided.
CREATE OR REPLACE FUNCTION public.fp_tag_write_plan(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_account uuid := public.my_account_id();
  v_asset   public.assets%ROWTYPE;
  v_label   text := nullif(btrim(coalesce(p->>'tag_label','')), '');
  v_clash   uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_asset FROM public.assets
   WHERE account_id = v_account
     AND ( (nullif(p->>'asset_id','') IS NOT NULL AND id = (p->>'asset_id')::uuid)
        OR (nullif(p->>'serial_num','') IS NOT NULL
            AND kind = 'fall_protection' AND serial_key = public.serial_key(p->>'serial_num'))
        OR (nullif(p->>'public_ref','') IS NOT NULL AND public_ref = upper(p->>'public_ref')) )
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such item — inspect it first, then write its tag';
  END IF;

  -- Caught here as well as by the unique index, so the tech is told BEFORE he
  -- holds a phone against a tag rather than after the write has half happened.
  IF v_label IS NOT NULL THEN
    SELECT id INTO v_clash FROM public.assets
     WHERE account_id = v_account AND tag_label_key = public.serial_key(v_label)
       AND id <> v_asset.id;
    IF FOUND THEN
      RAISE EXCEPTION 'Tag label % is already on another item', v_label;
    END IF;
  END IF;

  RETURN json_build_object(
    'asset_id',   v_asset.id,
    'has_tag',    (v_asset.tag_label IS NOT NULL OR v_asset.nfc_tag_uid IS NOT NULL),
    'serial_num', v_asset.serial_raw,
    'public_ref', v_asset.public_ref,
    'tag_label',  coalesce(v_label, v_asset.tag_label),
    'url',        public.fp_tag_url(v_asset.public_ref, v_asset.serial_raw),
    'prev_label', v_asset.tag_label,
    'prev_uid',   v_asset.nfc_tag_uid);
END;
$$;

-- ── Recording a write ───────────────────────────────────────────────────────
-- Called after the tag physically took the write. Idempotent on client_id so a
-- queued upload that retries records one write, not five.
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
  SELECT account_id INTO v_account FROM public.account_members WHERE user_id = v_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

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

-- ── Finding an item by any of the five ──────────────────────────────────────
-- One place the office and the app both use, so "which identifier is this"
-- is answered the same way everywhere.
--
-- Order matters. A URL is dispatched to the link index first and never run
-- through the others: fp_tag_url_key() on a non-URL is meaningless, and worse,
-- letting a link fall through to the uid matcher can return a DIFFERENT item's
-- record. The label is tried before the certificate code because a label is
-- something a human reads and a ref is something a machine wrote.
CREATE OR REPLACE FUNCTION public.fp_find_asset(p_value text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_account uuid := public.my_account_id();
  v_v       text := btrim(coalesce(p_value, ''));
  v_asset   public.assets%ROWTYPE;
  v_by      text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_v = '' THEN RETURN NULL; END IF;

  IF v_v ~* '^https?://' THEN
    SELECT * INTO v_asset FROM public.assets
     WHERE account_id = v_account AND tag_url_key = public.fp_tag_url_key(v_v) LIMIT 1;
    IF FOUND THEN RETURN json_build_object('by','tag_url','asset',row_to_json(v_asset)); END IF;
    -- Our own certificate link still resolves by what is inside it.
    v_v := coalesce(substring(v_v from '[?&]t=([A-Za-z0-9]+)'),
                    substring(v_v from '[?&]s=([^&#]+)'), '');
    IF v_v = '' THEN RETURN NULL; END IF;
  END IF;

  SELECT * INTO v_asset FROM public.assets
   WHERE account_id = v_account AND serial_key = public.serial_key(v_v) LIMIT 1;
  IF FOUND THEN RETURN json_build_object('by','serial','asset',row_to_json(v_asset)); END IF;

  SELECT * INTO v_asset FROM public.assets
   WHERE account_id = v_account AND tag_label_key = public.serial_key(v_v)
     AND tag_label_key <> '' LIMIT 1;
  IF FOUND THEN RETURN json_build_object('by','tag_label','asset',row_to_json(v_asset)); END IF;

  SELECT * INTO v_asset FROM public.assets
   WHERE account_id = v_account AND public_ref = upper(v_v) LIMIT 1;
  IF FOUND THEN RETURN json_build_object('by','public_ref','asset',row_to_json(v_asset)); END IF;

  -- Ordered, not arbitrary. record_fp_tag_write refuses to create a duplicate
  -- chip id, but rows that predate that guard may already carry one, and a bare
  -- LIMIT 1 over them would return a different item on different days.
  SELECT * INTO v_asset FROM public.assets
   WHERE account_id = v_account
     AND upper(regexp_replace(coalesce(nfc_tag_uid,''), '[^A-Fa-f0-9]', '', 'g'))
       = upper(regexp_replace(v_v, '[^A-Fa-f0-9]', '', 'g'))
     AND coalesce(nfc_tag_uid,'') <> ''
   ORDER BY updated_at DESC, id LIMIT 1;
  IF FOUND THEN RETURN json_build_object('by','nfc_tag_uid','asset',row_to_json(v_asset)); END IF;

  RETURN NULL;
END;
$$;

-- ── The office can correct a tag label ──────────────────────────────────────
-- Recreated to add tag_label, which the office needs for the ordinary case of a
-- label typed wrong on the phone. It refuses a label already on another item
-- for the same reason record_fp_tag_write does: moving it would leave that item
-- unfindable by the label printed on its own tag.
CREATE OR REPLACE FUNCTION public.update_fp_asset(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.require_lead();
  v_id      uuid := nullif(p->>'asset_id','')::uuid;
  v_reason  text := nullif(btrim(coalesce(p->>'reason','')), '');
  v_serial  text := nullif(btrim(coalesce(p->>'serial_raw','')), '');
  v_label   text := nullif(btrim(coalesce(p->>'tag_label','')), '');
  v_before  public.assets%ROWTYPE;
  v_who     text;
BEGIN
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Say why this item is being changed'; END IF;

  SELECT * INTO v_before FROM public.assets
   WHERE id = v_id AND account_id = v_account AND kind = 'fall_protection' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such item'; END IF;

  IF v_serial IS NOT NULL AND public.serial_key(v_serial) <> v_before.serial_key
     AND EXISTS (SELECT 1 FROM public.assets
                  WHERE account_id = v_account AND kind = 'fall_protection'
                    AND serial_key = public.serial_key(v_serial)) THEN
    RAISE EXCEPTION 'Another item already has serial %', v_serial;
  END IF;

  IF v_label IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.assets
                  WHERE account_id = v_account
                    AND tag_label_key = public.serial_key(v_label)
                    AND id <> v_id) THEN
    RAISE EXCEPTION 'Tag label % is already on another item', v_label;
  END IF;

  SELECT coalesce(u.name, u.email) INTO v_who FROM public.users u WHERE u.id = auth.uid();

  UPDATE public.assets SET
    serial_raw  = coalesce(v_serial, serial_raw),
    serial_key  = CASE WHEN v_serial IS NULL THEN serial_key ELSE public.serial_key(v_serial) END,
    nfc_tag_uid = coalesce(nullif(p->>'nfc_tag_uid',''), nfc_tag_uid),
    tag_url     = coalesce(nullif(p->>'tag_url',''), tag_url),
    tag_label   = coalesce(v_label, tag_label),
    updated_at  = clock_timestamp()
  WHERE id = v_id;

  -- public_ref is deliberately NOT changeable. It is printed on tags already in
  -- the field; changing it would make every one of them point at nothing.

  INSERT INTO public.fp_record_audit
    (account_id, asset_id, action, reason, before, after, actor_id, actor_name)
  VALUES (v_account, v_id, 'asset_edit', v_reason,
          row_to_json(v_before)::jsonb,
          (SELECT row_to_json(a)::jsonb FROM public.assets a WHERE a.id = v_id),
          auth.uid(), v_who);

  RETURN (SELECT row_to_json(a) FROM public.assets a WHERE a.id = v_id);
END;
$$;

-- ── The office finds an item by its tag label too ───────────────────────────
-- Recreated rather than patched: the office is the place somebody rings up
-- holding a tag and reading the code off it, and a search that could not match
-- that would send them to a spreadsheet. Selecting a.tag_label as well, so the
-- screen can show which label is on the item it found.
CREATE OR REPLACE FUNCTION public.fp_records(
  p_search text    DEFAULT NULL,
  p_status text    DEFAULT NULL,
  p_limit  integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_account uuid := public.my_account_id();
  v_q       text := nullif(btrim(coalesce(p_search, '')), '');
  v_key     text := public.serial_key(coalesce(p_search, ''));
  v_out     json;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT json_build_object(
    'total', (SELECT count(*) FROM public.assets a
               WHERE a.account_id = v_account AND a.kind = 'fall_protection'),
    'rows', coalesce(json_agg(r), '[]'::json)
  ) INTO v_out
  FROM (
    SELECT a.id AS asset_id, a.serial_raw, a.serial_key, a.public_ref,
           a.nfc_tag_uid, a.tag_url, a.tag_label,
           i.id AS inspection_id, i.inspection_date, i.next_due_date,
           i.item_type, i.manufacturer, i.model, i.lot_number,
           i.mfg_month, i.mfg_year, i.description,
           i.overall_pass, i.status, i.discard_reason,
           public.fp_effective_status(i.overall_pass, i.next_due_date, i.status) AS effective_status,
           i.collector_name, i.rep_number, i.work_order_id, i.source, i.version,
           (SELECT count(*) FROM public.fp_inspections h
             WHERE h.asset_id = a.id AND NOT h.is_deleted) AS history_count
      FROM public.assets a
      LEFT JOIN LATERAL (
        SELECT * FROM public.fp_inspections f
         WHERE f.asset_id = a.id AND f.is_current AND NOT f.is_deleted
         ORDER BY f.inspection_date DESC LIMIT 1
      ) i ON true
     WHERE a.account_id = v_account
       AND a.kind = 'fall_protection'
       AND (v_q IS NULL
            OR a.serial_key LIKE '%' || v_key || '%'
            -- The label the tech is reading off the tag in his hand.
            OR (a.tag_label_key <> '' AND a.tag_label_key LIKE '%' || v_key || '%')
            OR upper(coalesce(a.public_ref, '')) = upper(v_q)
            OR upper(coalesce(a.nfc_tag_uid, '')) LIKE '%' || upper(v_q) || '%'
            OR coalesce(i.manufacturer, '') ILIKE '%' || v_q || '%'
            OR coalesce(i.model, '') ILIKE '%' || v_q || '%'
            OR coalesce(i.item_type, '') ILIKE '%' || v_q || '%')
       AND (p_status IS NULL
            OR (p_status = 'due_soon'
                AND i.next_due_date IS NOT NULL
                AND i.next_due_date BETWEEN current_date AND current_date + 60)
            OR public.fp_effective_status(i.overall_pass, i.next_due_date, i.status) = p_status)
     ORDER BY coalesce(i.inspection_date, '1900-01-01') DESC, a.serial_key
     LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
     OFFSET greatest(0, coalesce(p_offset, 0))
  ) r;

  RETURN v_out;
END;
$$;

-- ── The public certificate view learns the label ────────────────────────────
-- Recreated in full: a view's column list cannot be extended in place. Columns
-- are only ever ADDED here — the site does select('*') and reads by name.
DROP VIEW IF EXISTS public.fall_protection_public;
CREATE VIEW public.fall_protection_public AS
  SELECT
    a.serial_raw    AS serial_num,
    a.serial_key,
    a.public_ref,
    a.tag_url,
    a.tag_label,
    a.tag_label_key,
    i.inspection_date,
    i.next_due_date,
    i.collector_name AS tech_name,
    i.rep_number,
    i.manufacturer,
    i.model,
    i.item_type,
    i.description,
    i.lot_number,
    i.mfg_month,
    i.mfg_year,
    i.status,
    i.overall_pass,
    i.discard_reason,
    i.work_order_id,
    i.created_at,
    public.certificate_url(a.public_ref, 'fall_protection') AS certificate_url,
    public.fp_tag_url(a.public_ref, a.serial_raw)           AS tag_write_url
  FROM public.assets a
  JOIN public.fp_inspections i ON i.asset_id = a.id AND i.is_current AND NOT i.is_deleted
  WHERE a.kind = 'fall_protection';

GRANT SELECT ON public.fall_protection_public TO anon, authenticated;

-- ── The device snapshot carries the label ───────────────────────────────────
-- So a phone with no signal can resolve a label the same way it resolves a
-- serial. Recreated in full for the same reason as the view.
DROP FUNCTION IF EXISTS public.account_snapshot(timestamptz, integer, timestamptz, uuid);
CREATE FUNCTION public.account_snapshot(
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
  tag_url       text,
  tag_label     text,
  tag_label_key text,
  last_inspected date,
  next_due       date,
  tech_name      text,
  rep_number     text,
  brand          text,
  ladder_type    text,
  length         text,
  lubricated     boolean,
  has_leveler    boolean,
  has_claw       boolean,
  has_vrung      boolean,
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
    a.tag_url, a.tag_label, a.tag_label_key,
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

-- ── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.fp_tag_write_plan(jsonb)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_fp_tag_write(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_find_asset(text)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.account_snapshot(timestamptz, integer, timestamptz, uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fp_tag_write_plan(jsonb)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_fp_tag_write(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_find_asset(text)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_snapshot(timestamptz, integer, timestamptz, uuid)
  TO authenticated;
-- The certificate site builds no URLs; it only reads them off the view. But it
-- does need to resolve a label a visitor typed, and that goes through the view.
GRANT EXECUTE ON FUNCTION public.fp_tag_url(text, text)     TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.urlencode_serial(text)     TO authenticated, anon;
