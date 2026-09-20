// Invite somebody, from Lia Office.
//
// Creating a Supabase auth user needs the service-role key — the one that can
// read and rewrite every company's records. It is NOT in the desktop app and
// must never be: anyone with the installer could extract it. It lives here,
// injected by Supabase at runtime, and this function is the only thing that
// holds it.
//
// What this does, in order, refusing at the first thing that fails:
//
//   1. identifies the CALLER from their own token (never from the body)
//   2. checks they are an active lead — and, for a subcontractor, the umbrella
//   3. creates the auth user and sends them the invite email
//   4. places them: a tech on the caller's account, or a new subcontractor
//      account beneath it
//
// Step 4 is done here rather than by calling the ordinary RPCs, because those
// derive the account from auth.uid() and the service role has none. Every check
// they make is repeated above, explicitly.
//
// Deploy:  supabase functions deploy invite-user
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Not authenticated' }, 401);

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

  // ── 1. Who is asking ──────────────────────────────────────────────────────
  // From the token itself. A body that claimed a user id would be a way to
  // invite people into somebody else's company.
  const { data: caller, error: whoErr } = await admin.auth.getUser(auth.replace('Bearer ', ''));
  if (whoErr || !caller?.user) return json({ error: 'Not authenticated' }, 401);
  const callerId = caller.user.id;

  let body: Record<string, string> = {};
  try { body = await req.json(); } catch { /* handled below */ }

  const email = String(body.email ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim();
  const kind = body.kind === 'subcontractor' ? 'subcontractor' : 'crew';
  const repNumber = String(body.rep_number ?? '').trim();
  const credits = Number.isFinite(Number(body.credits)) ? Number(body.credits) : 0;

  if (!email || !email.includes('@')) return json({ error: 'A valid email address is required.' }, 400);

  // ── 2. May they? ──────────────────────────────────────────────────────────
  const { data: member } = await admin
    .from('account_members')
    .select('account_id, role, removed_at')
    .eq('user_id', callerId)
    .is('removed_at', null)
    .maybeSingle();

  if (!member) return json({ error: 'No account — contact your administrator' }, 403);
  if (member.role !== 'lead') return json({ error: 'Only a lead can invite people.' }, 403);

  if (kind === 'subcontractor') {
    if (!name) return json({ error: 'A company name is required: it is what the account is called.' }, 400);
    if (!repNumber) {
      return json({ error: 'Their technician number is required: it is what the certificate names.' }, 400);
    }
    const { data: acct } = await admin
      .from('accounts').select('parent_account_id').eq('id', member.account_id).maybeSingle();
    if (acct?.parent_account_id) {
      return json({ error: 'Only the umbrella account can take on subcontractors. Add a crew member instead.' }, 403);
    }
  }

  // Already known? Then this is a placement question, not an invitation, and
  // moving somebody who has records is a data migration — refused, as in the
  // ordinary path.
  const { data: existingMember } = await admin
    .from('users').select('id').eq('email', email).maybeSingle();

  let userId = existingMember?.id as string | undefined;
  let invited = false;

  if (!userId) {
    const { data: created, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: name ? { name } : undefined,
    });
    if (inviteErr || !created?.user) {
      // Supabase's own words: "email rate limit exceeded" when SMTP is not
      // configured, "User already registered" when they exist in auth but not
      // in our tables.
      return json({ error: inviteErr?.message ?? 'Could not send the invitation.' }, 400);
    }
    userId = created.user.id;
    invited = true;
  }

  const { data: placed } = await admin
    .from('account_members').select('account_id, removed_at').eq('user_id', userId).maybeSingle();

  if (placed && placed.account_id !== member.account_id) {
    return json({ error: 'That person already belongs to an account. Moving them is a data migration, not an invitation.' }, 409);
  }

  // ── 4. Place them ─────────────────────────────────────────────────────────
  await admin.from('users').upsert(
    { id: userId, email, name: name || null, credits: 0 },
    { onConflict: 'id' },
  );

  if (kind === 'crew') {
    if (placed) {
      // A rehire: the same membership comes back, so their old work stays theirs.
      await admin.from('account_members')
        .update({ removed_at: null, removed_by: null, removed_reason: null })
        .eq('user_id', userId);
    } else {
      const { error } = await admin.from('account_members').insert({
        user_id: userId, account_id: member.account_id,
        role: 'tech', desktop_access: false, rep_number: null, invited_by: callerId,
      });
      if (error) return json({ error: error.message }, 400);
    }
    return json({ ok: true, invited, user_id: userId, account_id: member.account_id, kind: 'crew' });
  }

  // A subcontractor: their own account, beneath the caller's.
  if (placed) return json({ error: 'That person already belongs to an account.' }, 409);

  const { data: account, error: acctErr } = await admin
    .from('accounts')
    .insert({ name, credits, parent_account_id: member.account_id })
    .select('id').single();
  if (acctErr || !account) return json({ error: acctErr?.message ?? 'Could not create the account.' }, 400);

  const { error: memErr } = await admin.from('account_members').insert({
    user_id: userId, account_id: account.id,
    role: 'lead', desktop_access: true, rep_number: repNumber, invited_by: callerId,
  });
  if (memErr) return json({ error: memErr.message }, 400);

  return json({ ok: true, invited, user_id: userId, account_id: account.id, kind: 'subcontractor', name, rep_number: repNumber });
});
