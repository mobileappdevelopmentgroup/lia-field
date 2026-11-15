// Training and test accounts, from Lia Office (developer only). Migration 41.
//
// Creating and deleting logins needs the service-role key, so this lives here
// for the same reason invite-user does: the key must never be inside an
// installer. The caller is identified from their own token, never the body,
// and must be a developer (users.is_developer). The database functions it
// calls repeat that check against the caller id passed to them, and are
// executable by service_role only.
//
// Actions (POST JSON):
//   { action: 'create', name, expires_days?, bsi_work_orders?: string[], techs?: 1–30 }
//       → a training umbrella + crew, one office login (lead on the umbrella),
//         one crew lead, and `techs` tech logins. Returns every password ONCE;
//         they are not stored anywhere.
//   { action: 'erase', account_id }
//       → deletes every row (training_erase), then the photos under each
//         account id in fp-photos, then the generated logins. Anything left
//         half-done is recorded and finished by the next 'finish'.
//   { action: 'finish' }
//       → completes every half-finished erase.
//
// Generated logins are t-<code>-NN@training.mobileappdevelopmentgroup.com.
// Nothing is mailed to them (email_confirm: true), and they are the only
// auth users this function will ever delete.
//
// Deploy:  npx supabase functions deploy training-accounts --project-ref bqoxpbjtqwicurmuxueq
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DOMAIN = 'training.mobileappdevelopmentgroup.com';
const BUCKET = 'fp-photos';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Unambiguous characters only: these are read off a printed card.
const ALPHA = 'abcdefghjkmnpqrstuvwxyz';
const DIGIT = '23456789';
function pick(set: string, n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => set[x % set.length]).join('');
}
// e.g. "kmrt-4829-pxq" — 12 random characters, about 54 bits.
const password = () => `${pick(ALPHA, 4)}-${pick(DIGIT, 4)}-${pick(ALPHA, 4)}`;

async function rpc(admin: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

async function removePhotos(admin: SupabaseClient, accountIds: string[]): Promise<number> {
  let removed = 0;
  for (const id of accountIds) {
    // List the folder until it is empty; remove() takes full paths.
    for (let guard = 0; guard < 200; guard++) {
      const { data, error } = await admin.storage.from(BUCKET).list(id, { limit: 100 });
      if (error) throw new Error(`photos: ${error.message}`);
      if (!data || data.length === 0) break;
      const paths = data.map((o) => `${id}/${o.name}`);
      const { error: rmErr } = await admin.storage.from(BUCKET).remove(paths);
      if (rmErr) throw new Error(`photos: ${rmErr.message}`);
      removed += paths.length;
    }
  }
  return removed;
}

async function deleteLogins(admin: SupabaseClient, userIds: string[]): Promise<number> {
  let deleted = 0;
  for (const id of userIds) {
    const { data: u } = await admin.auth.admin.getUserById(id);
    if (!u?.user) continue;                       // already gone: a retry
    if (!String(u.user.email ?? '').toLowerCase().endsWith('@' + DOMAIN)) continue;  // never anybody real
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw new Error(`login ${u.user.email}: ${error.message}`);
    deleted++;
  }
  return deleted;
}

async function finishErasure(admin: SupabaseClient, actor: string,
                             e: { erasure_id: string; account_ids: string[]; user_ids: string[] }) {
  const photos = await removePhotos(admin, e.account_ids ?? []);
  const logins = await deleteLogins(admin, e.user_ids ?? []);
  await rpc(admin, 'training_erase_finished', { p_actor: actor, p_erasure: e.erasure_id });
  return { photos, logins };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Not authenticated' }, 401);

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

  const { data: caller, error: whoErr } = await admin.auth.getUser(auth.replace('Bearer ', ''));
  if (whoErr || !caller?.user) return json({ error: 'Not authenticated' }, 401);
  const actor = caller.user.id;

  const { data: me } = await admin.from('users').select('is_developer').eq('id', actor).maybeSingle();
  if (!me?.is_developer) return json({ error: 'Only the developer can manage training accounts.' }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const action = String(body.action ?? '');

  try {
    if (action === 'create') {
      const techs = Math.max(1, Math.min(30, Number(body.techs ?? 3) | 0));
      const created = await rpc(admin, 'training_create', {
        p_actor: actor,
        p: {
          name: String(body.name ?? ''),
          expires_days: body.expires_days ?? 14,
          bsi_work_orders: Array.isArray(body.bsi_work_orders) ? body.bsi_work_orders : [],
        },
      }) as { account_id: string; crew_account_id: string; name: string; expires_at: string; preview_token: string };

      const code = pick(ALPHA + DIGIT, 4);
      const plan = [
        { account_id: created.account_id, role: 'lead', name: 'Training office' },
        { account_id: created.crew_account_id, role: 'lead', name: 'Training lead' },
        ...Array.from({ length: techs }, (_, i) =>
          ({ account_id: created.crew_account_id, role: 'tech', name: `Trainee ${i + 1}` })),
      ];

      const logins: Array<Record<string, string>> = [];
      try {
        for (let i = 0; i < plan.length; i++) {
          const p = plan[i];
          const email = `t-${code}-${String(i + 1).padStart(2, '0')}@${DOMAIN}`;
          const pw = password();
          const { data: u, error } = await admin.auth.admin.createUser({
            email, password: pw, email_confirm: true, user_metadata: { name: p.name, training: true },
          });
          if (error || !u?.user) throw new Error(`creating ${email}: ${error?.message ?? 'no user'}`);
          await rpc(admin, 'training_add_member', {
            p_actor: actor,
            p: { account_id: p.account_id, user_id: u.user.id, role: p.role, name: p.name },
          });
          logins.push({ email, password: pw, name: p.name, role: p.role,
                        where: p.account_id === created.account_id ? 'Office (umbrella)' : 'Crew' });
        }
      } catch (err) {
        // Half a family is worse than none: take it back out.
        try {
          const e = await rpc(admin, 'training_erase', { p_actor: actor, p_account: created.account_id });
          await finishErasure(admin, actor, e);
        } catch { /* left pending; 'finish' completes it */ }
        throw err;
      }

      return json({ ok: true, ...created, logins });
    }

    if (action === 'erase') {
      const accountId = String(body.account_id ?? '');
      if (!accountId) return json({ error: 'account_id is required' }, 400);
      const e = await rpc(admin, 'training_erase', { p_actor: actor, p_account: accountId }) as
        { erasure_id: string; name: string; account_ids: string[]; user_ids: string[]; rows_deleted: unknown };
      try {
        const done = await finishErasure(admin, actor, e);
        return json({ ok: true, name: e.name, rows_deleted: e.rows_deleted, ...done });
      } catch (err) {
        return json({ ok: false, partial: true, name: e.name, rows_deleted: e.rows_deleted,
                      error: `Records erased, but ${String((err as Error).message)}. Run Finish to complete it.` }, 207);
      }
    }

    if (action === 'finish') {
      const pending = await rpc(admin, 'training_pending_erasures', { p_actor: actor }) as
        Array<{ erasure_id: string; account_ids: string[]; user_ids: string[] }>;
      let photos = 0, logins = 0;
      for (const e of pending ?? []) {
        const r = await finishErasure(admin, actor, e);
        photos += r.photos; logins += r.logins;
      }
      return json({ ok: true, finished: (pending ?? []).length, photos, logins });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 400);
  }
});
