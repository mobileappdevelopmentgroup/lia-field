# Training and test accounts

For demos, for training techs before they touch a real job, and for
reproducing a problem. Built 2026-11-15 (migration 41, Edge Function
`training-accounts`, Lia Office 1.15.12+, Lia Field with `training.js`,
certificate site preview mode).

## What one is

A training **umbrella** (like Batavia) with a **crew** beneath it (like a
subcontractor), and generated logins:

| Login | Where | Uses |
|---|---|---|
| Training office | lead on the umbrella | Lia Office: sees the whole family, as Batavia would |
| Training lead | lead on the crew | Lia Office and phone; the certificate names this lead (#TRAIN) |
| Trainee 1…N | tech on the crew | phone |

Logins are `t-<code>-NN@training.mobileappdevelopmentgroup.com` with a
generated password, shown **once** in Lia Office. Nothing is emailed.

It works exactly like a real account. What is different:

- **Never public.** The public certificate views leave training accounts out —
  including a training inspection of a *real* serial, which makes its own
  item and never touches the real certificate (this is what went wrong with
  the September test runs).
- **Certificates by preview link only.** `https://lia.mobileappdevelopmentgroup.com/?preview=<token>`
  shows the family's certificates with a purple TEST bar and a TEST watermark,
  on screen and in print. The phone's purple bar links straight to it. The
  token dies when the account is erased.
- **Never billed.** Unlimited credits.
- **BSI only into its training work order(s).** `preflight_work_order` refuses
  any other number, and Lia Office refuses an import with no work order. The
  trainee signs in to BSI themselves; **parts added to the training work order
  must never be submitted for payment** — ask Batavia to clear or close it
  afterwards.
- **Erasable.** Lia Office → Advanced → Training Accounts → Erase (type ERASE):
  every row, every photo, every generated login. Refuses any account that is
  not a training account, before touching anything.

## Day-to-day

Lia Office (developer login) → **Advanced → Training Accounts**:
name, number of trainees, days to keep (1–90), BSI training work order(s) →
**Create**. Copy the logins. **Copy certificate preview link** for the demo.
**Keep 14 more days** if training runs over. **Erase** when done.

Expiry is a reminder, not an automatic delete: expired families are outlined
on the list. Erase them.

## Deploying

1. Apply the migration: `./supabase/test/run-apply-41.sh` rehearses it and
   writes `supabase/dist/apply-41.sql`; paste that into the Supabase SQL editor.
   Then check from outside with the publishable key (the bundle's header lists
   the five requests and what each must answer).
2. Deploy the function:
   `npx supabase functions deploy training-accounts --project-ref bqoxpbjtqwicurmuxueq`
   (`verify_jwt` on, as for invite-user).
3. Release Lia Office (Training Accounts screen, banner, import guard), the
   phone build (purple bar), and redeploy the certificate site (preview mode).
   Until the site is redeployed, preview links show "No record".

## Why it is built this way

- `is_training` can only be set at creation (trigger). Flipping a real account
  to training would make it erasable; flipping training to real would publish
  practice records.
- Training and real accounts never sit under one another, so an umbrella's
  reports (and Batavia's view) never include training work.
- Creating and deleting logins needs the service role, so it lives in the Edge
  Function; the database functions it calls take the caller id, re-check
  `is_developer`, and are executable by `service_role` only.
- Erase deletes rows first (logins are referenced by `collected_by`), then the
  function deletes photos and logins. A half-finished erase is logged in
  `training_erasures` and completed by **Finish erasing**.
