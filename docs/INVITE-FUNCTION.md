# Inviting people from Lia Office

Subcontractors have no Supabase login, so hiring somebody cannot mean "open the
dashboard and copy a user id". Lia Office sends the invitation itself.

## Why this is an Edge Function and not code in the app

Creating an auth user needs the **service-role key** — the one that can read and
rewrite every company's records, bypassing RLS entirely. It must never be inside
something a customer installs: anyone with the DMG or the .exe could extract it
and read every subcontractor's data.

So the key lives on Supabase's servers, in `supabase/functions/invite-user`.
Lia Office calls that function with the **signed-in user's own token**; the
function works out who is asking from the token — never from the request body —
checks they are an active lead, and only then invites.

The same checks the ordinary RPCs make are repeated there explicitly, because a
service-role connection has no `auth.uid()` for those RPCs to read.

## Deploying it

**Deployed 2026-09-20**, version 1, `verify_jwt: true`. Redeploy after any edit:

```bash
npx supabase functions deploy invite-user --project-ref bqoxpbjtqwicurmuxueq
```

Use **npx, not Homebrew**: `brew install supabase/tap/supabase` fails on this
machine because the Command Line Tools are too old for Homebrew to build
anything, and updating them is a multi-gigabyte Xcode download for no gain. npx
needs nothing installed. Docker is not needed either — the CLI warns that it is
not running and deploys anyway.

The CLI is already authenticated from an earlier session. If that expires,
`npx supabase login` opens a browser.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase at
runtime — nothing to configure, no secret to paste.

Verified after deploying: an unauthenticated POST is refused with
`401 UNAUTHORIZED_NO_AUTH_HEADER` before it reaches any of our code, because
`verify_jwt` is on. Check the rest end to end by inviting yourself at a second
address from **Your Crew**.

## ⚠️ Email delivery will be the first thing that breaks

Supabase's built-in SMTP is for development: a handful of messages per hour,
shared infrastructure, and it will start refusing with *"email rate limit
exceeded"*. That error is passed through to the screen verbatim, so it is
recognisable when it happens.

The fix is custom SMTP: **Supabase → Project Settings → Auth → SMTP Settings**,
pointed at Amazon SES — which is already in use for the scheduler project
(`scheduler@mobileappdevelopmentgroup.com`, IAM user `ses-scheduler-messages`).
A separate IAM user and a `lia@` sender would keep the two apart.

Until that is configured, invitations work but should be treated as
rate-limited: invite a crew one at a time, not fifteen at once.

## What the function will and will not do

| | |
|---|---|
| Invites a **crew member** | Any active lead, into their own account — or, while acting as a subcontractor, into that subcontractor's account |
| Invites a **subcontractor** | The umbrella only. Requires a company name and a technician number, because the number prints on every certificate that company issues |
| Re-invites somebody **already removed** | Treated as a rehire: the same membership comes back, so their history stays in one place |
| Moves somebody **between companies** | **Refused.** Their records carry their own account and do not follow them; moving them is a data migration |
| Invites without a lead role | Refused, 403 |

## If an invitation fails

The screen shows the server's own sentence. The common ones:

- *"email rate limit exceeded"* — Supabase's built-in SMTP. See above.
- *"That person already belongs to an account…"* — they are on another company.
- *"Only the umbrella account can take on subcontractors."* — a subcontractor
  tried to take one on; they hire crew instead.
- *"User already registered"* — they exist in auth but have no Lia profile;
  inviting them again places them without sending a second email.
