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

## Email goes through Amazon SES

**Wired 2026-09-20.** Supabase's built-in SMTP is for development — a handful of
messages an hour, then *"email rate limit exceeded"* — and invitations are the
front door for people who have no other way in, so they cannot ride on that.

| | |
|---|---|
| Host | `email-smtp.us-east-1.amazonaws.com:587` (STARTTLS; 465 is implicit TLS, which Supabase's mailer does not speak) |
| Sender | `Lia <lia@mobileappdevelopmentgroup.com>` |
| IAM user | `ses-lia-invites`, allowed **only** `ses:SendRawEmail`/`SendEmail`, and only with `FromAddress = lia@mobileappdevelopmentgroup.com` |
| Credentials | `~/.ses-lia/smtp.env`, mode 600, **outside the repo**. Source it; never paste it |

SES is already in **production access** on this account (50,000/day, 14/sec) and
`mobileappdevelopmentgroup.com` is verified for sending, so no sandbox request
and no per-address verification was needed. The scheduler project sends from the
same domain as `scheduler@` through its own IAM user; the two are separate so
either can be revoked alone.

**An SES SMTP password is not the IAM secret key** — it is derived from it
through a SigV4 HMAC chain ending in `SendRawEmail`. `scripts/push-auth-config.mjs`
never sees the IAM key; the derivation happened once, and only the result is
stored.

### Changing the templates or the sender

`supabase/email-templates/` holds the invitation and the password reset. Push
them, and the SMTP settings, with:

```bash
set -a; . ~/.ses-lia/smtp.env; set +a
SUPABASE_ACCESS_TOKEN=$(security find-generic-password -s 'Supabase CLI' -w)   node scripts/push-auth-config.mjs
```

`--dry-run` prints what would be sent and changes nothing. Secrets are read from
the environment only — never printed, never committed.

### Verifying without emailing anybody

The derived password is the most likely thing to be wrong, and proving it does
not need a test message: open SMTP, STARTTLS, `AUTH LOGIN`, and stop. SES
answers `235 Authentication successful`. That was done after wiring it, and is
worth repeating whenever the credentials are rotated.

## Where the link lands

`https://lia.mobileappdevelopmentgroup.com/set-password.html`
(source: `inspection-site/set-password.html`, deployed with
`aws s3 cp inspection-site/set-password.html s3://batavia-ladder-inspections/set-password.html --content-type "text/html" --cache-control "no-cache"`).

**Every invitation sent before 2026-09-20 was unusable.** The project's Site URL
was still Supabase's default, `http://localhost:3000`, so the verify endpoint
checked the token — spending it — and then redirected to a page on the
recipient's own machine that does not exist. The account was created and the
person saw *"this site can't be reached"* with no way forward.

Three things now stop that recurring:

- `site_url` and `uri_allow_list` point at the real page (`push-auth-config.mjs`)
- the function passes `redirectTo` **explicitly**, so it does not depend on a
  project setting somebody may change
- the page reads the error out of the URL fragment and says what to do — an
  expired or already-used link explains itself instead of showing a blank form

Link lifetime is **24 hours** (`mailer_otp_exp`), up from the default hour: a
tech who reads the email in the evening and sets a password over breakfast
should not need a second invitation.

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
