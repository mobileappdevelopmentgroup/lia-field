-- Assertion helpers. pg_temp functions live for one session only, and each
-- psql -f invocation is its own session, so every test file includes this.

CREATE OR REPLACE FUNCTION pg_temp.want(p_label text, p_got anyelement, p_expect anyelement)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_expect THEN
    RAISE EXCEPTION 'FAIL %: expected %, got %', p_label, p_expect, p_got;
  END IF;
  RAISE NOTICE 'ok  %', p_label;
END;
$$;

-- Asserts that a statement is refused, and reports why.
CREATE OR REPLACE FUNCTION pg_temp.want_error(p_label text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE EXCEPTION 'FAIL %: expected an error, but the statement succeeded', p_label;
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
  RAISE NOTICE 'ok  % (%)', p_label, SQLERRM;
END;
$$;
