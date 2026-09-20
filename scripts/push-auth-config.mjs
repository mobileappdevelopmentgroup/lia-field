#!/usr/bin/env node
// Point Supabase Auth at Amazon SES, and upload the email templates.
//
//   SUPABASE_ACCESS_TOKEN=sbp_... \
//   SES_SMTP_USER=AKIA... SES_SMTP_PASS=... \
//   node scripts/push-auth-config.mjs
//
//   ... --dry-run     show what would be sent, change nothing
//
// Why this exists: Supabase's built-in SMTP is for development — a handful of
// messages an hour, shared infrastructure, and it starts refusing with "email
// rate limit exceeded". Invitations are the app's front door for people who
// have no other way in, so they cannot ride on that.
//
// SECRETS COME FROM THE ENVIRONMENT AND ARE NEVER WRITTEN DOWN. Nothing here is
// stored in the repo, printed, or echoed back — the script reports only which
// fields it set. The SMTP password is an SES credential; anyone holding it can
// send mail as this domain.
import { readFile } from 'node:fs/promises';

const PROJECT_REF = 'bqoxpbjtqwicurmuxueq';

// SES in the same region the scheduler project already sends from.
const SES_REGION = process.env.SES_REGION || 'us-east-1';
const SENDER     = process.env.LIA_SENDER_EMAIL || 'lia@mobileappdevelopmentgroup.com';

const dry = process.argv.includes('--dry-run');
const token = process.env.SUPABASE_ACCESS_TOKEN;
const user  = process.env.SES_SMTP_USER;
const pass  = process.env.SES_SMTP_PASS;

const missing = [
  !token && 'SUPABASE_ACCESS_TOKEN (supabase.com → Account → Access Tokens)',
  !user  && 'SES_SMTP_USER (SES → SMTP settings → Create SMTP credentials)',
  !pass  && 'SES_SMTP_PASS (shown once, when those credentials are created)',
].filter(Boolean);

if (missing.length && !dry) {
  console.error('Missing:\n  ' + missing.join('\n  '));
  console.error('\nSee docs/INVITE-FUNCTION.md. Nothing was changed.');
  process.exit(1);
}

const SITE = 'https://lia.mobileappdevelopmentgroup.com/set-password.html';

const dir = new URL('../supabase/email-templates/', import.meta.url);
const body = {
  // ── Where a verified link lands ───────────────────────────────────────────
  // The default is http://localhost:3000, which is what every invitation sent
  // before 2026-09-20 pointed at: the token was spent, the account was created,
  // and the person saw "this site can't be reached" with no way back.
  site_url: SITE,
  // Redirects are allow-listed. Without the entry, Supabase silently falls back
  // to site_url — which works here, but only by accident.
  uri_allow_list: [
    SITE,
    'https://lia.mobileappdevelopmentgroup.com/**',
  ].join(','),

  // ── SES ───────────────────────────────────────────────────────────────────
  // Port 587 with STARTTLS: 465 is implicit TLS, which Supabase's mailer does
  // not use, and 25 is blocked by most providers.
  smtp_host: `email-smtp.${SES_REGION}.amazonaws.com`,
  smtp_port: '587',      // the API wants a string here, not a number
  smtp_user: user,
  smtp_pass: pass,
  smtp_admin_email: SENDER,
  smtp_sender_name: 'Lia',

  // The built-in limit is set for the built-in mailer. With SES behind it, the
  // ceiling that matters is SES's own send rate, not this.
  rate_limit_email_sent: 100,

  // 24 hours, up from the default hour. A tech reads the invitation in the
  // evening and sets a password the next morning; an hour makes that a support
  // call, and re-inviting is the lead's time as well as theirs.
  mailer_otp_exp: 86400,

  // ── Templates ─────────────────────────────────────────────────────────────
  mailer_subjects_invite: 'You have been added to Lia',
  mailer_templates_invite_content: await readFile(new URL('invite.html', dir), 'utf8'),
  mailer_subjects_recovery: 'Your link to set a password for Lia',
  mailer_templates_recovery_content: await readFile(new URL('reset-password.html', dir), 'utf8'),
};

if (dry) {
  console.log('Would PATCH project', PROJECT_REF, 'with:');
  Object.entries(body).forEach(([k, v]) => {
    const shown = k === 'smtp_pass' ? '(from SES_SMTP_PASS, not shown)'
                : k === 'smtp_user' ? (user ? '(from SES_SMTP_USER, not shown)' : '(unset)')
                : typeof v === 'string' && v.length > 60 ? `${v.length} bytes of HTML`
                : v;
    console.log(`  ${k}: ${shown}`);
  });
  process.exit(0);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error(`Failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const cfg = await res.json();
console.log('Auth email is now sent through SES.');
console.log('  host    :', cfg.smtp_host, 'port', cfg.smtp_port);
console.log('  sender  :', cfg.smtp_sender_name, '<' + cfg.smtp_admin_email + '>');
console.log('  invite  :', cfg.mailer_subjects_invite);
console.log('  recovery:', cfg.mailer_subjects_recovery);
console.log('\nSend one to yourself from Lia Office → Your Crew before telling anybody it works.');
