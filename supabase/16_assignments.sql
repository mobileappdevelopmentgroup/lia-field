-- ═══════════════════════════════════════════════════════════════════════════
-- 16 — Job assignment
-- ═══════════════════════════════════════════════════════════════════════════
-- Until now a work order existed only as a number a tech typed into his phone.
-- Two techs on the same job typed it two ways, a third forgot it entirely, and
-- the lead had no way to know at four o'clock whether the day's work was done.
--
-- A job here is the lead's copy of that: one row per work order, saying who is
-- on it and whether it is finished.
--
-- ── Three decisions worth defending ────────────────────────────────────────
--
-- 1. A JOB DOES NOT OWN THE RECORDS. Progress is counted by matching wo_key
--    against the inspections that already exist. A tech who types the work
--    order by hand, or who was working before the job was created, still counts
--    — and a job deleted by mistake destroys no work. The alternative (a
--    job_id foreign key on every inspection) would make the assignment a
--    prerequisite for capture, which is exactly backwards: capture must never
--    depend on the lead having done something first.
--
-- 2. PEER VISIBILITY IS READ-ONLY AND DEFAULT OFF. share_peer_work lets a lead
--    show the team what each other has done. It is enforced in job_detail()
--    server-side, not by hiding a button — a tech who can read peers' rows
--    through some other path would make the setting decorative. And nothing on
--    that list is editable by anybody but its author: seeing another tech's
--    work is not permission to change it.
--
-- 3. AN ASSIGNMENT IS NOT A LOCK. A tech can still work a job he was not
--    assigned. The lead's list is a plan for the day, not an access control
--    boundary, and a phone that refused an unplanned job would strand a tech
--    sent somewhere at short notice with no signal to fetch the update.
--
-- Idempotent. Safe to re-run.

-- ── Jobs ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  work_order_uuid uuid NOT NULL REFERENCES public.work_orders(id) ON DELETE CASCADE,
  wo_number       text NOT NULL,
  wo_key          text NOT NULL,
  scope           text NOT NULL DEFAULT 'ladder'
                    CHECK (scope IN ('ladder', 'fall_protection')),

  title           text,
  site            text,
  notes           text,
  due_date        date,

  -- Everybody on the team, rather than a named list. Kept as a flag rather than
  -- expanded into rows at creation time so that a tech hired tomorrow picks up
  -- today's team-wide job without anyone re-assigning it.
  assign_all      boolean NOT NULL DEFAULT false,
  -- Whether a tech may see what the others have already submitted. Read-only,
  -- and off unless the lead turns it on.
  share_peer_work boolean NOT NULL DEFAULT false,

  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'closed', 'cancelled')),

  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  closed_by       uuid REFERENCES auth.users(id),
  close_note      text
);

-- One job per work order per account. Two leads planning the same work order
-- twice would give the techs two cards for one job.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_account_wo_uq
  ON public.jobs (account_id, wo_key);
CREATE INDEX IF NOT EXISTS jobs_account_status_idx ON public.jobs (account_id, status);

CREATE TABLE IF NOT EXISTS public.job_assignees (
  job_id      uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES auth.users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, user_id)
);
CREATE INDEX IF NOT EXISTS job_assignees_user_idx ON public.job_assignees (user_id);

ALTER TABLE public.jobs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_assignees  ENABLE ROW LEVEL SECURITY;

-- Read-only through RLS; every write goes through a SECURITY DEFINER function
-- below so that "only a lead may assign" is one rule in one place.
DROP POLICY IF EXISTS "jobs_select_own" ON public.jobs;
CREATE POLICY "jobs_select_own" ON public.jobs
  FOR SELECT USING (account_id = public.my_account_id());

DROP POLICY IF EXISTS "job_assignees_select_own" ON public.job_assignees;
CREATE POLICY "job_assignees_select_own" ON public.job_assignees
  FOR SELECT USING (job_id IN (SELECT id FROM public.jobs WHERE account_id = public.my_account_id()));

-- ── Progress ────────────────────────────────────────────────────────────────
-- What has been recorded against a work order, and by whom. Matched on wo_key
-- rather than a job id — see decision 1 in the header.
--
-- Ladders and fall protection are counted from their own tables because they
-- are genuinely different records; a job is single-scope, so only one of the
-- two branches ever contributes.
CREATE OR REPLACE FUNCTION public.job_progress(p_account uuid, p_wo_key text, p_scope text)
RETURNS TABLE (user_id uuid, who text, n integer, last_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT * FROM (
    SELECT i.collected_by AS user_id,
           coalesce(nullif(i.collector_name, ''), 'Unattributed') AS who,
           count(*)::int AS n,
           max(i.uploaded_at) AS last_at
      FROM public.fp_inspections i
     WHERE p_scope = 'fall_protection'
       AND i.account_id = p_account
       AND i.is_current AND NOT i.is_deleted
       AND public.wo_key(i.work_order_id) = p_wo_key
     GROUP BY 1, 2
    UNION ALL
    SELECT i.tech_user_id,
           coalesce(nullif(i.tech_name, ''), 'Unattributed'),
           count(*)::int,
           max(i.created_at)
      FROM public.inspections i
     WHERE p_scope = 'ladder'
       AND i.account_id = p_account
       AND public.wo_key(i.work_order_id) = p_wo_key
     GROUP BY 1, 2
  ) t ORDER BY n DESC, who;
$$;

-- ── Creating and editing a job ──────────────────────────────────────────────
-- Lead only. Upserts on the work order, so re-saving the same number edits the
-- job rather than failing on the unique index or quietly making a second one.
CREATE OR REPLACE FUNCTION public.save_job(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.require_lead();
  v_uid     uuid := auth.uid();
  v_wo      text := coalesce(p->>'wo_number', '');
  v_key     text := public.wo_key(v_wo);
  v_scope   text := coalesce(p->>'scope', 'ladder');
  v_wo_id   uuid;
  v_job     uuid;
  v_ids     uuid[];
BEGIN
  IF v_key = '' THEN RAISE EXCEPTION 'A work order number is required'; END IF;
  IF v_scope NOT IN ('ladder', 'fall_protection') THEN
    RAISE EXCEPTION 'Unknown scope: %', v_scope;
  END IF;

  -- The work order row may already exist from an import; this must not disturb
  -- its billing state, so it is INSERT ... DO NOTHING and never an UPDATE.
  INSERT INTO public.work_orders (account_id, wo_number, wo_key, scope, created_by)
  VALUES (v_account, v_wo, v_key, v_scope, v_uid)
  ON CONFLICT (account_id, wo_key) DO NOTHING
  RETURNING id INTO v_wo_id;
  IF v_wo_id IS NULL THEN
    SELECT id INTO v_wo_id FROM public.work_orders
     WHERE account_id = v_account AND wo_key = v_key;
  END IF;

  INSERT INTO public.jobs (
    account_id, work_order_uuid, wo_number, wo_key, scope,
    title, site, notes, due_date, assign_all, share_peer_work, created_by)
  VALUES (
    v_account, v_wo_id, v_wo, v_key, v_scope,
    nullif(p->>'title', ''), nullif(p->>'site', ''), nullif(p->>'notes', ''),
    (nullif(p->>'due_date', ''))::date,
    coalesce((p->>'assign_all')::boolean, false),
    coalesce((p->>'share_peer_work')::boolean, false),
    v_uid)
  -- Every field is updated ONLY if the payload named it. Assigning
  -- `excluded.x` unconditionally would mean editing a job's notes from a screen
  -- that does not show the sharing toggle silently switched sharing back off —
  -- which is how a lead ends up revoking peer visibility without touching it.
  -- Same reasoning as the assignees block below.
  ON CONFLICT (account_id, wo_key) DO UPDATE SET
    title           = CASE WHEN p ? 'title'           THEN excluded.title           ELSE public.jobs.title END,
    site            = CASE WHEN p ? 'site'            THEN excluded.site            ELSE public.jobs.site END,
    notes           = CASE WHEN p ? 'notes'           THEN excluded.notes           ELSE public.jobs.notes END,
    due_date        = CASE WHEN p ? 'due_date'        THEN excluded.due_date        ELSE public.jobs.due_date END,
    scope           = CASE WHEN p ? 'scope'           THEN excluded.scope           ELSE public.jobs.scope END,
    assign_all      = CASE WHEN p ? 'assign_all'      THEN excluded.assign_all      ELSE public.jobs.assign_all END,
    share_peer_work = CASE WHEN p ? 'share_peer_work' THEN excluded.share_peer_work ELSE public.jobs.share_peer_work END,
    updated_at      = now()
  RETURNING id INTO v_job;

  -- Assignees are replaced wholesale when the key is present, and left alone
  -- when it is absent — so editing a job's notes from a screen that does not
  -- show the assignee list cannot silently unassign everybody.
  IF p ? 'assignees' THEN
    SELECT coalesce(array_agg(x::uuid), '{}') INTO v_ids
      FROM jsonb_array_elements_text(p->'assignees') x;

    -- Only members of this account. A user id from outside it would create an
    -- assignment nobody in the company can see or clear.
    DELETE FROM public.job_assignees ja WHERE ja.job_id = v_job
      AND NOT (ja.user_id = ANY (v_ids));
    INSERT INTO public.job_assignees (job_id, user_id, assigned_by)
    SELECT v_job, m.user_id, v_uid
      FROM public.account_members m
     WHERE m.account_id = v_account AND m.user_id = ANY (v_ids)
    ON CONFLICT (job_id, user_id) DO NOTHING;
  END IF;

  RETURN public.job_detail(v_job);
END;
$$;

CREATE OR REPLACE FUNCTION public.close_job(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.require_lead();
  v_id      uuid := (p->>'job_id')::uuid;
  v_status  text := coalesce(p->>'status', 'closed');
BEGIN
  IF v_status NOT IN ('open', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'Unknown status: %', v_status;
  END IF;
  UPDATE public.jobs SET
    status     = v_status,
    close_note = CASE WHEN v_status = 'open' THEN NULL ELSE nullif(p->>'note', '') END,
    closed_at  = CASE WHEN v_status = 'open' THEN NULL ELSE now() END,
    closed_by  = CASE WHEN v_status = 'open' THEN NULL ELSE auth.uid() END,
    updated_at = now()
   WHERE id = v_id AND account_id = v_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such job'; END IF;
  RETURN public.job_detail(v_id);
END;
$$;

-- Deleting a job destroys the PLAN, never the work: the inspections are matched
-- by work order number and are untouched by this.
CREATE OR REPLACE FUNCTION public.delete_job(p jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid := public.require_lead();
  v_n       integer;
BEGIN
  DELETE FROM public.jobs WHERE id = (p->>'job_id')::uuid AND account_id = v_account;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ── Reading ─────────────────────────────────────────────────────────────────
-- One job with its assignees, its progress, and — when the lead has allowed it
-- — the individual records already submitted against it.
CREATE OR REPLACE FUNCTION public.job_detail(p_job_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_account uuid := public.my_account_id();
  v_uid     uuid := auth.uid();
  v_lead    boolean;
  v_job     public.jobs%ROWTYPE;
  v_share   boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id AND account_id = v_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such job'; END IF;

  SELECT (role = 'lead') INTO v_lead FROM public.account_members WHERE user_id = v_uid;
  -- A lead always sees everything; a tech sees peers' work only if told to.
  v_share := coalesce(v_lead, false) OR v_job.share_peer_work;

  RETURN json_build_object(
    'job', row_to_json(v_job),
    'assignees', (
      SELECT coalesce(json_agg(json_build_object(
               'user_id', u.id, 'name', u.name, 'email', u.email) ORDER BY u.name), '[]'::json)
        FROM public.job_assignees ja JOIN public.users u ON u.id = ja.user_id
       WHERE ja.job_id = v_job.id),
    'progress', (
      SELECT coalesce(json_agg(json_build_object(
               'user_id', pr.user_id, 'who', pr.who, 'n', pr.n, 'last_at', pr.last_at)), '[]'::json)
        FROM public.job_progress(v_account, v_job.wo_key, v_job.scope) pr),
    'share_peer_work', v_job.share_peer_work,
    'can_see_peers', v_share,
    -- The records themselves. A tech with sharing off gets ONLY his own rows
    -- back from the server; the filtering is not left to the client.
    'records', (
      SELECT coalesce(json_agg(r ORDER BY r->>'at' DESC), '[]'::json) FROM (
        SELECT json_build_object(
                 'id', i.id, 'serial', a.serial_raw, 'kind', 'fall_protection',
                 'date', i.inspection_date, 'pass', i.overall_pass,
                 'item_type', i.item_type, 'who', i.collector_name,
                 'mine', (i.collected_by IS NOT DISTINCT FROM v_uid),
                 'at', i.uploaded_at) AS r
          FROM public.fp_inspections i JOIN public.assets a ON a.id = i.asset_id
         WHERE v_job.scope = 'fall_protection'
           AND i.account_id = v_account AND i.is_current AND NOT i.is_deleted
           AND public.wo_key(i.work_order_id) = v_job.wo_key
           AND (v_share OR i.collected_by IS NOT DISTINCT FROM v_uid)
        UNION ALL
        SELECT json_build_object(
                 'id', i.id, 'serial', i.serial_num, 'kind', 'ladder',
                 'date', i.inspection_date, 'pass', true,
                 'item_type', i.type, 'who', i.tech_name,
                 'mine', (i.tech_user_id IS NOT DISTINCT FROM v_uid),
                 'at', i.created_at)
          FROM public.inspections i
         WHERE v_job.scope = 'ladder'
           AND i.account_id = v_account
           AND public.wo_key(i.work_order_id) = v_job.wo_key
           AND (v_share OR i.tech_user_id IS NOT DISTINCT FROM v_uid)
      ) s)
  );
END;
$$;

-- What a phone asks for at startup. Open jobs assigned to this tech, plus the
-- team-wide ones, with just enough to draw a card — the records themselves are
-- fetched only when he opens one.
--
-- Recently closed jobs come back too, marked, so a tech who finished at 3pm
-- does not watch the job vanish off his phone and wonder whether his work went
-- with it.
CREATE OR REPLACE FUNCTION public.my_jobs(p_closed_days integer DEFAULT 2)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_account uuid := public.my_account_id();
  v_uid     uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN (
    SELECT coalesce(json_agg(json_build_object(
             'id', j.id,
             'wo_number', j.wo_number,
             'wo_key', j.wo_key,
             'scope', j.scope,
             'title', j.title,
             'site', j.site,
             'notes', j.notes,
             'due_date', j.due_date,
             'status', j.status,
             'share_peer_work', j.share_peer_work,
             'assigned_to_me', EXISTS (
               SELECT 1 FROM public.job_assignees ja
                WHERE ja.job_id = j.id AND ja.user_id = v_uid),
             'team_wide', j.assign_all,
             'mine_count', (
               SELECT coalesce(sum(pr.n), 0)::int FROM public.job_progress(v_account, j.wo_key, j.scope) pr
                WHERE pr.user_id IS NOT DISTINCT FROM v_uid),
             -- Only meaningful when sharing is on, and zero rather than a lie
             -- when it is off.
             'team_count', CASE WHEN j.share_peer_work THEN (
               SELECT coalesce(sum(pr.n), 0)::int FROM public.job_progress(v_account, j.wo_key, j.scope) pr)
               ELSE 0 END,
             'updated_at', j.updated_at
           ) ORDER BY j.status, j.due_date NULLS LAST, j.updated_at DESC), '[]'::json)
      FROM public.jobs j
     WHERE j.account_id = v_account
       AND (j.assign_all OR EXISTS (
             SELECT 1 FROM public.job_assignees ja
              WHERE ja.job_id = j.id AND ja.user_id = v_uid))
       AND (j.status = 'open'
            OR (j.status <> 'open' AND j.closed_at > now() - make_interval(days => greatest(0, coalesce(p_closed_days, 2)))))
  );
END;
$$;

-- The lead's board: every job, who is on it, and how much has landed.
CREATE OR REPLACE FUNCTION public.job_board(p_status text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE v_account uuid := public.require_lead();
BEGIN
  RETURN (
    SELECT coalesce(json_agg(json_build_object(
             'id', j.id, 'wo_number', j.wo_number, 'scope', j.scope,
             'title', j.title, 'site', j.site, 'notes', j.notes,
             'due_date', j.due_date, 'status', j.status,
             'assign_all', j.assign_all, 'share_peer_work', j.share_peer_work,
             'closed_at', j.closed_at, 'close_note', j.close_note,
             'assignees', (
               SELECT coalesce(json_agg(json_build_object(
                        'user_id', u.id, 'name', u.name) ORDER BY u.name), '[]'::json)
                 FROM public.job_assignees ja JOIN public.users u ON u.id = ja.user_id
                WHERE ja.job_id = j.id),
             'progress', (
               SELECT coalesce(json_agg(json_build_object(
                        'user_id', pr.user_id, 'who', pr.who, 'n', pr.n, 'last_at', pr.last_at)), '[]'::json)
                 FROM public.job_progress(v_account, j.wo_key, j.scope) pr),
             'total', (
               SELECT coalesce(sum(pr.n), 0)::int
                 FROM public.job_progress(v_account, j.wo_key, j.scope) pr),
             'updated_at', j.updated_at
           ) ORDER BY (j.status <> 'open'), j.due_date NULLS LAST, j.updated_at DESC), '[]'::json)
      FROM public.jobs j
     WHERE j.account_id = v_account
       AND (p_status IS NULL OR j.status = p_status)
  );
END;
$$;

-- Who the lead can assign to. Sub-techs included; the developer's own account
-- is not part of any customer company so it cannot appear here.
CREATE OR REPLACE FUNCTION public.team_members()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE v_account uuid := public.my_account_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN (
    SELECT coalesce(json_agg(json_build_object(
             'user_id', u.id, 'name', u.name, 'email', u.email,
             'role', m.role, 'rep_number', m.rep_number) ORDER BY m.role, u.name), '[]'::json)
      FROM public.account_members m JOIN public.users u ON u.id = m.user_id
     WHERE m.account_id = v_account);
END;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.save_job(jsonb)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_job(jsonb)           FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_job(jsonb)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_detail(uuid)           FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_jobs(integer)           FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_board(text)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.team_members()             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_progress(uuid, text, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.save_job(jsonb)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_job(jsonb)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_job(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_detail(uuid)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_jobs(integer)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_board(text)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.team_members()    TO authenticated;
-- job_progress is a helper the functions above call as their definer owner; no
-- client needs it directly.
