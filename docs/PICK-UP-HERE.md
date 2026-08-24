# Pick up here — 2026-08-24

Everything that happened today, what is verified, and the one decision waiting
for you. Written to be read cold.

---

## The migrations are applied. The leak is closed.

The thing that blocked the whole project for weeks is done. Verified from
outside the database with the public key, after the fact:

| Check | Before | Now |
|---|---|---|
| `inspections` via publishable key | 200, **1,724 rows exposed** | **401 `42501`** |
| `accounts` / `work_orders` / `assets` / `fp_inspections` | 404 (absent) | 401 (exist, RLS enforced) |
| `ladder_inspections_public` | 1,724 | **1,724** — nothing lost |
| `app_settings.certificate_base_url` | — | `https://lia.mobileappdevelopmentgroup.com` |
| A real certificate URL | — | `/?t=RTPTXK9PJK` → **200** |

The `🔴 HIGH` security TODO in `CLAUDE.md` that had been open since 2026-07-29
is now genuinely closed, not just recorded as closed.

### What the consolidation did

Route B, not Route A — the reset would have destroyed 1,724 live certificates,
1,619 of them Nate's fieldwork. See `docs/APPLY-MIGRATIONS.md`.

- One account: `265882ec-0c13-44ef-9648-4b0a73375bf5`, named **Batavia**
- 1,724 inspections adopted, 0 ownerless, 0 assetless
- `credits = -1` (unlimited) preserved — `bool_or(credits = -1)` kept it rather
  than summing it down to a number
- Nate's old account (`6286776e-…`) removed

> The UUID `6286776e-97ac-4b88-8b6c-e250679dfce5` that caused three failed
> attempts was **Nate's account id**, not a user id. Real user ids:
> you `a8738ff3-412e-4369-8298-6fc37aa9a1b2`,
> Nate `d7bdb210-ae3d-4560-8de0-49ea73d09d80`.

---

## ⚠️ The open decision: rep numbers do not scale to more importers

**This is the thing to look at tonight.** More people are going to be importing,
and the current model gives all of them the same rep number.

`record_inspection` stamps the responsible rep from the **account's lead**, not
from the person who did the work (`supabase/05_rep_and_attribution.sql:74-76`):

```sql
-- Responsible rep comes from the account's lead, never from the payload: a
-- sub-tech's device must not be able to claim a different rep number.
v_rep := public.account_rep_number(v_account);
```

and `account_rep_number()` filters `role = 'lead'`. So with three techs
importing, **every certificate all three produce names one person**. Who
actually did the work is recorded (`collected_by`, `collector_name`,
`tech_name`) but is deliberately not exposed on the public certificate.

### Two coherent models

**A — one responsible rep per company (what is built).** A licensed contractor
signs off on crew work. Correct if BTV-0001 identifies Batavia's certifying
authority rather than a person.

**B — the inspector is the rep.** Each tech carries their own number and the
certificate names whoever inspected that ladder. Correct if BTV-xxxx is a
per-person technician ID — which is how they were assigned today.

**Recommendation: B**, if a customer reading a certificate should be able to
identify who actually inspected their equipment. It is a small change and keeps
the anti-spoofing property — the rep still comes from the database row for that
user, never from the device payload:

```sql
v_rep := coalesce(
  (SELECT rep_number FROM account_members WHERE user_id = v_user_id),
  public.account_rep_number(v_account));   -- fall back to the lead
```

Not written yet. It would be `supabase/11_per_tech_rep.sql` plus assertions.
Cheaper now than after certificates are printed and tagged — `rep_number` is
snapshotted onto each inspection at write time.

⚠️ **Under model B, every importer needs a rep number before their first
import** or they silently inherit the lead's. Make it part of onboarding.

---

## Adding more importers — works today

Nothing gates importing. `preflight_work_order` and `charge_work_order` check
only that you are authenticated and have an account. No role check.

```sql
SELECT create_lia_user(
  '<their-auth-uuid>',                        -- from auth.users after they sign up
  '<their-email>', '<Their Name>',
  0,                                          -- credits ignored; account balance is authority
  '265882ec-0c13-44ef-9648-4b0a73375bf5',     -- Batavia. Omit this and they get
                                              -- their own isolated account —
                                              -- invisible to merge and billing.
  'tech',
  '<BTV-xxxx>'                                -- required under model B
);
```

### `desktop_access` is documented but unenforced

`03_accounts_billing.sql:31` says `desktop_access = false` "keeps them out of
Lia Office entirely." **Nothing implements that** — not `preflight_work_order`,
not `charge_work_order`, not the Electron app. It is stored, returned by
`get_my_profile`, and otherwise inert.

So a sub-tech can use Lia Office today. Either enforce it or correct the
comment; right now the schema promises a control that does not exist.

### Who is what, as of tonight

Set so that Nate — who does the actual fieldwork — is the responsible
technician, and the developer account never appears on a customer certificate:

| | role | desktop_access | rep_number |
|---|---|---|---|
| Nate (`nathandobbs@me.com`) | `lead` | true | BTV-0001 |
| You (`hectorahinojosa@gmail.com`) | `tech` | true | **NULL** |

Your `rep_number` is deliberately NULL: `account_rep_number()` skips non-leads
and nulls, so you can never be stamped as responsible for an inspection you did
not perform.

---

## Also done today

- **TestFlight build 3** uploaded, VALID, export compliance answered, live to
  internal testers.
- **Domain move.** `lia.mobileappdevelopmentgroup.com` serves the certificate
  site, `/fp/`, the privacy policy and the data-deletion page. ACM cert +
  CloudFront alias + Route 53. The old cloudfront.net address still works.
- **`/fp/` deployed** — it had never been uploaded, so every fall-protection
  certificate URL the database generates would have 404'd. No FP inspections
  exist yet, so nothing was broken in the field. Now returns 200.
- **Data deletion page** — Play's Data safety form requires a deletion URL and
  the policy only offered an email address.
- **Store declarations** filed on both stores.
- **`DEVIATIONS.md` item 1 decided** — no pass/fail override in the merge UI.

### Two things the build 3 upload uncovered

1. The regenerated provisioning profile was **`MAC_APP_STORE`**
   (`.provisionprofile`) — cannot sign an iOS app, no NFC entitlement. The
   correct `IOS_APP_STORE` profile, "Lia Field App Store NFC", was created via
   the ASC API and is what `ExportOptions.plist` names.
2. **`NDEF` is no longer a legal NFC entitlement format.** Apple rejected the
   first upload: *"sdk version '26.2' and min OS version '15.0' are not
   compatible … 'NDEF is disallowed'"*. `App.entitlements` now declares `TAG`.

⚠️ The plugin uses `NFCNDEFReaderSession`. **Whether it still reads NDEF tags
under a `TAG`-only entitlement is unverified.** Make it the first thing hardware
testing checks.

---

## Still outstanding

1. **The rep-number decision above.** Everything else is mechanical.
2. **A BSI work order that can be dirtied** — the L/C/V/P checkbox selectors,
   and *how BSI identifies an aggregate fall-protection box*. Ladder boxes key
   off the serial; an FP box has none, so a re-run adds a second box and
   double-bills the customer. Still the only unanswered design question.
3. **NFC hardware testing** — `docs/NFC-PLUGIN.md`, plus the `TAG` question.
4. **Windows** — code-signing cert, and a first NSIS build. Never built once,
   cannot be built from macOS.
5. **Push the branch** — 49 commits, local only, needs the
   `mobileappdevelopmentgroup` account.
6. **Build and verify Lia Office**: `npm run electron:build`. Confirm by hand
   that cancelling at the diff card is free, a completed import charges one
   credit, a repeat work order charges nothing, and an empty work order box is
   refused before Chrome opens.

⚠️ **You cannot verify billing on this account.** `credits = -1` is unlimited,
so no work order will ever charge. Testing the one-token-per-work-order
behaviour needs an account with a finite balance.
