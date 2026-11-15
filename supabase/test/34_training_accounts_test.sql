-- Training and test accounts (41). Runs after 33_serial_and_destroy_test.sql.
--
-- What has to hold:
--   * nothing recorded in a training account reaches any public view —
--     including a training inspection of a REAL serial, which must leave the
--     real item's certificate exactly as it was;
--   * the same rows ARE reachable with the family's preview token, and with no
--     other token;
--   * anon and authenticated cannot read the *_all views or call the
--     service-role functions;
--   * an account is born training or never is, and training and real accounts
--     never sit under one another;
--   * training never bills, and never imports into a BSI work order that is not
--     on its list;
--   * erasing refuses a real account before touching anything, deletes every
--     training row, and hands back only generated logins for deletion.

\set ON_ERROR_STOP on

\ir _helpers.sql
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
\ir ../migrations/41_training_accounts.sql
-- Twice: the paste is idempotent.
\ir ../migrations/41_training_accounts.sql

UPDATE impersonation_sessions SET ended_at = now() WHERE ended_at IS NULL;

INSERT INTO auth.users (id, email) VALUES
  ('1b000000-0000-0000-0000-000000000001', 'dev@lia.test'),
  ('1b000000-0000-0000-0000-000000000011', 't-abcd-01@training.mobileappdevelopmentgroup.com'),
  ('1b000000-0000-0000-0000-000000000012', 't-abcd-02@training.mobileappdevelopmentgroup.com'),
  ('1b000000-0000-0000-0000-000000000013', 't-abcd-03@training.mobileappdevelopmentgroup.com'),
  ('1b000000-0000-0000-0000-000000000021', 'outsider@real.test');
INSERT INTO users (id, email, name, is_developer) VALUES
  ('1b000000-0000-0000-0000-000000000001', 'dev@lia.test', 'Dev', true);

-- A real record the training will collide with.
SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- a tech under Nate
SELECT record_inspection('{"serial_num":"TR-REAL-1","work_order_id":"WO-REAL-TR","source":"field","brand":"Werner"}'::jsonb);
SELECT pg_temp.want('the real ladder is public before training starts',
  (SELECT count(*) FROM ladder_inspections_public WHERE serial_key = 'TRREAL1')::int, 1);
RESET lia.uid;

-- ── Creating ────────────────────────────────────────────────────────────────
SELECT pg_temp.want_error('a non-developer cannot create a training account',
  $$SELECT training_create('1a000000-0000-0000-0000-000000000001', '{"name":"Nope"}'::jsonb)$$);
SELECT pg_temp.want_error('a training account needs a name',
  $$SELECT training_create('1b000000-0000-0000-0000-000000000001', '{"name":"  "}'::jsonb)$$);
SELECT pg_temp.want_error('… and lasts at most 90 days',
  $$SELECT training_create('1b000000-0000-0000-0000-000000000001', '{"name":"Long","expires_days":365}'::jsonb)$$);

CREATE TEMP TABLE tr AS
  SELECT training_create('1b000000-0000-0000-0000-000000000001',
           '{"name":"Batavia demo","expires_days":7,"bsi_work_orders":["TRAIN-WO"," ",""]}'::jsonb) AS j;
CREATE TEMP TABLE ids AS SELECT (j->>'account_id')::uuid AS root, (j->>'crew_account_id')::uuid AS crew,
                                j->>'preview_token' AS token FROM tr;
GRANT SELECT ON ids TO anon, authenticated;

SELECT pg_temp.want('the family is an umbrella and a crew beneath it',
  (SELECT parent_account_id FROM accounts WHERE id = (SELECT crew FROM ids)), (SELECT root FROM ids));
SELECT pg_temp.want('both are training accounts',
  (SELECT count(*) FROM accounts WHERE id IN (SELECT root FROM ids UNION SELECT crew FROM ids) AND is_training)::int, 2);
SELECT pg_temp.want('training is never billed (unlimited credits)',
  (SELECT credits FROM accounts WHERE id = (SELECT crew FROM ids)), -1);
SELECT pg_temp.want('the preview token is 64 random hex characters',
  (SELECT token ~ '^[0-9a-f]{64}$' FROM ids), true);
SELECT pg_temp.want('blank work orders are dropped from the training list',
  (SELECT training_bsi_work_orders FROM accounts WHERE id = (SELECT crew FROM ids)), ARRAY['TRAIN-WO']);

-- ── The guard ───────────────────────────────────────────────────────────────
SELECT pg_temp.want_error('a real account cannot be turned into a training account',
  $$UPDATE accounts SET is_training = true WHERE id = (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002')$$);
SELECT pg_temp.want_error('a training account cannot be turned into a real one',
  $$UPDATE accounts SET is_training = false WHERE id = (SELECT crew FROM ids)$$);
SELECT pg_temp.want_error('a real account cannot be put under a training umbrella',
  $$UPDATE accounts SET parent_account_id = (SELECT root FROM ids) WHERE id = (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002')$$);
SELECT pg_temp.want_error('a training account cannot be put under a real umbrella',
  $$UPDATE accounts SET parent_account_id = (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000001') WHERE id = (SELECT root FROM ids)$$);

-- ── Logins ──────────────────────────────────────────────────────────────────
SELECT pg_temp.want_error('only generated logins go into a training account',
  $$SELECT training_add_member('1b000000-0000-0000-0000-000000000001',
      jsonb_build_object('account_id', (SELECT crew FROM ids), 'user_id', '1b000000-0000-0000-0000-000000000021'))$$);
SELECT pg_temp.want_error('a generated login cannot be put on a real account',
  $$SELECT training_add_member('1b000000-0000-0000-0000-000000000001',
      jsonb_build_object('account_id', (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002'),
                         'user_id', '1b000000-0000-0000-0000-000000000011'))$$);

SELECT training_add_member('1b000000-0000-0000-0000-000000000001',
  jsonb_build_object('account_id', (SELECT root FROM ids), 'user_id', '1b000000-0000-0000-0000-000000000011', 'role', 'lead', 'name', 'Training office'));
SELECT training_add_member('1b000000-0000-0000-0000-000000000001',
  jsonb_build_object('account_id', (SELECT crew FROM ids), 'user_id', '1b000000-0000-0000-0000-000000000012', 'role', 'lead', 'name', 'Training lead'));
SELECT training_add_member('1b000000-0000-0000-0000-000000000001',
  jsonb_build_object('account_id', (SELECT crew FROM ids), 'user_id', '1b000000-0000-0000-0000-000000000013', 'role', 'tech', 'name', 'Trainee 1'));

SELECT pg_temp.want_error('a login already on an account cannot be placed again',
  $$SELECT training_add_member('1b000000-0000-0000-0000-000000000001',
      jsonb_build_object('account_id', (SELECT crew FROM ids), 'user_id', '1b000000-0000-0000-0000-000000000013'))$$);
SELECT pg_temp.want('a lead gets the TRAIN number and Lia Office; a tech neither',
  (SELECT string_agg(role || ':' || coalesce(rep_number, '-') || ':' || desktop_access, ',' ORDER BY user_id)
     FROM account_members WHERE user_id::text LIKE '1b000000-0000-0000-0000-00000000001%'),
  'lead:TRAIN:true,lead:TRAIN:true,tech:-:false');

-- ── Recording in training ───────────────────────────────────────────────────
SET lia.uid = '1b000000-0000-0000-0000-000000000013';   -- the trainee
SELECT pg_temp.want('my_context says training, and carries the preview token',
  (SELECT (my_context()->>'is_training')::boolean AND my_context()->>'training_preview_token' = (SELECT token FROM ids)), true);
SELECT record_inspection('{"serial_num":"TR-REAL-1","work_order_id":"TRAIN-WO","source":"field","brand":"Louisville","parts":[{"name":"PMCD4","qty":1}]}'::jsonb);
SELECT record_inspection('{"serial_num":"TR-ONLY-1","work_order_id":"TRAIN-WO","source":"field"}'::jsonb);
SELECT record_fp_inspection(jsonb_build_object('serial_num','TR-FP-1','manufacturer','MSA','model','V-FIT',
  'work_order_id','TRAIN-WO',
  'checks', jsonb_build_array(jsonb_build_object('prompt','Labels?','result',false))));

SELECT pg_temp.want('a training inspection of a real serial makes its own item',
  (SELECT count(*) FROM assets WHERE serial_key = 'TRREAL1')::int, 2);
RESET lia.uid;

SELECT pg_temp.want('the real certificate still shows only the real inspection',
  (SELECT count(*) FROM ladder_inspections_public WHERE serial_key = 'TRREAL1')::int, 1);
SELECT pg_temp.want('… with its real brand and work order, not destroyed',
  (SELECT brand || '/' || work_order_id || '/' || destroyed FROM ladder_inspections_public WHERE serial_key = 'TRREAL1'),
  'Werner/WO-REAL-TR/false');
SELECT pg_temp.want('a training-only ladder is not public',
  (SELECT count(*) FROM ladder_inspections_public WHERE serial_key = 'TRONLY1')::int, 0);
SELECT pg_temp.want('a training work order is not public',
  (SELECT count(*) FROM ladder_inspections_public WHERE work_order_id = 'TRAIN-WO')::int, 0);
SELECT pg_temp.want('a training FP item is not public',
  (SELECT count(*) FROM fall_protection_public WHERE serial_key = 'TRFP1')::int, 0);
SELECT pg_temp.want('… nor are its checks',
  (SELECT count(*) FROM fall_protection_checks_public c
     JOIN assets a ON a.public_ref = c.public_ref WHERE a.serial_key = 'TRFP1')::int, 0);

SELECT pg_temp.want('fall_protection_public carries tag_url_key, for the phone''s link lookup',
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fall_protection_public'
      AND column_name = 'tag_url_key')::int, 1);

-- ── Preview ─────────────────────────────────────────────────────────────────
SET ROLE anon;
SELECT pg_temp.want('anon sees the training ladders with the token',
  (SELECT count(*) FROM training_ladder_inspections((SELECT token FROM ids)) WHERE work_order_id = 'TRAIN-WO')::int, 2);
SELECT pg_temp.want('… including the training copy of the real serial, destroyed',
  (SELECT destroyed FROM training_ladder_inspections((SELECT token FROM ids)) WHERE serial_key = 'TRREAL1'), true);
SELECT pg_temp.want('… and never the real record of it',
  (SELECT count(*) FROM training_ladder_inspections((SELECT token FROM ids)) WHERE work_order_id = 'WO-REAL-TR')::int, 0);
SELECT pg_temp.want('anon sees the training FP item and its checks with the token',
  (SELECT count(*) FROM training_fall_protection((SELECT token FROM ids)))::int
  + (SELECT count(*) FROM training_fall_protection_checks((SELECT token FROM ids)))::int, 2);
SELECT pg_temp.want('the training certificate names the training lead',
  (SELECT rep_number FROM training_ladder_inspections((SELECT token FROM ids)) WHERE serial_key = 'TRONLY1'), 'TRAIN');
SELECT pg_temp.want('a wrong token sees nothing',
  (SELECT count(*) FROM training_ladder_inspections(repeat('0', 64)))::int, 0);
SELECT pg_temp.want('a short token sees nothing, even a prefix of the right one',
  (SELECT count(*) FROM training_ladder_inspections(left((SELECT token FROM ids), 31)))::int, 0);
SELECT pg_temp.want('no token sees nothing',
  (SELECT count(*) FROM training_ladder_inspections(NULL))::int, 0);
SELECT pg_temp.want_error('anon cannot read the unfiltered ladder view',  $$SELECT 1 FROM ladder_inspections_all LIMIT 1$$);
SELECT pg_temp.want_error('anon cannot read the unfiltered FP view',      $$SELECT 1 FROM fall_protection_all LIMIT 1$$);
SELECT pg_temp.want_error('anon cannot read the unfiltered checks view',  $$SELECT 1 FROM fall_protection_checks_all LIMIT 1$$);
SELECT pg_temp.want_error('anon cannot create a training account',
  $$SELECT training_create('1b000000-0000-0000-0000-000000000001', '{"name":"x"}'::jsonb)$$);
SELECT pg_temp.want_error('anon cannot erase one',
  $$SELECT training_erase('1b000000-0000-0000-0000-000000000001', (SELECT root FROM ids))$$);
SELECT pg_temp.want_error('anon cannot read the erasure log',  $$SELECT 1 FROM training_erasures$$);
SELECT pg_temp.want('anon still reads the public view',
  (SELECT count(*) FROM ladder_inspections_public WHERE serial_key = 'TRREAL1')::int, 1);
RESET ROLE;

SET ROLE authenticated;
SET lia.uid = '1b000000-0000-0000-0000-000000000001';   -- even the developer, from the app
SELECT pg_temp.want_error('a signed-in user cannot read the unfiltered view', $$SELECT 1 FROM ladder_inspections_all LIMIT 1$$);
SELECT pg_temp.want_error('a signed-in user cannot call the service-role erase',
  $$SELECT training_erase('1b000000-0000-0000-0000-000000000001', (SELECT root FROM ids))$$);
RESET ROLE;

-- ── Certificate-view tracking ───────────────────────────────────────────────
DELETE FROM certificate_views;
SELECT record_certificate_view(jsonb_build_object('public_ref',
  (SELECT public_ref FROM assets WHERE serial_key = 'TRONLY1'), 'user_agent', 'Mozilla/5.0 (Macintosh)'));
SELECT pg_temp.want('opening a training certificate is not a visit',
  (SELECT count(*) FROM certificate_views)::int, 0);
SELECT record_certificate_view(jsonb_build_object('serial_key', 'TR-REAL-1', 'user_agent', 'Mozilla/5.0 (Macintosh)'));
SELECT pg_temp.want('a real serial typed on the site counts against the real item',
  (SELECT a.account_id FROM certificate_views v JOIN assets a ON a.id = v.asset_id),
  (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002'));

-- ── Billing and BSI ─────────────────────────────────────────────────────────
SET lia.uid = '1b000000-0000-0000-0000-000000000012';   -- the training crew's lead
SELECT pg_temp.want('a training account cannot import into a live work order',
  (preflight_work_order('99434')->>'can_run')::boolean, false);
SELECT pg_temp.want('… and is told which one it can use',
  preflight_work_order('99434')->>'reason' LIKE '%training work order: TRAIN-WO.', true);
SELECT pg_temp.want('its training work order is allowed, however it is typed',
  (preflight_work_order('train wo')->>'can_run')::boolean, true);
SELECT pg_temp.want('… and free',
  (preflight_work_order('TRAIN-WO')->>'free')::boolean, true);
SELECT charge_work_order('TRAIN-WO');
SELECT pg_temp.want('charging a training work order takes nothing',
  (SELECT credits FROM accounts WHERE id = (SELECT crew FROM ids)), -1);
SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate, real
SELECT pg_temp.want('a real account preflights as before',
  (preflight_work_order('99434')->>'training')::boolean, false);
SELECT pg_temp.want('my_context on a real account carries no preview token',
  my_context()->>'training_preview_token', NULL::text);
SELECT pg_temp.want('… and says it is not training',
  (my_context()->>'is_training')::boolean, false);

-- ── The developer's list and edits ──────────────────────────────────────────
SELECT pg_temp.want_error('only the developer may list training accounts', $$SELECT training_accounts()$$);
SET lia.uid = '1b000000-0000-0000-0000-000000000001';
SELECT pg_temp.want('the list shows the family, its three logins and its records',
  (SELECT (e->>'name') || '/' || json_array_length(e->'members') || '/' || (e->>'ladders') || '/' || (e->>'fp')
     FROM json_array_elements(training_accounts()) e),
  'Training: Batavia demo/3/2/1');
SELECT training_update(jsonb_build_object('account_id', (SELECT root FROM ids), 'expires_days', 30,
                                          'bsi_work_orders', '["TRAIN-WO","TRAIN-2"]'::jsonb));
SELECT pg_temp.want('an edit applies to the whole family',
  (SELECT bool_and(training_bsi_work_orders = ARRAY['TRAIN-WO','TRAIN-2'] AND training_expires_at > now() + interval '29 days')
     FROM accounts WHERE id IN (SELECT root FROM ids UNION SELECT crew FROM ids)), true);
SELECT pg_temp.want_error('training_update refuses a real account',
  $$SELECT training_update(jsonb_build_object('account_id', (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002'), 'expires_days', 5))$$);
RESET lia.uid;

-- ── Erasing ─────────────────────────────────────────────────────────────────
CREATE TEMP TABLE before AS
  SELECT (SELECT count(*) FROM inspections) AS insp, (SELECT count(*) FROM assets) AS assets,
         (SELECT count(*) FROM accounts) AS accts;

SELECT pg_temp.want_error('erasing a real account is refused',
  $$SELECT training_erase('1b000000-0000-0000-0000-000000000001',
      (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002'))$$);
SELECT pg_temp.want_error('erasing the real umbrella is refused',
  $$SELECT training_erase('1b000000-0000-0000-0000-000000000001',
      (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000001'))$$);
SELECT pg_temp.want_error('a non-developer cannot erase',
  $$SELECT training_erase('1a000000-0000-0000-0000-000000000001', (SELECT root FROM ids))$$);
SELECT pg_temp.want('… and nothing was touched by any of that',
  (SELECT (SELECT count(*) FROM inspections) = insp AND (SELECT count(*) FROM assets) = assets
          AND (SELECT count(*) FROM accounts) = accts FROM before), true);

-- Somebody who is not a generated login, put on the account behind the
-- functions' back: they lose the membership, never their login.
INSERT INTO account_members (user_id, account_id, role) VALUES
  ('1b000000-0000-0000-0000-000000000021', (SELECT crew FROM ids), 'tech');

CREATE TEMP TABLE er AS
  SELECT training_erase('1b000000-0000-0000-0000-000000000001', (SELECT root FROM ids)) AS j;

SELECT pg_temp.want('erasing hands back the three generated logins, and only those',
  (SELECT string_agg(u, ',' ORDER BY u) FROM er, json_array_elements_text(j->'user_ids') u),
  '1b000000-0000-0000-0000-000000000011,1b000000-0000-0000-0000-000000000012,1b000000-0000-0000-0000-000000000013');
SELECT pg_temp.want('… and both account ids, for the photos',
  (SELECT json_array_length(j->'account_ids') FROM er), 2);
SELECT pg_temp.want('both accounts are gone',
  (SELECT count(*) FROM accounts WHERE id IN (SELECT root FROM ids UNION SELECT crew FROM ids))::int, 0);
SELECT pg_temp.want('every training inspection is gone',
  (SELECT count(*) FROM inspections WHERE work_order_id = 'TRAIN-WO')::int, 0);
SELECT pg_temp.want('every training FP inspection is gone',
  (SELECT count(*) FROM fp_inspections WHERE work_order_id = 'TRAIN-WO')::int, 0);
SELECT pg_temp.want('the training items are gone; the real one stays',
  (SELECT count(*) FROM assets WHERE serial_key IN ('TRREAL1', 'TRONLY1', 'TRFP1'))::int, 1);
SELECT pg_temp.want('the real certificate is untouched',
  (SELECT brand FROM ladder_inspections_public WHERE serial_key = 'TRREAL1'), 'Werner');
SELECT pg_temp.want('the memberships went with the accounts',
  (SELECT count(*) FROM account_members WHERE user_id::text LIKE '1b000000-0000-0000-0000-0000000000%')::int, 0);
SELECT pg_temp.want('the erasure is logged as unfinished until the logins are deleted',
  (SELECT json_array_length(training_pending_erasures('1b000000-0000-0000-0000-000000000001'))), 1);
SELECT training_erase_finished('1b000000-0000-0000-0000-000000000001', (SELECT (j->>'erasure_id')::uuid FROM er));
SELECT pg_temp.want('… and finished after',
  (SELECT json_array_length(training_pending_erasures('1b000000-0000-0000-0000-000000000001'))), 0);
SELECT pg_temp.want('the preview token now answers nothing',
  (SELECT count(*) FROM training_ladder_inspections((SELECT token FROM ids)))::int, 0);

-- The logins themselves are deleted by the Edge Function. Simulate it, so the
-- rest of the suite sees a clean database.
DELETE FROM auth.users WHERE id::text LIKE '1b000000-0000-0000-0000-00000000001%';
