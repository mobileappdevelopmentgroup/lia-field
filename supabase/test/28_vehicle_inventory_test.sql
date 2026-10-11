-- Vehicle inventory (34). Runs after 27_part_sets_test.sql, on its umbrella:
-- Batavia over Nate (with a tech) and Michael.
--
-- The properties that matter, each asserted below:
--   * the ledger decides the quantity, and a count is as of when it was TAKEN
--     — an offline count arriving late neither wipes a later load nor lets an
--     earlier use come off twice;
--   * a resent phone write is one move;
--   * a phone changes only the trucks its user is on; the office only its own
--     account's; Batavia sees its subcontractors' trucks, siblings never;
--   * ladder parts come off the truck only when switched on, follow whichever
--     version of the record is current, and never stop a ladder being saved.
--
-- Statements that write a ladder are their own transactions on purpose: the
-- deduction runs at commit (a deferred trigger), so it is checked after.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/34_vehicle_inventory.sql

-- ── The office sets up ──────────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate, a lead

SELECT save_stock_loadout('{"name":"Ladder truck","lines":[
  {"part_number":"g13","par":10},{"part_number":"W44","par":4},{"part_number":"G13","par":99},{"part_number":" ","par":1}]}'::jsonb);

DO $$
DECLARE v_lo uuid := (SELECT id FROM stock_loadouts WHERE name = 'Ladder truck');
BEGIN
  PERFORM pg_temp.want('a load-out keeps one line per part, the first, uppercased',
    (SELECT lines FROM stock_loadouts WHERE id = v_lo),
    '[{"par": 10, "part_number": "G13"}, {"par": 4, "part_number": "W44"}]'::jsonb);
  PERFORM save_stock_location(jsonb_build_object('name', 'Truck 14', 'unit', 'KXP-221', 'loadout_id', v_lo));
  PERFORM save_stock_location('{"name":"Truck 9"}'::jsonb);
  PERFORM save_stock_location('{"name":"Shop","kind":"warehouse"}'::jsonb);
  PERFORM pg_temp.want_error('two places cannot share a name',
    $q$SELECT save_stock_location('{"name":"truck 14"}'::jsonb)$q$);
  PERFORM pg_temp.want_error('a tech from another company cannot be put on a truck',
    format($q$SELECT set_stock_assignees(%L, ARRAY['1a000000-0000-0000-0000-000000000003'::uuid])$q$,
           (SELECT id FROM stock_locations WHERE name = 'Truck 14')));
  PERFORM set_stock_assignees((SELECT id FROM stock_locations WHERE name = 'Truck 14'),
                              ARRAY['1a000000-0000-0000-0000-000000000004'::uuid]);
  PERFORM set_stock_assignees((SELECT id FROM stock_locations WHERE name = 'Truck 9'),
                              ARRAY['1a000000-0000-0000-0000-000000000004'::uuid]);
  PERFORM pg_temp.want('the first truck someone is put on is theirs by default',
    (SELECT l.name FROM stock_assignees a JOIN stock_locations l ON l.id = a.location_id
      WHERE a.user_id = '1a000000-0000-0000-0000-000000000004' AND a.is_primary), 'Truck 14');
END $$;

-- The shop gets stock, and loads the truck from it.
SELECT adjust_stock(jsonb_build_object('location_id', (SELECT id FROM stock_locations WHERE name = 'Shop'),
  'reason', 'load', 'part_number', 'G13', 'qty', 50));
SELECT transfer_stock(jsonb_build_object(
  'from_location_id', (SELECT id FROM stock_locations WHERE name = 'Shop'),
  'to_location_id',   (SELECT id FROM stock_locations WHERE name = 'Truck 14'),
  'lines', '[{"part_number":"g13","qty":6}]'::jsonb));

DO $$
DECLARE v_t14 uuid := (SELECT id FROM stock_locations WHERE name = 'Truck 14');
        v_shop uuid := (SELECT id FROM stock_locations WHERE name = 'Shop');
BEGIN
  PERFORM pg_temp.want('a transfer takes it out of the shop',
    (SELECT qty FROM stock_levels WHERE location_id = v_shop AND part_key = 'G13'), 44);
  PERFORM pg_temp.want('and puts it on the truck',
    (SELECT qty FROM stock_levels WHERE location_id = v_t14 AND part_key = 'G13'), 6);
  PERFORM pg_temp.want('both legs share one transfer',
    (SELECT count(DISTINCT transfer_id)::int FROM stock_moves WHERE transfer_id IS NOT NULL), 1);
  PERFORM pg_temp.want('the truck''s par comes from its load-out, and it is short by the difference',
    (SELECT par || '/' || need FROM stock_lines(v_t14) WHERE part_key = 'G13'), '10/4');
  PERFORM pg_temp.want('a load-out part not on the truck yet is listed, short by all of it',
    (SELECT qty || '/' || par || '/' || need FROM stock_lines(v_t14) WHERE part_key = 'W44'), '0/4/4');
  PERFORM set_stock_par(v_t14, 'w44', 2);
  PERFORM pg_temp.want('a truck''s own par overrides the load-out''s',
    (SELECT par FROM stock_lines(v_t14) WHERE part_key = 'W44'), 2);
  PERFORM set_stock_par(v_t14, 'W44', NULL);
  PERFORM pg_temp.want('and clearing it goes back to the load-out''s',
    (SELECT par FROM stock_lines(v_t14) WHERE part_key = 'W44'), 4);
  PERFORM pg_temp.want_error('a correction needs a reason',
    format($q$SELECT adjust_stock('{"location_id":"%s","reason":"adjust","part_number":"G13","qty":-1}'::jsonb)$q$, v_t14));
  PERFORM pg_temp.want('the restock list names the truck and what it needs',
    (SELECT r->>'name' || ':' || (r->'lines'->0->>'part_number') || '+' || (r->'lines'->0->>'need')
       FROM json_array_elements(stock_restock_report()) r LIMIT 1), 'Truck 14:G13+4');
END $$;

-- ── The phone ───────────────────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- the tech on Truck 14

DO $$
DECLARE v json := my_vehicles();
BEGIN
  PERFORM pg_temp.want('a tech sees the trucks they are on, theirs first',
    (SELECT string_agg(x->>'name', ',') FROM json_array_elements(v->'vehicles') x), 'Truck 14,Truck 9');
  PERFORM pg_temp.want('with each truck''s lines',
    (SELECT x->>'qty' FROM json_array_elements(v->'vehicles'->0->'lines') x WHERE x->>'part_number' = 'G13'), '6');
  PERFORM pg_temp.want('and the warehouses to load from',
    (SELECT string_agg(x->>'name', ',') FROM json_array_elements(v->'warehouses') x), 'Shop');
END $$;

-- Used one, offline, with a resend.
SELECT record_stock_move(jsonb_build_object('client_id', 'mv-1', 'reason', 'use', 'part_number', 'G13', 'qty', 1,
  'location_id', (SELECT id FROM stock_locations WHERE name = 'Truck 14'), 'captured_at', now() - interval '3 hours'));
SELECT record_stock_move(jsonb_build_object('client_id', 'mv-1', 'reason', 'use', 'part_number', 'G13', 'qty', 1,
  'location_id', (SELECT id FROM stock_locations WHERE name = 'Truck 14'), 'captured_at', now() - interval '3 hours'));

DO $$
DECLARE v_t14 uuid := (SELECT id FROM stock_locations WHERE name = 'Truck 14');
BEGIN
  PERFORM pg_temp.want('a resent move is one move', (SELECT count(*)::int FROM stock_moves WHERE client_id = 'mv-1'), 1);
  PERFORM pg_temp.want('and comes off once', (SELECT qty FROM stock_levels WHERE location_id = v_t14 AND part_key = 'G13'), 5);
  PERFORM pg_temp.want_error('a tech cannot change a truck they are not on',
    format($q$SELECT record_stock_move('{"client_id":"mv-x","reason":"use","part_number":"G13","qty":1,"location_id":"%s"}'::jsonb)$q$,
           (SELECT id FROM stock_locations WHERE name = 'Shop')));
  PERFORM pg_temp.want_error('nor use nothing',
    format($q$SELECT record_stock_move('{"client_id":"mv-y","reason":"use","part_number":"G13","qty":0,"location_id":"%s"}'::jsonb)$q$, v_t14));
  PERFORM pg_temp.want_error('nor do office corrections',
    format($q$SELECT adjust_stock('{"location_id":"%s","reason":"load","part_number":"G13","qty":1}'::jsonb)$q$, v_t14));
END $$;

-- Loading from the shop on the phone is a transfer too.
SELECT record_stock_move(jsonb_build_object('client_id', 'mv-2', 'reason', 'load', 'part_number', 'W44', 'qty', 3,
  'location_id', (SELECT id FROM stock_locations WHERE name = 'Truck 14'),
  'from_location_id', (SELECT id FROM stock_locations WHERE name = 'Shop')));
DO $$
BEGIN
  PERFORM pg_temp.want('a phone load from the shop puts it on the truck',
    (SELECT qty FROM stock_levels l JOIN stock_locations s ON s.id = l.location_id WHERE s.name = 'Truck 14' AND part_key = 'W44'), 3);
  PERFORM pg_temp.want('and takes it out of the shop (negative: the shop was never counted)',
    (SELECT qty FROM stock_levels l JOIN stock_locations s ON s.id = l.location_id WHERE s.name = 'Shop' AND part_key = 'W44'), -3);
END $$;

-- ── A count is as of when it was taken ──────────────────────────────────────
-- Three hours ago the tech counted 8 of L33 with no signal; two hours ago the
-- office loaded 5; the count arrives now. Then a use from four hours ago
-- arrives, later still. (Relative to now: a time in the future is clamped.)
SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate loads at noon
SELECT adjust_stock(jsonb_build_object('location_id', (SELECT id FROM stock_locations WHERE name = 'Truck 14'),
  'reason', 'load', 'part_number', 'L33', 'qty', 5));
UPDATE stock_moves SET captured_at = now() - interval '2 hours'
 WHERE part_key = 'L33' AND reason = 'load';

SET lia.uid = '1a000000-0000-0000-0000-000000000004';
SELECT record_stock_move(jsonb_build_object('client_id', 'cnt-1', 'reason', 'count', 'part_number', 'L33', 'counted_qty', 8,
  'location_id', (SELECT id FROM stock_locations WHERE name = 'Truck 14'),
  'captured_at', now() - interval '3 hours'));
DO $$
BEGIN
  PERFORM pg_temp.want('a late count does not wipe out a load made after it was taken',
    (SELECT qty FROM stock_levels l JOIN stock_locations s ON s.id = l.location_id WHERE s.name = 'Truck 14' AND part_key = 'L33'), 13);
END $$;
SELECT record_stock_move(jsonb_build_object('client_id', 'use-8am', 'reason', 'use', 'part_number', 'L33', 'qty', 2,
  'location_id', (SELECT id FROM stock_locations WHERE name = 'Truck 14'),
  'captured_at', now() - interval '4 hours'));
DO $$
BEGIN
  PERFORM pg_temp.want('a use from before the count, arriving after it, does not come off twice',
    (SELECT qty FROM stock_levels l JOIN stock_locations s ON s.id = l.location_id WHERE s.name = 'Truck 14' AND part_key = 'L33'), 13);
END $$;

-- ── Ladder parts off the truck ──────────────────────────────────────────────
-- Off by default: a ladder with parts takes nothing.
SELECT record_inspection('{"serial_num":"STK-1","work_order_id":"WO-S","parts":[{"name":"G13","qty":2}]}'::jsonb);
DO $$
BEGIN
  PERFORM pg_temp.want('with automatic deduction off, a ladder takes nothing off the truck',
    (SELECT count(*)::int FROM stock_moves WHERE reason = 'ladder'), 0);
  PERFORM pg_temp.want_error('and a tech cannot switch it on',
    $q$SELECT save_stock_settings('{"auto_deduct":true}'::jsonb)$q$);
END $$;

SET lia.uid = '1a000000-0000-0000-0000-000000000002';
SELECT save_stock_settings('{"auto_deduct":true}'::jsonb);

SET lia.uid = '1a000000-0000-0000-0000-000000000004';
SELECT record_inspection('{"serial_num":"STK-2","work_order_id":"WO-S","parts":[{"name":"G13","qty":2},{"name":"w44","qty":1}]}'::jsonb);
DO $$
BEGIN
  PERFORM pg_temp.want('switched on, a ladder''s parts come off the tech''s truck',
    (SELECT string_agg(part_key || ':' || qty, ',' ORDER BY part_key) FROM stock_levels l
       JOIN stock_locations s ON s.id = l.location_id WHERE s.name = 'Truck 14' AND part_key IN ('G13','W44')),
    'G13:3,W44:2');
  PERFORM pg_temp.want('as ladder moves, carrying the work order',
    (SELECT string_agg(DISTINCT wo_key, ',') FROM stock_moves WHERE reason = 'ladder'), 'WOS');
END $$;

-- The tech corrects the ladder the same day: 3 of G13, no W44.
SELECT record_inspection('{"serial_num":"STK-2","work_order_id":"WO-S","parts":[{"name":"G13","qty":3}]}'::jsonb);
DO $$
BEGIN
  PERFORM pg_temp.want('a corrected ladder moves only the difference',
    (SELECT string_agg(part_key || ':' || qty, ',' ORDER BY part_key) FROM stock_levels l
       JOIN stock_locations s ON s.id = l.location_id WHERE s.name = 'Truck 14' AND part_key IN ('G13','W44')),
    'G13:2,W44:3');
END $$;

-- Switching trucks: the record stays with the truck it already took from.
SELECT set_my_truck((SELECT id FROM stock_locations WHERE name = 'Truck 9'));
SELECT record_inspection('{"serial_num":"STK-2","work_order_id":"WO-S","parts":[{"name":"G13","qty":1}]}'::jsonb);
DO $$
BEGIN
  PERFORM pg_temp.want('a later correction settles on the truck the parts came off, not today''s',
    (SELECT string_agg(s.name || ':' || qty, ',' ORDER BY s.name) FROM stock_levels l
       JOIN stock_locations s ON s.id = l.location_id WHERE part_key = 'G13' AND s.kind = 'vehicle'),
    'Truck 14:4');
END $$;
SELECT record_inspection('{"serial_num":"STK-3","work_order_id":"WO-S","parts":[{"name":"G13","qty":1}]}'::jsonb);
DO $$
BEGIN
  PERFORM pg_temp.want('a new ladder comes off the truck the tech is in now',
    (SELECT qty FROM stock_levels l JOIN stock_locations s ON s.id = l.location_id WHERE s.name = 'Truck 9' AND part_key = 'G13'), -1);
END $$;

-- The office deletes the ladder: its parts go back.
SET lia.uid = '1a000000-0000-0000-0000-000000000002';
SELECT delete_inspection(jsonb_build_object('inspection_id',
  (SELECT id FROM inspections WHERE serial_num = 'STK-3' AND is_current), 'reason', 'duplicate'));
DO $$
BEGIN
  PERFORM pg_temp.want('a deleted ladder puts its parts back',
    (SELECT qty FROM stock_levels l JOIN stock_locations s ON s.id = l.location_id WHERE s.name = 'Truck 9' AND part_key = 'G13'), 0);
END $$;

-- A stock problem never stops a ladder: a part number too long to stock.
SET lia.uid = '1a000000-0000-0000-0000-000000000004';
SELECT set_my_truck((SELECT id FROM stock_locations WHERE name = 'Truck 14'));
SELECT record_inspection(jsonb_build_object('serial_num', 'STK-4', 'work_order_id', 'WO-S',
  'parts', jsonb_build_array(jsonb_build_object('name', repeat('X', 80), 'qty', 1))));
DO $$
BEGIN
  PERFORM pg_temp.want('a ladder the stock cannot take is still recorded',
    (SELECT count(*)::int FROM inspections WHERE serial_num = 'STK-4' AND is_current), 1);
END $$;

-- ── Who sees what ───────────────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000001';   -- Batavia, the umbrella
DO $$
BEGIN
  PERFORM pg_temp.want('the umbrella sees its subcontractor''s trucks',
    (SELECT count(*)::int FROM json_array_elements(stock_overview()->'locations') x WHERE x->>'account_name' <> 'Batavia'), 3);
  PERFORM pg_temp.want('marked as not its own',
    (SELECT bool_or((x->>'mine')::boolean) FROM json_array_elements(stock_overview()->'locations') x), false);
  PERFORM pg_temp.want_error('but cannot change them from its own account',
    format($q$SELECT save_stock_location('{"id":"%s","name":"Mine now"}'::jsonb)$q$,
           (SELECT id FROM stock_locations WHERE name = 'Truck 14')));
END $$;

SET lia.uid = '1a000000-0000-0000-0000-000000000003';   -- Michael, a sibling
DO $$
BEGIN
  PERFORM pg_temp.want('a sibling sees none of Nate''s trucks',
    (SELECT count(*)::int FROM json_array_elements(stock_overview()->'locations')), 0);
  PERFORM pg_temp.want_error('nor their detail',
    format($q$SELECT stock_location_detail('%s')$q$, (SELECT id FROM stock_locations WHERE name = 'Truck 14')));
  PERFORM pg_temp.want('nor has any trucks of their own on a phone',
    json_array_length(my_vehicles()->'vehicles'), 0);
END $$;

-- Through the tables, as the API role.
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM pg_temp.want('row security hides Nate''s moves from a sibling',
    (SELECT count(*)::int FROM stock_moves), 0);
  PERFORM pg_temp.want_error('and nobody writes the ledger directly',
    $q$INSERT INTO stock_moves (account_id, location_id, part_key, part_number, delta, reason)
       SELECT account_id, id, 'G13', 'G13', 100, 'load' FROM stock_locations LIMIT 1$q$);
END $$;
RESET ROLE;

SET ROLE anon;
DO $$
BEGIN
  PERFORM pg_temp.want_error('anon cannot call the phone''s read', $q$SELECT my_vehicles()$q$);
  PERFORM pg_temp.want_error('nor read the ledger', $q$SELECT count(*) FROM stock_moves$q$);
  PERFORM pg_temp.want_error('nor 33''s catalogue any more', $q$SELECT * FROM account_part_sets_catalog()$q$);
END $$;
RESET ROLE;
RESET lia.uid;
