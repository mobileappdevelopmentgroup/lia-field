-- ═══════════════════════════════════════════════════════════════════════════
-- 14 — Who is looking at certificates
--
-- Run after 13_support.sql. Idempotent, like every file here.
--
-- The certificate sites are public: anyone holding a tagged item can scan it
-- and read the record. Useful, and completely invisible — there is no way to
-- tell whether a certificate has ever been looked at, by whom, or whether the
-- tags are being used at all.
--
-- This records a view: which item, when, roughly who, and how they arrived.
--
-- ── What is deliberately NOT recorded ───────────────────────────────────────
-- Not the visitor's IP address. These pages are public and are read by
-- customers' staff and by the general public; keeping an address that
-- identifies a person, on a page nobody logged into, is a liability with no
-- corresponding use. What is actually wanted is "office or field", and that
-- needs a NETWORK, not a person.
--
-- So the address is used at insert time to match a known network and derive a
-- label, then truncated to a /24 (v4) or /48 (v6) and only the prefix is
-- stored. That is enough to tell one site from another and to dedupe repeat
-- views; it is not enough to identify a household.
--
-- Views from the Lia apps are not recorded at all — see record_certificate_view.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Networks somebody has named ─────────────────────────────────────────────
-- The whole "was that the office or a tech in the field" question comes down to
-- this table. An unmatched network is reported as unknown rather than guessed
-- at, and the device class is used as a weaker hint alongside it.
CREATE TABLE IF NOT EXISTS public.known_networks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  cidr       cidr NOT NULL,
  label      text NOT NULL,               -- 'Batavia office', 'Nate hotspot'
  -- What this network means, for rolling up. Free-form labels are for humans;
  -- this is what a report groups by.
  kind       text NOT NULL DEFAULT 'office'
             CHECK (kind IN ('office', 'field', 'customer', 'other')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS known_networks_cidr_idx ON public.known_networks USING gist (cidr inet_ops);

ALTER TABLE public.known_networks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "known_networks_read" ON public.known_networks;
CREATE POLICY "known_networks_read" ON public.known_networks
  FOR SELECT TO authenticated
  USING (account_id IS NULL OR account_id = public.my_account_id());
REVOKE ALL ON public.known_networks FROM anon, authenticated;
GRANT SELECT ON public.known_networks TO authenticated;

-- ── The views themselves ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.certificate_views (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  kind         text CHECK (kind IN ('ladder', 'fall_protection')),
  public_ref   text,
  serial_key   text,
  asset_id     uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  account_id   uuid REFERENCES public.accounts(id) ON DELETE CASCADE,

  -- A miss is as interesting as a hit: it means a tag pointing at something
  -- this database does not have, which is worth knowing about.
  found        boolean NOT NULL DEFAULT true,
  -- How they identified it. 'ref' means they arrived from a tag or a QR code;
  -- 'serial' means somebody typed it, which is a different kind of visit.
  lookup_by    text CHECK (lookup_by IN ('ref', 'serial')),

  -- Roughly who. See the header for why this is a network and not a person.
  viewer_kind   text NOT NULL DEFAULT 'unknown'
                CHECK (viewer_kind IN ('office', 'field', 'customer', 'other', 'unknown')),
  network_label text,
  ip_prefix     text,
  device_class  text,          -- mobile | tablet | desktop | bot | unknown
  user_agent    text,
  referrer      text,
  tz            text,

  -- Repeat views of one certificate from one network inside an hour are one
  -- row with a count, not fifty rows. A public endpoint that inserts a row per
  -- request is a table that grows without bound and a report nobody can read.
  bucket_hour  timestamptz NOT NULL,
  hits         integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS certificate_views_bucket_uq
  ON public.certificate_views (
    coalesce(public_ref, ''), coalesce(serial_key, ''), coalesce(ip_prefix, ''), bucket_hour);
CREATE INDEX IF NOT EXISTS certificate_views_account_idx
  ON public.certificate_views(account_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS certificate_views_asset_idx
  ON public.certificate_views(asset_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS certificate_views_seen_idx
  ON public.certificate_views(last_seen_at DESC);

ALTER TABLE public.certificate_views ENABLE ROW LEVEL SECURITY;

-- Account-scoped read for signed-in users. anon may WRITE (through the function
-- below) and may never read: the sites are public, and a public key that could
-- list who has been looking at what would be worse than not tracking at all.
DROP POLICY IF EXISTS "certificate_views_read" ON public.certificate_views;
CREATE POLICY "certificate_views_read" ON public.certificate_views
  FOR SELECT TO authenticated
  USING (account_id = public.my_account_id() OR public.is_developer());

REVOKE ALL ON public.certificate_views FROM anon, authenticated;
GRANT SELECT ON public.certificate_views TO authenticated;

-- ── Deriving the coarse bits ────────────────────────────────────────────────

-- The caller's address, as PostgREST saw it. Behind Supabase's proxy the real
-- address is the FIRST entry of x-forwarded-for; the rest are hops.
CREATE OR REPLACE FUNCTION public.request_ip()
RETURNS inet LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  hdrs json;
  raw  text;
BEGIN
  BEGIN
    hdrs := nullif(current_setting('request.headers', true), '')::json;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF hdrs IS NULL THEN RETURN NULL; END IF;

  raw := coalesce(hdrs->>'x-forwarded-for', hdrs->>'cf-connecting-ip', hdrs->>'x-real-ip');
  IF raw IS NULL OR btrim(raw) = '' THEN RETURN NULL; END IF;
  raw := btrim(split_part(raw, ',', 1));
  -- An address with a port, or anything malformed, must not raise: this runs on
  -- every public page view and a throw would break the certificate itself.
  raw := regexp_replace(raw, ':\d+$', '');
  BEGIN
    RETURN raw::inet;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END;
$$;

-- Enough to tell one site from another; not enough to identify a household.
CREATE OR REPLACE FUNCTION public.ip_prefix(p_ip inet)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_ip IS NULL THEN NULL
    WHEN family(p_ip) = 4 THEN host(network(set_masklen(p_ip, 24))) || '/24'
    ELSE host(network(set_masklen(p_ip, 48))) || '/48'
  END;
$$;

-- A weak hint, used only where no known network matched. A phone on a customer
-- site and a phone in the office look identical here, which is exactly why the
-- network table exists.
CREATE OR REPLACE FUNCTION public.device_class(p_ua text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_ua IS NULL OR p_ua = '' THEN 'unknown'
    WHEN p_ua ~* '(bot|crawler|spider|slurp|curl|wget|headless|preview)' THEN 'bot'
    WHEN p_ua ~* '(ipad|tablet|playbook|silk)' THEN 'tablet'
    WHEN p_ua ~* '(mobi|iphone|ipod|android.*mobile|windows phone)' THEN 'mobile'
    ELSE 'desktop'
  END;
$$;

-- ── Recording a view ────────────────────────────────────────────────────────
-- Callable by anon: the certificate sites use the publishable key, like every
-- other read they do. It only ever inserts, and anon cannot read the table.
--
-- Returns void rather than anything useful, on purpose. The public page must
-- not be able to tell whether it was recorded, and must not fail if it was not.
CREATE OR REPLACE FUNCTION public.record_certificate_view(p jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_source  text := coalesce(nullif(p->>'source',''), 'web');
  v_ua      text := left(coalesce(nullif(p->>'user_agent',''), ''), 400);
  v_ref     text := nullif(upper(btrim(coalesce(p->>'public_ref',''))), '');
  v_serial  text := nullif(p->>'serial_key','');
  v_kind    text := nullif(p->>'kind','');
  v_found   boolean := coalesce((p->>'found')::boolean, true);
  v_lookup  text := nullif(p->>'lookup_by','');
  v_ip      inet;
  v_prefix  text;
  v_net     public.known_networks%ROWTYPE;
  v_asset   public.assets%ROWTYPE;
  v_class   text;
  v_viewer  text := 'unknown';
  v_label   text;
  v_bucket  timestamptz := date_trunc('hour', now());
BEGIN
  -- Views from our own apps are not visits. A tech opening a certificate from
  -- inside Lia Field, or the office app rendering one, would otherwise swamp
  -- the only signal this table exists to capture: whether anybody OUTSIDE is
  -- using the tags.
  IF v_source <> 'web' THEN RETURN; END IF;
  -- Belt and braces, in case an app forgets to say so. Capacitor and Electron
  -- both put themselves in the user agent.
  IF v_ua ~* '(capacitor|lia-?field|lia-?office|electron)' THEN RETURN; END IF;

  v_class := public.device_class(v_ua);
  -- A crawler fetching a public URL is not a person looking at a certificate.
  IF v_class = 'bot' THEN RETURN; END IF;

  IF v_ref IS NULL AND v_serial IS NULL THEN RETURN; END IF;

  v_ip := public.request_ip();
  v_prefix := public.ip_prefix(v_ip);

  IF v_ip IS NOT NULL THEN
    SELECT * INTO v_net FROM public.known_networks
     -- <<= not <<. The strict operator excludes the network address itself, so
     -- labelling one machine as 198.51.100.9/32 would never match 198.51.100.9
     -- — the single most obvious thing anyone would try.
     WHERE v_ip <<= cidr
     -- The most specific matching network wins, so a single machine can be
     -- labelled inside a broader office range.
     ORDER BY masklen(cidr) DESC
     LIMIT 1;
    IF FOUND THEN
      v_viewer := v_net.kind;
      v_label  := v_net.label;
    END IF;
  END IF;

  -- No named network. A phone is more likely a tech in front of the item than
  -- somebody at a desk — a hint, and reported as such rather than as fact.
  IF v_viewer = 'unknown' AND v_class IN ('mobile', 'tablet') THEN
    v_viewer := 'field';
  END IF;

  -- Tie it to the item so a report can say which items get looked at. Resolved
  -- here rather than trusted from the client, which is a public page.
  IF v_ref IS NOT NULL THEN
    SELECT * INTO v_asset FROM public.assets WHERE public_ref = v_ref;
  END IF;
  IF v_asset.id IS NULL AND v_serial IS NOT NULL THEN
    SELECT * INTO v_asset FROM public.assets
     WHERE serial_key = public.serial_key(v_serial)
     ORDER BY created_at LIMIT 1;
  END IF;

  INSERT INTO public.certificate_views (
    kind, public_ref, serial_key, asset_id, account_id, found, lookup_by,
    viewer_kind, network_label, ip_prefix, device_class, user_agent, referrer, tz,
    bucket_hour
  ) VALUES (
    coalesce(v_kind, v_asset.kind), v_ref,
    CASE WHEN v_serial IS NULL THEN NULL ELSE public.serial_key(v_serial) END,
    v_asset.id, v_asset.account_id, v_found,
    v_lookup, v_viewer, v_label, v_prefix, v_class, v_ua,
    left(nullif(p->>'referrer',''), 300), left(nullif(p->>'tz',''), 60),
    v_bucket
  )
  ON CONFLICT (coalesce(public_ref, ''), coalesce(serial_key, ''),
               coalesce(ip_prefix, ''), bucket_hour)
  DO UPDATE SET
    hits = public.certificate_views.hits + 1,
    last_seen_at = now();
END;
$$;

-- ── Reporting ───────────────────────────────────────────────────────────────
-- Who has been looking, over a window. Account-scoped; the developer sees all.
CREATE OR REPLACE FUNCTION public.certificate_view_summary(p_days integer DEFAULT 30)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_account uuid := public.my_account_id();
  v_dev     boolean := public.is_developer();
  v_since   timestamptz := now() - (greatest(1, least(coalesce(p_days, 30), 365)) || ' days')::interval;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  RETURN json_build_object(
    'since', v_since,
    'by_viewer', (
      SELECT coalesce(json_agg(x), '[]'::json) FROM (
        SELECT viewer_kind, network_label,
               sum(hits)::int AS hits, count(*)::int AS sessions,
               count(DISTINCT coalesce(public_ref, serial_key))::int AS items
          FROM public.certificate_views
         WHERE last_seen_at >= v_since AND (v_dev OR account_id = v_account)
         GROUP BY viewer_kind, network_label
         ORDER BY sum(hits) DESC
      ) x),
    'by_day', (
      SELECT coalesce(json_agg(x ORDER BY x.day), '[]'::json) FROM (
        SELECT date_trunc('day', last_seen_at)::date AS day, sum(hits)::int AS hits
          FROM public.certificate_views
         WHERE last_seen_at >= v_since AND (v_dev OR account_id = v_account)
         GROUP BY 1
      ) x),
    'top_items', (
      SELECT coalesce(json_agg(x), '[]'::json) FROM (
        SELECT v.public_ref, coalesce(a.serial_raw, v.serial_key) AS serial_num,
               v.kind, sum(v.hits)::int AS hits, max(v.last_seen_at) AS last_viewed
          FROM public.certificate_views v
          LEFT JOIN public.assets a ON a.id = v.asset_id
         WHERE v.last_seen_at >= v_since AND (v_dev OR v.account_id = v_account)
         GROUP BY v.public_ref, coalesce(a.serial_raw, v.serial_key), v.kind
         ORDER BY sum(v.hits) DESC
         LIMIT 25
      ) x),
    -- Tags pointing at something this database does not have. Each one is a
    -- physical tag in the world that resolves to nothing.
    -- `v.found` is qualified because FOUND is also plpgsql's own status
    -- variable, and an unqualified reference is ambiguous inside a function.
    'misses', (
      SELECT coalesce(json_agg(x), '[]'::json) FROM (
        SELECT v.public_ref, v.serial_key, sum(v.hits)::int AS hits,
               max(v.last_seen_at) AS last_seen
          FROM public.certificate_views v
         WHERE v.last_seen_at >= v_since AND NOT v.found
           AND (v_dev OR v.account_id IS NULL OR v.account_id = v_account)
         GROUP BY v.public_ref, v.serial_key
         ORDER BY max(v.last_seen_at) DESC
         LIMIT 25
      ) x)
  );
END;
$$;

-- Every view of one item, for the record page in the office app.
CREATE OR REPLACE FUNCTION public.certificate_views_for(p_public_ref text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE v_account uuid := public.my_account_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN (
    SELECT coalesce(json_agg(x ORDER BY x.last_seen_at DESC), '[]'::json) FROM (
      SELECT viewer_kind, network_label, device_class, lookup_by, hits,
             first_seen_at, last_seen_at, tz
        FROM public.certificate_views
       WHERE public_ref = upper(p_public_ref)
         AND (public.is_developer() OR account_id = v_account)
       LIMIT 200
    ) x);
END;
$$;

-- ── Managing the network list ───────────────────────────────────────────────
-- Leads only: labelling a network decides how every future view is attributed.
CREATE OR REPLACE FUNCTION public.save_known_network(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.my_account_id();
  v_id      uuid := nullif(p->>'id','')::uuid;
  v_row     public.known_networks%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_members
                  WHERE user_id = auth.uid() AND role = 'lead') THEN
    RAISE EXCEPTION 'Only a lead technician can label networks';
  END IF;

  IF v_id IS NOT NULL THEN
    UPDATE public.known_networks
       SET cidr = (p->>'cidr')::cidr, label = p->>'label',
           kind = coalesce(nullif(p->>'kind',''), 'office')
     WHERE id = v_id AND account_id = v_account
    RETURNING * INTO v_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'No such network'; END IF;
  ELSE
    INSERT INTO public.known_networks (account_id, cidr, label, kind)
    VALUES (v_account, (p->>'cidr')::cidr, p->>'label',
            coalesce(nullif(p->>'kind',''), 'office'))
    RETURNING * INTO v_row;
  END IF;
  RETURN row_to_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_known_network(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.account_members
                  WHERE user_id = auth.uid() AND role = 'lead') THEN
    RAISE EXCEPTION 'Only a lead technician can label networks';
  END IF;
  DELETE FROM public.known_networks
   WHERE id = p_id AND account_id = public.my_account_id();
END;
$$;

-- What address is this machine on? The only reliable way for a lead to label
-- his own office is to be told what it looks like from here.
CREATE OR REPLACE FUNCTION public.my_network()
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ip inet := public.request_ip();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN json_build_object(
    'ip', host(v_ip),
    'prefix', public.ip_prefix(v_ip),
    'suggested_cidr', CASE WHEN v_ip IS NULL THEN NULL
                           WHEN family(v_ip) = 4 THEN host(network(set_masklen(v_ip, 24))) || '/24'
                           ELSE host(network(set_masklen(v_ip, 48))) || '/48' END);
END;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.record_certificate_view(jsonb)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.certificate_view_summary(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.certificate_views_for(text)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_known_network(jsonb)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_known_network(uuid)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_network()                     FROM PUBLIC, anon;

-- The one thing anon may do: say that a certificate was looked at.
GRANT EXECUTE ON FUNCTION public.record_certificate_view(jsonb)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.certificate_view_summary(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.certificate_views_for(text)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_known_network(jsonb)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_known_network(uuid)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_network()                      TO authenticated;
