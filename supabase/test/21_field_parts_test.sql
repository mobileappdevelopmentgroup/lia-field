-- Parts on a field record.
-- Runs after 20_crew_removal_test.sql.
--
-- The property that matters: a ladder captured on the phone keeps the parts
-- the tech tapped, because the office's import turns them into the BSI line
-- items the job is billed on.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/24_field_parts.sql

SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate

SELECT record_inspection('{"serial_num":"PARTS-1","work_order_id":"WO-P",
  "parts":[{"name":"G13","qty":2},{"name":"W44","qty":1}]}'::jsonb);

DO $$
BEGIN
  PERFORM pg_temp.want('the parts are kept',
    (SELECT jsonb_array_length(parts) FROM inspections WHERE serial_num = 'PARTS-1'), 2);
  PERFORM pg_temp.want('with their quantities',
    (SELECT parts->0->>'qty' FROM inspections WHERE serial_num = 'PARTS-1'), '2');
END $$;

-- A correction that does not mention parts must not silently strip them: the
-- office would then import a ladder with nothing to bill.
SELECT record_inspection('{"serial_num":"PARTS-1","work_order_id":"WO-P","notes":"corrected"}'::jsonb);

DO $$
BEGIN
  PERFORM pg_temp.want('superseding without parts carries them forward',
    (SELECT jsonb_array_length(parts) FROM inspections
      WHERE serial_num = 'PARTS-1' AND is_current), 2);
  PERFORM pg_temp.want('and the correction landed',
    (SELECT notes FROM inspections WHERE serial_num = 'PARTS-1' AND is_current), 'corrected');
END $$;

-- Replacing them outright still works.
SELECT record_inspection('{"serial_num":"PARTS-1","work_order_id":"WO-P","parts":[{"name":"PM36","qty":1}]}'::jsonb);

DO $$
BEGIN
  PERFORM pg_temp.want('and a new set replaces the old',
    (SELECT parts->0->>'name' FROM inspections WHERE serial_num = 'PARTS-1' AND is_current), 'PM36');
END $$;

-- A record with no parts at all is ordinary, not an error.
SELECT record_inspection('{"serial_num":"PARTS-2","work_order_id":"WO-P"}'::jsonb);
DO $$
BEGIN
  PERFORM pg_temp.want('a ladder with no parts is fine',
    (SELECT parts IS NULL FROM inspections WHERE serial_num = 'PARTS-2'), true);
END $$;

\ir ../migrations/24_field_parts.sql

DO $$
BEGIN
  PERFORM pg_temp.want('re-running changes nothing',
    (SELECT parts->0->>'name' FROM inspections WHERE serial_num = 'PARTS-1' AND is_current), 'PM36');
END $$;

\echo
\echo 'All field parts assertions passed.'
