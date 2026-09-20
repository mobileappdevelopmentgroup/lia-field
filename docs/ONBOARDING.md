# Onboarding people

Who can be added, by whom, and what each one sees. The structure this describes
is `supabase/migrations/18_umbrella_accounts.sql`.

---

## The shape

```
Batavia  (umbrella — holds the contracts, sees everything)
├── Nate Dobbs      lead subcontractor · Pennsylvania · tech no. 763
│   └── crew        field people who report to Nate
└── Michael Dobbs   lead subcontractor · California   · tech no. 738
    └── crew        field people who report to Michael
```

Three rules follow from it, and everything else is detail:

- **Work flows up.** Batavia reads every record its subcontractors produce.
- **Nothing flows sideways.** Nate cannot see Michael's work, techs, jobs, tags
  or work orders, and vice versa. They are separate accounts; the database
  enforces it, not the interface.
- **The catalogue flows down.** Equipment types and models defined by Batavia
  are usable by everyone beneath it. A subcontractor's own entries stay theirs.

**On a certificate:** Batavia as the organisation standing behind the
inspection, and the **lead subcontractor** for that area as the technician —
never the person who physically took the reading. Who did the work *is*
recorded, and the office can see it; it just never reaches the customer.
(`19_certificate_attribution.sql` — written and rehearsed; until it is applied
to the live database, the public certificate still shows the collector's name.)

---

## Adding a lead subcontractor

You do this. It is a new company under the umbrella.

**In Lia Office → Subcontractors → Take on a subcontractor.** Their lead's
email, the company name, and their technician number. Credits are billed to
them: `0` blocks imports until you set a balance, `-1` is unlimited.

The screen lists every company under you with its number, how many people are
on it, how much work has come back, and an **Act as** button.

It refuses — in the server's own words — if you are not the umbrella, if you are
acting as somebody, if the number is missing, or if that person already belongs
to an account. The last one is deliberate: moving somebody who already has
records is a data migration, not an invitation.

**Or from SQL**, which is what the screen calls:

```sql
SELECT public.create_subcontractor(
  '<their auth.users uuid>',
  'them@example.com',
  'Their Company',            -- the account name; the company, not the person
  '738',                      -- their Batavia technician number
  '<Batavia account id>'      -- the umbrella they hang under
);
```

It returns their new account id. The call refuses without a technician number,
because that number is what the certificate names; it refuses a uuid that is
not in `auth.users`, because such a user can sign in and then sees
*"No account — contact your administrator"*.

They get `role = lead`, desktop access, and a **fresh, empty account**: their
own assets, work orders, jobs and tags. They inherit the shared catalogue
(the fourteen equipment types) and anything Batavia has defined.

**3. Credits.** New accounts start at `0`, which blocks imports. Set the balance
deliberately — `-1` is unlimited:

```sql
UPDATE public.accounts SET credits = -1 WHERE id = '<their account id>';
```

Subcontractors are billed on their own account, so this is a per-company
decision, not something to inherit by accident.

**4. Give them the apps.**
- Android: Play Console → Lia Field → Internal testing → **Testers**, add the
  Google account email they will install with.
- iPhone: TestFlight invite for the same address.
- Lia Office: the macOS DMG or the Windows installer.

**5. Tell them to sign in with signal.** The first launch downloads the
catalogue and will not let them start without it.

---

## Adding a field person to a crew

**The lead does this for their own people.** A field person is a `tech` in
their lead's account: they inherit the catalogue, their work counts toward that
account, and they carry **no technician number of their own** — the certificate
names their lead.

**In Lia Office → Your Crew → Invite a field person.** Their email and name.
They get an invitation, set their own password, and appear on the list. Nobody
needs a Supabase login — see `docs/INVITE-FUNCTION.md` for how that works and
why the key is not in the app.

While you are acting as a subcontractor, this adds **their** crew — the title
says whose — and `invited_by` still records that it was you.

**Or from SQL**, which is what the screen calls:

```sql
SELECT public.add_crew_member('{
  "user_id": "<their auth.users uuid>",
  "email":   "them@example.com",
  "name":    "Their Name"
}'::jsonb);
```

It refuses if the caller is not a lead, and adds them to the caller's own
account — a lead cannot put somebody into another company's crew even by
passing the wrong id, because the account is taken from who is calling.

They get no desktop access. Field people use the phone app.

---

## Acting as a subcontractor

You can work *inside* a subcontractor's account — to show a new lead how the job
is done, or to see exactly what they see when they call about a problem.

**In Lia Office:** the home screen shows **Act as a Subcontractor** (only if the
server says you may). Pick the company, type why, choose how long. From then on
an orange bar across the top says whose account you are in and how long is left,
with a **Stop** button. The credit badge switches to **their** balance, because
an import now bills them.

Starting or stopping clears every screen you had open. That is deliberate:
another company's rows left on screen, with writes going somewhere else, is the
mistake this whole design exists to prevent.

**Or from SQL**, which is what the screen calls:

```sql
SELECT public.start_impersonation('{
  "account_id": "<their account id>",
  "reason":     "showing Michael how a job is recorded",
  "minutes":    60
}'::jsonb);

SELECT public.my_context();      -- whose account am I in, and until when
SELECT public.stop_impersonation();
```

While a session runs, everything behaves as that subcontractor: what you can
read, what you record, which catalogue you pull, which account is billed.
There is no second code path, which is the point — you are exercising theirs.

**The home screen becomes theirs, too.** Anything they do not have is greyed
out rather than hidden — a subcontractor has no *Subcontractors* screen, so the
card stays visible, disabled, and says whose limitation it is. Hiding it would
look like a fault; greying it shows you what they see and why.

The rules:

- **Downward only.** You can act as an account beneath yours. Never a sibling,
  never upward. A subcontractor can never act as anybody, and an active session
  cannot be used to start another — the permission is always checked against
  your *real* account.
- **Leads only.** A field person cannot.
- **It expires.** 60 minutes by default, 8 hours at most. A forgotten session is
  the dangerous one: it writes a customer's certificate into the wrong company.
- **It is recorded.** Every session is a permanent row — who acted, as whom, why,
  and for how long — and every record written under one points back at it. The
  certificate names their lead (correct: the work was done on their behalf),
  while the office can always see that you were the one holding the phone.

**What does not follow the session**, for now: catalogue authoring and tag
links. Editing a catalogue while acting as somebody writes to *your* catalogue.
Do that work signed in as yourself. Support tickets deliberately stay yours —
a ticket is from the person who wrote it.

## Removing somebody

**Your Crew → Remove**, and it asks first.

Removal ends **access**, not history. Their next sync is refused, every screen
closes to them at once, and **everything they recorded stays exactly as it is** —
the inspections, the certificates, and their name on them as the person who
collected the work. A certificate issued in March was true in March.

They stay on the crew list, marked with the date and reason, because the office
still needs to answer "who was on this account last spring". **Put back**
restores the same membership, so a rehire does not split one person's work
across two accounts.

**A lead cannot be removed here.** Their number is the responsible technician on
every certificate their account issues, so removing them would leave the next
one with nobody to name. Replacing a lead is a separate, deliberate job.

## Who sees what

| | their own work | their crew's | a sibling company's | the umbrella's |
|---|---|---|---|---|
| Batavia (umbrella) | ✅ | ✅ | ✅ — everyone's | ✅ |
| Batavia, acting as a sub | — | as them | ❌ | ❌ |
| Lead subcontractor | ✅ | ✅ | ❌ | ❌ |
| Field person | ✅ | ✅ (same account) | ❌ | ❌ |

Two deliberate exceptions:

- **Support tickets are not shared upward.** A ticket is a conversation with the
  developer. The umbrella reading its subcontractors' support threads would be a
  separate decision, and nobody has made it.
- **Peer visibility inside an account** is its own setting (`share_peer_work` on
  a job). Being in the same account does not automatically mean seeing each
  other's rows on a job.

---

## Things that go wrong

**Somebody was created in the wrong account.** Fix it before they record
anything. A membership move does not move records — those carry their own
`account_id` — so once they have inspections, moving them is a data migration,
not an update. `create_subcontractor` deliberately will not relocate an account
that already exists.

**A lead with no technician number.** Their certificates fall back to whatever
the account's lead resolves to. `create_subcontractor` refuses to create one;
check with:

```sql
SELECT u.email, m.role, m.rep_number, a.name AS account, a.parent_account_id
  FROM public.account_members m
  JOIN public.users u ON u.id = m.user_id
  JOIN public.accounts a ON a.id = m.account_id
 ORDER BY a.name, m.role;
```

Every `lead` row must have a number. Every `tech` row should have none.

**Two leads in one account.** That is the one shape this model does not want:
the responsible technician becomes ambiguous and both crews' work lands in one
pot. A second lead means a second account under the umbrella.

**An account with no parent** is an island: nobody above sees it. That is
correct for the umbrella itself and wrong for everybody else.
