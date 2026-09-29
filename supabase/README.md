> **Layout changed 2026-09-20.** The numbered migrations moved into
> `supabase/migrations/`, and `supabase/schema.sql` is a generated snapshot of
> what they produce — read that when the question is "what shape is the
> database", rather than piecing it together from twenty-two files.
> `supabase/MIGRATIONS.md` says what each one did. Nothing was deleted: an
> applied migration is still how the live database gets changed, and every SQL
> test builds from them.

# Supabase Setup for Lia

## 1. Create a Supabase project

Go to https://supabase.com → New Project. Note your **Project URL** and **anon public key** (Settings → API).

## 2. Run the SQL migrations

In the Supabase dashboard → SQL Editor, run these files in order:

1. `01_licensing.sql` — users table, credit functions, RLS
2. `02_inspections.sql` — ladder inspection records + public view
3. `03_accounts_billing.sql` — accounts, work orders, and one-token-per-work-order billing
4. `04_inspections_v2.sql` — versioned, account-scoped inspections + the public view
5. `05_rep_and_attribution.sql` — rep numbers, collector attribution, derived certificate URLs
6. `06_fall_protection.sql` — fall-protection catalogue, checklists, inspections, photos
7. `07_fp_status.sql` — status constraint and derived status
8. `08_device_snapshot.sql` — the read model behind the on-device cache
9. `09_fp_authoring.sql` — catalogue authoring (leads only)
10. `10_consolidate_account.sql` — *optional*, single-company only; needs a user id
11. `11_fp_equipment_types.sql` — the fourteen equipment types and their per-type
    pass/fail parameters, plus the answer style each check is recorded with
12. `12_tag_links.sql` — the hyperlink an NFC tag carries: `assets.tag_url` and
    its canonical key, tag sightings, and external records
13. `13_support.sql` — in-app support tickets, replies, and the developer inbox
14. `14_certificate_views.sql` — who has been reading certificates, and the
    network labels that decide office versus field
15. `15_fp_records.sql` — correcting and deleting fall-protection records, the
    audit trail behind it, and the queue of work waiting to go onto BSI
16. `16_assignments.sql` — the lead's job board: work orders assigned to techs
    or to the whole team, and whether techs may read each other's work
17. `17_tag_write.sql` — writing our own tags: the label printed on the tag as a
    fifth identifier, and one resolver that accepts any of them

All are idempotent and safe to re-run.

> **Applied 2026-08-30.** The live database now carries **01–17**. It had been
> at 10: migrations 11–17 were written on the fall-protection branch after the
> 2026-08-24 apply. Applied from `supabase/dist/apply-11-17.sql`.
>
> Do not start such a bundle part-way up the range. The first attempt began at
> 14 and died on `is_developer()`, which 13 defines, leaving a half-applied
> database. It was recoverable — everything is idempotent — but the numbering is
> a dependency order, not a suggestion. `./supabase/test/run-apply.sh` rehearses
> a bundle against an already-migrated database and reproduces that failure.

### Becoming the developer

`13_support.sql` adds `users.is_developer`. Nothing sets it — run this once, by
hand, in the SQL editor:

```sql
UPDATE public.users SET is_developer = true WHERE email = 'you@example.com';
```

There is deliberately no function to grant it. That flag lets one account read
every customer's support traffic, so obtaining it should require database
access, not an API call. It is not a role in `account_members` either: the
developer is not a member of any customer's company, and an account lead must
not be able to grant it.

### Tag hyperlinks, and why claims live in their own table

Gear usually arrives already tagged by whoever supplied it. Those tags carry a
serial printed on the outside and, in the NDEF, a link into somebody else's
system — no serial we know and no certificate code. `assets.tag_url` makes that
link a fourth way to identify an item, alongside the serial, the hardware uid
and the certificate ref.

`fp_tag_url_key()` **must stay identical to `urlKey()` in
`field-app/js/tag-link.js`**, the same way `serial_key()` and `serialKey()` must
agree — a device and a server that disagree on when two links are the same link
will index an item nobody can then find. Both suites assert the same pairs:
`supabase/test/10_tag_links_test.sql` and `field-app/test/tag-link.test.mjs`.

What a link *claimed* goes to `fp_external_records`, never to `fp_inspections`.
A blank NTAG213 costs pennies and any phone can rewrite one, so a URL read off a
tag is an unauthenticated claim by whoever last held the item. If a fetched row
could land in `fp_inspections` — even flagged by a `source` column — anyone able
to write a tag could put "last inspected, PASS" into the history of a harness.
External records are never joined into a certificate and can never satisfy a due
date; the test suite asserts all three.

### Where a fall-protection checklist comes from

A checklist belongs to the **equipment type**, not to the manufacturer or model:
a body harness is checked as a body harness whoever made it, and manufacturer,
model, lot number and date of manufacture are recorded *about* the item rather
than selecting its questions. `11_fp_equipment_types.sql` seeds the fourteen
standard types with the checks each one carries.

A specific model may still be given its own list, which then overrides its
type's — authored in Lia Office, seeded from the type's list so adding a check
to a model starts from the standard one.

Publishing always writes a **new version**. An inspection pins the version it was
performed against, so changing a checklist never rewrites what a certificate
already issued says the tech was asked.

Two checks are yes/no questions rather than pass/fail components, and one of
them is inverted — *"has the impact indicator been activated?"* fails on **Yes**.
Each check therefore records `answer_style` and `pass_answer`, and
`record_fp_inspection` takes both **from the template, not the client**, so a
device cannot redefine what counts as a pass.

### Setting a lead tech's rep number

The rep number identifies the Batavia tech responsible for an inspection. It is an
attribute of the lead, snapshotted onto every inspection they are responsible for —
a device cannot claim a different one.

```sql
UPDATE public.account_members SET rep_number = 'BTV-4471'
 WHERE user_id = 'their-auth-uuid';
```

### Test before applying to a live database

`03_accounts_billing.sql` migrates real credit balances and `04_inspections_v2.sql`
restructures live inspection data. Rehearse both locally first:

```bash
./supabase/test/run.sh
```

That builds a throwaway Postgres database, stubs the pieces Supabase provides
(`auth.users`, `auth.uid()`, the `anon` / `authenticated` roles), applies every
migration in order over realistic pre-migration data, and asserts the billing
behaviour — charge once per work order, free on re-run, per-account namespacing,
account isolation under RLS, and that re-running the migration changes nothing.
A failed assertion exits non-zero.

Needs a local Postgres: `brew install postgresql@16 && brew services start postgresql@16`.

## 3. Create user accounts

Each tech gets an account. In Supabase:

1. **Auth → Users → Invite user** — enter their email. They receive a magic-link to set their password.
2. Copy their **UUID** from the Auth users table.
3. In SQL Editor, run:
   ```sql
   -- A lead: gets their own account and desktop access.
   SELECT create_lia_user(
     'paste-uuid-here',
     'tech@company.com',
     'Tech Name',
     10,          -- import credits on the account (-1 for unlimited)
     NULL,        -- no existing account: create one
     'lead',
     'BTV-0001'   -- their Batavia technician number
   );

   -- A sub-tech under that lead: shares the account and its credits, and has
   -- no Lia Office access. Pass the account id the call above returned.
   SELECT create_lia_user(
     'sub-tech-uuid',
     'sub@company.com',
     'Sub Name',
     0,
     'account-uuid-from-above',
     'tech'
   );
   ```

   The function returns the account id. Re-running it for an existing user is
   safe and will not clear their rep number.

## 4. Adjust credit balances

In **Table Editor → users**, find the user and edit the `credits` column directly.  
`-1` = unlimited, `0` = blocked, any positive number = that many imports left.

## 5. Add Supabase config to Lia

In `config.json` (next to the Lia app), add:

```json
{
  "username": "bsi-username",
  "password": "bsi-password",
  "supabase": {
    "url": "https://your-project.supabase.co",
    "anonKey": "eyJ..."
  }
}
```

The anon key is safe to store here — RLS prevents users from reading or writing other users' data.

## 6. Inspection report website

After running `02_inspections.sql`, build the S3 static site:

1. Open `inspection-site/index.html`
2. Replace `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` with your values
3. Upload `index.html` to an S3 bucket with static website hosting enabled
4. Share the S3 website URL — anyone with the link can look up ladders by serial number

To add an inspection record from the Supabase dashboard:
**Table Editor → inspections → Insert row**
