-- Lia — training and test accounts; safe to re-run, idempotent
--
-- Needs 01–40.
--
-- ── Why ────────────────────────────────────────────────────────────────────
-- Batavia's techs are trained, and problems are reproduced, in accounts that
-- have to behave exactly like real ones — and must never show on a public
-- certificate. In September, test runs saved against REAL serials made a real
-- ladder's certificate read "Alex Test, WO-12345" as its latest inspection
-- (supabase/ops/applied/2026-11-12-delete-test-records.sql cleaned it up by
-- hand). A demo where Batavia inspects its own ladders would do it again.
--
-- ── What ───────────────────────────────────────────────────────────────────
--   · accounts.is_training. An account is BORN a training account or never is
--     (a trigger refuses flipping it either way), and a training account can
--     never sit under a real one, or a real one under it — so no umbrella's
--     reports ever include training work, and nothing real can be erased.
--   · The three public views skip training accounts. Their bodies move into
--     *_all views that anon cannot read; the public views select from those.
--   · A training certificate is seen only through a PREVIEW token, via
--     training_ladder_inspections(p_token) and friends — same row shape as the
--     public views, so the certificate site renders them unchanged (PostgREST
--     filters work on a set-returning RPC exactly as on a view).
--   · No billing: training accounts are created with unlimited credits (-1),
--     and preflight_work_order refuses any BSI work order that is not on the
--     account's training list — a trainee cannot push parts into a live job.
--   · Certificate-view tracking ignores training items.
--   · Creating, listing and ERASING — developer only. Erasing deletes every
--     row; the Edge Function `training-accounts` then deletes the photos and
--     the generated logins (that needs the service role, which this database
--     function does not have). Generated logins are the only auth users it
--     will ever delete: their address is @training.mobileappdevelopmentgroup.com.
--
-- A training account's items are its own: assets are unique per account, so
-- inspecting a real serial in training creates a separate item and never a new
-- version of the real one.

-- ── The flag ────────────────────────────────────────────────────────────────
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS is_training boolean NOT NULL DEFAULT false;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS training_expires_at timestamptz;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS training_bsi_work_orders text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS training_preview_token text;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS training_created_by uuid;

CREATE INDEX IF NOT EXISTS accounts_training_token_idx
  ON public.accounts (training_preview_token) WHERE training_preview_token IS NOT NULL;

COMMENT ON COLUMN public.accounts.is_training IS
  'Training/test account: never on a public certificate, never billed, erasable. Set at creation only.';

CREATE OR REPLACE FUNCTION public.accounts_training_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_parent_training boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.is_training IS DISTINCT FROM OLD.is_training THEN
    RAISE EXCEPTION 'An account is created as a training account or never is — is_training cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.parent_account_id IS NOT NULL THEN
    SELECT is_training INTO v_parent_training FROM public.accounts WHERE id = NEW.parent_account_id;
    IF v_parent_training IS DISTINCT FROM NEW.is_training THEN
      RAISE EXCEPTION 'A training account and a real account cannot sit under one another'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_training_guard ON public.accounts;
CREATE TRIGGER accounts_training_guard
  BEFORE INSERT OR UPDATE OF is_training, parent_account_id ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.accounts_training_guard();

CREATE OR REPLACE FUNCTION public.is_training_account(p_account uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT is_training FROM public.accounts WHERE id = p_account), false);
$$;
GRANT EXECUTE ON FUNCTION public.is_training_account(uuid) TO authenticated;

-- ── Every certificate row, training included — never readable by anon ───────
-- 40's ladder view body, unchanged, with the account appended.
CREATE OR REPLACE VIEW public.ladder_inspections_all AS
  SELECT
    coalesce(a.serial_raw, i.serial_num) AS serial_num,
    a.serial_key,
    i.inspection_date,
    coalesce(i.rep_name, i.tech_name)    AS tech_name,
    i.rep_name,
    i.rep_number,
    i.verified_by,
    i.next_due_date,
    i.work_order_id,
    i.notes,
    i.brand,
    i.type,
    i.length,
    i.created_at,
    a.public_ref,
    i.version,
    i.lubricated,
    i.has_leveler,
    i.has_claw,
    i.has_vrung,
    public.certificate_url(a.public_ref, a.kind) AS certificate_url,
    (public.ladder_destroy_reason(i.parts) IS NOT NULL) AS destroyed,
    public.ladder_destroy_reason(i.parts)               AS destroy_reason,
    a.tag_label,
    a.tag_label_key,
    coalesce(i.account_id, a.account_id) AS account_id
  FROM public.inspections i
  LEFT JOIN public.assets a ON a.id = i.asset_id
  WHERE i.is_current AND NOT i.is_deleted;

CREATE OR REPLACE VIEW public.fall_protection_all AS
  SELECT a.serial_raw AS serial_num,
    a.serial_key,
    a.public_ref,
    a.tag_url,
    a.tag_label,
    a.tag_label_key,
    i.inspection_date,
    i.next_due_date,
    coalesce(i.rep_name, i.collector_name) AS tech_name,
    i.rep_name,
    i.rep_number,
    i.verified_by,
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
    public.certificate_url(a.public_ref, 'fall_protection'::text) AS certificate_url,
    public.fp_tag_url(a.public_ref, a.serial_raw) AS tag_write_url,
    a.account_id,
    a.tag_url_key
  FROM public.assets a
  JOIN public.fp_inspections i ON i.asset_id = a.id AND i.is_current AND NOT i.is_deleted
  WHERE a.kind = 'fall_protection';

CREATE OR REPLACE VIEW public.fall_protection_checks_all AS
  SELECT a.public_ref,
    i.inspection_date,
    c.ord,
    c.prompt,
    c.answer_style,
    c.answer,
    CASE
      WHEN c.answer IS NULL THEN NULL::text
      WHEN c.answer_style = 'yes_no' THEN CASE WHEN c.answer THEN 'Yes' ELSE 'No' END
      ELSE CASE WHEN c.answer THEN 'Pass' ELSE 'Fail' END
    END AS answer_label,
    c.result,
    a.account_id
  FROM public.fp_inspection_checks c
  JOIN public.fp_inspections i ON i.id = c.fp_inspection_id
  JOIN public.assets a ON a.id = i.asset_id
  WHERE i.is_current AND NOT i.is_deleted;

-- Supabase grants new relations in public to anon and authenticated by
-- default. These carry training rows, so nobody but their owner reads them.
REVOKE ALL ON public.ladder_inspections_all     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.fall_protection_all        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.fall_protection_checks_all FROM PUBLIC, anon, authenticated;

-- ── The public views: the same columns, training accounts left out ──────────
-- CREATE OR REPLACE keeps each view's grants and column list.
CREATE OR REPLACE VIEW public.ladder_inspections_public AS
  SELECT v.serial_num, v.serial_key, v.inspection_date, v.tech_name, v.rep_name,
         v.rep_number, v.verified_by, v.next_due_date, v.work_order_id, v.notes,
         v.brand, v.type, v.length, v.created_at, v.public_ref, v.version,
         v.lubricated, v.has_leveler, v.has_claw, v.has_vrung, v.certificate_url,
         v.destroyed, v.destroy_reason, v.tag_label, v.tag_label_key
    FROM public.ladder_inspections_all v
   WHERE NOT EXISTS (SELECT 1 FROM public.accounts t WHERE t.id = v.account_id AND t.is_training)
   ORDER BY v.serial_num, v.inspection_date DESC;

CREATE OR REPLACE VIEW public.fall_protection_public AS
  SELECT v.serial_num, v.serial_key, v.public_ref, v.tag_url, v.tag_label, v.tag_label_key,
         v.inspection_date, v.next_due_date, v.tech_name, v.rep_name, v.rep_number,
         v.verified_by, v.manufacturer, v.model, v.item_type, v.description,
         v.lot_number, v.mfg_month, v.mfg_year, v.status, v.overall_pass,
         v.discard_reason, v.work_order_id, v.created_at, v.certificate_url, v.tag_write_url,
         -- Appended: the phone looks a third-party tag link up by its canonical
         -- form (fp.js fpLookupOnline). tag_url is already public; this is it normalised.
         v.tag_url_key
    FROM public.fall_protection_all v
   WHERE NOT EXISTS (SELECT 1 FROM public.accounts t WHERE t.id = v.account_id AND t.is_training);

CREATE OR REPLACE VIEW public.fall_protection_checks_public AS
  SELECT v.public_ref, v.inspection_date, v.ord, v.prompt, v.answer_style,
         v.answer, v.answer_label, v.result
    FROM public.fall_protection_checks_all v
   WHERE NOT EXISTS (SELECT 1 FROM public.accounts t WHERE t.id = v.account_id AND t.is_training)
   ORDER BY v.public_ref, v.inspection_date DESC, v.ord;

GRANT SELECT ON public.ladder_inspections_public     TO anon, authenticated;
GRANT SELECT ON public.fall_protection_public        TO anon, authenticated;
GRANT SELECT ON public.fall_protection_checks_public TO anon, authenticated;

-- ── Training certificates, by preview token only ────────────────────────────
-- Anon-callable on purpose: the certificate site has no login. The token is
-- 64 random hex characters, shared by a training family, and dies with it.
-- Anything shorter than 32 characters answers nothing.
CREATE OR REPLACE FUNCTION public.training_ladder_inspections(p_token text)
RETURNS SETOF public.ladder_inspections_public
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.serial_num, v.serial_key, v.inspection_date, v.tech_name, v.rep_name,
         v.rep_number, v.verified_by, v.next_due_date, v.work_order_id, v.notes,
         v.brand, v.type, v.length, v.created_at, v.public_ref, v.version,
         v.lubricated, v.has_leveler, v.has_claw, v.has_vrung, v.certificate_url,
         v.destroyed, v.destroy_reason, v.tag_label, v.tag_label_key
    FROM public.ladder_inspections_all v
    JOIN public.accounts t ON t.id = v.account_id
   WHERE t.is_training
     AND length(coalesce(p_token, '')) >= 32
     AND t.training_preview_token = p_token;
$$;

CREATE OR REPLACE FUNCTION public.training_fall_protection(p_token text)
RETURNS SETOF public.fall_protection_public
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.serial_num, v.serial_key, v.public_ref, v.tag_url, v.tag_label, v.tag_label_key,
         v.inspection_date, v.next_due_date, v.tech_name, v.rep_name, v.rep_number,
         v.verified_by, v.manufacturer, v.model, v.item_type, v.description,
         v.lot_number, v.mfg_month, v.mfg_year, v.status, v.overall_pass,
         v.discard_reason, v.work_order_id, v.created_at, v.certificate_url, v.tag_write_url,
         -- Appended: the phone looks a third-party tag link up by its canonical
         -- form (fp.js fpLookupOnline). tag_url is already public; this is it normalised.
         v.tag_url_key
    FROM public.fall_protection_all v
    JOIN public.accounts t ON t.id = v.account_id
   WHERE t.is_training
     AND length(coalesce(p_token, '')) >= 32
     AND t.training_preview_token = p_token;
$$;

CREATE OR REPLACE FUNCTION public.training_fall_protection_checks(p_token text)
RETURNS SETOF public.fall_protection_checks_public
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.public_ref, v.inspection_date, v.ord, v.prompt, v.answer_style,
         v.answer, v.answer_label, v.result
    FROM public.fall_protection_checks_all v
    JOIN public.accounts t ON t.id = v.account_id
   WHERE t.is_training
     AND length(coalesce(p_token, '')) >= 32
     AND t.training_preview_token = p_token;
$$;

GRANT EXECUTE ON FUNCTION public.training_ladder_inspections(text)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.training_fall_protection(text)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.training_fall_protection_checks(text) TO anon, authenticated;

-- ── Certificate-view tracking ignores training items ────────────────────────
-- 14's function, re-emitted; the two changes are marked "41".
CREATE OR REPLACE FUNCTION public.record_certificate_view(p jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
     WHERE v_ip <<= cidr
     ORDER BY masklen(cidr) DESC
     LIMIT 1;
    IF FOUND THEN
      v_viewer := v_net.kind;
      v_label  := v_net.label;
    END IF;
  END IF;

  IF v_viewer = 'unknown' AND v_class IN ('mobile', 'tablet') THEN
    v_viewer := 'field';
  END IF;

  IF v_ref IS NOT NULL THEN
    SELECT * INTO v_asset FROM public.assets WHERE public_ref = v_ref;
  END IF;
  -- 41: a training item is never a visit.
  IF v_asset.id IS NOT NULL AND public.is_training_account(v_asset.account_id) THEN RETURN; END IF;
  IF v_asset.id IS NULL AND v_serial IS NOT NULL THEN
    SELECT * INTO v_asset FROM public.assets
     WHERE serial_key = public.serial_key(v_serial)
       -- 41: a real serial typed on the public site is the real item, never a
       -- training copy of it.
       AND NOT public.is_training_account(account_id)
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

-- ── BSI: a training account imports only into its training work orders ──────
-- 03's preflight, re-emitted; the training block is new. Lia Office runs this
-- before the browser opens, and refuses on can_run = false.
CREATE OR REPLACE FUNCTION public.preflight_work_order(p_wo_number text) RETURNS json
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_account_id uuid;
  v_credits    integer;
  v_key        text;
  v_charged    boolean := false;
  v_training   boolean;
  v_allowed    text[];
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_key := public.wo_key(p_wo_number);
  IF v_key = '' THEN RAISE EXCEPTION 'A work order number is required'; END IF;

  v_account_id := public.my_account_id();
  IF v_account_id IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  SELECT credits, is_training, training_bsi_work_orders
    INTO v_credits, v_training, v_allowed
    FROM public.accounts WHERE id = v_account_id;

  -- 41: training parts must only ever land on a training work order in BSI.
  IF v_training AND NOT EXISTS (SELECT 1 FROM unnest(v_allowed) w WHERE public.wo_key(w) = v_key) THEN
    RETURN json_build_object(
      'credits', v_credits, 'already_charged', false, 'free', true, 'can_run', false,
      'training', true,
      'reason', CASE WHEN coalesce(array_length(v_allowed, 1), 0) = 0
                  THEN 'This is a training account and no BSI training work order is set for it. Ask the developer to add one.'
                  ELSE 'This is a training account. It can only import into its BSI training work order: '
                       || array_to_string(v_allowed, ', ') || '.'
                END);
  END IF;

  SELECT (charged_at IS NOT NULL) INTO v_charged
  FROM public.work_orders WHERE account_id = v_account_id AND wo_key = v_key;

  RETURN json_build_object(
    'credits',         v_credits,
    'already_charged', COALESCE(v_charged, false),
    'free',            COALESCE(v_charged, false) OR v_credits = -1,
    'can_run',         COALESCE(v_charged, false) OR v_credits = -1 OR v_credits > 0,
    'training',        coalesce(v_training, false)
  );
END;
$$;

-- ── my_context(): the apps draw the TEST banner and preview links from it ───
-- 23's function, re-emitted; the training keys at the end are new.
CREATE OR REPLACE FUNCTION public.my_context() RETURNS json
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT json_build_object(
    'account_id',      public.my_account_id(),
    'account_name',    (SELECT name FROM public.accounts WHERE id = public.my_account_id()),
    'real_account_id', public.my_real_account_id(),
    'real_account_name', (SELECT name FROM public.accounts WHERE id = public.my_real_account_id()),
    'impersonating',   public.is_impersonating(),
    'expires_at',      (SELECT expires_at FROM public.active_impersonation()),
    'reason',          (SELECT reason FROM public.active_impersonation()),
    'role',            (SELECT role FROM public.account_members
                         WHERE user_id = auth.uid() AND removed_at IS NULL),
    'is_umbrella',     (SELECT a.parent_account_id IS NULL
                          FROM public.accounts a WHERE a.id = public.my_real_account_id()),
    'acting_is_umbrella', EXISTS (SELECT 1 FROM public.accounts
                                   WHERE parent_account_id = public.my_account_id()),
    'can_act_as',      coalesce((
       SELECT json_agg(json_build_object('account_id', a.id, 'name', a.name) ORDER BY a.name)
         FROM public.accounts a
         JOIN public.account_descendants(public.my_real_account_id()) d ON d.account_id = a.id
        WHERE a.id <> public.my_real_account_id()
          AND EXISTS (SELECT 1 FROM public.account_members m
                       WHERE m.user_id = auth.uid() AND m.role = 'lead'
                         AND m.removed_at IS NULL)
     ), '[]'::json),
    -- 41
    'is_training',     coalesce((SELECT is_training FROM public.accounts WHERE id = public.my_account_id()), false),
    'training_preview_token', (SELECT training_preview_token FROM public.accounts
                                WHERE id = public.my_account_id() AND is_training),
    'training_bsi_work_orders', (SELECT to_json(training_bsi_work_orders) FROM public.accounts
                                  WHERE id = public.my_account_id() AND is_training),
    'training_expires_at', (SELECT training_expires_at FROM public.accounts
                             WHERE id = public.my_account_id() AND is_training)
  );
$$;

-- ── Developer tools ─────────────────────────────────────────────────────────
-- Creation and erasure run in the Edge Function with the service role (it has
-- to create and delete logins), so the functions it calls take the caller as
-- p_actor — verified by the function from the caller's own token — and are
-- executable by service_role ONLY. The listing and the edit run as the
-- signed-in developer from Lia Office.

CREATE OR REPLACE FUNCTION public.training_require_developer(p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_actor IS NULL OR NOT coalesce((SELECT is_developer FROM public.users WHERE id = p_actor), false) THEN
    RAISE EXCEPTION 'Only the developer can manage training accounts' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- A typed list of BSI work orders: blanks dropped, the same number typed two
-- ways kept once, in the order given.
CREATE OR REPLACE FUNCTION public.training_work_order_list(p jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT coalesce(array_agg(w ORDER BY n), '{}')
    FROM (SELECT DISTINCT ON (public.wo_key(x)) btrim(x) AS w, n
            FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END)
                   WITH ORDINALITY AS t(x, n)
           WHERE btrim(x) <> '' AND public.wo_key(x) <> ''
           ORDER BY public.wo_key(x), n) s;
$$;

-- The address every generated login gets. Nothing else is ever deleted.
CREATE OR REPLACE FUNCTION public.training_login_domain()
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'training.mobileappdevelopmentgroup.com'::text $$;

-- Creates a training umbrella and one crew beneath it — the same shape as
-- Batavia over a subcontractor. p: {name, expires_days (1–90, default 14),
-- bsi_work_orders: [text], rep_number (default 'TRAIN')}.
CREATE OR REPLACE FUNCTION public.training_create(p_actor uuid, p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name    text := btrim(coalesce(p->>'name', ''));
  v_days    int  := coalesce(nullif(p->>'expires_days', '')::int, 14);
  v_wos     text[];
  v_token   text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_expires timestamptz;
  v_root    uuid;
  v_crew    uuid;
BEGIN
  PERFORM public.training_require_developer(p_actor);
  IF v_name = '' THEN RAISE EXCEPTION 'A name is required (e.g. "Batavia demo")'; END IF;
  IF length(v_name) > 60 THEN RAISE EXCEPTION 'Keep the name under 60 characters'; END IF;
  IF v_days < 1 OR v_days > 90 THEN RAISE EXCEPTION 'A training account lasts 1–90 days'; END IF;
  v_expires := now() + make_interval(days => v_days);

  v_wos := public.training_work_order_list(p->'bsi_work_orders');

  INSERT INTO public.accounts (name, credits, is_training, training_expires_at,
                               training_bsi_work_orders, training_preview_token, training_created_by)
  VALUES ('Training: ' || v_name, -1, true, v_expires, v_wos, v_token, p_actor)
  RETURNING id INTO v_root;

  INSERT INTO public.accounts (name, credits, parent_account_id, is_training, training_expires_at,
                               training_bsi_work_orders, training_preview_token, training_created_by)
  VALUES ('Training crew: ' || v_name, -1, v_root, true, v_expires, v_wos, v_token, p_actor)
  RETURNING id INTO v_crew;

  RETURN json_build_object('account_id', v_root, 'crew_account_id', v_crew,
                           'name', 'Training: ' || v_name, 'expires_at', v_expires,
                           'bsi_work_orders', to_json(v_wos), 'preview_token', v_token);
END;
$$;

-- Places a generated login. p: {account_id, user_id, name, role ('lead'|'tech'),
-- rep_number}. Refuses a real account, an address that is not a generated one,
-- and anybody already on an account.
CREATE OR REPLACE FUNCTION public.training_add_member(p_actor uuid, p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := (p->>'account_id')::uuid;
  v_user    uuid := (p->>'user_id')::uuid;
  v_role    text := coalesce(nullif(p->>'role', ''), 'tech');
  v_name    text := nullif(btrim(coalesce(p->>'name', '')), '');
  v_email   text;
BEGIN
  PERFORM public.training_require_developer(p_actor);
  IF NOT public.is_training_account(v_account) THEN
    RAISE EXCEPTION 'Not a training account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_role NOT IN ('lead', 'tech') THEN RAISE EXCEPTION 'Role is lead or tech'; END IF;
  SELECT lower(email) INTO v_email FROM auth.users WHERE id = v_user;
  IF v_email IS NULL THEN RAISE EXCEPTION 'No such login'; END IF;
  IF v_email NOT LIKE '%@' || public.training_login_domain() THEN
    RAISE EXCEPTION 'Training accounts only take generated logins (@%)', public.training_login_domain();
  END IF;
  IF EXISTS (SELECT 1 FROM public.account_members WHERE user_id = v_user) THEN
    RAISE EXCEPTION 'That login is already on an account';
  END IF;

  INSERT INTO public.users (id, email, name, credits)
  VALUES (v_user, v_email, v_name, 0)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO public.account_members (user_id, account_id, role, desktop_access, rep_number, invited_by)
  VALUES (v_user, v_account, v_role, v_role = 'lead',
          CASE WHEN v_role = 'lead' THEN coalesce(nullif(p->>'rep_number', ''), 'TRAIN') END,
          p_actor);

  RETURN json_build_object('user_id', v_user, 'account_id', v_account, 'role', v_role, 'email', v_email);
END;
$$;

-- What has been erased, so a half-finished erase (rows gone, logins or photos
-- not yet) can be finished later rather than leaving orphans.
CREATE TABLE IF NOT EXISTS public.training_erasures (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  account_ids  uuid[] NOT NULL,
  user_ids     uuid[] NOT NULL DEFAULT '{}',
  erased_by    uuid,
  erased_at    timestamptz NOT NULL DEFAULT now(),
  rows_deleted jsonb,
  finished_at  timestamptz
);
ALTER TABLE public.training_erasures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_erasures FROM PUBLIC, anon, authenticated;

-- Deletes every row belonging to a training account and everything beneath
-- it. Returns the logins and account ids whose photos and auth users the Edge
-- Function deletes next. Refuses — before touching anything — unless every
-- account in the family is a training account.
CREATE OR REPLACE FUNCTION public.training_erase(p_actor uuid, p_account uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fam    uuid[];
  v_users  uuid[];
  v_name   text;
  v_id     uuid;
  v_counts jsonb := '{}'::jsonb;
  v_n      int;
  v_left   int;
BEGIN
  PERFORM public.training_require_developer(p_actor);
  SELECT name INTO v_name FROM public.accounts WHERE id = p_account;
  IF v_name IS NULL THEN RAISE EXCEPTION 'No such account'; END IF;

  SELECT array_agg(account_id) INTO v_fam FROM public.account_descendants(p_account);
  IF EXISTS (SELECT 1 FROM public.accounts WHERE id = ANY (v_fam) AND NOT is_training) THEN
    RAISE EXCEPTION 'Refused: % is not a training account (or has a real account beneath it). Nothing was erased.', v_name
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Only generated logins are ever deleted; anybody else on the account (it
  -- should never happen) just loses the membership with it.
  SELECT coalesce(array_agg(m.user_id), '{}') INTO v_users
    FROM public.account_members m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.account_id = ANY (v_fam)
     AND lower(u.email) LIKE '%@' || public.training_login_domain();

  -- Tables that do not cascade from accounts, or reference other rows that are
  -- going, first.
  DELETE FROM public.usage_log              WHERE account_id = ANY (v_fam);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('usage_log', v_n);
  DELETE FROM public.support_tickets        WHERE account_id = ANY (v_fam);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('support_tickets', v_n);
  DELETE FROM public.impersonation_sessions WHERE account_id = ANY (v_fam) OR actor_account = ANY (v_fam);
  DELETE FROM public.inspections            WHERE account_id = ANY (v_fam)
                                               OR asset_id IN (SELECT id FROM public.assets WHERE account_id = ANY (v_fam));
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('inspections', v_n);
  DELETE FROM public.fp_inspections         WHERE account_id = ANY (v_fam)
                                               OR asset_id IN (SELECT id FROM public.assets WHERE account_id = ANY (v_fam));
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('fp_inspections', v_n);
  DELETE FROM public.inspection_photos      WHERE account_id = ANY (v_fam);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('photos', v_n);

  -- The accounts themselves, deepest first (a parent is ON DELETE RESTRICT).
  -- Everything else cascades with them.
  LOOP
    DELETE FROM public.accounts a
     WHERE a.id = ANY (v_fam)
       AND NOT EXISTS (SELECT 1 FROM public.accounts c WHERE c.parent_account_id = a.id);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    SELECT count(*) INTO v_left FROM public.accounts WHERE id = ANY (v_fam);
    EXIT WHEN v_left = 0 OR v_n = 0;
  END LOOP;
  IF v_left > 0 THEN RAISE EXCEPTION 'Could not erase every account in the family'; END IF;
  v_counts := v_counts || jsonb_build_object('accounts', array_length(v_fam, 1));

  INSERT INTO public.training_erasures (name, account_ids, user_ids, erased_by, rows_deleted)
  VALUES (v_name, v_fam, v_users, p_actor, v_counts)
  RETURNING id INTO v_id;

  RETURN json_build_object('erasure_id', v_id, 'name', v_name, 'account_ids', to_json(v_fam),
                           'user_ids', to_json(v_users), 'rows_deleted', v_counts);
END;
$$;

CREATE OR REPLACE FUNCTION public.training_erase_finished(p_actor uuid, p_erasure uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.training_require_developer(p_actor);
  UPDATE public.training_erasures SET finished_at = now() WHERE id = p_erasure AND finished_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.training_pending_erasures(p_actor uuid)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.training_require_developer(p_actor);
  RETURN coalesce((SELECT json_agg(json_build_object('erasure_id', id, 'name', name,
                     'account_ids', account_ids, 'user_ids', user_ids, 'erased_at', erased_at)
                     ORDER BY erased_at)
                     FROM public.training_erasures WHERE finished_at IS NULL), '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.training_require_developer(uuid)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.training_create(uuid, jsonb)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.training_add_member(uuid, jsonb)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.training_erase(uuid, uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.training_erase_finished(uuid, uuid)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.training_pending_erasures(uuid)       FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.training_create(uuid, jsonb)        TO service_role;
    GRANT EXECUTE ON FUNCTION public.training_add_member(uuid, jsonb)    TO service_role;
    GRANT EXECUTE ON FUNCTION public.training_erase(uuid, uuid)          TO service_role;
    GRANT EXECUTE ON FUNCTION public.training_erase_finished(uuid, uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.training_pending_erasures(uuid)     TO service_role;
  END IF;
END $$;

-- The developer's list in Lia Office: each training family with its people
-- and how much is in it.
CREATE OR REPLACE FUNCTION public.training_accounts()
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.training_require_developer(auth.uid());
  RETURN coalesce((
    SELECT json_agg(json_build_object(
      'account_id', r.id,
      'name', r.name,
      'created_at', r.created_at,
      'expires_at', r.training_expires_at,
      'expired', r.training_expires_at < now(),
      'bsi_work_orders', to_json(r.training_bsi_work_orders),
      'preview_token', r.training_preview_token,
      'accounts', (SELECT json_agg(json_build_object('account_id', a.id, 'name', a.name,
                                                     'is_root', a.id = r.id) ORDER BY a.id <> r.id, a.name)
                     FROM public.accounts a JOIN public.account_descendants(r.id) d ON d.account_id = a.id),
      'members', coalesce((SELECT json_agg(json_build_object('user_id', m.user_id, 'email', u.email,
                                                     'name', u.name, 'role', m.role,
                                                     'account_name', a.name) ORDER BY a.id <> r.id, m.role, u.email)
                     FROM public.account_members m
                     JOIN public.users u ON u.id = m.user_id
                     JOIN public.accounts a ON a.id = m.account_id
                     JOIN public.account_descendants(r.id) d ON d.account_id = m.account_id), '[]'::json),
      'ladders', (SELECT count(*) FROM public.inspections i
                   JOIN public.account_descendants(r.id) d ON d.account_id = i.account_id
                  WHERE i.is_current AND NOT i.is_deleted),
      'fp', (SELECT count(*) FROM public.fp_inspections i
              JOIN public.account_descendants(r.id) d ON d.account_id = i.account_id
             WHERE i.is_current AND NOT i.is_deleted)
    ) ORDER BY r.created_at DESC)
    FROM public.accounts r
    WHERE r.is_training AND r.parent_account_id IS NULL
  ), '[]'::json);
END;
$$;

-- Extend a training account, or change its BSI training work orders.
-- p: {account_id, expires_days?, bsi_work_orders?}. Applies to the family.
CREATE OR REPLACE FUNCTION public.training_update(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_root uuid := (p->>'account_id')::uuid;
  v_days int  := nullif(p->>'expires_days', '')::int;
  v_wos  text[];
BEGIN
  PERFORM public.training_require_developer(auth.uid());
  IF NOT public.is_training_account(v_root) THEN
    RAISE EXCEPTION 'Not a training account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_days IS NOT NULL AND (v_days < 1 OR v_days > 90) THEN
    RAISE EXCEPTION 'A training account lasts 1–90 days';
  END IF;
  IF p ? 'bsi_work_orders' THEN
    v_wos := public.training_work_order_list(p->'bsi_work_orders');
  END IF;
  UPDATE public.accounts a
     SET training_expires_at = CASE WHEN v_days IS NULL THEN a.training_expires_at
                                    ELSE now() + make_interval(days => v_days) END,
         training_bsi_work_orders = coalesce(v_wos, a.training_bsi_work_orders)
    FROM public.account_descendants(v_root) d
   WHERE a.id = d.account_id;
  RETURN json_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.training_accounts()     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.training_update(jsonb)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_accounts()    TO authenticated;
GRANT EXECUTE ON FUNCTION public.training_update(jsonb) TO authenticated;
