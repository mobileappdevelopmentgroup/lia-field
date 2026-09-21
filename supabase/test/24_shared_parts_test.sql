-- The lead's own parts catalogue, shared to their techs.
-- Runs after 23_field_work_test.sql.
--
-- Two properties, both about direction. The catalogue flows DOWN — Batavia's
-- parts reach everyone beneath it — and never sideways, so Michael's company
-- cannot see Nate's. Getting that backwards leaks one company into another,
-- which is why 18 asserts the same thing for equipment.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/27_shared_parts_catalog.sql

SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate, a lead

SELECT save_account_parts('{"parts":[
  {"part_number":"G13","description":"GRAB RAIL","favorited":true,"default_qty":2,"ord":1},
  {"part_number":"W44","description":"WEAR PAD","favorited":true,"default_qty":1,"ord":2},
  {"part_number":"PM36","description":"PIVOT MOUNT"}
]}'::jsonb);

DO $$
BEGIN
  PERFORM pg_temp.want('the lead''s list is saved',
    (SELECT count(*)::int FROM account_parts_catalog() WHERE NOT is_deleted), 3);
  PERFORM pg_temp.want('with the quantity the lead set',
    (SELECT default_qty FROM account_parts_catalog() WHERE part_number = 'G13'), 2);
  PERFORM pg_temp.want('and the description',
    (SELECT description FROM account_parts_catalog() WHERE part_number = 'W44'), 'WEAR PAD');
  PERFORM pg_temp.want('a part with no quantity given defaults to one',
    (SELECT default_qty FROM account_parts_catalog() WHERE part_number = 'PM36'), 1);
END $$;

-- Case does not make a second part. A lead typing "g13" on Tuesday is
-- correcting Monday's entry, not adding a rival to it.
SELECT save_account_parts('{"parts":[
  {"part_number":"g13","description":"GRAB RAIL","favorited":true,"default_qty":4,"ord":1},
  {"part_number":"W44","description":"WEAR PAD","favorited":true,"default_qty":1,"ord":2},
  {"part_number":"PM36","description":"PIVOT MOUNT"}
]}'::jsonb);

DO $$
BEGIN
  PERFORM pg_temp.want('the same part in another case is the same part',
    (SELECT count(*)::int FROM account_parts_catalog() WHERE NOT is_deleted), 3);
  PERFORM pg_temp.want('and the edit took',
    (SELECT default_qty FROM account_parts_catalog() WHERE upper(part_number) = 'G13'), 4);
END $$;

-- ── Removing one ────────────────────────────────────────────────────────────
-- Tombstoned rather than dropped: a phone that has been in a basement for a
-- week has to be TOLD the part went. A row that simply vanishes says nothing.
SELECT save_account_parts('{"parts":[
  {"part_number":"G13","favorited":true,"default_qty":4,"ord":1},
  {"part_number":"W44","favorited":true,"default_qty":1,"ord":2}
]}'::jsonb);

DO $$
BEGIN
  PERFORM pg_temp.want('a removed part stops counting',
    (SELECT count(*)::int FROM account_parts_catalog() WHERE NOT is_deleted), 2);
  PERFORM pg_temp.want('but is still sent, marked, so a device learns it went',
    (SELECT is_deleted FROM account_parts_catalog() WHERE part_number = 'PM36'), true);
  PERFORM pg_temp.want('and its description is not thrown away on the way out',
    (SELECT description FROM account_parts_catalog() WHERE part_number = 'PM36'), 'PIVOT MOUNT');
END $$;

-- Re-adding is not blocked by the tombstone.
SELECT save_account_parts('{"parts":[
  {"part_number":"G13","favorited":true,"default_qty":4,"ord":1},
  {"part_number":"W44","favorited":true,"default_qty":1,"ord":2},
  {"part_number":"PM36","description":"PIVOT MOUNT"}
]}'::jsonb);

DO $$
BEGIN
  PERFORM pg_temp.want('a part can come back',
    (SELECT NOT is_deleted FROM account_parts_catalog() WHERE part_number = 'PM36'), true);
END $$;

-- ── The catalogue reaches the lead's own techs ──────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- a tech under Nate
DO $$
BEGIN
  PERFORM pg_temp.want('a tech gets their lead''s catalogue',
    (SELECT count(*)::int FROM account_parts_catalog() WHERE NOT is_deleted), 3);
  PERFORM pg_temp.want_error('but cannot author it',
    'SELECT save_account_parts(''{"parts":[{"part_number":"NOPE"}]}''::jsonb)');
END $$;

-- ── And not sideways ────────────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000003';   -- Michael, another company
DO $$
BEGIN
  PERFORM pg_temp.want('a different company sees none of it',
    (SELECT count(*)::int FROM account_parts_catalog()
      WHERE part_number IN ('G13','W44','PM36')), 0);
END $$;

-- ── Incremental pulls ───────────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000002';
DO $$
DECLARE v_mark timestamptz;
BEGIN
  SELECT max(updated_at) INTO v_mark FROM public.account_parts;
  PERFORM pg_temp.want('nothing has changed since the last pull',
    (SELECT count(*)::int FROM account_parts_catalog(v_mark)), 0);

  PERFORM save_account_parts('{"parts":[
    {"part_number":"G13","favorited":true,"default_qty":4,"ord":1},
    {"part_number":"W44","favorited":true,"default_qty":1,"ord":2},
    {"part_number":"PM36","description":"PIVOT MOUNT"},
    {"part_number":"L33","description":"LADDER SHOE","default_qty":2}
  ]}'::jsonb);

  PERFORM pg_temp.want('and a pull since then brings only what moved',
    (SELECT count(*)::int FROM account_parts_catalog(v_mark) WHERE part_number = 'L33'), 1);
END $$;
