-- Field Work: what has gone to BSI, what has been corrected, what is filed.
-- Runs after 22_assigned_by_test.sql.
--
-- The property that matters is that a work order's state is DERIVED from its
-- records and never stored. Storing "processed" as a flag is the failure this
-- is written against: a tech adds three ladders to a work order imported
-- yesterday, the flag still says processed, and those three are never billed.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/26_field_work.sql

SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate, a lead

-- Two ladders on one work order.
SELECT record_inspection('{"serial_num":"FW-1","work_order_id":"WO-FW"}'::jsonb);
SELECT record_inspection('{"serial_num":"FW-2","work_order_id":"WO-FW"}'::jsonb);

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM field_work_orders(false) WHERE work_order_id = 'WO-FW';
  PERFORM pg_temp.want('a work order with field records is listed', r.total, 2);
  PERFORM pg_temp.want('nothing has reached BSI yet', r.pushed, 0);
  PERFORM pg_temp.want('so it needs processing', r.state, 'needs_processing');
  PERFORM pg_temp.want('and carries no processed date', r.processed_at IS NULL, true);
END $$;

-- ── The import runs ─────────────────────────────────────────────────────────
DO $$
DECLARE v_ids jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('inspection_id', x.id, 'box_ref', 'box-' || x.n))
    INTO v_ids
    FROM (SELECT id, row_number() OVER (ORDER BY serial_num) AS n
            FROM public.inspections
           WHERE work_order_id = 'WO-FW' AND is_current AND NOT is_deleted) x;
  PERFORM mark_bsi_pushed(jsonb_build_object('items', v_ids));
END $$;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM field_work_orders(false) WHERE work_order_id = 'WO-FW';
  PERFORM pg_temp.want('once every box lands it is processed', r.state, 'processed');
  PERFORM pg_temp.want('both records counted as pushed', r.pushed, 2);
  PERFORM pg_temp.want('with the date the last one landed', r.processed_at IS NOT NULL, true);
  PERFORM pg_temp.want('and it is still in Field Work, not filed away',
                       r.archived_at IS NULL, true);
END $$;

-- ── A ladder added afterwards ───────────────────────────────────────────────
-- THE case a stored flag gets wrong. The work order was imported; this one
-- has not been, and must not be able to hide behind the work order's state.
SELECT record_inspection('{"serial_num":"FW-3","work_order_id":"WO-FW"}'::jsonb);

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM field_work_orders(false) WHERE work_order_id = 'WO-FW';
  PERFORM pg_temp.want('a ladder added after the import shows up', r.total, 3);
  PERFORM pg_temp.want('and the work order stops saying processed', r.state, 'has_edits');
  PERFORM pg_temp.want('with two of three accounted for', r.pushed, 2);
END $$;

-- ── Correcting a record ─────────────────────────────────────────────────────
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.inspections
   WHERE serial_num = 'FW-3' AND is_current AND NOT is_deleted;

  PERFORM pg_temp.want_error('a correction with no reason is refused',
    format('SELECT amend_inspection(''{"inspection_id":"%s"}''::jsonb)', v_id));

  PERFORM amend_inspection(jsonb_build_object(
    'inspection_id', v_id, 'reason', 'brand was wrong on the tag', 'brand', 'Werner'));
END $$;

DO $$
DECLARE v_cur record;
BEGIN
  SELECT * INTO v_cur FROM public.inspections
   WHERE serial_num = 'FW-3' AND is_current AND NOT is_deleted;
  PERFORM pg_temp.want('the correction is live', v_cur.brand, 'Werner');
  PERFORM pg_temp.want('as a new version', v_cur.version, 2);
  PERFORM pg_temp.want('superseding the old one', v_cur.supersedes IS NOT NULL, true);

  PERFORM pg_temp.want('the superseded row is kept, not deleted',
    (SELECT count(*)::int FROM public.inspections WHERE serial_num = 'FW-3'), 2);
  PERFORM pg_temp.want('and the reason is on the audit trail',
    (SELECT reason FROM public.inspection_audit
      WHERE serial_num = 'FW-3' AND action = 'amend' ORDER BY created_at DESC LIMIT 1),
    'brand was wrong on the tag');
  PERFORM pg_temp.want('which names who did it, not who collected it',
    (SELECT actor_name FROM public.inspection_audit
      WHERE serial_num = 'FW-3' ORDER BY created_at DESC LIMIT 1), 'Nate Dobbs');
END $$;

-- ── Correcting something that HAD been pushed ───────────────────────────────
-- Its own state. The importer only adds boxes BSI does not have, so re-running
-- cannot repair this one and must not be allowed to call it green.
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.inspections
   WHERE serial_num = 'FW-1' AND is_current AND NOT is_deleted;
  PERFORM amend_inspection(jsonb_build_object(
    'inspection_id', v_id, 'reason', 'length was 24 not 28', 'length', '24'));
END $$;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM field_work_orders(false) WHERE work_order_id = 'WO-FW';
  PERFORM pg_temp.want('correcting a pushed record is its own state',
                       r.state, 'needs_bsi_edit');
  PERFORM pg_temp.want('and it is counted, so the screen can name it', r.stale > 0, true);

  PERFORM pg_temp.want('the corrected version has NOT inherited the push',
    (SELECT bsi_pushed_at IS NULL FROM public.inspections
      WHERE serial_num = 'FW-1' AND is_current AND NOT is_deleted), true);
END $$;

-- ── Deleting and restoring ──────────────────────────────────────────────────
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.inspections
   WHERE serial_num = 'FW-2' AND is_current AND NOT is_deleted;

  PERFORM pg_temp.want_error('deleting with no reason is refused',
    format('SELECT delete_inspection(''{"inspection_id":"%s"}''::jsonb)', v_id));

  PERFORM delete_inspection(jsonb_build_object(
    'inspection_id', v_id, 'reason', 'duplicate of FW-1'));
END $$;

DO $$
DECLARE r record;
BEGIN
  PERFORM pg_temp.want('a deleted record is soft-deleted, still on the table',
    (SELECT count(*)::int FROM public.inspections WHERE serial_num = 'FW-2'), 1);
  SELECT * INTO r FROM field_work_orders(false) WHERE work_order_id = 'WO-FW';
  PERFORM pg_temp.want('and stops being counted', r.total, 2);
END $$;

DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.inspections WHERE serial_num = 'FW-2';
  PERFORM restore_inspection(jsonb_build_object(
    'inspection_id', v_id, 'reason', 'not a duplicate after all'));
  PERFORM pg_temp.want('restoring brings it back',
    (SELECT count(*)::int FROM field_work_orders(false)
      WHERE work_order_id = 'WO-FW' AND total = 3), 1);
END $$;

-- ── Filing it away, and pulling it back ─────────────────────────────────────
SELECT set_work_order_archived('{"work_order_id":"WO-FW","archived":true}'::jsonb);

DO $$
BEGIN
  PERFORM pg_temp.want('an archived work order leaves Field Work',
    (SELECT count(*)::int FROM field_work_orders(false) WHERE work_order_id = 'WO-FW'), 0);
  PERFORM pg_temp.want('and appears in Work History',
    (SELECT count(*)::int FROM field_work_orders(true) WHERE work_order_id = 'WO-FW'), 1);
  PERFORM pg_temp.want('still knowing when it was processed',
    (SELECT processed_at IS NOT NULL FROM field_work_orders(true) WHERE work_order_id = 'WO-FW'), true);
  PERFORM pg_temp.want('and who filed it',
    (SELECT archived_by_name FROM field_work_orders(true) WHERE work_order_id = 'WO-FW'), 'Nate Dobbs');
  -- Archiving is not billing. A work order can be filed without ever having
  -- been charged, and filing must not look like a charge.
  PERFORM pg_temp.want('archiving did not touch the billing state',
    (SELECT charged_at IS NULL FROM public.work_orders WHERE wo_key = wo_key('WO-FW')), true);
END $$;

SELECT set_work_order_archived('{"work_order_id":"WO-FW","archived":false}'::jsonb);

DO $$
BEGIN
  PERFORM pg_temp.want('unarchiving returns it to Field Work',
    (SELECT count(*)::int FROM field_work_orders(false) WHERE work_order_id = 'WO-FW'), 1);
  PERFORM pg_temp.want('and it is gone from Work History',
    (SELECT count(*)::int FROM field_work_orders(true) WHERE work_order_id = 'WO-FW'), 0);
END $$;

-- ── Nobody else's work, and not every hand ──────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000003';   -- Michael, another company
DO $$
BEGIN
  PERFORM pg_temp.want('a different company sees none of it',
    (SELECT count(*)::int FROM field_work_orders(false) WHERE work_order_id = 'WO-FW'), 0);
END $$;

SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- a tech under Nate
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.inspections
   WHERE serial_num = 'FW-3' AND is_current AND NOT is_deleted;
  PERFORM pg_temp.want_error('a tech cannot correct records',
    format('SELECT amend_inspection(''{"inspection_id":"%s","reason":"nope"}''::jsonb)', v_id));
  PERFORM pg_temp.want_error('nor file a work order away',
    'SELECT set_work_order_archived(''{"work_order_id":"WO-FW"}''::jsonb)');
END $$;
