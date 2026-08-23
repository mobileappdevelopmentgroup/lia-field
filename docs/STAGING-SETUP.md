# Setting up a staging Supabase project

Migrations `03`–`07` restructure live data: credit balances move to accounts, the
destructive unique constraint on `inspections` is dropped, and existing rows are
backfilled into a versioned model. That is not something to try for the first
time on the database your customers are using.

This sets up a throwaway copy to rehearse against. Budget about 30 minutes, most
of it waiting for a restore.

You need: a Supabase account, the Supabase CLI, and Postgres client tools.

```bash
brew install supabase/tap/supabase
brew install postgresql@16     # for pg_dump / pg_restore
```

---

## 1. Create the project

1. <https://supabase.com/dashboard> → **New project**
2. Name it `lia-staging`. Same region as production keeps the restore quick.
3. Set a database password and **save it** — it is shown once, and step 3 needs it.
4. Wait for provisioning (~2 minutes).

## 2. Collect the connection details

**Settings → API**
- Project URL → `https://<ref>.supabase.co`
- `anon` `public` key

**Settings → Database → Connection string → URI**
- The full `postgresql://postgres:...` string. This is the one with your password in it.

Do the same for the **production** project — you need its connection string for
step 3. Production's ref is `bqoxpbjtqwicurmuxueq`.

## 3. Copy production data into staging

The point is to rehearse against realistic data — the same volume, the same messy
serials, the same rows whose ownership the backfill has to work out.

```bash
# Dump production. Schema and data, no ownership or ACLs (they differ per project).
pg_dump "postgresql://postgres:PROD_PASSWORD@db.bqoxpbjtqwicurmuxueq.supabase.co:5432/postgres" \
  --schema=public --no-owner --no-acl --clean --if-exists \
  -f /tmp/lia-prod.sql

# Load it into staging.
psql "postgresql://postgres:STAGING_PASSWORD@db.<staging-ref>.supabase.co:5432/postgres" \
  -f /tmp/lia-prod.sql
```

Notes:
- `--schema=public` only. Do **not** dump the `auth` schema — Supabase manages it,
  and overwriting it will break login on the staging project.
- Auth users therefore do not come across. Step 5 creates one.
- If `pg_dump` complains about a version mismatch, use the one from
  `postgresql@16`: `/opt/homebrew/opt/postgresql@16/bin/pg_dump`.
- Delete `/tmp/lia-prod.sql` when you are done. It contains real customer data.

## 4. Point Lia Office at staging

```bash
cp config.example.json config.staging.json
```

Fill in the staging URL and anon key. `config.*.json` is gitignored.

```bash
npm run electron:dev:staging
```

That sets `LIA_ENV=staging`, which makes the app read `config.staging.json`
instead of `config.json`. It only works in a dev run — a packaged build always
reads `config.json`, so a shipped app can never talk to staging by accident.

If the file is missing, the app fails with a clear message rather than silently
falling back to production.

## 5. Create a test user on staging

Auth users did not come across in step 3.

1. **Authentication → Users → Add user** → email + password, confirm it.
2. Copy the new user's UUID.
3. **SQL Editor**:

```sql
SELECT create_lia_user('paste-uuid-here', 'you@example.com', 'Test Lead', 5);
```

## 6. Rehearse the migrations

First locally, which needs no Supabase at all and takes seconds:

```bash
./supabase/test/run.sh
```

That builds a throwaway Postgres database, stubs what Supabase provides, applies
every migration over realistic pre-migration data, and runs 121 assertions. If
this fails, stop — do not go near staging.

Then against staging, in the **SQL Editor**, one file at a time, in order:

| File | What it does |
|---|---|
| `03_accounts_billing.sql` | Accounts, work orders, one-token-per-work-order billing |
| `04_inspections_v2.sql` | Versioned account-scoped inspections; drops the destructive constraint |
| `05_rep_and_attribution.sql` | Rep numbers, collector attribution, certificate URLs |
| `06_fall_protection.sql` | Fall-protection catalogue, checklists, inspections, photos |
| `07_fp_status.sql` | Status constraint and derived status |

Read the NOTICEs. `04` reports any inspection whose account it could not work
out; those rows are invisible to the app until assigned by hand.

## 7. Check it worked

```sql
-- One account per user, balances carried across, -1 preserved.
SELECT u.email, a.name, a.credits, m.role, m.rep_number
  FROM users u
  JOIN account_members m ON m.user_id = u.id
  JOIN accounts a ON a.id = m.account_id;

-- Every inspection got an asset and an owner. Both should be 0.
SELECT count(*) FILTER (WHERE asset_id IS NULL)   AS no_asset,
       count(*) FILTER (WHERE account_id IS NULL) AS no_account
  FROM inspections;

-- The destructive constraint is gone and the safe index replaced it.
SELECT conname FROM pg_constraint WHERE conname = 'inspections_serial_date_uq';   -- 0 rows
SELECT indexname FROM pg_indexes  WHERE indexname = 'inspections_current_uq';     -- 1 row

-- The public certificate view still returns rows.
SELECT count(*) FROM ladder_inspections_public;
```

Then set your rep number and run the app:

```sql
UPDATE account_members SET rep_number = 'BTV-0001' WHERE user_id = 'your-uuid';
```

```bash
npm run electron:dev:staging
```

Sign in as the test user. Load a CSV and start an import against a **BSI test
work order**, then check the billing behaved:

```sql
SELECT wo_number, charged_at, credits_charged FROM work_orders;
SELECT credits FROM accounts;
```

The things worth confirming by hand, because they are what changed:

- Cancelling at the diff card costs nothing.
- A completed import charges exactly one credit.
- Running the **same** work order again charges nothing.
- A different work order charges one.
- Leaving the work order box empty is refused before the browser opens.

## 8. When you are ready for production

Same files, same order, in production's SQL Editor — but take a backup first
(**Database → Backups**, or repeat the `pg_dump` from step 3 and keep it).

**Ship the SQL and the Lia Office build together.** The current build calls
`preflight_work_order` and `charge_work_order`; against a database without `03`
applied, every import is blocked.

---

## If something goes wrong

**Login fails on staging** — you dumped the `auth` schema over Supabase's own.
Easiest fix is to delete the project and redo from step 1 with `--schema=public`.

**`04` reports inspections with no resolvable account** — their work order number
appears under more than one account, so it refuses to guess. Assign them by hand:

```sql
UPDATE inspections SET account_id = '<account-uuid>' WHERE account_id IS NULL;
```

**A migration half-applied** — all seven files are idempotent. Fix the cause and
re-run the file; it will skip what already exists.

**Starting over** — delete the staging project and repeat. Nothing here is
precious, which is the point of having it.
