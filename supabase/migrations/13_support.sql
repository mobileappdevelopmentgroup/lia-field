-- ═══════════════════════════════════════════════════════════════════════════
-- 13 — In-app support: tickets, replies, and the developer's inbox
--
-- Run after 12_tag_links.sql. Idempotent, like every file here.
--
-- A tech who hits something broken at a customer's site currently has no way to
-- say so from inside the app. He finishes the day, forgets the detail that
-- mattered, and the report arrives second-hand as "the scanner is weird
-- sometimes" — which is unactionable. This gives him a way to send it while he
-- is standing in front of it, and gives the developer the context automatically
-- rather than asking for it.
--
-- ── The two properties that make this worth building ────────────────────────
--
-- 1. A ticket is never lost. Techs work offline all day. Submission goes
--    through the same upload queue as an inspection, keyed by a client-side id
--    so a retry cannot create a second ticket. Until it lands the app says
--    "waiting to send" — never "sent", which would be a lie the tech acts on.
--
-- 2. The tech can SEE that it was received and is being worked on. A reference,
--    a status that changes, and the developer's actual replies, all in the app.
--    A ticket that vanishes into a mailbox teaches him not to bother again.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Who is the developer ────────────────────────────────────────────────────
-- One flag, on the user, set by hand. Deliberately NOT a role in
-- account_members: the developer is not a member of the customer's company, and
-- the ability to read every account's tickets must not be something an account
-- lead can grant.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_developer boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.is_developer()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT is_developer FROM public.users WHERE id = auth.uid()), false);
$$;

-- ── A human-readable reference ──────────────────────────────────────────────
-- What the tech reads back over the phone. Vowel-free so it cannot spell
-- anything, and unambiguous when read aloud: no O/0, no I/1.
CREATE OR REPLACE FUNCTION public.gen_ticket_ref()
RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = public AS $$
DECLARE
  alphabet text := '23456789BCDFGHJKLMNPQRSTVWXYZ';
  out text := '';
  i integer;
BEGIN
  FOR i IN 1..5 LOOP
    out := out || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  END LOOP;
  RETURN 'LIA-' || out;
END;
$$;

-- ── Tickets ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref         text NOT NULL DEFAULT public.gen_ticket_ref(),

  -- Generated on the device before the ticket is ever sent, so a queue that
  -- retries after a timeout cannot file the same complaint twice.
  client_id   uuid,

  account_id  uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Denormalized so a ticket stays readable after the person leaves the
  -- company and their row is gone.
  reporter_name  text,
  reporter_email text,

  kind        text NOT NULL DEFAULT 'bug'
              CHECK (kind IN ('bug', 'suggestion', 'question', 'other')),
  -- How much it is costing him right now. This is what orders the inbox: a
  -- tech who cannot finish a job outranks a nice-to-have, always.
  severity    text NOT NULL DEFAULT 'annoying'
              CHECK (severity IN ('blocking', 'annoying', 'idea')),
  subject     text NOT NULL,

  status      text NOT NULL DEFAULT 'new'
              CHECK (status IN ('new', 'open', 'answered', 'resolved', 'wont_fix')),

  -- Context, captured automatically. Asking a tech on a ladder which version he
  -- is running gets a wrong answer or none; the app knows, so the app says.
  app          text,          -- 'field' | 'office'
  app_version  text,
  platform     text,          -- ios | android | web | mac | windows
  screen       text,          -- where he was when he hit it
  device       jsonb,         -- ua, queue depth, catalogue count, online state

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  -- Drives the badge at each end. Two flags rather than one read-receipt table:
  -- there are exactly two parties to a ticket.
  unread_reporter  boolean NOT NULL DEFAULT false,
  unread_developer boolean NOT NULL DEFAULT true
);

-- Idempotency for the offline queue. Partial, because client_id is null for
-- anything filed server-side.
CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_client_uq
  ON public.support_tickets(client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_ref_uq ON public.support_tickets(ref);
CREATE INDEX IF NOT EXISTS support_tickets_account_idx ON public.support_tickets(account_id);
CREATE INDEX IF NOT EXISTS support_tickets_creator_idx ON public.support_tickets(created_by);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx  ON public.support_tickets(status, last_message_at DESC);

-- ── Messages ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  client_id   uuid,
  author_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Which side of the conversation, recorded rather than derived: whether a
  -- given user is the developer can change, and an old message must still
  -- render as whoever wrote it.
  author_role text NOT NULL CHECK (author_role IN ('reporter', 'developer')),
  author_name text,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS support_messages_client_uq
  ON public.support_messages(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS support_messages_ticket_idx
  ON public.support_messages(ticket_id, created_at);

-- ── Row level security ──────────────────────────────────────────────────────
-- A tech sees his own tickets. A lead sees his company's, because he is the one
-- fielding "did anyone report this?". The developer sees all. Every write goes
-- through the functions below — no client gets INSERT or UPDATE.
ALTER TABLE public.support_tickets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "support_tickets_read" ON public.support_tickets;
CREATE POLICY "support_tickets_read" ON public.support_tickets
  FOR SELECT TO authenticated
  USING (
    created_by = auth.uid()
    OR public.is_developer()
    OR (account_id IS NOT NULL AND account_id = public.my_account_id()
        AND EXISTS (SELECT 1 FROM public.account_members m
                     WHERE m.user_id = auth.uid() AND m.role = 'lead'))
  );

DROP POLICY IF EXISTS "support_messages_read" ON public.support_messages;
CREATE POLICY "support_messages_read" ON public.support_messages
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.support_tickets t WHERE t.id = ticket_id));

REVOKE ALL ON public.support_tickets  FROM anon, authenticated;
REVOKE ALL ON public.support_messages FROM anon, authenticated;
GRANT SELECT ON public.support_tickets  TO authenticated;
GRANT SELECT ON public.support_messages TO authenticated;

-- ── Submitting ──────────────────────────────────────────────────────────────
-- Returns the ticket as the app should display it. The REF in that answer is
-- the confirmation the tech is shown, so it must come from the row that was
-- actually committed and never be guessed at on the device.
CREATE OR REPLACE FUNCTION public.submit_support_ticket(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_account uuid;
  v_who     text;
  v_email   text;
  v_body    text := nullif(btrim(coalesce(p->>'body', '')), '');
  v_subject text := nullif(btrim(coalesce(p->>'subject', '')), '');
  v_client  uuid := nullif(p->>'client_id', '')::uuid;
  v_id      uuid;
  v_row     public.support_tickets%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_body IS NULL THEN RAISE EXCEPTION 'A message is required'; END IF;

  -- A retry of a queued submission returns the ORIGINAL ticket rather than
  -- filing a second one. Without this a flaky connection turns one complaint
  -- into five, and the developer cannot tell which is real.
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_row FROM public.support_tickets WHERE client_id = v_client;
    IF FOUND THEN RETURN row_to_json(v_row); END IF;
  END IF;

  SELECT account_id INTO v_account FROM public.account_members WHERE user_id = v_user;
  SELECT coalesce(u.name, u.email), u.email INTO v_who, v_email
    FROM public.users u WHERE u.id = v_user;

  INSERT INTO public.support_tickets (
    client_id, account_id, created_by, reporter_name, reporter_email,
    kind, severity, subject, app, app_version, platform, screen, device
  ) VALUES (
    v_client, v_account, v_user, v_who, v_email,
    coalesce(nullif(p->>'kind',''), 'bug'),
    coalesce(nullif(p->>'severity',''), 'annoying'),
    -- A tech should never be blocked from reporting something because he did
    -- not think of a title. One is made from the message if he left it blank.
    coalesce(v_subject, left(regexp_replace(v_body, '\s+', ' ', 'g'), 72)),
    nullif(p->>'app',''), nullif(p->>'app_version',''),
    nullif(p->>'platform',''), nullif(p->>'screen',''),
    p->'device'
  )
  RETURNING id INTO v_id;

  INSERT INTO public.support_messages (ticket_id, client_id, author_id, author_role, author_name, body)
  VALUES (v_id, v_client, v_user, 'reporter', v_who, v_body);

  SELECT * INTO v_row FROM public.support_tickets WHERE id = v_id;
  RETURN row_to_json(v_row);
END;
$$;

-- ── Replying ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reply_support_ticket(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user   uuid := auth.uid();
  v_dev    boolean := public.is_developer();
  v_ticket uuid := nullif(p->>'ticket_id','')::uuid;
  v_body   text := nullif(btrim(coalesce(p->>'body','')), '');
  v_client uuid := nullif(p->>'client_id','')::uuid;
  v_who    text;
  v_role   text;
  v_t      public.support_tickets%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_body IS NULL THEN RAISE EXCEPTION 'A message is required'; END IF;

  IF v_ticket IS NULL AND nullif(p->>'ref','') IS NOT NULL THEN
    SELECT id INTO v_ticket FROM public.support_tickets WHERE ref = upper(p->>'ref');
  END IF;

  SELECT * INTO v_t FROM public.support_tickets WHERE id = v_ticket;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such ticket'; END IF;

  -- SECURITY DEFINER bypasses RLS, so the check is made explicitly here.
  IF NOT v_dev AND v_t.created_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'That is not your ticket';
  END IF;

  IF v_client IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.support_messages WHERE client_id = v_client) THEN
    RETURN json_build_object('ticket_id', v_ticket, 'duplicate', true);
  END IF;

  v_role := CASE WHEN v_dev THEN 'developer' ELSE 'reporter' END;
  SELECT coalesce(u.name, u.email) INTO v_who FROM public.users u WHERE u.id = v_user;

  INSERT INTO public.support_messages (ticket_id, client_id, author_id, author_role, author_name, body)
  VALUES (v_ticket, v_client, v_user, v_role, v_who, v_body);

  UPDATE public.support_tickets SET
    last_message_at  = now(),
    updated_at       = now(),
    -- A developer's reply is what makes the tech's copy light up, and vice
    -- versa. A resolved ticket that gets a new reply is open again: the tech
    -- saying "still broken" must not be filed as closed.
    status = CASE
               WHEN v_dev AND status IN ('new', 'open') THEN 'answered'
               WHEN NOT v_dev AND status IN ('resolved', 'wont_fix', 'answered') THEN 'open'
               ELSE status
             END,
    unread_reporter  = CASE WHEN v_dev THEN true  ELSE unread_reporter  END,
    unread_developer = CASE WHEN v_dev THEN unread_developer ELSE true  END
  WHERE id = v_ticket;

  SELECT * INTO v_t FROM public.support_tickets WHERE id = v_ticket;
  RETURN row_to_json(v_t);
END;
$$;

-- ── Status, developer only ──────────────────────────────────────────────────
-- Moving a ticket to 'open' is how the tech is told somebody is actually on it,
-- so it is a first-class action and not just bookkeeping.
CREATE OR REPLACE FUNCTION public.set_support_ticket_status(p jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ticket uuid := nullif(p->>'ticket_id','')::uuid;
  v_status text := nullif(p->>'status','');
  v_t      public.support_tickets%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_developer() THEN RAISE EXCEPTION 'Only the developer can change a ticket status'; END IF;
  IF v_status NOT IN ('new','open','answered','resolved','wont_fix') THEN
    RAISE EXCEPTION 'Unknown status: %', coalesce(v_status, '(null)');
  END IF;

  UPDATE public.support_tickets
     SET status = v_status, updated_at = now(), unread_reporter = true
   WHERE id = v_ticket
  RETURNING * INTO v_t;

  IF NOT FOUND THEN RAISE EXCEPTION 'No such ticket'; END IF;
  RETURN row_to_json(v_t);
END;
$$;

-- ── Reading ─────────────────────────────────────────────────────────────────
-- The tech's own tickets, newest activity first, with every message inline —
-- one round trip, because this is opened on a phone with one bar.
CREATE OR REPLACE FUNCTION public.my_support_tickets()
RETURNS json LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT coalesce(json_agg(t ORDER BY t.last_message_at DESC), '[]'::json)
  FROM (
    SELECT s.id, s.ref, s.client_id, s.kind, s.severity, s.subject, s.status,
           s.created_at, s.last_message_at, s.unread_reporter,
           (SELECT coalesce(json_agg(json_build_object(
                     'id', m.id, 'author_role', m.author_role,
                     'author_name', m.author_name, 'body', m.body,
                     'created_at', m.created_at) ORDER BY m.created_at), '[]'::json)
              FROM public.support_messages m WHERE m.ticket_id = s.id) AS messages
      FROM public.support_tickets s
     WHERE s.created_by = auth.uid()
  ) t;
$$;

-- Marks the tech's copy read. Separate from reading the list so that merely
-- syncing in the background does not clear a badge he never looked at.
CREATE OR REPLACE FUNCTION public.mark_support_ticket_read(p jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid := nullif(p->>'ticket_id','')::uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF public.is_developer() THEN
    UPDATE public.support_tickets SET unread_developer = false WHERE id = v_id;
  ELSE
    UPDATE public.support_tickets SET unread_reporter = false
     WHERE id = v_id AND created_by = auth.uid();
  END IF;
END;
$$;

-- The developer's inbox. Ordered by what is hurting most: anything blocking a
-- tech from finishing a job, then by how long it has been sitting.
CREATE OR REPLACE FUNCTION public.developer_support_inbox(p_status text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE v_out json;
BEGIN
  IF NOT public.is_developer() THEN RAISE EXCEPTION 'Not authorized'; END IF;

  SELECT coalesce(json_agg(t), '[]'::json) INTO v_out FROM (
    SELECT s.id, s.ref, s.kind, s.severity, s.subject, s.status,
           s.reporter_name, s.reporter_email, s.account_id,
           (SELECT a.name FROM public.accounts a WHERE a.id = s.account_id) AS account_name,
           s.app, s.app_version, s.platform, s.screen, s.device,
           s.created_at, s.last_message_at, s.unread_developer,
           (SELECT coalesce(json_agg(json_build_object(
                     'id', m.id, 'author_role', m.author_role,
                     'author_name', m.author_name, 'body', m.body,
                     'created_at', m.created_at) ORDER BY m.created_at), '[]'::json)
              FROM public.support_messages m WHERE m.ticket_id = s.id) AS messages
      FROM public.support_tickets s
     WHERE (p_status IS NULL
            OR (p_status = 'open'   AND s.status IN ('new','open','answered'))
            OR (p_status = 'closed' AND s.status IN ('resolved','wont_fix'))
            OR s.status = p_status)
     ORDER BY
       CASE s.severity WHEN 'blocking' THEN 0 WHEN 'annoying' THEN 1 ELSE 2 END,
       s.unread_developer DESC,
       s.last_message_at DESC
  ) t;

  RETURN v_out;
END;
$$;

-- How many need attention. Cheap enough to poll for a badge.
CREATE OR REPLACE FUNCTION public.developer_support_counts()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
BEGIN
  IF NOT public.is_developer() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN (SELECT json_build_object(
    'unread',   count(*) FILTER (WHERE unread_developer),
    'open',     count(*) FILTER (WHERE status IN ('new','open','answered')),
    'blocking', count(*) FILTER (WHERE severity = 'blocking'
                                   AND status IN ('new','open','answered')),
    'total',    count(*))
    FROM public.support_tickets);
END;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.submit_support_ticket(jsonb)     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reply_support_ticket(jsonb)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_support_ticket_status(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_support_tickets()             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_support_ticket_read(jsonb)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.developer_support_inbox(text)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.developer_support_counts()       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_developer()                   FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.submit_support_ticket(jsonb)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.reply_support_ticket(jsonb)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_support_ticket_status(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_support_tickets()             TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_support_ticket_read(jsonb)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.developer_support_inbox(text)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.developer_support_counts()       TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_developer()                   TO authenticated;

-- ── Making yourself the developer ───────────────────────────────────────────
-- Run once, by hand, in the SQL editor:
--
--   UPDATE public.users SET is_developer = true WHERE email = 'you@example.com';
--
-- There is deliberately no function to grant this. A privilege that lets one
-- account read every other company's support traffic should require database
-- access to obtain, not an API call.
