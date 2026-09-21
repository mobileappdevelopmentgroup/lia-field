-- An assigned job says who assigned it.
-- Runs after 21_field_parts_test.sql.
--
-- "Who gave me this?" is the first question a tech asks of work that appeared
-- on his phone, and on a shared phone — or for a tech working under more than
-- one lead — the answer was nowhere on the device.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/25_assigned_by.sql

-- Nate plans a job for his crew member.
SET lia.uid = '1a000000-0000-0000-0000-000000000002';
SELECT save_job('{"wo_number":"WO-ASG","scope":"ladder","title":"Comcast yard",
                  "assignees":["1a000000-0000-0000-0000-000000000004"]}'::jsonb);

SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- the crew member
DO $$
DECLARE v json; j json;
BEGIN
  v := my_jobs();
  SELECT x INTO j FROM json_array_elements(v) x WHERE x->>'wo_number' = 'WO-ASG';

  PERFORM pg_temp.want('the job reaches the tech', (j->>'wo_number'), 'WO-ASG');
  PERFORM pg_temp.want('and names the lead who assigned it',
                       (j->>'assigned_by'), 'Nate Dobbs');
  PERFORM pg_temp.want('with their address, for a tech who works for several',
                       (j->>'assigned_by_email'), 'nate@sub.test');
END $$;

-- Nothing new is exposed: this is a member of the tech's own account, and the
-- job was already visible to him.
SET lia.uid = '1a000000-0000-0000-0000-000000000003';   -- Michael, another company
DO $$
BEGIN
  PERFORM pg_temp.want('a different company still sees none of it',
    (SELECT count(*)::int FROM json_array_elements(my_jobs()) x
      WHERE x->>'wo_number' = 'WO-ASG'), 0);
END $$;

\ir ../migrations/25_assigned_by.sql

SET lia.uid = '1a000000-0000-0000-0000-000000000004';
DO $$
BEGIN
  PERFORM pg_temp.want('re-running changes nothing',
    (SELECT x->>'assigned_by' FROM json_array_elements(my_jobs()) x
      WHERE x->>'wo_number' = 'WO-ASG'), 'Nate Dobbs');
END $$;

\echo
\echo 'All assigned-by assertions passed.'
