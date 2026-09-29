-- Catalogue authoring. Runs after 06_snapshot_test.sql.

\set ON_ERROR_STOP on
\set ACME '11111111-1111-1111-1111-111111111111'
\set SUB  '33333333-3333-3333-3333-333333333333'

\ir _helpers.sql
\ir ../migrations/09_fp_authoring.sql

SET lia.uid = '11111111-1111-1111-1111-111111111111';

DO $$
DECLARE v_id uuid; v_res json;
BEGIN
  v_id := save_fp_model('{"manufacturer":"Petzl","model":"NEWTON","item_type":"Harness","has_impact_indicator":true}'::jsonb);
  PERFORM pg_temp.want('a lead can add a model', v_id IS NOT NULL, true);
  PERFORM pg_temp.want('the indicator flag is stored',
    (SELECT has_impact_indicator FROM fp_models WHERE id = v_id), true);

  -- Editing a model must not create a second one.
  PERFORM save_fp_model(jsonb_build_object('id', v_id, 'manufacturer','Petzl','model','NEWTON',
                                           'item_type','Full body harness','has_impact_indicator',false));
  PERFORM pg_temp.want('editing updates in place',
    (SELECT count(*)::int FROM fp_models WHERE lower(model)='newton'), 1);
  PERFORM pg_temp.want('and the edit sticks',
    (SELECT item_type FROM fp_models WHERE id = v_id), 'Full body harness');

  v_res := publish_fp_checks(v_id, '[
    {"code":"labels","prompt":"Labels legible"},
    {"code":"webbing","prompt":"Webbing intact"}]'::jsonb);
  PERFORM pg_temp.want('publishing starts at version 1', (v_res->>'version')::int, 1);
  PERFORM pg_temp.want('with both checks', (v_res->>'checks')::int, 2);

  -- The whole point of versioning: a past certificate must keep showing what
  -- the tech was actually asked.
  v_res := publish_fp_checks(v_id, '[{"prompt":"Labels legible"}]'::jsonb);
  PERFORM pg_temp.want('re-publishing creates a new version, not an edit',
    (v_res->>'version')::int, 2);
  PERFORM pg_temp.want('and version 1 is still intact',
    (SELECT count(*)::int FROM fp_template_checks c
       JOIN fp_check_templates t ON t.id = c.template_id
      WHERE t.model_id = v_id AND t.version = 1), 2);

  PERFORM pg_temp.want_error('an empty checklist is refused',
    format($q$ SELECT publish_fp_checks(%L, '[]'::jsonb) $q$, v_id));
  PERFORM pg_temp.want_error('a model with no manufacturer is refused',
    $q$ SELECT save_fp_model('{"model":"X"}'::jsonb) $q$);
END $$;

-- A sub-tech collects data; changing what everyone is asked is not their call.
SET lia.uid = '33333333-3333-3333-3333-333333333333';
DO $$ BEGIN
  PERFORM pg_temp.want_error('a sub-tech cannot add a model',
    $q$ SELECT save_fp_model('{"manufacturer":"X","model":"Y"}'::jsonb) $q$);
  PERFORM pg_temp.want_error('nor publish a checklist',
    format($q$ SELECT publish_fp_checks(%L, '[{"prompt":"x"}]'::jsonb) $q$,
           (SELECT id FROM fp_models WHERE lower(model)='newton')));
END $$;

-- Another account's catalogue is not reachable.
SET lia.uid = '22222222-2222-2222-2222-222222222222';
DO $$ BEGIN
  PERFORM pg_temp.want_error('another account cannot publish to this model',
    format($q$ SELECT publish_fp_checks(%L, '[{"prompt":"x"}]'::jsonb) $q$,
           (SELECT id FROM fp_models WHERE lower(model)='newton')));
END $$;

\ir ../migrations/09_fp_authoring.sql
SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$ BEGIN
  PERFORM pg_temp.want('re-running the migration keeps published versions',
    (SELECT max(version)::int FROM fp_check_templates t
       JOIN fp_models m ON m.id = t.model_id WHERE lower(m.model)='newton'), 2);
END $$;

SET ROLE anon;
DO $$ BEGIN
  PERFORM pg_temp.want_error('anon cannot author',
    $q$ SELECT save_fp_model('{"manufacturer":"X","model":"Y"}'::jsonb) $q$);
END $$;
RESET ROLE;

\echo ''
\echo 'All authoring assertions passed.'
