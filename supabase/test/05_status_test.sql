-- Fall protection status. Runs after 04_fall_protection_test.sql.

\set ON_ERROR_STOP on
\ir _helpers.sql
\ir ../migrations/07_fp_status.sql

SET lia.uid = '11111111-1111-1111-1111-111111111111';

DO $$ BEGIN
  PERFORM pg_temp.want('a passing item records pass',    fp_default_status(true,  NULL), 'pass');
  PERFORM pg_temp.want('a failing item records fail',    fp_default_status(false, NULL), 'fail');
  PERFORM pg_temp.want('a tech can record an item found already out of date',
    fp_default_status(true, 'inspection overdue'), 'inspection overdue');
END $$;

-- effective_status is what is true today, not what was written on the day.
DO $$ BEGIN
  PERFORM pg_temp.want('an in-date passing item reads as pass',
    fp_effective_status(true, current_date + 100, 'pass'), 'pass');
  -- Nobody edited this row; the calendar moved.
  PERFORM pg_temp.want('a passing item past its due date reads as overdue',
    fp_effective_status(true, current_date - 1, 'pass'), 'inspection overdue');
  -- A condemned item does not soften into "merely overdue".
  PERFORM pg_temp.want('a failed item stays failed once overdue',
    fp_effective_status(false, current_date - 1, 'fail'), 'fail');
  PERFORM pg_temp.want('no due date means nothing has expired',
    fp_effective_status(true, NULL, 'pass'), 'pass');
END $$;

-- The constraint is real.
DO $$ BEGIN
  PERFORM pg_temp.want_error('an unrecognized status is rejected',
    $q$ UPDATE fp_inspections SET status = 'sort of ok' WHERE status IS NOT NULL $q$);
END $$;

-- End to end through the RPC.
DO $$
DECLARE v_ok uuid; v_bad uuid;
BEGIN
  v_ok := record_fp_inspection(jsonb_build_object(
    'serial_num','ST-1','manufacturer','MSA','model','V-FIT',
    'checks', jsonb_build_array(jsonb_build_object('prompt','Labels?','result',true))));
  PERFORM pg_temp.want('the RPC records pass for a clean item',
    (SELECT status FROM fp_inspections WHERE id = v_ok), 'pass');

  v_bad := record_fp_inspection(jsonb_build_object(
    'serial_num','ST-2','manufacturer','MSA','model','V-FIT',
    'discard_reason','webbing cut',
    'checks', jsonb_build_array(jsonb_build_object('prompt','Webbing intact?','result',false))));
  PERFORM pg_temp.want('the RPC records fail for a condemned item',
    (SELECT status FROM fp_inspections WHERE id = v_bad), 'fail');

  PERFORM pg_temp.want('the certificate exposes the derived status',
    (SELECT effective_status FROM fall_protection_public WHERE serial_key='ST2'), 'fail');
END $$;

-- Backdate a passing item and watch the certificate change on its own.
DO $$ BEGIN
  UPDATE fp_inspections SET next_due_date = current_date - 5
   WHERE asset_id = (SELECT id FROM assets WHERE serial_key='ST1' AND kind='fall_protection');
  PERFORM pg_temp.want('the recorded status is untouched', 
    (SELECT status FROM fall_protection_public WHERE serial_key='ST1'), 'pass');
  PERFORM pg_temp.want('but the certificate now reads overdue',
    (SELECT effective_status FROM fall_protection_public WHERE serial_key='ST1'), 'inspection overdue');
END $$;

\ir ../migrations/07_fp_status.sql
DO $$ BEGIN
  PERFORM pg_temp.want('re-running the migration keeps the constraint',
    (SELECT count(*)::int FROM pg_constraint WHERE conname='fp_status_allowed'), 1);
END $$;

\echo ''
\echo 'All status assertions passed.'
