-- In-app support tickets. Runs after 10_tag_links_test.sql.
--
-- The properties that matter:
--   • a queued submission that retries files ONE ticket, not five
--   • a tech sees his own tickets and nobody else's
--   • only the developer reads every account's traffic, and only the developer
--     can change a status
--   • a reply from either side is visible to the other, and re-opens a ticket
--     the tech says is still broken

\set ON_ERROR_STOP on
\set ALEX '11111111-1111-1111-1111-111111111111'
\set SUB  '33333333-3333-3333-3333-333333333333'
\set DEV  '77777777-7777-7777-7777-777777777777'

\ir _helpers.sql
\ir ../13_support.sql

-- The developer is not a member of the customer's company: that is the point of
-- the flag. He gets a users row and nothing else.
INSERT INTO auth.users (id, email) VALUES (:'DEV', 'dev@example.com')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email, name) VALUES (:'DEV', 'dev@example.com', 'The Developer')
  ON CONFLICT (id) DO NOTHING;
UPDATE public.users SET is_developer = true WHERE id = :'DEV';

-- ── A tech files one ────────────────────────────────────────────────────────
SET lia.uid = '11111111-1111-1111-1111-111111111111';

DO $$
DECLARE v_a json; v_b json; v_ref text;
BEGIN
  PERFORM pg_temp.want('a tech is not the developer', is_developer(), false);

  v_a := submit_support_ticket(jsonb_build_object(
    'client_id', 'aaaaaaaa-0000-0000-0000-000000000001',
    'kind', 'bug', 'severity', 'blocking',
    'subject', 'Scanner will not focus',
    'body', 'The barcode scanner opens but never focuses on the ladder plate.',
    'app', 'field', 'app_version', '1.6.2', 'platform', 'ios', 'screen', 'detail',
    'device', jsonb_build_object('queue', 3, 'catalogue', 1724)));

  PERFORM pg_temp.want('the ticket comes back with a reference to read out',
    (v_a->>'ref') ~ '^LIA-[0-9A-Z]{5}$', true);
  PERFORM pg_temp.want('and starts as new', v_a->>'status', 'new');
  PERFORM pg_temp.want('unread at the developer''s end', (v_a->>'unread_developer')::boolean, true);
  -- The tech has read his own message; a badge for it would be nonsense.
  PERFORM pg_temp.want('and not at the tech''s', (v_a->>'unread_reporter')::boolean, false);

  -- The context is captured rather than asked for. A tech on a ladder does not
  -- know which build he is running.
  PERFORM pg_temp.want('the app version rode along',
    (SELECT app_version FROM support_tickets WHERE id = (v_a->>'id')::uuid), '1.6.2');
  PERFORM pg_temp.want('and what he was looking at',
    (SELECT screen FROM support_tickets WHERE id = (v_a->>'id')::uuid), 'detail');

  -- THE offline property: the upload queue retries, and a retry must not file a
  -- second complaint. Same client_id, same ticket.
  v_b := submit_support_ticket(jsonb_build_object(
    'client_id', 'aaaaaaaa-0000-0000-0000-000000000001',
    'body', 'The barcode scanner opens but never focuses on the ladder plate.'));
  PERFORM pg_temp.want('a retried submission returns the SAME ticket', v_b->>'id', v_a->>'id');
  PERFORM pg_temp.want('and files no second one',
    (SELECT count(*)::int FROM support_tickets
      WHERE client_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 1);
  PERFORM pg_temp.want('nor a duplicate message',
    (SELECT count(*)::int FROM support_messages WHERE ticket_id = (v_a->>'id')::uuid), 1);

  -- He should never be blocked from reporting because he did not think of a title.
  v_b := submit_support_ticket(jsonb_build_object(
    'client_id', 'aaaaaaaa-0000-0000-0000-000000000002',
    'kind', 'suggestion', 'severity', 'idea',
    'body', 'It would help if the job list showed the customer name.'));
  PERFORM pg_temp.want('a ticket with no subject still files',
    v_b->>'subject', 'It would help if the job list showed the customer name.');
END $$;

SELECT pg_temp.want_error('an empty message is refused',
  $$ SELECT submit_support_ticket('{"body":"   "}'::jsonb) $$);

-- ── One tech does not read another's ────────────────────────────────────────
SET lia.uid = '33333333-3333-3333-3333-333333333333';
DO $$
DECLARE v json;
BEGIN
  v := submit_support_ticket(jsonb_build_object(
    'client_id', 'bbbbbbbb-0000-0000-0000-000000000001',
    'body', 'Tap-through stops after about ten items.'));

  PERFORM pg_temp.want('a tech sees only his own tickets',
    (SELECT count(*)::int FROM json_array_elements(my_support_tickets())), 1);
  PERFORM pg_temp.want('and it is his',
    (SELECT json_array_elements(my_support_tickets())->>'id'), v->>'id');
END $$;

-- Replying to somebody else's ticket must be refused outright, not silently
-- ignored — the function runs as SECURITY DEFINER and bypasses RLS.
SELECT pg_temp.want_error('a tech cannot reply to another tech''s ticket',
  $$ SELECT reply_support_ticket(jsonb_build_object(
       'ticket_id', (SELECT id FROM support_tickets WHERE ref IS NOT NULL
                      AND created_by = '11111111-1111-1111-1111-111111111111' LIMIT 1),
       'body', 'me too')) $$);

SELECT pg_temp.want_error('nor read the whole inbox',
  $$ SELECT developer_support_inbox() $$);

SELECT pg_temp.want_error('nor change a status',
  $$ SELECT set_support_ticket_status(jsonb_build_object(
       'ticket_id', (SELECT id FROM support_tickets LIMIT 1), 'status', 'resolved')) $$);

-- ── The developer's end ─────────────────────────────────────────────────────
SET lia.uid = '77777777-7777-7777-7777-777777777777';
DO $$
DECLARE v_inbox json; v_first json; v_id uuid;
BEGIN
  PERFORM pg_temp.want('the developer is flagged as one', is_developer(), true);

  v_inbox := developer_support_inbox();
  PERFORM pg_temp.want('the inbox holds every account''s tickets',
    (SELECT count(*)::int FROM json_array_elements(v_inbox)), 3);

  -- What is stopping a tech working outranks a nice-to-have, always.
  v_first := (SELECT json_array_elements(v_inbox) LIMIT 1);
  PERFORM pg_temp.want('and leads with what is blocking somebody',
    v_first->>'severity', 'blocking');

  PERFORM pg_temp.want('counts are available for a badge',
    (developer_support_counts()->>'blocking')::int, 1);

  v_id := (v_first->>'id')::uuid;

  -- Moving it to 'open' is how the tech is told somebody is actually on it.
  PERFORM set_support_ticket_status(jsonb_build_object('ticket_id', v_id, 'status', 'open'));
  PERFORM pg_temp.want('the developer can say he is on it',
    (SELECT status FROM support_tickets WHERE id = v_id), 'open');

  PERFORM reply_support_ticket(jsonb_build_object(
    'ticket_id', v_id, 'body', 'Fixed in the next build — the scanner now refocuses.'));

  PERFORM pg_temp.want('a reply is recorded as the developer''s',
    (SELECT author_role FROM support_messages
      WHERE ticket_id = v_id ORDER BY created_at DESC LIMIT 1), 'developer');
  PERFORM pg_temp.want('and moves the ticket to answered',
    (SELECT status FROM support_tickets WHERE id = v_id), 'answered');
  -- Without this the tech has no idea anybody looked at it.
  PERFORM pg_temp.want('and lights up the tech''s copy',
    (SELECT unread_reporter FROM support_tickets WHERE id = v_id), true);
END $$;

-- ── The tech sees the answer, and can say it is still broken ────────────────
SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE v_t json; v_id uuid;
BEGIN
  v_t := (SELECT t FROM json_array_elements(my_support_tickets()) t
           WHERE t->>'status' = 'answered' LIMIT 1);
  v_id := (v_t->>'id')::uuid;

  PERFORM pg_temp.want('the tech sees the developer''s reply',
    (SELECT count(*)::int FROM json_array_elements(v_t->'messages') m
      WHERE m->>'author_role' = 'developer'), 1);
  PERFORM pg_temp.want('and is told there is something new',
    (v_t->>'unread_reporter')::boolean, true);

  PERFORM mark_support_ticket_read(jsonb_build_object('ticket_id', v_id));
  PERFORM pg_temp.want('reading it clears the badge',
    (SELECT unread_reporter FROM support_tickets WHERE id = v_id), false);

  -- A resolved ticket that the tech says is still broken must not stay closed.
  PERFORM set_config('lia.uid', '77777777-7777-7777-7777-777777777777', false);
  PERFORM set_support_ticket_status(jsonb_build_object('ticket_id', v_id, 'status', 'resolved'));
  PERFORM set_config('lia.uid', '11111111-1111-1111-1111-111111111111', false);

  PERFORM reply_support_ticket(jsonb_build_object('ticket_id', v_id, 'body', 'Still doing it.'));
  PERFORM pg_temp.want('a tech saying it is still broken re-opens it',
    (SELECT status FROM support_tickets WHERE id = v_id), 'open');
  PERFORM pg_temp.want('and puts it back in front of the developer',
    (SELECT unread_developer FROM support_tickets WHERE id = v_id), true);
END $$;

-- ── No client writes either table directly ──────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('authenticated cannot insert tickets',
    has_table_privilege('authenticated', 'public.support_tickets', 'INSERT'), false);
  PERFORM pg_temp.want('nor update them',
    has_table_privilege('authenticated', 'public.support_tickets', 'UPDATE'), false);
  PERFORM pg_temp.want('nor insert messages',
    has_table_privilege('authenticated', 'public.support_messages', 'INSERT'), false);
  -- anon serves the public certificate site and has no business here at all.
  PERFORM pg_temp.want('anon cannot read support traffic',
    has_table_privilege('anon', 'public.support_tickets', 'SELECT'), false);
END $$;
