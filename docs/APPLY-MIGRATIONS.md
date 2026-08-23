# Applying the migrations to the live database

Staging was skipped deliberately: the inspection data is test data, and losing
it is acceptable. This is the shorter path that replaces `STAGING-SETUP.md`.

**Auth is never touched.** No migration writes to the `auth` schema —
`auth.users` is only ever referenced. Logins survive whatever happens here.

## 1. Rehearse locally (30 seconds, no Supabase)

```bash
./supabase/test/run.sh
```

Builds a throwaway Postgres, applies every migration over realistic
pre-migration data, and runs 178 assertions. **If this fails, stop.**

## 2. Take the backup anyway

Supabase dashboard → **Database** → **Backups** → take one.

It is one click and it covers the case nobody predicted. Skipping it saves
nothing.

## 3. Apply, in order, in the SQL Editor

| File | What it does |
|---|---|
| `03_accounts_billing.sql` | Accounts, work orders, one-token-per-work-order billing |
| `04_inspections_v2.sql` | Versioned inspections; drops the destructive unique constraint |
| `05_rep_and_attribution.sql` | Rep numbers, collector attribution, certificate URLs |
| `06_fall_protection.sql` | Fall-protection catalogue, checklists, inspections, photos |
| `07_fp_status.sql` | Status constraint and derived status |
| `08_device_snapshot.sql` | The read model behind the on-device cache |
| `09_fp_authoring.sql` | Catalogue authoring (leads only) |

All are idempotent — a half-applied file can be re-run after fixing the cause.

Read the NOTICEs. `04` reports any inspection whose account it could not work
out; those rows are invisible to the app until assigned by hand.

### If you would rather start clean

Since the data is disposable, wiping is also a supported route and is verified
end to end:

```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
```

Then run `01` through `09` in order. Auth users survive this — but every user
needs re-provisioning with `create_lia_user` (step 4), because `public.users` is
gone.

## 4. Provision yourself

```sql
-- A lead: their own account, desktop access, and a rep number.
SELECT create_lia_user('your-auth-uuid', 'you@example.com', 'Your Name',
                       10, NULL, 'lead', 'BTV-0001');
```

The function returns the account id. For a sub-tech, pass it as the fifth
argument with role `'tech'` — they share the lead's account and credits and get
no Lia Office access.

## 5. Check it took

```sql
-- Every user has an account, and balances carried across.
SELECT u.email, a.name, a.credits, m.role, m.rep_number
  FROM users u JOIN account_members m ON m.user_id = u.id
               JOIN accounts a ON a.id = m.account_id;

-- Both should be 0.
SELECT count(*) FILTER (WHERE asset_id IS NULL)   AS no_asset,
       count(*) FILTER (WHERE account_id IS NULL) AS no_account
  FROM inspections;

-- The destructive constraint is gone, the safe index replaced it.
SELECT conname FROM pg_constraint WHERE conname = 'inspections_serial_date_uq';  -- 0 rows
SELECT indexname FROM pg_indexes  WHERE indexname = 'inspections_current_uq';    -- 1 row

-- The public certificate site still returns rows.
SELECT count(*) FROM ladder_inspections_public;
```

## 6. Then ship Lia Office

**The current build cannot run an import until `03` is applied** — it calls
`preflight_work_order` and `charge_work_order`, which do not exist before it.
Ship the SQL first, or ship them together.

Worth confirming by hand once, because it is what changed:

- cancelling at the diff card costs nothing
- a completed import charges exactly one credit
- running the **same** work order again charges nothing
- leaving the work order box empty is refused before the browser opens
