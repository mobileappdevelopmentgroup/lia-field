-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — vehicle inventory: what is on every truck and in every warehouse.
-- Idempotent; safe to re-run. Run AFTER 33_published_part_sets.sql.
--
-- docs/VEHICLE-INVENTORY-PLAN.md is the design and the decisions behind it.
-- The load-bearing rules:
--
--   * THE LEDGER IS THE TRUTH. stock_moves is append-only and written only by
--     the functions here, in the same transaction as the quantity it changes.
--     stock_levels.qty is derived from it by stock_recompute() and nothing
--     else writes it.
--
--   * A COUNT IS AS OF WHEN IT WAS TAKEN. A phone records "I counted 6" at
--     9 am with no signal; it reaches the server at 4 pm, after the office
--     loaded the truck at noon. The quantity is therefore
--         the latest count by captured_at  +  every other move captured after it
--     — so the noon load stays on top of the 9 am count, and a use captured at
--     8 am that arrives late does not come off twice (the 9 am count already
--     saw it gone). Negative on-hand is allowed and shown: it means recount.
--
--   * OFFLINE AND RETRIED. Every phone write carries a client_id and is
--     idempotent on it, so the upload queue can resend freely.
--
--   * WHO. The office (a lead, following impersonation like every other office
--     write) manages its own account's locations; reads follow can_see(), so
--     Batavia sees every subcontractor's trucks and a subcontractor sees only
--     its own. A phone reads and changes only the trucks its user is assigned
--     to — anyone assigned may record use, loading and counts.
--
--   * LADDER PARTS COME OFF THE TRUCK AUTOMATICALLY — only once the office
--     switches it on (stock_settings.auto_deduct, default off), because the
--     counts must be trusted first. The deduction is keyed to the ladder
--     record (asset + inspection date), and follows whichever version is
--     current: a corrected ladder moves only the difference, a deleted one
--     puts its parts back. It runs after the inspection is written and can
--     never stop one being recorded.
--
-- No prices. Money belongs to Lia Office and BSI, not to a phone.
--
-- Also revokes anon from 33's objects: Supabase grants anon EXECUTE/SELECT on
-- new objects by default, which made 33's catalogue answer anon with its own
-- "Not authenticated" rather than a permission error. Nothing leaked; this
-- makes it explicit.
-- ═══════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.account_part_sets_catalog() FROM anon;
REVOKE ALL ON FUNCTION public.save_account_part_sets(jsonb) FROM anon;
REVOKE ALL ON public.account_part_sets FROM anon;

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.stock_loadouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  name_key    text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  -- [{"part_number","par"}], in display order.
  lines       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lines) = 'array'),
  is_deleted  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_loadouts_name_uq
  ON public.stock_loadouts (account_id, name_key) WHERE NOT is_deleted;

CREATE TABLE IF NOT EXISTS public.stock_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('vehicle', 'warehouse')),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  name_key    text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  unit        text CHECK (unit IS NULL OR length(unit) <= 40),   -- plate or unit number
  loadout_id  uuid REFERENCES public.stock_loadouts(id) ON DELETE SET NULL,
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_name_uq
  ON public.stock_locations (account_id, name_key);
CREATE INDEX IF NOT EXISTS stock_locations_account_idx ON public.stock_locations (account_id);

CREATE TABLE IF NOT EXISTS public.stock_assignees (
  location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  -- The truck a person is driving today: where their ladder parts come off.
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, user_id)
);
CREATE INDEX IF NOT EXISTS stock_assignees_user_idx ON public.stock_assignees (user_id);

CREATE TABLE IF NOT EXISTS public.stock_levels (
  location_id  uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  part_key     text NOT NULL,
  part_number  text NOT NULL,
  qty          integer NOT NULL DEFAULT 0,
  -- NULL means "whatever the truck's load-out says".
  par_override integer CHECK (par_override IS NULL OR par_override >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, part_key)
);

CREATE TABLE IF NOT EXISTS public.stock_moves (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  location_id   uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  part_key      text NOT NULL,
  part_number   text NOT NULL,
  delta         integer NOT NULL,
  reason        text NOT NULL CHECK (reason IN
                  ('use', 'load', 'count', 'transfer_in', 'transfer_out', 'adjust', 'ladder')),
  counted_qty   integer CHECK (counted_qty IS NULL OR counted_qty >= 0),
  transfer_id   uuid,             -- both legs of a transfer share it
  inspection_key text,            -- 'ladder' moves: asset_id|inspection_date
  wo_key        text,
  note          text CHECK (note IS NULL OR length(note) <= 500),
  client_id     text,
  actor         uuid,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (reason <> 'count' OR counted_qty IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_moves_client_uq ON public.stock_moves (client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_moves_level_idx ON public.stock_moves (location_id, part_key, captured_at);
CREATE INDEX IF NOT EXISTS stock_moves_inspection_idx ON public.stock_moves (inspection_key) WHERE inspection_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_moves_account_idx ON public.stock_moves (account_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS public.stock_settings (
  account_id  uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  auto_deduct boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Read through can_see (work flows up); written only by the functions below.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_loadouts','stock_locations','stock_levels','stock_moves','stock_settings'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.can_see(account_id))',
                   t || '_read', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

ALTER TABLE public.stock_assignees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_assignees_read ON public.stock_assignees;
CREATE POLICY stock_assignees_read ON public.stock_assignees FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.stock_locations l
                  WHERE l.id = location_id AND public.can_see(l.account_id)));
REVOKE ALL ON public.stock_assignees FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.stock_assignees FROM authenticated;
GRANT SELECT ON public.stock_assignees TO authenticated;

-- ── The arithmetic ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.stock_part_key(p text) RETURNS text
    LANGUAGE sql IMMUTABLE AS $$ SELECT upper(btrim(coalesce(p, ''))) $$;

-- What a location held of a part just before a moment, by the rule above:
-- the latest count at or before it, plus the other moves between.
CREATE OR REPLACE FUNCTION public.stock_qty_at(p_location uuid, p_key text, p_at timestamptz,
                                               p_before_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $$
DECLARE c record;
BEGIN
  SELECT captured_at, recorded_at, counted_qty, id INTO c FROM public.stock_moves
   WHERE location_id = p_location AND part_key = p_key AND reason = 'count'
     AND captured_at <= coalesce(p_at, 'infinity') AND id IS DISTINCT FROM p_before_id
   ORDER BY captured_at DESC, recorded_at DESC, id DESC LIMIT 1;
  RETURN coalesce(c.counted_qty, 0) + coalesce((
    SELECT sum(m.delta) FROM public.stock_moves m
     WHERE m.location_id = p_location AND m.part_key = p_key AND m.reason <> 'count'
       AND m.captured_at <= coalesce(p_at, 'infinity') AND m.id IS DISTINCT FROM p_before_id
       AND (c.captured_at IS NULL OR (m.captured_at, m.recorded_at) > (c.captured_at, c.recorded_at))), 0)::integer;
END;
$$;

-- Brings stock_levels.qty into line with the ledger. The only writer of qty.
CREATE OR REPLACE FUNCTION public.stock_recompute(p_location uuid, p_key text, p_part text)
RETURNS integer LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE v_qty integer := public.stock_qty_at(p_location, p_key, NULL);
        v_acct uuid;
BEGIN
  SELECT account_id INTO v_acct FROM public.stock_locations WHERE id = p_location;
  INSERT INTO public.stock_levels (location_id, account_id, part_key, part_number, qty, updated_at)
  VALUES (p_location, v_acct, p_key, upper(btrim(p_part)), v_qty, now())
  ON CONFLICT (location_id, part_key) DO UPDATE SET qty = EXCLUDED.qty, updated_at = now();
  RETURN v_qty;
END;
$$;

-- One move, every write path's way in. Returns the move's id. A count's delta
-- is what it changed as of when it was taken — kept for the ledger's reader;
-- the quantity itself comes from stock_recompute.
CREATE OR REPLACE FUNCTION public.stock_write_move(
  p_location uuid, p_part text, p_reason text, p_delta integer, p_counted integer,
  p_captured timestamptz, p_client text, p_note text, p_wo text,
  p_transfer uuid DEFAULT NULL, p_inspection_key text DEFAULT NULL, p_actor uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE v_key text := public.stock_part_key(p_part);
        v_acct uuid;
        v_id uuid;
        v_at timestamptz := least(coalesce(p_captured, now()), now() + interval '5 minutes');
        v_delta integer := p_delta;
BEGIN
  IF v_key = '' THEN RAISE EXCEPTION 'A part number is needed'; END IF;
  IF length(v_key) > 60 THEN RAISE EXCEPTION 'Part numbers are 60 characters at most'; END IF;
  SELECT account_id INTO v_acct FROM public.stock_locations WHERE id = p_location;
  IF v_acct IS NULL THEN RAISE EXCEPTION 'No such truck or warehouse'; END IF;
  IF p_reason = 'count' THEN
    v_delta := p_counted - public.stock_qty_at(p_location, v_key, v_at);
  END IF;
  INSERT INTO public.stock_moves (account_id, location_id, part_key, part_number, delta, reason,
         counted_qty, transfer_id, inspection_key, wo_key, note, client_id, actor, captured_at)
  VALUES (v_acct, p_location, v_key, upper(btrim(p_part)), v_delta, p_reason,
         CASE WHEN p_reason = 'count' THEN p_counted END, p_transfer, p_inspection_key,
         nullif(public.wo_key(p_wo), ''), nullif(btrim(coalesce(p_note, '')), ''), p_client,
         coalesce(p_actor, auth.uid()), v_at)
  RETURNING id INTO v_id;
  PERFORM public.stock_recompute(p_location, v_key, p_part);
  RETURN v_id;
END;
$$;

-- Effective par: the truck's own number for the part, else its load-out's.
CREATE OR REPLACE FUNCTION public.stock_lines(p_location uuid)
RETURNS TABLE (part_number text, part_key text, qty integer, par integer, par_override integer, need integer)
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  WITH lo AS (
    SELECT public.stock_part_key(x->>'part_number') AS k, btrim(x->>'part_number') AS pn,
           nullif(x->>'par','')::integer AS par
      FROM public.stock_locations l
      JOIN public.stock_loadouts o ON o.id = l.loadout_id AND NOT o.is_deleted
      CROSS JOIN LATERAL jsonb_array_elements(o.lines) x
     WHERE l.id = p_location
  ), lv AS (
    SELECT part_key AS k, part_number AS pn, qty, par_override FROM public.stock_levels WHERE location_id = p_location
  )
  SELECT coalesce(lv.pn, lo.pn), coalesce(lv.k, lo.k), coalesce(lv.qty, 0),
         coalesce(lv.par_override, lo.par), lv.par_override,
         greatest(coalesce(lv.par_override, lo.par, 0) - coalesce(lv.qty, 0), 0)
    FROM lv FULL JOIN lo ON lo.k = lv.k
   WHERE coalesce(lv.k, lo.k) <> ''
   ORDER BY 2;
$$;

-- ── Who may touch a location ────────────────────────────────────────────────

-- The office: a lead, in the account they are working in (impersonation
-- included), on that account's own location.
CREATE OR REPLACE FUNCTION public.stock_office_location(p_location uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_account uuid := public.require_lead_account();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.stock_locations WHERE id = p_location AND account_id = v_account) THEN
    RAISE EXCEPTION 'No such truck or warehouse in this account';
  END IF;
  RETURN v_account;
END;
$$;

-- The phone: assigned to it (or the lead of its account), still a member.
CREATE OR REPLACE FUNCTION public.stock_can_change(p_location uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.stock_locations l
     WHERE l.id = p_location AND l.active AND l.account_id = public.my_account_id()
       AND (EXISTS (SELECT 1 FROM public.stock_assignees a WHERE a.location_id = l.id AND a.user_id = auth.uid())
            OR EXISTS (SELECT 1 FROM public.account_members m
                        WHERE m.user_id = auth.uid() AND m.removed_at IS NULL AND m.role = 'lead'
                          AND m.account_id = l.account_id)));
$$;

-- ── The phone ───────────────────────────────────────────────────────────────

-- Everything a phone shows: the trucks its user is assigned to, each with its
-- lines (on hand, par, short by), and the account's warehouses to load from.
CREATE OR REPLACE FUNCTION public.my_vehicles() RETURNS json
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_account uuid := public.my_account_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN json_build_object(
    'fetched_at', now(),
    'auto_deduct', coalesce((SELECT auto_deduct FROM public.stock_settings WHERE account_id = v_account), false),
    'vehicles', (SELECT coalesce(json_agg(json_build_object(
        'id', l.id, 'name', l.name, 'unit', l.unit, 'primary', a.is_primary,
        'loadout', (SELECT o.name FROM public.stock_loadouts o WHERE o.id = l.loadout_id AND NOT o.is_deleted),
        'lines', (SELECT coalesce(json_agg(json_build_object('part_number', s.part_number, 'qty', s.qty,
                                                             'par', s.par, 'need', s.need) ORDER BY s.part_key), '[]'::json)
                    FROM public.stock_lines(l.id) s))
        ORDER BY a.is_primary DESC, l.name), '[]'::json)
      FROM public.stock_locations l
      JOIN public.stock_assignees a ON a.location_id = l.id AND a.user_id = auth.uid()
     WHERE l.account_id = v_account AND l.active AND l.kind = 'vehicle'),
    'warehouses', (SELECT coalesce(json_agg(json_build_object('id', l.id, 'name', l.name) ORDER BY l.name), '[]'::json)
      FROM public.stock_locations l
     WHERE l.account_id = v_account AND l.active AND l.kind = 'warehouse'));
END;
$$;

-- The phone's one write: use, load (optionally out of a warehouse) or count.
-- Idempotent on client_id: a resend returns what the first one did.
CREATE OR REPLACE FUNCTION public.record_stock_move(p jsonb) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_client  text := nullif(btrim(coalesce(p->>'client_id','')), '');
  v_loc     uuid := nullif(p->>'location_id','')::uuid;
  v_from    uuid := nullif(p->>'from_location_id','')::uuid;
  v_reason  text := p->>'reason';
  v_part    text := p->>'part_number';
  v_qty     integer;
  v_at      timestamptz := coalesce(nullif(p->>'captured_at','')::timestamptz, now());
  v_id      uuid;
  v_xfer    uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_client IS NULL THEN RAISE EXCEPTION 'client_id is required'; END IF;
  SELECT id INTO v_id FROM public.stock_moves WHERE client_id = v_client;
  IF FOUND THEN RETURN json_build_object('id', v_id, 'duplicate', true); END IF;

  IF v_reason NOT IN ('use', 'load', 'count') THEN RAISE EXCEPTION 'Unknown kind of change: %', v_reason; END IF;
  IF NOT public.stock_can_change(v_loc) THEN
    RAISE EXCEPTION 'You are not assigned to that truck';
  END IF;
  v_qty := (CASE WHEN v_reason = 'count' THEN p->>'counted_qty' ELSE p->>'qty' END)::integer;
  IF v_qty IS NULL OR v_qty < 0 OR v_qty > 100000 OR (v_reason <> 'count' AND v_qty = 0) THEN
    RAISE EXCEPTION 'That quantity is not possible';
  END IF;

  IF v_reason = 'load' AND v_from IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.stock_locations w
                    WHERE w.id = v_from AND w.kind = 'warehouse' AND w.active
                      AND w.account_id = (SELECT account_id FROM public.stock_locations WHERE id = v_loc)) THEN
      RAISE EXCEPTION 'No such warehouse';
    END IF;
    v_xfer := gen_random_uuid();
    PERFORM public.stock_write_move(v_from, v_part, 'transfer_out', -v_qty, NULL, v_at, NULL,
                                    p->>'note', p->>'wo_number', v_xfer);
    v_id := public.stock_write_move(v_loc, v_part, 'transfer_in', v_qty, NULL, v_at, v_client,
                                    p->>'note', p->>'wo_number', v_xfer);
  ELSE
    v_id := public.stock_write_move(v_loc, v_part, v_reason,
              CASE v_reason WHEN 'use' THEN -v_qty WHEN 'load' THEN v_qty ELSE 0 END,
              CASE WHEN v_reason = 'count' THEN v_qty END,
              v_at, v_client, p->>'note', p->>'wo_number');
  END IF;

  RETURN json_build_object('id', v_id,
    'qty', (SELECT qty FROM public.stock_levels WHERE location_id = v_loc AND part_key = public.stock_part_key(v_part)));
END;
$$;

-- Which of a tech's trucks they are in today — where ladder parts come off.
CREATE OR REPLACE FUNCTION public.set_my_truck(p_location uuid) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stock_assignees a JOIN public.stock_locations l ON l.id = a.location_id
                  WHERE a.location_id = p_location AND a.user_id = auth.uid()
                    AND l.account_id = public.my_account_id()) THEN
    RAISE EXCEPTION 'You are not assigned to that truck';
  END IF;
  UPDATE public.stock_assignees SET is_primary = (location_id = p_location) WHERE user_id = auth.uid();
  RETURN json_build_object('primary', p_location);
END;
$$;

-- ── The office ──────────────────────────────────────────────────────────────

-- Every location the office may see (its own and, for an umbrella, its
-- subcontractors'), with enough to draw the list.
CREATE OR REPLACE FUNCTION public.stock_overview() RETURNS json
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_account uuid := public.my_account_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN json_build_object(
    'auto_deduct', coalesce((SELECT auto_deduct FROM public.stock_settings WHERE account_id = v_account), false),
    'locations', (SELECT coalesce(json_agg(json_build_object(
      'id', l.id, 'kind', l.kind, 'name', l.name, 'unit', l.unit, 'active', l.active,
      'mine', l.account_id = v_account, 'account_name', a.name,
      'loadout_id', l.loadout_id,
      'loadout', (SELECT o.name FROM public.stock_loadouts o WHERE o.id = l.loadout_id AND NOT o.is_deleted),
      'assignees', (SELECT coalesce(json_agg(json_build_object('user_id', sa.user_id,
                      'name', coalesce(u.name, u.email), 'primary', sa.is_primary) ORDER BY u.name), '[]'::json)
                      FROM public.stock_assignees sa LEFT JOIN public.users u ON u.id = sa.user_id
                     WHERE sa.location_id = l.id),
      'parts', (SELECT count(*) FROM public.stock_lines(l.id) s WHERE s.qty <> 0 OR s.par IS NOT NULL),
      'short', (SELECT count(*) FROM public.stock_lines(l.id) s WHERE s.need > 0),
      'negative', (SELECT count(*) FROM public.stock_lines(l.id) s WHERE s.qty < 0))
      ORDER BY (l.account_id = v_account) DESC, a.name, l.kind DESC, l.name), '[]'::json)
      FROM public.stock_locations l JOIN public.accounts a ON a.id = l.account_id
     WHERE public.can_see(l.account_id)),
    'loadouts', (SELECT coalesce(json_agg(json_build_object('id', o.id, 'name', o.name, 'lines', o.lines)
                   ORDER BY o.name), '[]'::json)
                   FROM public.stock_loadouts o WHERE o.account_id = v_account AND NOT o.is_deleted));
END;
$$;

CREATE OR REPLACE FUNCTION public.stock_location_detail(p_location uuid) RETURNS json
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE l public.stock_locations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO l FROM public.stock_locations WHERE id = p_location;
  IF NOT FOUND OR NOT public.can_see(l.account_id) THEN RAISE EXCEPTION 'No such truck or warehouse'; END IF;
  RETURN json_build_object(
    'id', l.id, 'kind', l.kind, 'name', l.name, 'unit', l.unit, 'active', l.active,
    'mine', l.account_id = public.my_account_id(), 'loadout_id', l.loadout_id,
    'lines', (SELECT coalesce(json_agg(row_to_json(s) ORDER BY s.part_key), '[]'::json) FROM public.stock_lines(l.id) s),
    'moves', (SELECT coalesce(json_agg(json_build_object(
                'id', m.id, 'part_number', m.part_number, 'delta', m.delta, 'reason', m.reason,
                'counted_qty', m.counted_qty, 'note', m.note, 'wo_key', m.wo_key,
                'who', coalesce(u.name, u.email), 'captured_at', m.captured_at, 'recorded_at', m.recorded_at)
                ORDER BY m.captured_at DESC, m.recorded_at DESC), '[]'::json)
                FROM (SELECT * FROM public.stock_moves WHERE location_id = l.id
                       ORDER BY captured_at DESC, recorded_at DESC LIMIT 200) m
                LEFT JOIN public.users u ON u.id = m.actor));
END;
$$;

CREATE OR REPLACE FUNCTION public.save_stock_location(p jsonb) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_id      uuid := nullif(p->>'id','')::uuid;
  v_name    text := btrim(coalesce(p->>'name',''));
  v_kind    text := coalesce(nullif(p->>'kind',''), 'vehicle');
  v_lo      uuid := nullif(p->>'loadout_id','')::uuid;
BEGIN
  IF v_name = '' THEN RAISE EXCEPTION 'Give it a name'; END IF;
  IF length(v_name) > 60 THEN RAISE EXCEPTION 'Names are 60 characters at most'; END IF;
  IF v_kind NOT IN ('vehicle', 'warehouse') THEN RAISE EXCEPTION 'A location is a truck or a warehouse'; END IF;
  IF v_lo IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.stock_loadouts
                                       WHERE id = v_lo AND account_id = v_account AND NOT is_deleted) THEN
    RAISE EXCEPTION 'No such load-out';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_locations WHERE account_id = v_account
              AND name_key = lower(v_name) AND id IS DISTINCT FROM v_id) THEN
    RAISE EXCEPTION 'There is already a truck or warehouse called "%"', v_name;
  END IF;
  IF v_id IS NOT NULL THEN
    UPDATE public.stock_locations
       SET name = v_name, kind = v_kind, unit = nullif(btrim(coalesce(p->>'unit','')), ''),
           loadout_id = v_lo, active = coalesce((p->>'active')::boolean, active), updated_at = now()
     WHERE id = v_id AND account_id = v_account;
    IF NOT FOUND THEN RAISE EXCEPTION 'No such truck or warehouse in this account'; END IF;
  ELSE
    INSERT INTO public.stock_locations (account_id, kind, name, unit, loadout_id, active, created_by)
    VALUES (v_account, v_kind, v_name, nullif(btrim(coalesce(p->>'unit','')), ''), v_lo,
            coalesce((p->>'active')::boolean, true), auth.uid())
    RETURNING id INTO v_id;
  END IF;
  RETURN json_build_object('id', v_id);
END;
$$;

-- Who may change a truck from a phone: anyone in this account's crew.
CREATE OR REPLACE FUNCTION public.set_stock_assignees(p_location uuid, p_users uuid[]) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_account uuid := public.stock_office_location(p_location);
        v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM unnest(coalesce(p_users, '{}')) x(u)
   WHERE NOT EXISTS (SELECT 1 FROM public.account_members m
                      WHERE m.user_id = x.u AND m.account_id = v_account AND m.removed_at IS NULL);
  IF v_bad > 0 THEN RAISE EXCEPTION 'Only people in this crew can be put on a truck'; END IF;
  DELETE FROM public.stock_assignees WHERE location_id = p_location AND NOT (user_id = ANY (coalesce(p_users, '{}')));
  INSERT INTO public.stock_assignees (location_id, user_id, is_primary)
  SELECT p_location, u,
         NOT EXISTS (SELECT 1 FROM public.stock_assignees a WHERE a.user_id = u AND a.is_primary)
    FROM unnest(coalesce(p_users, '{}')) u
  ON CONFLICT (location_id, user_id) DO NOTHING;
  RETURN json_build_object('assigned', coalesce(array_length(p_users, 1), 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.save_stock_loadout(p jsonb) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_id      uuid := nullif(p->>'id','')::uuid;
  v_name    text := btrim(coalesce(p->>'name',''));
  v_lines   jsonb;
BEGIN
  IF v_name = '' THEN RAISE EXCEPTION 'Give the load-out a name'; END IF;
  IF EXISTS (SELECT 1 FROM public.stock_loadouts WHERE account_id = v_account AND NOT is_deleted
              AND name_key = lower(v_name) AND id IS DISTINCT FROM v_id) THEN
    RAISE EXCEPTION 'There is already a load-out called "%"', v_name;
  END IF;
  -- One line per part (first wins), par a whole number 0 or more.
  SELECT coalesce(jsonb_agg(jsonb_build_object('part_number', pn, 'par', par) ORDER BY n), '[]'::jsonb) INTO v_lines
    FROM (SELECT upper(btrim(x->>'part_number')) AS pn, greatest(coalesce((x->>'par')::integer, 0), 0) AS par, n,
                 row_number() OVER (PARTITION BY upper(btrim(x->>'part_number')) ORDER BY n) AS rk
            FROM jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) WITH ORDINALITY AS t(x, n)
           WHERE btrim(coalesce(x->>'part_number','')) <> '') q
   WHERE rk = 1;
  IF v_id IS NOT NULL THEN
    UPDATE public.stock_loadouts SET name = v_name, lines = v_lines, updated_at = now()
     WHERE id = v_id AND account_id = v_account AND NOT is_deleted;
    IF NOT FOUND THEN RAISE EXCEPTION 'No such load-out'; END IF;
  ELSE
    INSERT INTO public.stock_loadouts (account_id, name, lines) VALUES (v_account, v_name, v_lines)
    RETURNING id INTO v_id;
  END IF;
  RETURN json_build_object('id', v_id, 'lines', jsonb_array_length(v_lines));
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_stock_loadout(p_id uuid) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_account uuid := public.require_lead_account();
BEGIN
  UPDATE public.stock_loadouts SET is_deleted = true, updated_at = now()
   WHERE id = p_id AND account_id = v_account AND NOT is_deleted;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such load-out'; END IF;
  UPDATE public.stock_locations SET loadout_id = NULL, updated_at = now() WHERE loadout_id = p_id;
  RETURN json_build_object('deleted', p_id);
END;
$$;

-- A truck's own par for one part; NULL goes back to the load-out's.
CREATE OR REPLACE FUNCTION public.set_stock_par(p_location uuid, p_part text, p_par integer) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_account uuid := public.stock_office_location(p_location);
        v_key text := public.stock_part_key(p_part);
BEGIN
  IF v_key = '' THEN RAISE EXCEPTION 'A part number is needed'; END IF;
  IF p_par IS NOT NULL AND p_par < 0 THEN RAISE EXCEPTION 'Par cannot be negative'; END IF;
  INSERT INTO public.stock_levels (location_id, account_id, part_key, part_number, qty, par_override)
  VALUES (p_location, v_account, v_key, upper(btrim(p_part)), public.stock_qty_at(p_location, v_key, NULL), p_par)
  ON CONFLICT (location_id, part_key) DO UPDATE SET par_override = EXCLUDED.par_override, updated_at = now();
  RETURN json_build_object('part_number', upper(btrim(p_part)), 'par_override', p_par);
END;
$$;

-- The office's own changes: load, use, count or a correction, with a reason.
CREATE OR REPLACE FUNCTION public.adjust_stock(p jsonb) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_loc    uuid := nullif(p->>'location_id','')::uuid;
  v_reason text := p->>'reason';
  v_qty    integer := (p->>'qty')::integer;
  v_id     uuid;
BEGIN
  PERFORM public.stock_office_location(v_loc);
  IF v_reason NOT IN ('load', 'use', 'count', 'adjust') THEN RAISE EXCEPTION 'Unknown kind of change: %', v_reason; END IF;
  IF v_qty IS NULL OR abs(v_qty) > 100000 OR (v_reason = 'count' AND v_qty < 0)
     OR (v_reason IN ('load','use') AND v_qty <= 0) OR (v_reason = 'adjust' AND v_qty = 0) THEN
    RAISE EXCEPTION 'That quantity is not possible';
  END IF;
  IF v_reason = 'adjust' AND btrim(coalesce(p->>'note','')) = '' THEN
    RAISE EXCEPTION 'Say why the quantity is being corrected';
  END IF;
  v_id := public.stock_write_move(v_loc, p->>'part_number', v_reason,
            CASE v_reason WHEN 'use' THEN -v_qty WHEN 'count' THEN 0 ELSE v_qty END,
            CASE WHEN v_reason = 'count' THEN v_qty END,
            now(), NULL, p->>'note', NULL);
  RETURN json_build_object('id', v_id,
    'qty', (SELECT qty FROM public.stock_levels WHERE location_id = v_loc
              AND part_key = public.stock_part_key(p->>'part_number')));
END;
$$;

-- Warehouse to truck (or any location to another in the same account): both
-- legs in one transaction, sharing a transfer id.
CREATE OR REPLACE FUNCTION public.transfer_stock(p jsonb) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_from uuid := nullif(p->>'from_location_id','')::uuid;
  v_to   uuid := nullif(p->>'to_location_id','')::uuid;
  v_xfer uuid := gen_random_uuid();
  v_lines jsonb := coalesce(p->'lines', jsonb_build_array(jsonb_build_object('part_number', p->>'part_number', 'qty', p->>'qty')));
  e jsonb;
  v_n integer := 0;
BEGIN
  PERFORM public.stock_office_location(v_from);
  PERFORM public.stock_office_location(v_to);
  IF v_from = v_to THEN RAISE EXCEPTION 'Pick two different places'; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    IF coalesce((e->>'qty')::integer, 0) <= 0 OR (e->>'qty')::integer > 100000 THEN
      RAISE EXCEPTION 'That quantity is not possible';
    END IF;
    PERFORM public.stock_write_move(v_from, e->>'part_number', 'transfer_out', -(e->>'qty')::integer, NULL,
                                    now(), NULL, p->>'note', NULL, v_xfer);
    PERFORM public.stock_write_move(v_to, e->>'part_number', 'transfer_in', (e->>'qty')::integer, NULL,
                                    now(), NULL, p->>'note', NULL, v_xfer);
    v_n := v_n + 1;
  END LOOP;
  RETURN json_build_object('transfer_id', v_xfer, 'lines', v_n);
END;
$$;

-- Every truck's restock list in one: what to load before it goes out.
CREATE OR REPLACE FUNCTION public.stock_restock_report() RETURNS json
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_account uuid := public.my_account_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN (SELECT coalesce(json_agg(json_build_object(
      'location_id', l.id, 'name', l.name, 'unit', l.unit,
      'lines', (SELECT json_agg(json_build_object('part_number', s.part_number, 'qty', s.qty,
                                                  'par', s.par, 'need', s.need) ORDER BY s.part_key)
                  FROM public.stock_lines(l.id) s WHERE s.need > 0))
      ORDER BY l.name), '[]'::json)
    FROM public.stock_locations l
   WHERE l.account_id = v_account AND l.active AND l.kind = 'vehicle'
     AND EXISTS (SELECT 1 FROM public.stock_lines(l.id) s WHERE s.need > 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.save_stock_settings(p jsonb) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_account uuid := public.require_lead_account();
BEGIN
  INSERT INTO public.stock_settings (account_id, auto_deduct, updated_at)
  VALUES (v_account, coalesce((p->>'auto_deduct')::boolean, false), now())
  ON CONFLICT (account_id) DO UPDATE SET auto_deduct = EXCLUDED.auto_deduct, updated_at = now();
  RETURN json_build_object('auto_deduct', (SELECT auto_deduct FROM public.stock_settings WHERE account_id = v_account));
END;
$$;

-- ── Ladder parts off the truck ──────────────────────────────────────────────
-- One ladder record is (asset, inspection date). Whatever version of it is
-- current says which parts it used; what has already come off for it is the
-- sum of its 'ladder' moves. The difference is written, so a correction moves
-- only what changed and a deletion puts everything back.
--
-- Which truck: whichever this record already took parts from, else the truck
-- the collector has marked as theirs today, else none (nothing deducted).
CREATE OR REPLACE FUNCTION public.stock_sync_ladder(p_asset uuid, p_date date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_key  text := p_asset::text || '|' || p_date::text;
  r      public.inspections%ROWTYPE;
  v_loc  uuid;
  v_n    integer := 0;
  x      record;
BEGIN
  SELECT * INTO r FROM public.inspections
   WHERE asset_id = p_asset AND inspection_date = p_date AND is_current AND NOT is_deleted
   ORDER BY created_at DESC LIMIT 1;

  SELECT location_id INTO v_loc FROM public.stock_moves
   WHERE inspection_key = v_key ORDER BY recorded_at LIMIT 1;

  IF v_loc IS NULL THEN
    IF r.id IS NULL OR r.collected_by IS NULL THEN RETURN 0; END IF;
    IF NOT coalesce((SELECT auto_deduct FROM public.stock_settings WHERE account_id = r.account_id), false) THEN
      RETURN 0;
    END IF;
    SELECT a.location_id INTO v_loc FROM public.stock_assignees a
      JOIN public.stock_locations l ON l.id = a.location_id
     WHERE a.user_id = r.collected_by AND a.is_primary AND l.active AND l.kind = 'vehicle'
       AND l.account_id = r.account_id
     LIMIT 1;
    IF v_loc IS NULL THEN RETURN 0; END IF;
  END IF;

  FOR x IN
    WITH want AS (
      SELECT public.stock_part_key(e->>'name') AS k, max(btrim(e->>'name')) AS pn,
             sum(greatest(coalesce(nullif(e->>'qty','')::integer, 1), 0))::integer AS q
        FROM jsonb_array_elements(CASE WHEN r.id IS NOT NULL AND jsonb_typeof(r.parts) = 'array'
                                       THEN r.parts ELSE '[]'::jsonb END) e
       WHERE btrim(coalesce(e->>'name','')) <> ''
       GROUP BY 1
    ), had AS (
      SELECT part_key AS k, max(part_number) AS pn, (-sum(delta))::integer AS q
        FROM public.stock_moves WHERE inspection_key = v_key GROUP BY 1
    )
    SELECT coalesce(w.k, h.k) AS k, coalesce(w.pn, h.pn) AS pn,
           coalesce(w.q, 0) - coalesce(h.q, 0) AS more
      FROM want w FULL JOIN had h ON h.k = w.k
  LOOP
    CONTINUE WHEN x.more = 0;
    PERFORM public.stock_write_move(v_loc, x.pn, 'ladder', -x.more, NULL,
              coalesce(r.captured_at, r.created_at, now()), NULL, NULL, r.work_order_id,
              NULL, v_key, r.collected_by);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- Deferred to commit, so a correction's "old version off, new version on"
-- settles once, on the final state, instead of putting everything back and
-- taking it off again. Never lets a stock problem stop an inspection.
CREATE OR REPLACE FUNCTION public.stock_ladder_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.asset_id IS NULL THEN RETURN NULL; END IF;
  BEGIN
    PERFORM public.stock_sync_ladder(NEW.asset_id, NEW.inspection_date);
    IF TG_OP = 'UPDATE' AND (OLD.asset_id, OLD.inspection_date) IS DISTINCT FROM (NEW.asset_id, NEW.inspection_date)
       AND OLD.asset_id IS NOT NULL THEN
      PERFORM public.stock_sync_ladder(OLD.asset_id, OLD.inspection_date);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'stock: ladder parts not taken off the truck for %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS stock_ladder_parts ON public.inspections;
CREATE CONSTRAINT TRIGGER stock_ladder_parts
  AFTER INSERT OR UPDATE OF is_current, is_deleted, parts, asset_id, inspection_date ON public.inspections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.stock_ladder_trigger();

-- ── Grants ──────────────────────────────────────────────────────────────────
DO $$
DECLARE f text;
BEGIN
  -- Internal: callable only from the functions above.
  FOREACH f IN ARRAY ARRAY[
    'stock_qty_at(uuid,text,timestamptz,uuid)', 'stock_recompute(uuid,text,text)',
    'stock_write_move(uuid,text,text,integer,integer,timestamptz,text,text,text,uuid,text,uuid)',
    'stock_lines(uuid)', 'stock_office_location(uuid)', 'stock_can_change(uuid)',
    'stock_sync_ladder(uuid,date)', 'stock_ladder_trigger()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  -- The API.
  FOREACH f IN ARRAY ARRAY[
    'my_vehicles()', 'record_stock_move(jsonb)', 'set_my_truck(uuid)',
    'stock_overview()', 'stock_location_detail(uuid)', 'save_stock_location(jsonb)',
    'set_stock_assignees(uuid,uuid[])', 'save_stock_loadout(jsonb)', 'delete_stock_loadout(uuid)',
    'set_stock_par(uuid,text,integer)', 'adjust_stock(jsonb)', 'transfer_stock(jsonb)',
    'stock_restock_report()', 'save_stock_settings(jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP;
END $$;

-- ── consolidate_to_one_account(), re-emitted from 33 ────────────────────────
-- Verbatim from 33_published_part_sets.sql except the block marked "34".
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
