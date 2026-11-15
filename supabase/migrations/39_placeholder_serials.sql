-- Lia — placeholder serials refused by the database; safe to re-run, idempotent
--
-- Needs 01–38.
--
-- ── Why ────────────────────────────────────────────────────────────────────
-- An item is keyed on its serial. A lanyard recorded as "N/A" (2026-10-28)
-- meant the next item anybody recorded as "N/A" in that account was matched to
-- the lanyard and recorded against it — two items' histories became one, and
-- the certificate for one showed the other's result. Lia Field 1.15.9 refuses
-- these words on the phone; this refuses them in the database, so that an
-- older phone, a hand-made CSV in Lia Office, a history import or any write
-- path added later cannot put one back.
--
-- ── How ────────────────────────────────────────────────────────────────────
-- Every write path that records an item goes through public.assets (serial_raw
-- is NOT NULL there), so ONE trigger on assets covers them all rather than a
-- check in each of a dozen functions that would drift. It fires on INSERT —
-- including the INSERT … ON CONFLICT DO NOTHING the record paths use, because
-- BEFORE INSERT triggers run before the conflict check — and on an UPDATE
-- that changes the serial. It never fires on an update that leaves the serial
-- alone, so a placeholder row that predates this (there should be none: the
-- live "NA" was merged on 2026-11-13) can still be corrected, tagged or
-- consolidated; it simply cannot be recorded against again until its serial
-- is corrected.
--
-- The list is the phone's: field-app/js/serial-check.js. Matching is on
-- public.serial_key() — upper case, letters and digits only — so "n/a",
-- "N.A." and "N / A" are one word. field-app/test/serial-check.test.mjs fails
-- if the two lists drift.
--
-- Batch paths: import_fp_history isolates each row, so a refused row is
-- reported as skipped and the rest import. record_inspections is one
-- transaction; Lia Office already retries a refused batch row by row and
-- (from 1.15.12) does not queue a refused serial for retry, because it never
-- succeeds. The phone parks a refused record after three tries, names it in
-- Settings with this message, and keeps uploading everything else.

-- Null when the serial is acceptable, otherwise why not. A truly blank serial
-- is 'blank' — every caller refuses that already, the trigger too.
CREATE OR REPLACE FUNCTION public.serial_problem(p_serial text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN btrim(coalesce(p_serial, '')) = '' THEN 'blank'
    WHEN public.serial_key(p_serial) = '' THEN 'needs letters or numbers'
    WHEN public.serial_key(p_serial) = ANY (ARRAY[
      'NA', 'NONE', 'NIL', 'NULL', 'UNKNOWN', 'UNK', 'TBD', 'TBA',
      'NOSERIAL', 'NOSERIALNUMBER', 'NOSN', 'NOSERIALNO', 'NONUMBER', 'NONUM',
      'NOTAG', 'NOLABEL', 'MISSING', 'ILLEGIBLE', 'NOTLEGIBLE', 'UNREADABLE',
      'BLANK', 'EMPTY', 'NOTAPPLICABLE'
    ]) THEN 'placeholder'
    WHEN public.serial_key(p_serial) ~ '^(0+|X+)$' THEN 'placeholder'
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION public.serial_problem(text) IS
  'Why a serial cannot identify an item (blank, punctuation only, or a placeholder word such as N/A), or NULL. Mirrors field-app/js/serial-check.js.';

CREATE OR REPLACE FUNCTION public.assets_refuse_placeholder_serial()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_problem text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.serial_raw IS NOT DISTINCT FROM OLD.serial_raw
     AND NEW.serial_key IS NOT DISTINCT FROM OLD.serial_key THEN
    RETURN NEW;
  END IF;

  -- Both columns, because callers set serial_key themselves and a mismatched
  -- pair must not slip a placeholder key in under a real-looking raw value.
  v_problem := coalesce(public.serial_problem(NEW.serial_raw),
                        CASE WHEN NEW.serial_key IS NULL OR NEW.serial_key = '' THEN 'blank'
                             ELSE public.serial_problem(NEW.serial_key) END);
  IF v_problem IS NULL THEN RETURN NEW; END IF;

  IF v_problem = 'blank' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'A serial number is required',
      HINT    = 'Use the number on the item. An item with no number gets a spare number.';
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'check_violation',
    MESSAGE = format('"%s" is not a serial number — use the number on the item, or a spare number if it has none',
                     btrim(NEW.serial_raw)),
    HINT    = 'Placeholder serials would merge different items into one record.';
END;
$$;

DROP TRIGGER IF EXISTS assets_serial_check_t ON public.assets;
CREATE TRIGGER assets_serial_check_t
  BEFORE INSERT OR UPDATE OF serial_raw, serial_key ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.assets_refuse_placeholder_serial();

-- Helpers, not endpoints. serial_problem is harmless but nobody outside needs
-- it; the trigger function is never called directly.
REVOKE ALL ON FUNCTION public.serial_problem(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.serial_problem(text) TO authenticated;
REVOKE ALL ON FUNCTION public.assets_refuse_placeholder_serial() FROM PUBLIC, anon, authenticated;
