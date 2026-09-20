-- ═══════════════════════════════════════════════════════════════════════════
-- 12 — Tag hyperlinks
--
-- Run after 11_fp_equipment_types.sql. Idempotent, like every file here.
--
-- Most fall-protection gear arrives already tagged by whoever supplied it.
-- Those tags carry a serial printed on the outside and, in the NDEF, a link
-- into somebody else's system — no serial we know and no certificate code. The
-- app could not name such an item at all, so it invented one: the tag's
-- hardware uid went into the serial field, and the link was discarded.
--
-- This file makes the link a first-class identifier:
--
--   assets.tag_url          the link that was last read off an item's tag,
--                           plus a canonical key it can be looked up by. This
--                           IS the tag/hyperlink database.
--   fp_tag_links            tags seen but not yet inspected — the tech recorded
--                           the link and moved on. Uploading these is what makes
--                           the next tap on that tag resolve, on any phone.
--   fp_external_records     what a tag's link CLAIMED about an item.
--
-- ── Why external records are a separate table ────────────────────────────────
-- A blank NTAG213 costs pennies and any phone can rewrite one. A URL read off a
-- tag is therefore an unauthenticated claim by whoever last held the item. If a
-- fetched row could land in fp_inspections — even flagged by a source column —
-- then anyone able to write a tag could put "last inspected, PASS" into the
-- history of a harness, which is the single record that says the gear is safe
-- to wear. So it lands here instead: never joined into a certificate, never
-- counted as an inspection, never able to satisfy a due date.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The canonical form of a link ─────────────────────────────────────────────
-- MUST stay identical to urlKey() in field-app/js/tag-link.js, the same way
-- serial_key() and serialKey() must agree — a device and the server that
-- disagree on when two links are the same link will index an item the tech
-- cannot then find. supabase/test/10_tag_links_test.sql pins the pairs.
--
-- Scheme and host are lowercased, a leading www. and the default port dropped,
-- trailing slashes trimmed, tracking parameters removed and the rest sorted.
-- The PATH keeps its case on purpose: plenty of systems key off a
-- case-sensitive id, and folding it would merge two different items into one.
CREATE OR REPLACE FUNCTION public.fp_tag_url_key(p_url text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  s        text := btrim(coalesce(p_url, ''));
  scheme   text;
  rest     text;
  frag     text;
  query    text;
  hostport text;
  path     text;
  host     text;
  port     text;
  kept     text[] := '{}';
  kv       text;
BEGIN
  IF s = '' THEN RETURN ''; END IF;

  -- Not a URL at all. Still worth a stable key so a malformed link is at least
  -- consistent with itself, which is what the JS side does too.
  IF s !~ '^[A-Za-z][A-Za-z0-9+.-]*://' THEN RETURN lower(s); END IF;

  scheme := lower(substring(s from '^([A-Za-z][A-Za-z0-9+.-]*)://'));
  rest   := substring(s from '^[A-Za-z][A-Za-z0-9+.-]*://(.*)$');

  frag := substring(rest from '#(.*)$');
  rest := regexp_replace(rest, '#.*$', '');

  query := substring(rest from '\?(.*)$');
  rest  := regexp_replace(rest, '\?.*$', '');

  hostport := split_part(rest, '/', 1);
  path     := coalesce(substring(rest from '^[^/]*(/.*)$'), '');

  -- Credentials in the authority are stripped rather than keyed on: the same
  -- link with and without them is the same link.
  IF position('@' in hostport) > 0 THEN
    hostport := substring(hostport from '@(.*)$');
  END IF;

  host := lower(split_part(hostport, ':', 1));
  host := regexp_replace(host, '^www\.', '');
  port := nullif(split_part(hostport, ':', 2), '');

  IF port IS NOT NULL AND ((scheme = 'https' AND port = '443')
                        OR (scheme = 'http'  AND port = '80')) THEN
    port := NULL;
  END IF;

  path := regexp_replace(path, '/+$', '');

  IF query IS NOT NULL AND query <> '' THEN
    SELECT array_agg(p ORDER BY split_part(p, '=', 1))
      INTO kept
      FROM unnest(string_to_array(query, '&')) AS p
     WHERE p <> ''
       AND split_part(p, '=', 1) !~* '^(utm_|fbclid$|gclid$|mc_[ce]id$|_ga$|ref$|source$)';
  END IF;

  -- Only a sheet tab id survives in the fragment: for Google Sheets #gid=N is
  -- the sole thing distinguishing one tab from another, so dropping it would
  -- merge every tab of a workbook into one item.
  IF frag IS NULL OR frag !~ '^gid=[0-9]+$' THEN
    frag := NULL;
  END IF;

  RETURN scheme || '://' || host
      || coalesce(':' || port, '')
      || path
      || CASE WHEN kept IS NULL OR array_length(kept, 1) IS NULL
              THEN '' ELSE '?' || array_to_string(kept, '&') END
      || coalesce('#' || frag, '');
END;
$$;

-- ── The link, on the item ────────────────────────────────────────────────────
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS tag_url text;
-- Generated rather than written by the app, so the two can never drift apart
-- and no upload path can forget to set it.
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS tag_url_key text
  GENERATED ALWAYS AS (public.fp_tag_url_key(tag_url)) STORED;

CREATE INDEX IF NOT EXISTS assets_tag_url_key_idx
  ON public.assets(account_id, tag_url_key) WHERE tag_url_key <> '';

-- fp_inspections.tag_url — the link read at the time of THAT inspection — is
-- declared in 11_fp_equipment_types.sql, beside record_fp_inspection() which
-- writes it. Kept on the inspection and not only on the item because an item can
-- be re-tagged, and the record has to say which link the tech actually read.
-- Repeated here so re-running this file alone still finds the column.
ALTER TABLE public.fp_inspections ADD COLUMN IF NOT EXISTS tag_url text;

-- ── Tags seen but not inspected ──────────────────────────────────────────────
-- The tech tapped it, could not identify it, and chose to record the link and
-- move on. One row per link per account.
CREATE TABLE IF NOT EXISTS public.fp_tag_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Set once the link is tied to a real item. Until then this is a sighting.
  asset_id       uuid REFERENCES public.assets(id) ON DELETE SET NULL,

  tag_url        text NOT NULL,
  tag_url_key    text GENERATED ALWAYS AS (public.fp_tag_url_key(tag_url)) STORED,
  nfc_tag_uid    text,
  public_ref     text,
  serial_num     text,

  work_order_id  text,
  -- What the link claimed, if anything was fetched at sighting time. Whole, as
  -- fetched, so a later change to the parser can be re-run over it.
  claimed        jsonb,
  fetched_at     timestamptz,

  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  seen_count     integer NOT NULL DEFAULT 1,
  created_by     uuid REFERENCES auth.users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fp_tag_links_account_url_uq
  ON public.fp_tag_links(account_id, tag_url_key);
CREATE INDEX IF NOT EXISTS fp_tag_links_asset_idx ON public.fp_tag_links(asset_id);

-- ── What a link claimed ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fp_external_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  asset_id       uuid REFERENCES public.assets(id) ON DELETE CASCADE,

  -- Where it came from. Not nullable: an external record with no provenance is
  -- indistinguishable from a fabricated one, which is the whole thing this
  -- table exists to prevent.
  source_url     text NOT NULL,
  source_url_key text GENERATED ALWAYS AS (public.fp_tag_url_key(source_url)) STORED,
  fetched_at     timestamptz,

  -- Extracted for querying. Every one is a CLAIM — hence the naming, so that no
  -- future join can mistake one of these for something this company recorded.
  claimed_serial          text,
  claimed_tag_id          text,
  claimed_inspection_date date,
  claimed_next_due_date   date,
  claimed_pass            boolean,
  claimed_result_text     text,
  claimed_manufacturer    text,
  claimed_model           text,
  claimed_item_type       text,
  claimed_inspector       text,

  -- The whole parsed payload, checks included, kept verbatim.
  claimed        jsonb NOT NULL,

  captured_at    timestamptz,
  created_by     uuid REFERENCES auth.users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fp_external_account_idx ON public.fp_external_records(account_id);
CREATE INDEX IF NOT EXISTS fp_external_asset_idx   ON public.fp_external_records(asset_id);
CREATE INDEX IF NOT EXISTS fp_external_url_idx     ON public.fp_external_records(source_url_key);

-- One row per link per inspection-date claim, so a tech tapping the same tag
-- twice does not stack duplicates of the same claim.
CREATE UNIQUE INDEX IF NOT EXISTS fp_external_uq
  ON public.fp_external_records(account_id, source_url_key,
                                coalesce(claimed_inspection_date, 'epoch'::date));

-- ── Row level security ───────────────────────────────────────────────────────
-- Account-scoped, read-only to the client. Every write goes through the
-- SECURITY DEFINER functions below, exactly as the inspection tables do — the
-- client never gets INSERT or UPDATE on either table.
ALTER TABLE public.fp_tag_links        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fp_external_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fp_tag_links_read" ON public.fp_tag_links;
CREATE POLICY "fp_tag_links_read" ON public.fp_tag_links
  FOR SELECT TO authenticated
  USING (account_id = public.my_account_id());

DROP POLICY IF EXISTS "fp_external_read" ON public.fp_external_records;
CREATE POLICY "fp_external_read" ON public.fp_external_records
  FOR SELECT TO authenticated
  USING (account_id = public.my_account_id());

REVOKE ALL ON public.fp_tag_links        FROM anon, authenticated;
REVOKE ALL ON public.fp_external_records FROM anon, authenticated;
GRANT SELECT ON public.fp_tag_links        TO authenticated;
GRANT SELECT ON public.fp_external_records TO authenticated;

-- ── record_fp_tag_link ───────────────────────────────────────────────────────
-- A tag was seen. Records the link, ties it to an item if the payload names one
-- we can resolve, and counts the sighting.
CREATE OR REPLACE FUNCTION public.record_fp_tag_link(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_account uuid;
  v_url     text := nullif(btrim(coalesce(p->>'tag_url','')), '');
  v_serial  text := nullif(btrim(coalesce(p->>'serial_num','')), '');
  v_asset   uuid;
  v_id      uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_url IS NULL THEN RAISE EXCEPTION 'A tag link is required'; END IF;

  SELECT account_id INTO v_account FROM public.account_members WHERE user_id = v_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  -- Tie it to an item where the tag named one. A sighting whose serial matches
  -- nothing stays unattached rather than creating an asset: an item this
  -- company has never inspected should not appear in its catalogue because
  -- somebody walked past it with a phone.
  IF v_serial IS NOT NULL THEN
    SELECT id INTO v_asset FROM public.assets
     WHERE account_id = v_account AND kind = 'fall_protection'
       AND serial_key = public.serial_key(v_serial);
  END IF;

  IF v_asset IS NULL AND nullif(p->>'public_ref','') IS NOT NULL THEN
    SELECT id INTO v_asset FROM public.assets
     WHERE account_id = v_account AND public_ref = p->>'public_ref';
  END IF;

  INSERT INTO public.fp_tag_links (
    account_id, asset_id, tag_url, nfc_tag_uid, public_ref, serial_num,
    work_order_id, claimed, fetched_at, created_by
  ) VALUES (
    v_account, v_asset, v_url,
    nullif(p->>'nfc_tag_serial',''), nullif(p->>'public_ref',''), v_serial,
    nullif(p->>'work_order_id',''),
    p->'claimed', (p->>'fetched_at')::timestamptz, v_user
  )
  ON CONFLICT (account_id, tag_url_key) DO UPDATE SET
    last_seen_at  = now(),
    seen_count    = public.fp_tag_links.seen_count + 1,
    -- Only ever fills gaps. A later sighting that learned less must not erase
    -- what an earlier one established.
    asset_id      = coalesce(public.fp_tag_links.asset_id, EXCLUDED.asset_id),
    nfc_tag_uid   = coalesce(public.fp_tag_links.nfc_tag_uid, EXCLUDED.nfc_tag_uid),
    serial_num    = coalesce(public.fp_tag_links.serial_num, EXCLUDED.serial_num),
    public_ref    = coalesce(public.fp_tag_links.public_ref, EXCLUDED.public_ref),
    claimed       = coalesce(EXCLUDED.claimed, public.fp_tag_links.claimed),
    fetched_at    = coalesce(EXCLUDED.fetched_at, public.fp_tag_links.fetched_at)
  RETURNING id INTO v_id;

  -- Where the sighting did resolve to an item, the item learns its link.
  IF v_asset IS NOT NULL THEN
    UPDATE public.assets
       SET tag_url = v_url, updated_at = clock_timestamp()
     WHERE id = v_asset AND coalesce(tag_url, '') <> v_url;
  END IF;

  RETURN v_id;
END;
$$;

-- ── record_fp_external ───────────────────────────────────────────────────────
-- Files what a tag's link claimed. Deliberately does NOT touch fp_inspections,
-- does not create an asset, and does not affect any due date or certificate.
CREATE OR REPLACE FUNCTION public.record_fp_external(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_account uuid;
  v_url     text := nullif(btrim(coalesce(p->>'source_url', p->>'tag_url', '')), '');
  v_claim   jsonb := coalesce(p->'claimed', '{}'::jsonb);
  v_serial  text := nullif(btrim(coalesce(p->>'serial_num','')), '');
  v_asset   uuid;
  v_id      uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_url IS NULL THEN RAISE EXCEPTION 'An external record must say where it came from'; END IF;

  SELECT account_id INTO v_account FROM public.account_members WHERE user_id = v_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  IF v_serial IS NOT NULL THEN
    SELECT id INTO v_asset FROM public.assets
     WHERE account_id = v_account AND kind = 'fall_protection'
       AND serial_key = public.serial_key(v_serial);
  END IF;

  INSERT INTO public.fp_external_records (
    account_id, asset_id, source_url, fetched_at,
    claimed_serial, claimed_tag_id, claimed_inspection_date, claimed_next_due_date,
    claimed_pass, claimed_result_text, claimed_manufacturer, claimed_model,
    claimed_item_type, claimed_inspector, claimed, captured_at, created_by
  ) VALUES (
    v_account, v_asset, v_url, (p->>'fetched_at')::timestamptz,
    nullif(v_claim->>'serial',''),
    nullif(v_claim->>'tag_id',''),
    -- The client has already normalized these to ISO; anything it could not
    -- parse arrives null and the raw string stays in `claimed`.
    (nullif(v_claim->>'inspection_date',''))::date,
    (nullif(v_claim->>'next_due_date',''))::date,
    (v_claim->>'overall_pass')::boolean,
    nullif(v_claim->>'result_text',''),
    nullif(v_claim->>'manufacturer',''),
    nullif(v_claim->>'model',''),
    nullif(v_claim->>'item_type',''),
    nullif(v_claim->>'inspector',''),
    v_claim,
    (p->>'captured_at')::timestamptz,
    v_user
  )
  ON CONFLICT (account_id, source_url_key,
               coalesce(claimed_inspection_date, 'epoch'::date))
  DO UPDATE SET
    claimed    = EXCLUDED.claimed,
    asset_id   = coalesce(public.fp_external_records.asset_id, EXCLUDED.asset_id),
    fetched_at = coalesce(EXCLUDED.fetched_at, public.fp_external_records.fetched_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── An inspection's link reaches the item ────────────────────────────────────
-- record_fp_inspection() writes fp_inspections.tag_url; this copies it up onto
-- the asset so the NEXT tap resolves through the catalogue instead of needing
-- another fetch. A trigger rather than more code in that function, so
-- 11_fp_equipment_types.sql stays the single definition of how an inspection is
-- recorded and the two files can be re-run in any order.
CREATE OR REPLACE FUNCTION public.fp_inspection_tag_url()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.tag_url IS NOT NULL AND NEW.tag_url <> '' THEN
    UPDATE public.assets
       SET tag_url = NEW.tag_url, updated_at = clock_timestamp()
     WHERE id = NEW.asset_id AND coalesce(tag_url, '') <> NEW.tag_url;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fp_inspection_tag_url_t ON public.fp_inspections;
CREATE TRIGGER fp_inspection_tag_url_t
  AFTER INSERT ON public.fp_inspections
  FOR EACH ROW EXECUTE FUNCTION public.fp_inspection_tag_url();

-- ── Grants ───────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.record_fp_tag_link(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_fp_external(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_fp_tag_link(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_fp_external(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_tag_url_key(text) TO authenticated, anon;

-- ── The public view carries the link ─────────────────────────────────────────
-- Recreated in full because a view's column list cannot be extended in place.
-- Columns are only ever ADDED here; the site does select('*') and reads by name.
DROP VIEW IF EXISTS public.fall_protection_public;
CREATE VIEW public.fall_protection_public AS
  SELECT
    coalesce(a.serial_raw, '')                              AS serial_num,
    a.serial_key,
    a.public_ref,
    public.certificate_url(a.public_ref, 'fall_protection') AS certificate_url,
    a.tag_url,
    a.tag_url_key,
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
    public.fp_effective_status(i.overall_pass, i.next_due_date, i.status)
                                                            AS effective_status,
    i.rep_number,
    i.overall_pass,
    i.version,
    i.created_at
  FROM public.fp_inspections i
  JOIN public.assets a ON a.id = i.asset_id
  WHERE i.is_current AND NOT i.is_deleted
  ORDER BY a.serial_key, i.inspection_date DESC;

GRANT SELECT ON public.fall_protection_public TO anon;
GRANT SELECT ON public.fall_protection_public TO authenticated;

-- ── The device snapshot carries it too ───────────────────────────────────────
-- Without this the phone can index a link it has never been sent, which is to
-- say it cannot index one at all. Adding a column means replacing the function:
-- its RETURNS TABLE is part of its signature.
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
    a.tag_url,
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

REVOKE ALL ON FUNCTION public.account_snapshot(timestamptz, integer, timestamptz, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_snapshot(timestamptz, integer, timestamptz, uuid)
  TO authenticated;
