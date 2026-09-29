-- Certificate view tracking. Runs after 11_support_test.sql.
--
-- The properties that matter:
--   • views from the Lia apps are NOT recorded — they would drown the only
--     signal this exists to capture, which is outside use of the tags
--   • no visitor IP is ever stored; a /24 prefix and a coarse label are
--   • a named network decides office vs field; an unnamed one is not guessed at
--   • repeat views collapse into a count rather than a row per request
--   • anon may record a view and may never read one back

\set ON_ERROR_STOP on
\set ALEX '11111111-1111-1111-1111-111111111111'

\ir _helpers.sql
\ir ../migrations/14_certificate_views.sql

SET lia.uid = '11111111-1111-1111-1111-111111111111';

-- The request headers PostgREST would have set. In the real thing these come
-- from the proxy; here they are set directly so request_ip() has something to
-- read.
CREATE OR REPLACE FUNCTION pg_temp.as_ip(p_ip text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.headers',
    json_build_object('x-forwarded-for', p_ip)::text, false);
END; $$;

-- Something to look at.
DO $$
DECLARE v_checks jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt, 'answer', pass_answer))
    INTO v_checks FROM fp_current_checks(NULL, fp_type_for(NULL, 'body_harness'));
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'VIEW-1', 'equipment_type', 'body_harness', 'checks', v_checks));
END $$;

-- ── Deriving the coarse bits ────────────────────────────────────────────────
DO $$ BEGIN
  -- Enough to tell one site from another, not enough to identify a household.
  PERFORM pg_temp.want('an address is truncated to a /24',
    ip_prefix('203.0.113.47'::inet), '203.0.113.0/24');
  PERFORM pg_temp.want('and v6 to a /48',
    ip_prefix('2001:db8:1234:5678::1'::inet), '2001:db8:1234::/48');
  PERFORM pg_temp.want('a missing address is not invented', ip_prefix(NULL), NULL);

  PERFORM pg_temp.want('a phone reads as mobile',
    device_class('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Mobile/15E148'), 'mobile');
  PERFORM pg_temp.want('a laptop as desktop',
    device_class('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Safari'), 'desktop');
  PERFORM pg_temp.want('a crawler is recognised as one',
    device_class('Mozilla/5.0 (compatible; Googlebot/2.1)'), 'bot');
END $$;

-- ── Views from our own apps are not visits ──────────────────────────────────
DO $$
DECLARE v_ref text; v_before int;
BEGIN
  SELECT public_ref INTO v_ref FROM assets WHERE serial_key = serial_key('VIEW-1');
  SELECT count(*)::int INTO v_before FROM certificate_views;
  PERFORM pg_temp.as_ip('203.0.113.47');

  -- Said outright by the app.
  PERFORM record_certificate_view(jsonb_build_object(
    'public_ref', v_ref, 'source', 'app', 'user_agent', 'Mozilla/5.0 iPhone Mobile'));
  PERFORM pg_temp.want('a view the app declares is not recorded',
    (SELECT count(*)::int FROM certificate_views), v_before);

  -- Or not said, and caught by the user agent anyway.
  PERFORM record_certificate_view(jsonb_build_object(
    'public_ref', v_ref, 'source', 'web',
    'user_agent', 'Mozilla/5.0 (iPhone) AppleWebKit Mobile Capacitor/8.4'));
  PERFORM pg_temp.want('nor one that only looks like the app',
    (SELECT count(*)::int FROM certificate_views), v_before);

  -- A crawler fetching a public URL is not a person reading a certificate.
  PERFORM record_certificate_view(jsonb_build_object(
    'public_ref', v_ref, 'source', 'web', 'user_agent', 'Googlebot/2.1'));
  PERFORM pg_temp.want('and neither is a crawler',
    (SELECT count(*)::int FROM certificate_views), v_before);
END $$;

-- ── A real visit ────────────────────────────────────────────────────────────
DO $$
DECLARE v_ref text; v_row public.certificate_views%ROWTYPE;
BEGIN
  SELECT public_ref INTO v_ref FROM assets WHERE serial_key = serial_key('VIEW-1');
  PERFORM pg_temp.as_ip('203.0.113.47');

  PERFORM record_certificate_view(jsonb_build_object(
    'public_ref', v_ref, 'source', 'web', 'lookup_by', 'ref', 'found', true,
    'user_agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Mobile/15E148',
    'tz', 'America/New_York'));

  SELECT * INTO v_row FROM certificate_views WHERE public_ref = v_ref;
  PERFORM pg_temp.want('a real visit is recorded', v_row.id IS NOT NULL, true);
  PERFORM pg_temp.want('tied to the item',
    v_row.asset_id, (SELECT id FROM assets WHERE serial_key = serial_key('VIEW-1')));
  PERFORM pg_temp.want('and to the account that owns it', v_row.account_id IS NOT NULL, true);
  PERFORM pg_temp.want('with how they arrived', v_row.lookup_by, 'ref');

  -- THE privacy property. The address was used to derive a label and then
  -- thrown away; only the /24 survives.
  PERFORM pg_temp.want('only a network prefix is kept', v_row.ip_prefix, '203.0.113.0/24');
  PERFORM pg_temp.want('and the full address is nowhere in the row',
    (SELECT count(*)::int FROM certificate_views
      WHERE id = v_row.id AND (ip_prefix LIKE '%203.0.113.47%'
                            OR coalesce(user_agent,'') LIKE '%203.0.113.47%')), 0);

  -- No named network, so the device is the only hint there is — and it is
  -- reported as a hint rather than as fact.
  PERFORM pg_temp.want('an unlabelled network with a phone reads as field',
    v_row.viewer_kind, 'field');
  PERFORM pg_temp.want('with no network name invented for it', v_row.network_label, NULL);
END $$;

-- ── Repeat views collapse ───────────────────────────────────────────────────
DO $$
DECLARE v_ref text;
BEGIN
  SELECT public_ref INTO v_ref FROM assets WHERE serial_key = serial_key('VIEW-1');
  PERFORM pg_temp.as_ip('203.0.113.47');
  FOR i IN 1..5 LOOP
    PERFORM record_certificate_view(jsonb_build_object(
      'public_ref', v_ref, 'source', 'web', 'lookup_by', 'ref',
      'user_agent', 'Mozilla/5.0 (iPhone) AppleWebKit Mobile/15E148'));
  END LOOP;

  -- A row per request is a table that grows without bound and a report nobody
  -- can read.
  PERFORM pg_temp.want('a refreshed page is one row, not six',
    (SELECT count(*)::int FROM certificate_views WHERE public_ref = v_ref), 1);
  PERFORM pg_temp.want('but the views are counted',
    (SELECT hits FROM certificate_views WHERE public_ref = v_ref), 6);
END $$;

-- ── A named network decides office vs field ─────────────────────────────────
DO $$
DECLARE v_ref text; v_row public.certificate_views%ROWTYPE;
BEGIN
  SELECT public_ref INTO v_ref FROM assets WHERE serial_key = serial_key('VIEW-1');

  PERFORM save_known_network(jsonb_build_object(
    'cidr', '198.51.100.0/24', 'label', 'Batavia office', 'kind', 'office'));

  -- A phone, which would otherwise read as field, on a network we have named.
  -- The name wins: that is the entire point of the table.
  PERFORM pg_temp.as_ip('198.51.100.9');
  PERFORM record_certificate_view(jsonb_build_object(
    'public_ref', v_ref, 'source', 'web', 'lookup_by', 'ref',
    'user_agent', 'Mozilla/5.0 (iPhone) AppleWebKit Mobile/15E148'));

  SELECT * INTO v_row FROM certificate_views WHERE ip_prefix = '198.51.100.0/24';
  PERFORM pg_temp.want('a named network overrides the device hint', v_row.viewer_kind, 'office');
  PERFORM pg_temp.want('and is reported by its name', v_row.network_label, 'Batavia office');

  -- A more specific range inside a broader one wins, so one machine can be
  -- labelled separately from its office.
  PERFORM save_known_network(jsonb_build_object(
    'cidr', '198.51.100.9/32', 'label', 'Nate laptop', 'kind', 'field'));
  PERFORM pg_temp.as_ip('198.51.100.9');
  -- Move the existing row out of this hour's bucket so the next view is a new
  -- row rather than an increment of the one labelled a moment ago.
  UPDATE certificate_views SET bucket_hour = bucket_hour - interval '2 hours'
   WHERE ip_prefix = '198.51.100.0/24';
  PERFORM record_certificate_view(jsonb_build_object(
    'public_ref', v_ref, 'source', 'web', 'lookup_by', 'ref',
    'user_agent', 'Mozilla/5.0 (iPhone) AppleWebKit Mobile/15E148'));
  -- Selected by bucket, not by last_seen_at: now() is the TRANSACTION clock, so
  -- inside one test both rows carry the same timestamp and ordering by it is
  -- arbitrary. In production each call is its own transaction.
  PERFORM pg_temp.want('the most specific named network wins',
    (SELECT network_label FROM certificate_views
      WHERE ip_prefix = '198.51.100.0/24'
        AND bucket_hour = date_trunc('hour', now())), 'Nate laptop');
  PERFORM pg_temp.want('and it is attributed the way that network is labelled',
    (SELECT viewer_kind FROM certificate_views
      WHERE ip_prefix = '198.51.100.0/24'
        AND bucket_hour = date_trunc('hour', now())), 'field');
END $$;

-- ── A tag pointing at nothing ───────────────────────────────────────────────
-- Each of these is a physical tag in the world that resolves to no record.
DO $$ BEGIN
  PERFORM pg_temp.as_ip('203.0.113.99');
  PERFORM record_certificate_view(jsonb_build_object(
    'public_ref', 'ZZZZZZZZZZ', 'source', 'web', 'lookup_by', 'ref', 'found', false,
    'user_agent', 'Mozilla/5.0 (iPhone) AppleWebKit Mobile/15E148'));
  -- Qualified: FOUND is also a plpgsql status variable in an enclosing block.
  PERFORM pg_temp.want('a tag matching nothing is still recorded',
    (SELECT v.found FROM certificate_views v WHERE v.public_ref = 'ZZZZZZZZZZ'), false);
  PERFORM pg_temp.want('and surfaces in the report',
    (SELECT count(*)::int FROM json_array_elements(certificate_view_summary(30)->'misses')), 1);
END $$;

-- ── Reporting ───────────────────────────────────────────────────────────────
DO $$
DECLARE v json;
BEGIN
  v := certificate_view_summary(30);
  PERFORM pg_temp.want('the report groups by who was looking',
    (SELECT count(*)::int FROM json_array_elements(v->'by_viewer')) > 0, true);
  PERFORM pg_temp.want('and names the items being looked at',
    (SELECT count(*)::int FROM json_array_elements(v->'top_items')) > 0, true);
  PERFORM pg_temp.want('a lead can be told what his own network looks like from here',
    my_network()->>'suggested_cidr' IS NOT NULL, true);
END $$;

-- ── Permissions ─────────────────────────────────────────────────────────────
-- anon serves the public sites: it must be able to say a certificate was
-- looked at, and must never be able to read who has been looking.
DO $$ BEGIN
  PERFORM pg_temp.want('anon may record a view',
    has_function_privilege('anon', 'public.record_certificate_view(jsonb)', 'EXECUTE'), true);
  PERFORM pg_temp.want('but may not read the table',
    has_table_privilege('anon', 'public.certificate_views', 'SELECT'), false);
  PERFORM pg_temp.want('nor run the report',
    has_function_privilege('anon', 'public.certificate_view_summary(integer)', 'EXECUTE'), false);
  PERFORM pg_temp.want('nor label a network',
    has_function_privilege('anon', 'public.save_known_network(jsonb)', 'EXECUTE'), false);
  PERFORM pg_temp.want('and nobody writes the table directly',
    has_table_privilege('authenticated', 'public.certificate_views', 'INSERT'), false);
END $$;

-- Labelling a network decides how every future view is attributed, so it is a
-- lead's call and not a tech's.
SET lia.uid = '33333333-3333-3333-3333-333333333333';
SELECT pg_temp.want_error('a sub-tech cannot label a network',
  $$ SELECT save_known_network('{"cidr":"10.0.0.0/8","label":"mine","kind":"office"}'::jsonb) $$);
