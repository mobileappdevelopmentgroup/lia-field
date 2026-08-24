# Applying the migrations to the live database

Staging was skipped deliberately: the inspection data is test data, and losing
it is acceptable. This is the shorter path that replaces `STAGING-SETUP.md`.

**Auth is never touched.** No migration writes to the `auth` schema —
`auth.users` is only ever referenced. Logins survive whatever happens here.

## Two routes

**Reset and reinstall** — chosen, because the existing data is disposable. A
clean install starts with one account, so ownerless inspections and the
consolidation step do not arise at all. Jump to "Route A".

**Migrate in place** — keeps the ~1,724 existing inspection records. More steps,
and the account backfill needs consolidating afterwards. That is "Route B".

Either way: **no migration writes to the `auth` schema.** Logins survive.

---

## Route A — reset and start clean

⚠️ **This deletes every Lia table and everything in them**, including ~1,724
inspection records. Take the Supabase backup first (Database → Backups) even
though the data is disposable — it costs one click.

`public.users` is dropped along with everything else, so every user needs
re-provisioning afterwards. Their **logins are unaffected**; only their Lia
profile and credits go.

1. Rehearse: `./supabase/test/run-reset.sh` — builds a populated database,
   resets it, reinstalls, and checks the result works.
2. In the SQL Editor, run in this order:
   - `supabase/dist/reset-and-install.sql` — the reset. It fails loudly rather
     than half-clearing.
   - `supabase/01_licensing.sql`
   - `supabase/02_inspections.sql`
   - `supabase/dist/apply-all.sql`
3. Provision each user (step 4 below). The first is the lead; everyone else
   passes that lead's account id and role `'tech'`.
4. Verify (step 5 below). On a clean install `no_account` is 0 by construction.

This also closes a live leak: `anon` can currently read the `inspections` base
table directly, despite `CLAUDE.md` recording that the REVOKE was applied on
2026-07-29. It was not. A clean install applies it properly, and
`run-reset.sh` asserts it.

---

## Route B — migrate in place

### 1. Rehearse locally (30 seconds, no Supabase)

```bash
./supabase/test/run.sh
```

Builds a throwaway Postgres, applies every migration over realistic
pre-migration data, and runs 178 assertions. **If this fails, stop.**

### 2. Take the backup anyway

Supabase dashboard → **Database** → **Backups** → take one.

It is one click and it covers the case nobody predicted. Skipping it saves
nothing.

### 3. Apply

Everything is concatenated into **`supabase/dist/apply-all.sql`** (1,858 lines).
Open it, copy all of it, paste into the Supabase **SQL Editor**, and run once.

That is `03` through `09` in order — accounts and billing, versioned inspections,
rep numbers, fall protection, status, the device snapshot, and catalogue
authoring. Every statement is idempotent, so a partial run can be fixed and
re-run.

Regenerate it with `./supabase/build-combined.sh` after editing any migration.

Read the NOTICEs. `04` reports any inspection whose account it could not work
out — step 3a is almost certainly what you want next.

### 3a. Put everyone on one account — read this, it matters

**The backfill gives every existing user their OWN account.** From inside the
database there is no way to tell whether two users are colleagues or two
unrelated customers, so it assumes the safe thing. For Batavia that assumption
is wrong, and wrong in ways that break quietly:

- each tech gets a separate credit balance, so one work order can be charged
  more than once
- techs cannot see each other's equipment catalogue
- **multi-tech merge does not work at all** — it is account-scoped, and two techs
  on one work order would be sitting in different accounts

It is also why `04` reports ownerless inspections: with several accounts it can
only attribute the rows whose work order appears in `usage_log`. On a rehearsal
with 120 inspections and 2 users, **96 came out ownerless** and invisible to the
app.

So unless the users in this database genuinely belong to different companies,
run this too:

```sql
-- Paste supabase/10_consolidate_account.sql, then:
SELECT consolidate_to_one_account('your-auth-uuid', 'Batavia');
```

It puts every user on one account, makes the one you name the lead and the rest
collection-only, adopts every ownerless record, folds duplicate work order
numbers without charging twice, and merges assets that now share a serial. It is
re-runnable and it loses nothing.

It returns a summary — check `inspections_moved` and that `credits` looks right.

## 4. Provision users  *(both routes)*

```sql
-- A lead: their own account, desktop access, and a rep number.
SELECT create_lia_user('your-auth-uuid', 'you@example.com', 'Your Name',
                       10, NULL, 'lead', 'BTV-0001');
```

The function returns the account id. For a sub-tech, pass it as the fifth
argument with role `'tech'` — they share the lead's account and credits and get
no Lia Office access.

## 5. Check it took  *(both routes)*

```sql
-- One account, everyone on it, balances carried across.
SELECT u.email, a.name, a.credits, m.role, m.rep_number
  FROM users u JOIN account_members m ON m.user_id = u.id
               JOIN accounts a ON a.id = m.account_id;

-- Both should be 0. If no_account is not, step 3a was skipped.
SELECT count(*) FILTER (WHERE asset_id IS NULL)   AS no_asset,
       count(*) FILTER (WHERE account_id IS NULL) AS no_account
  FROM inspections;

-- The destructive constraint is gone, the safe index replaced it.
SELECT conname FROM pg_constraint WHERE conname = 'inspections_serial_date_uq';  -- 0 rows
SELECT indexname FROM pg_indexes  WHERE indexname = 'inspections_current_uq';    -- 1 row

-- The public certificate site still returns rows.
SELECT count(*) FROM ladder_inspections_public;
```

## 6. Then ship Lia Office  *(both routes)*

**The current build cannot run an import until `03` is applied** — it calls
`preflight_work_order` and `charge_work_order`, which do not exist before it.
Ship the SQL first, or ship them together.

Worth confirming by hand once, because it is what changed:

- cancelling at the diff card costs nothing
- a completed import charges exactly one credit
- running the **same** work order again charges nothing
- leaving the work order box empty is refused before the browser opens
