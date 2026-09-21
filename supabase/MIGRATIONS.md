# The database, in one page

Where to look, depending on the question:

| Question | File |
|---|---|
| What shape is the database in *now*? | **`schema.sql`** — every table, view, function, policy and grant, generated |
| What changed, when, and why? | the table below, then the migration's own header |
| How do I change the live database? | write the next numbered migration, paste it into the Supabase SQL editor |

`schema.sql` is **generated** by `./supabase/tools/schema-snapshot.sh` from the
migrations, so it cannot drift from what the SQL actually produces.
`--check` fails if it is stale. It is for reading, not for applying: a dump
cannot be pasted at a database that already holds 1,724 certificates.

**The migrations are not leftovers.** They are the only way the live database
is changed, all nineteen SQL test files build from them, and several later ones
are extracted from earlier ones. Deleting an applied migration breaks the test
suite and the only path to rebuilding the database from nothing.

---

## Applied to the live database

**01–17** landed between June and 2026-08-30. **18–23** on 2026-09-19/20.
**24** on 2026-09-21.

| | What it did |
|---|---|
| `01_licensing` | users, credits, the usage log |
| `02_inspections` | ladder inspections, and the public certificate view |
| `03_accounts_billing` | accounts, members, work orders — one charge per work order |
| `04_inspections_v2` | versioned inspections that supersede rather than overwrite; account-scoped policies replacing `USING (true)` |
| `05_rep_and_attribution` | the responsible rep, and who actually collected the record |
| `06_fall_protection` | fall-protection items, checklists, photos |
| `07_fp_status` | the derived pass / fail / overdue status |
| `08_device_snapshot` | what the phone pulls down to work offline |
| `09_fp_authoring` | editing checklists from the office |
| `10_consolidate_account` | **optional, one-off** — merges several accounts into one. Not in any bundle |
| `11_fp_equipment_types` | the fourteen standard types; the checklist belongs to the type, not the model |
| `12_tag_links` | tags that link into somebody else's system |
| `13_support` | in-app tickets and the developer's inbox |
| `14_certificate_views` | who is reading certificates, with no IP stored |
| `15_fp_records` | correcting records from the office; pushing them to BSI |
| `16_assignments` | the job board |
| `17_tag_write` | writing our own tags; five identifiers reaching one record |
| `18_umbrella_accounts` | accounts gain a parent. Work flows up, catalogue flows down |
| `19_certificate_attribution` | the certificate names the lead and the umbrella — and stops publishing the field person's name |
| `20_impersonation` | the office can act as a subcontractor: expiring, recorded, downward only |
| `21_impersonation_write_paths` | the write paths follow that session — without it, work lands in the wrong account and looks fine |
| `22_onboarding_rpcs` | crew and subcontractors added from Lia Office; fixes `add_crew_member` putting people in the wrong account |
| `24_field_parts` | a field ladder keeps the parts the tech tapped, so the office can import its work into BSI |
| `23_crew_removal` | removing somebody ends access and keeps their work; rehiring restores the same membership |

## Where things are

```
supabase/
  schema.sql        generated — the whole database in one file
  MIGRATIONS.md     this page
  README.md         how to run things against Supabase
  migrations/       01–22, the only way the live database is changed
  test/             the suite that builds a database from those and asserts it
  ops/applied/      one-off provisioning already run against real accounts
  tools/            schema-snapshot.sh
  build-combined.sh makes a paste-able bundle in dist/ (generated, uncommitted)
```

## The rest of this folder

- **`test/`** — `run.sh` applies every migration to a throwaway database and
  asserts behaviour (610 assertions). `run-apply-18-22.sh` rehearses a live
  paste against a production-shaped database.
- **`ops/applied/`** — one-off provisioning that has already been run, kept
  because it records what happened to real accounts on a real day.
- **`tools/schema-snapshot.sh`** — regenerates `schema.sql`.
- **`build-combined.sh`** — concatenates migrations into a paste-able bundle in
  `dist/`, which is **generated and not committed**. Build one when you need it;
  a bundle kept around goes stale and re-runs history at a database that has
  moved on.
- **`dist/reset-and-install.sql`** — ⚠️ the destructive route. It **drops the
  inspection data**. Only ever appropriate for a genuinely empty project; see
  `docs/APPLY-MIGRATIONS.md` for why Route B was used instead.
