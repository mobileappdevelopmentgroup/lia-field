# Ship runbook — migrations, then Lia Office

> ## ✅ Steps 1–5a were completed on 2026-08-24
>
> The migrations are applied, the anon leak is closed, and the account is
> consolidated. This document is kept as the record of how it was done and for
> re-running against another database. **What happens next is in
> `docs/PICK-UP-HERE.md`.**
>
> One correction learned in the field: step 3 needs the lead's **user** UUID
> from `auth.users`, not an account id. Passing an account id fails with
> "That user has no account", which reads like a provisioning problem and is
> not.

Rehearsed 2026-08-24 against a production-shaped database. Every command below
was run locally first; the results are recorded inline.

---

## The route changed: use Route B, not Route A

`APPLY-MIGRATIONS.md` chose **Route A (reset and reinstall)** on the premise that
"the inspection data is test data, and losing it is acceptable."

**That premise is false.** Profiling the live database through the public REST
API on 2026-08-24:

| | |
|---|---|
| Rows | 1,724 |
| Date range | 2026-05-24 → **2026-08-11** (13 days ago) |
| Techs | **Nate Dobbs — 1,619 rows**; Alex Hinojosa — 105 |
| Distinct work orders | 1 (every row is the literal `'unknown'`) |
| `next_due_date` | out to 2027 — these are live annual certificates |

The certificate site looks records up **by serial number**
(`inspection-site/index.html:391`). Those serials are on physical tags on
customer ladders. A reset turns every one of those lookups into
"not registered" — 1,724 dead certificates, 1,619 of them another tech's work
from the last three months.

Route A is off the table. Route B preserves all of it and was rehearsed end to
end below.

---

## Before you start

Local Postgres must be running (`brew services start postgresql@16`).

```bash
npm run test:sql        # 8 suites, all passed 2026-08-24
npm run typecheck       # clean
npm test                # 30/30
npm run test:field      # all passed
npm run test:desktop    # all passed
```

---

## Step 1 — back up

Supabase dashboard → **Database → Backups** → take one. One click. Do it even
though Route B is non-destructive.

## Step 2 — apply 03–09

Open `supabase/dist/apply-all.sql` (1,858 lines), copy all of it, paste into the
Supabase **SQL Editor**, run once.

`supabase/dist/` is gitignored, so on a fresh clone regenerate it first —
it takes a second and guarantees it matches the migrations:

```bash
./supabase/build-combined.sh
```

**You will see this NOTICE, and it is expected:**

```
NOTICE: inspections with no resolvable account: 1724 — assign these by hand,
        they are invisible to the app until you do
```

All 1,724, not some of them. The backfill gives each existing user their own
account, so there are two; with every row carrying `work_order_id = 'unknown'`
there is no way to attribute them from inside the database. **Step 3 fixes this
completely.** Do not stop here, and do not assign anything by hand.

At this point the app cannot see any inspection. That is normal and temporary.

## Step 3 — consolidate onto one account  ← do not skip

Paste `supabase/10_consolidate_account.sql`, then run with your own auth UUID
(Supabase dashboard → Authentication → Users → copy the id for the Alex account):

```sql
SELECT consolidate_to_one_account('<your-auth-uuid>', 'Batavia');
```

Rehearsal returned:

```json
{"members": 2, "inspections_moved": 1724, "fp_moved": 0,
 "accounts_removed": 1, "credits": 52}
```

`credits` is the two balances summed. Check the number looks right before
moving on — that is the one value worth eyeballing.

## Step 4 — set rep numbers

Consolidation leaves `rep_number` empty. `create_lia_user` doubles as the setter
and is safe to re-run on an existing member:

```sql
SELECT create_lia_user('<alex-auth-uuid>', 'alex@…', 'Alex Hinojosa',
                       NULL, NULL, 'lead', 'BTV-0001');
SELECT create_lia_user('<nate-auth-uuid>', 'nate@…', 'Nate Dobbs',
                       NULL, '<account-id-from-step-3>', 'tech', 'BTV-0002');
```

## Step 5 — verify

```sql
SELECT (SELECT count(*) FROM accounts)                                AS accounts,       -- 1
       (SELECT count(*) FROM inspections WHERE account_id IS NULL)    AS ownerless,      -- 0
       (SELECT count(*) FROM inspections WHERE asset_id IS NULL)      AS assetless,      -- 0
       (SELECT credits FROM accounts)                                 AS credits,
       (SELECT count(*) FROM ladder_inspections_public)               AS public_rows,    -- 1724
       has_table_privilege('anon','public.inspections','SELECT')      AS anon_leak,      -- f
       has_table_privilege('anon','public.ladder_inspections_public','SELECT') AS anon_view, -- t
       (SELECT count(*) FROM pg_constraint
         WHERE conname='inspections_serial_date_uq')                  AS old_constraint, -- 0
       (SELECT count(*) FROM pg_indexes
         WHERE indexname='inspections_current_uq')                    AS safe_index;     -- 1
```

Those are the exact values the rehearsal produced. `anon_leak = f` is the
security fix landing.

Then confirm from outside the database that the leak is actually closed — this
is the same probe that found it open:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  "$SUPABASE_URL/rest/v1/inspections?select=id"     # want 401/403, was 200
```

And load the live certificate site, search a real serial, confirm it still
resolves.

## Step 5a — confirm the certificate base URL

`05_rep_and_attribution.sql` seeds `app_settings.certificate_base_url` with
`https://lia.mobileappdevelopmentgroup.com` (changed from the raw CloudFront
address on 2026-08-24, before any NFC tag was ever written). The seed uses
`ON CONFLICT DO NOTHING`, so on a database where the row already exists it will
**not** be updated. Check it, and correct it if needed:

```sql
SELECT value FROM app_settings WHERE key = 'certificate_base_url';
-- want: https://lia.mobileappdevelopmentgroup.com

UPDATE app_settings SET value = 'https://lia.mobileappdevelopmentgroup.com'
 WHERE key = 'certificate_base_url';
```

This value is written onto physical NFC tags and printed on certificates. It is
effectively permanent once tags are in the field — get it right before the first
tag is written.

## Step 6 — ship Lia Office

Only now. The build calls `preflight_work_order` and `charge_work_order`, which
do not exist before step 2 — every import is blocked without them.

```bash
npm run electron:build
```

Confirm by hand once, because billing is what changed:

- cancelling at the diff card costs nothing
- a completed import charges exactly one credit
- re-running the **same** work order charges nothing
- an empty work order box is refused before Chrome opens

---

## Still needs you — nothing here can be done from the repo

| | Blocks |
|---|---|
| **Store data declarations** (`docs/STORE-DATA-DECLARATIONS.md`) — both stores still say "no data collected" | The first syncing release. Shipping against a stale declaration can pull the listing. |
| **iOS NFC capability** on the App ID in the Apple Developer portal | Phase 8. Everything else is built and compiling; an entitlement cannot grant itself. |
| **A BSI work order that can be dirtied** | Phase 3 L/C/V/P selectors — and the unanswered question below. |
| **Windows code-signing certificate** | Signed Windows installers. If it ships on a hardware token, CI signing is impossible. |

### The open design question, restated because it costs money

An aggregate fall-protection box has no serial to key off, the way ladder boxes
do. Until we know how BSI identifies one, a re-run adds a **second** box instead
of updating the first — and bills the customer twice. This needs an answer
before fall protection imports go anywhere near a real work order.

### Also unpushed

`fall-protection` exists only on this machine — no upstream, not on origin.
Pushing needs the `mobileappdevelopmentgroup` account; `hectorahinojosa1` is
pull-only on `lia-field`.
