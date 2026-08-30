-- Job assignment. Runs after 13_fp_records_test.sql.
--
-- The properties that matter:
--   • only a lead can create, assign, or close a job
--   • a tech sees jobs assigned to him and team-wide ones, and nobody else's
--   • peer visibility is enforced by the SERVER: with sharing off, another
--     tech's rows never leave the database, they are not merely hidden
--   • progress is counted from the inspections themselves, so work recorded
--     before the job existed still counts, and deleting a job destroys no work
--   • an assignment is not a lock — a tech can still work a job he was not given

\set ON_ERROR_STOP on
\set ALEX '11111111-1111-1111-1111-111111111111'
\set SUB  '33333333-3333-3333-3333-333333333333'
\set SUB2 '66666666-6666-6666-6666-666666666666'
\set OTHER '99999999-9999-9999-9999-999999999999'

\ir _helpers.sql
\ir ../16_assignments.sql

-- Two sub-techs on Alex's account, and one person on a different company
-- entirely — the account boundary needs somebody standing outside it.
INSERT INTO auth.users (id, email) VALUES
  (:'SUB',  'sub@acme.com'), (:'SUB2', 'sub2@acme.com'), (:'OTHER', 'rival@other.com')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email, name) VALUES
  (:'SUB',  'sub@acme.com',    'Sub Tech'),
  (:'SUB2', 'sub2@acme.com',   'Second Tech'),
  (:'OTHER','rival@other.com', 'Rival Tech')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO public.account_members (user_id, account_id, role, desktop_access)
SELECT :'SUB', m.account_id, 'tech', false FROM public.account_members m WHERE m.user_id = :'ALEX'
  ON CONFLICT (user_id) DO NOTHING;
INSERT INTO public.account_members (user_id, account_id, role, desktop_access)
SELECT :'SUB2', m.account_id, 'tech', false FROM public.account_members m WHERE m.user_id = :'ALEX'
  ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.accounts (id, name, plan, credits)
VALUES ('aaaa0000-0000-0000-0000-00000000aaaa', 'Rival Co', 'pay-per-use', 10)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.account_members (user_id, account_id, role)
VALUES (:'OTHER', 'aaaa0000-0000-0000-0000-00000000aaaa', 'lead')
  ON CONFLICT (user_id) DO NOTHING;

-- ── Only a lead may plan ────────────────────────────────────────────────────
SET lia.uid = '33333333-3333-3333-3333-333333333333';

DO $$ BEGIN
  PERFORM pg_temp.want_error('a tech cannot create a job',
    $q$ SELECT save_job('{"wo_number":"WO-J1","scope":"fall_protection"}'::jsonb) $q$);
END $$;

-- ── The lead plans the day ──────────────────────────────────────────────────
SET lia.uid = '11111111-1111-1111-1111-111111111111';

DO $$
DECLARE v json;
BEGIN
  v := save_job(jsonb_build_object(
    'wo_number', 'WO-J1', 'scope', 'fall_protection',
    'title', 'Comcast Northern Tier', 'site', 'Batavia yard',
    'due_date', '2026-09-01',
    'assignees', jsonb_build_array('33333333-3333-3333-3333-333333333333')));

  PERFORM pg_temp.want('the job is created', v->'job'->>'wo_number', 'WO-J1');
  PERFORM pg_temp.want('and starts open', v->'job'->>'status', 'open');
  -- Off unless asked for: a tech seeing everyone's work is a decision, not a default.
  PERFORM pg_temp.want('peer visibility is off by default', (v->'job'->>'share_peer_work')::boolean, false);
  PERFORM pg_temp.want('the assignee is on it',
    (SELECT count(*)::int FROM json_array_elements(v->'assignees')), 1);

  -- A work order row has to exist for the importer and the billing to key on.
  PERFORM pg_temp.want('a work order row was created for it',
    (SELECT count(*)::int FROM work_orders WHERE wo_key = wo_key('WO-J1')), 1);
END $$;

-- Re-saving the same number is an EDIT. Making a second job for one work order
-- would put two cards on the tech's phone for one piece of work.
DO $$
DECLARE v json;
BEGIN
  v := save_job(jsonb_build_object(
    'wo_number', 'wo j1', 'scope', 'fall_protection', 'title', 'Renamed',
    'share_peer_work', true,
    'assignees', jsonb_build_array('33333333-3333-3333-3333-333333333333',
                                   '66666666-6666-6666-6666-666666666666')));
  PERFORM pg_temp.want('re-saving the same work order edits it', v->'job'->>'title', 'Renamed');
  PERFORM pg_temp.want('and does not make a second job',
    (SELECT count(*)::int FROM jobs WHERE wo_key = wo_key('WO-J1')), 1);
  PERFORM pg_temp.want('the second tech was added',
    (SELECT count(*)::int FROM json_array_elements(v->'assignees')), 2);
END $$;

-- Editing from a screen that does not show the assignee list must not wipe it.
DO $$
DECLARE v json;
BEGIN
  v := save_job('{"wo_number":"WO-J1","scope":"fall_protection","notes":"Gate code 4412"}'::jsonb);
  PERFORM pg_temp.want('an edit with no assignee list leaves the assignments alone',
    (SELECT count(*)::int FROM json_array_elements(v->'assignees')), 2);
  PERFORM pg_temp.want('and the note landed', v->'job'->>'notes', 'Gate code 4412');
END $$;

-- A team-wide job, and one nobody on this team is on.
DO $$ BEGIN
  PERFORM save_job('{"wo_number":"WO-J2","scope":"ladder","title":"Everybody","assign_all":true}'::jsonb);
  PERFORM save_job(jsonb_build_object('wo_number','WO-J3','scope','fall_protection',
    'title','Just the other one',
    'assignees', jsonb_build_array('66666666-6666-6666-6666-666666666666')));
END $$;

-- A user id from outside the company must not become an assignment nobody in
-- the company can see or clear.
DO $$
DECLARE v json;
BEGIN
  v := save_job(jsonb_build_object('wo_number','WO-J1','scope','fall_protection',
    'assignees', jsonb_build_array('33333333-3333-3333-3333-333333333333',
                                   '99999999-9999-9999-9999-999999999999')));
  PERFORM pg_temp.want('an outsider cannot be assigned to this account''s job',
    (SELECT count(*)::int FROM json_array_elements(v->'assignees')), 1);
END $$;

-- ── What a tech sees ────────────────────────────────────────────────────────
SET lia.uid = '33333333-3333-3333-3333-333333333333';

DO $$
DECLARE v json;
BEGIN
  v := my_jobs(2);
  PERFORM pg_temp.want('a tech sees his own job and the team-wide one, not the third',
    (SELECT count(*)::int FROM json_array_elements(v)), 2);
  PERFORM pg_temp.want('the team-wide one is marked as such',
    (SELECT (r->>'team_wide')::boolean FROM json_array_elements(v) r WHERE r->>'wo_number' = 'WO-J2'), true);
  PERFORM pg_temp.want('and the assigned one says so',
    (SELECT (r->>'assigned_to_me')::boolean FROM json_array_elements(v) r WHERE r->>'wo_number' = 'WO-J1'), true);
END $$;

-- ── Work lands against the work order ───────────────────────────────────────
-- Recorded exactly as it is today: the tech types (or is given) the number and
-- the record carries it. Nothing here references the job.
DO $$
DECLARE v_checks jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt, 'answer', pass_answer))
    INTO v_checks FROM fp_current_checks(NULL, fp_type_for(NULL, 'body_harness'));
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'JOB-A', 'equipment_type', 'body_harness',
    'inspection_date', '2026-08-25', 'work_order_id', 'WO-J1',
    'collector_name', 'Sub Tech', 'checks', v_checks));
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'JOB-B', 'equipment_type', 'body_harness',
    'inspection_date', '2026-08-25', 'work_order_id', 'wo-j1',
    'collector_name', 'Sub Tech', 'checks', v_checks));
END $$;

SET lia.uid = '66666666-6666-6666-6666-666666666666';
DO $$
DECLARE v_checks jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt, 'answer', pass_answer))
    INTO v_checks FROM fp_current_checks(NULL, fp_type_for(NULL, 'body_harness'));
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'JOB-C', 'equipment_type', 'body_harness',
    'inspection_date', '2026-08-25', 'work_order_id', 'WO J1',
    'collector_name', 'Second Tech', 'checks', v_checks));
END $$;

SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE v json;
BEGIN
  v := job_detail((SELECT id FROM jobs WHERE wo_key = wo_key('WO-J1')));
  -- Three different spellings of one work order number. If these did not
  -- collapse the lead would see a third of the day's work.
  PERFORM pg_temp.want('work counts regardless of how the number was typed',
    (SELECT count(*)::int FROM json_array_elements(v->'records')), 3);
  PERFORM pg_temp.want('and is broken down by who did it',
    (SELECT count(*)::int FROM json_array_elements(v->'progress')), 2);
END $$;

-- ── Peer visibility, enforced server-side ───────────────────────────────────
SET lia.uid = '33333333-3333-3333-3333-333333333333';

DO $$
DECLARE v json; v_job uuid := (SELECT id FROM jobs WHERE wo_key = wo_key('WO-J1'));
BEGIN
  v := job_detail(v_job);
  PERFORM pg_temp.want('with sharing on, a tech sees the whole job',
    (SELECT count(*)::int FROM json_array_elements(v->'records')), 3);
  PERFORM pg_temp.want('and can tell which rows are his',
    (SELECT count(*)::int FROM json_array_elements(v->'records') r WHERE (r->>'mine')::boolean), 2);
END $$;

SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$ BEGIN
  PERFORM save_job('{"wo_number":"WO-J1","scope":"fall_protection","share_peer_work":false}'::jsonb);
END $$;

SET lia.uid = '33333333-3333-3333-3333-333333333333';
DO $$
DECLARE v json;
BEGIN
  v := job_detail((SELECT id FROM jobs WHERE wo_key = wo_key('WO-J1')));
  -- THE property. Turning sharing off must keep the other tech's rows OUT OF
  -- THE RESPONSE, not merely off the screen — otherwise the setting is
  -- decorative and anybody reading the network tab defeats it.
  PERFORM pg_temp.want('with sharing off, peers'' rows never leave the database',
    (SELECT count(*)::int FROM json_array_elements(v->'records')), 2);
  PERFORM pg_temp.want('and every row he gets is his own',
    (SELECT bool_and((r->>'mine')::boolean) FROM json_array_elements(v->'records') r), true);
  PERFORM pg_temp.want('the app is told which it is', (v->>'can_see_peers')::boolean, false);
  -- He still gets the totals: knowing HOW MUCH is done is not the same as
  -- reading somebody else's inspection, and a tech who cannot tell whether the
  -- job is nearly finished cannot plan his own afternoon.
  PERFORM pg_temp.want('but the overall progress is still visible',
    (SELECT sum((p->>'n')::int)::int FROM json_array_elements(v->'progress') p), 3);
END $$;

DO $$
DECLARE v json;
BEGIN
  v := my_jobs(2);
  PERFORM pg_temp.want('his own count is his own, not the team''s',
    (SELECT (r->>'mine_count')::int FROM json_array_elements(v) r WHERE r->>'wo_number' = 'WO-J1'), 2);
  PERFORM pg_temp.want('and the team count is not offered when sharing is off',
    (SELECT (r->>'team_count')::int FROM json_array_elements(v) r WHERE r->>'wo_number' = 'WO-J1'), 0);
END $$;

-- ── The account boundary ────────────────────────────────────────────────────
SET lia.uid = '99999999-9999-9999-9999-999999999999';
DO $$
DECLARE v json;
BEGIN
  PERFORM pg_temp.want('another company sees none of these jobs',
    (SELECT count(*)::int FROM json_array_elements(my_jobs(2))), 0);
  PERFORM pg_temp.want('and its board is empty, not everyone''s',
    (SELECT count(*)::int FROM json_array_elements(job_board(NULL))), 0);
  PERFORM pg_temp.want_error('and it cannot open a job by id',
    format($q$ SELECT job_detail(%L::uuid) $q$,
           (SELECT id FROM public.jobs WHERE wo_key = public.wo_key('WO-J1'))));
END $$;

-- ── Closing out the day ─────────────────────────────────────────────────────
SET lia.uid = '33333333-3333-3333-3333-333333333333';
DO $$ BEGIN
  PERFORM pg_temp.want_error('a tech cannot close a job',
    format($q$ SELECT close_job(jsonb_build_object('job_id', %L)) $q$,
           (SELECT id FROM public.jobs WHERE wo_key = public.wo_key('WO-J1'))));
END $$;

SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE v json; v_job uuid := (SELECT id FROM jobs WHERE wo_key = wo_key('WO-J1'));
BEGIN
  v := job_board(NULL);
  PERFORM pg_temp.want('the lead sees every job',
    (SELECT count(*)::int FROM json_array_elements(v)), 3);
  PERFORM pg_temp.want('with the day''s total on each',
    (SELECT (r->>'total')::int FROM json_array_elements(v) r WHERE r->>'wo_number' = 'WO-J1'), 3);

  v := close_job(jsonb_build_object('job_id', v_job, 'note', 'All twelve done, gate locked'));
  PERFORM pg_temp.want('the lead closes it', v->'job'->>'status', 'closed');
  PERFORM pg_temp.want('with what he wants on record', v->'job'->>'close_note', 'All twelve done, gate locked');
  PERFORM pg_temp.want('and it can be reopened',
    close_job(jsonb_build_object('job_id', v_job, 'status', 'open'))->'job'->>'status', 'open');
  -- Reopening has to clear the closing note as well, or the job reads as
  -- finished while it is open.
  PERFORM pg_temp.want('reopening clears the closing note',
    close_job(jsonb_build_object('job_id', v_job, 'status', 'open'))->'job'->>'close_note', NULL);
  PERFORM close_job(jsonb_build_object('job_id', v_job, 'note', 'Done'));
END $$;

-- A closed job stays on the phone briefly, then goes. A tech who finished at
-- three should not watch it vanish and wonder where his work went.
SET lia.uid = '33333333-3333-3333-3333-333333333333';
DO $$
DECLARE v json;
BEGIN
  v := my_jobs(2);
  PERFORM pg_temp.want('a just-closed job is still on the phone, marked closed',
    (SELECT r->>'status' FROM json_array_elements(v) r WHERE r->>'wo_number' = 'WO-J1'), 'closed');
  PERFORM pg_temp.want('and drops off once it is old',
    (SELECT count(*)::int FROM json_array_elements(my_jobs(0)) r WHERE r->>'wo_number' = 'WO-J1'), 0);
END $$;

-- ── Deleting the plan does not delete the work ──────────────────────────────
SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE v_job uuid := (SELECT id FROM jobs WHERE wo_key = wo_key('WO-J1'));
BEGIN
  PERFORM pg_temp.want('the job is deleted', delete_job(jsonb_build_object('job_id', v_job)), 1);
  -- The inspections were never owned by the job — see the header. A lead
  -- tidying his board must not be able to destroy a day of certificates.
  PERFORM pg_temp.want('the inspections it was tracking are untouched',
    (SELECT count(*)::int FROM fp_inspections
      WHERE wo_key(work_order_id) = wo_key('WO-J1') AND is_current AND NOT is_deleted), 3);
  PERFORM pg_temp.want('and the work order itself survives',
    (SELECT count(*)::int FROM work_orders WHERE wo_key = wo_key('WO-J1')), 1);
END $$;

-- ── An assignment is a plan, not a lock ─────────────────────────────────────
-- A tech sent somewhere at short notice, with no signal to fetch the update,
-- must still be able to record against a work order nobody gave him.
SET lia.uid = '33333333-3333-3333-3333-333333333333';
DO $$
DECLARE v_checks jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt, 'answer', pass_answer))
    INTO v_checks FROM fp_current_checks(NULL, fp_type_for(NULL, 'body_harness'));
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'JOB-D', 'equipment_type', 'body_harness',
    'inspection_date', '2026-08-26', 'work_order_id', 'WO-J3',
    'collector_name', 'Sub Tech', 'checks', v_checks));
  PERFORM pg_temp.want('a tech can record against a job he was never assigned',
    (SELECT count(*)::int FROM fp_inspections WHERE wo_key(work_order_id) = wo_key('WO-J3')), 1);
END $$;

-- And the lead sees it, because progress is counted from the records rather
-- than from who was assigned.
SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE v json;
BEGIN
  v := job_detail((SELECT id FROM jobs WHERE wo_key = wo_key('WO-J3')));
  PERFORM pg_temp.want('and the lead sees the unplanned work on his board',
    (SELECT count(*)::int FROM json_array_elements(v->'records')), 1);
END $$;

-- ── Team list ───────────────────────────────────────────────────────────────
DO $$
DECLARE v json;
BEGIN
  v := team_members();
  PERFORM pg_temp.want('the lead can see who there is to assign to',
    (SELECT count(*)::int FROM json_array_elements(v)), 3);
  PERFORM pg_temp.want('and nobody from another company is in the list',
    (SELECT count(*)::int FROM json_array_elements(v) r WHERE r->>'email' = 'rival@other.com'), 0);
END $$;
