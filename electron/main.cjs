'use strict';

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const crypto = require('crypto');
const { fork } = require('child_process');

let mainWindow = null;
let automationChild = null;

// ── Shared CSV column logic ──────────────────────────────────────────────────
// Built from src/core/ by `npm run build:core`. Shared with src/csv-parser.ts so
// the preview shown here and the import that actually runs can never disagree
// about what counts as a part column — they used to, and "[Custom] " fields were
// being searched for as BSI parts.
const { partColumns, parsePartValue, FLAG_COLS, parseFlagValue } = require('../dist/lia-core.cjs');

// ── Path helpers ─────────────────────────────────────────────────────────────

function getRunnerPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'electron-runner.cjs')
    : path.join(__dirname, '..', 'dist', 'electron-runner.cjs');
}

// Playwright's per-platform default browser cache. Lia launches system Chrome
// (channel:'chrome'), so this rarely matters — but pointing it at a macOS-only
// path made the runner unusable on Windows, so resolve it properly per platform.
function getPlaywrightBrowsersPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'playwright-browsers');
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
    case 'win32':
      return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
    default:
      return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
  }
}

function getLogsDir() {
  return path.join(app.getPath('documents'), 'Lia Logs');
}

// LIA_ENV=staging points a dev run at config.staging.json instead, so migrations
// and billing changes can be rehearsed against a throwaway Supabase project
// before they touch the real one. Ignored in a packaged build — a shipped app
// must never be able to talk to anything but production.
function getConfigPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'config.json');
  const env = (process.env.LIA_ENV || '').trim().toLowerCase();
  const name = env && env !== 'production' ? `config.${env}.json` : 'config.json';
  const p = path.join(__dirname, '..', name);
  if (env && env !== 'production' && !fs.existsSync(p)) {
    throw new Error(`LIA_ENV=${env} but ${name} does not exist. Copy config.example.json to ${name} and fill it in.`);
  }
  return p;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')); }
  catch { return {}; }
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 820,
    // 800x640 is the size the layout is checked against: three cards a row,
    // the two-column screens folded into one, and nothing off the right edge.
    // Below 700 the folded screens start losing their own content, so that is
    // the floor rather than a number picked for looks.
    minWidth: 700,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setTitle('Lia');
  mainWindow.on('page-title-updated', (e) => { e.preventDefault(); mainWindow.setTitle('Lia'); });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (automationChild) { automationChild.kill(); automationChild = null; }
  if (process.platform !== 'darwin') app.quit();
});

// ── Supabase auth ─────────────────────────────────────────────────────────────

const AUTH_FILE = () => path.join(app.getPath('userData'), 'lia-auth.json');

function loadStoredSession() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE(), 'utf-8')); }
  catch { return null; }
}

function saveSession(session) {
  if (session) {
    fs.writeFileSync(AUTH_FILE(), JSON.stringify(session), 'utf-8');
  } else {
    try { fs.unlinkSync(AUTH_FILE()); } catch {}
  }
}

let _supabase = null;

async function getSupabase() {
  if (_supabase) return _supabase;
  const cfg = readConfig();
  if (!cfg.supabase?.url || !cfg.supabase?.anonKey) {
    throw new Error('Supabase not configured — add supabase.url and supabase.anonKey to config.json');
  }
  // Node.js < 22 lacks native WebSocket; provide the 'ws' package so Supabase realtime doesn't warn.
  if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = require('ws');
  }
  const { createClient } = await import('@supabase/supabase-js');
  _supabase = createClient(cfg.supabase.url, cfg.supabase.anonKey, {
    auth: { persistSession: false, autoRefreshToken: true },
  });
  const stored = loadStoredSession();
  if (stored) {
    await _supabase.auth.setSession(stored).catch(() => {});
  }
  _supabase.auth.onAuthStateChange((_event, session) => {
    saveSession(session);
  });
  return _supabase;
}

ipcMain.handle('auth:is-configured', () => {
  const cfg = readConfig();
  return !!(cfg.supabase?.url && cfg.supabase?.anonKey);
});

ipcMain.handle('auth:get-session', async () => {
  try {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const { data: profile, error } = await sb.rpc('get_my_profile');
    if (error) return { user: { email: session.user.email }, credits: null };
    const p = typeof profile === 'string' ? JSON.parse(profile) : profile;
    return { user: { email: session.user.email, name: p.name }, credits: p.credits };
  } catch { return null; }
});

ipcMain.handle('auth:login', async (_event, { email, password }) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    const { data: profile, error: pe } = await sb.rpc('get_my_profile');
    if (pe) return { ok: true, user: { email: data.user.email }, credits: null };
    const p = typeof profile === 'string' ? JSON.parse(profile) : profile;
    return { ok: true, user: { email: data.user.email, name: p.name }, credits: p.credits };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('auth:logout', async () => {
  try {
    if (_supabase) await _supabase.auth.signOut();
  } catch {}
  saveSession(null);
  return { ok: true };
});

// ── IPC: file dialog ─────────────────────────────────────────────────────────

ipcMain.handle('dialog:open-csv', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select CSV File',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── CSV path validation ──────────────────────────────────────────────────────
// Both CSV handlers take a path straight from the renderer and hand the parsed
// contents back to it. In normal use that path came from a native open dialog,
// but a compromised renderer could pass anything — which would make these an
// arbitrary-file-read primitive. Directory allowlisting is not workable here:
// users legitimately load CSVs from Downloads, Desktop, external drives and
// network shares. So validate the file itself. Resolve symlinks *first*, then
// check the extension, so a `ladders.csv` symlink pointing at a private file
// is rejected on the target's extension rather than the link's.

const MAX_CSV_BYTES = 50 * 1024 * 1024;

function resolveCsvPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return { error: 'No file selected.' };
  if (filePath.includes('\0')) return { error: 'Invalid file path.' };

  let real;
  try { real = fs.realpathSync(path.resolve(filePath)); }
  catch (err) { return { error: `Cannot read file: ${err.message}` }; }

  if (path.extname(real).toLowerCase() !== '.csv') return { error: 'Only .csv files can be opened.' };

  let stat;
  try { stat = fs.statSync(real); }
  catch (err) { return { error: `Cannot read file: ${err.message}` }; }

  if (!stat.isFile()) return { error: 'Not a regular file.' };
  if (stat.size > MAX_CSV_BYTES) {
    return { error: `File is too large (${(stat.size / 1048576).toFixed(1)} MB, limit 50 MB).` };
  }

  return { path: real };
}

// ── IPC: CSV preview ─────────────────────────────────────────────────────────

ipcMain.handle('csv:parse', (_event, filePath) => {
  const Papa = require('papaparse');
  const checked = resolveCsvPath(filePath);
  if (checked.error) return { error: checked.error };

  let content;
  try { content = fs.readFileSync(checked.path, 'utf-8'); }
  catch (err) { return { error: `Cannot read file: ${err.message}` }; }

  const result = Papa.parse(content, { header: true, skipEmptyLines: true });
  if (result.errors.length > 0) {
    const fatal = result.errors.find((e) => e.type === 'Delimiter' || e.type === 'Quotes');
    if (fatal) return { error: `CSV parse error: ${fatal.message}` };
  }

  const headers = result.meta.fields ?? [];
  const partCols = partColumns(headers);
  const records = [];
  const skipped = [];

  result.data.forEach((row, idx) => {
    const rowNum = idx + 2;
    const serial = (row['Serial #'] ?? '').trim();
    if (!serial) { skipped.push({ row: rowNum, serialNum: '(blank)', reason: 'Missing Serial #' }); return; }
    const parts = partCols.map((col) => parsePartValue(row[col])).filter(Boolean);
    records.push({
      serialNum: serial,
      truckId: (row['Location ID'] ?? '').trim() || '1',
      brand:   (row['Brand'] ?? '').trim(),
      type:    (row['Type']  ?? '').trim(),
      length:  (row['Length'] ?? '').trim(),
      desc:    (row['Description'] ?? '').trim(),
      parts,
      // Kept in step with src/csv-parser.ts so the preview and the import can
      // never disagree about a row — the whole point of the shared core.
      flags: {
        leveler:    parseFlagValue(row[FLAG_COLS.leveler]),
        claw:       parseFlagValue(row[FLAG_COLS.claw]),
        vrung:      parseFlagValue(row[FLAG_COLS.vrung]),
        lubricated: parseFlagValue(row[FLAG_COLS.lubricated]),
      },
    });
  });

  return { records, skipped };
});

// ── IPC: multi-tech merge ────────────────────────────────────────────────────
// Several techs work one work order on their own phones. This pulls everything
// captured under a work order so the lead can review it as one set before an
// import — nothing is resolved without them seeing it.

ipcMain.handle('merge:work-orders', async () => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from('work_order_submissions')
      .select('work_order_id, collector_name, collector_role, item_count, last_captured_at')
      .order('last_captured_at', { ascending: false });
    if (error) return { ok: false, error: error.message };

    // One row per work order, carrying who contributed to it.
    const byWo = new Map();
    (data || []).forEach(r => {
      const e = byWo.get(r.work_order_id) || {
        workOrderId: r.work_order_id, items: 0, techs: [], lastCapturedAt: r.last_captured_at,
      };
      e.items += Number(r.item_count) || 0;
      e.techs.push({ name: r.collector_name, role: r.collector_role, items: Number(r.item_count) || 0 });
      if (r.last_captured_at > e.lastCapturedAt) e.lastCapturedAt = r.last_captured_at;
      byWo.set(r.work_order_id, e);
    });
    return { ok: true, workOrders: [...byWo.values()] };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('merge:pull', async (_event, workOrderId) => {
  try {
    if (typeof workOrderId !== 'string' || !workOrderId.trim()) {
      return { ok: false, error: 'Pick a work order first.' };
    }
    const sb = await getSupabase();
    const core = require('../dist/lia-core.cjs');

    const [ladders, fp] = await Promise.all([
      // `inspections` has no `uploaded_at` — `created_at` is when the server
      // took the row, which is the same fact under a different name. Only
      // `fp_inspections` carries `uploaded_at`, and asking for it here failed
      // the whole pull with "column inspections.uploaded_at does not exist".
      sb.from('inspections')
        .select('id, serial_num, tech_name, tech_user_id, captured_at, created_at, is_deleted, brand, type, length, notes, parts, lubricated, has_leveler, has_claw, has_vrung')
        .eq('work_order_id', workOrderId).eq('is_current', true),
      sb.from('fp_inspections')
        .select('id, tech_user_id, collector_name, captured_at, uploaded_at, is_deleted, overall_pass, manufacturer, model, item_type, lot_number, mfg_month, mfg_year, assets(serial_raw)')
        .eq('work_order_id', workOrderId).eq('is_current', true),
    ]);
    if (ladders.error) return { ok: false, error: ladders.error.message };
    if (fp.error) return { ok: false, error: fp.error.message };

    const records = [];
    (ladders.data || []).forEach(r => records.push({
      clientId: r.id, serialNum: r.serial_num, scope: 'ladder',
      capturedAt: r.captured_at, uploadedAt: r.created_at,
      techName: r.tech_name, techUserId: r.tech_user_id, deleted: r.is_deleted,
      brand: r.brand, type: r.type, length: r.length, notes: r.notes, parts: r.parts || [],
      lubricated: r.lubricated, has_leveler: r.has_leveler,
      has_claw: r.has_claw, has_vrung: r.has_vrung,
    }));
    (fp.data || []).forEach(r => records.push({
      clientId: r.id, serialNum: (r.assets && r.assets.serial_raw) || '', scope: 'fall_protection',
      capturedAt: r.captured_at, uploadedAt: r.uploaded_at,
      techName: r.collector_name, techUserId: r.tech_user_id, deleted: r.is_deleted,
      overallPass: r.overall_pass, manufacturer: r.manufacturer, model: r.model,
      item_type: r.item_type, lot_number: r.lot_number,
      mfg_month: r.mfg_month, mfg_year: r.mfg_year,
    }));

    return { ok: true, merge: core.mergeRecords(records), pulled: records.length };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// ── IPC: fall protection catalog ─────────────────────────────────────────────
// Models and the checks techs are asked. Templates are versioned and an
// inspection pins the version it was performed against, so editing a checklist
// never rewrites what a past certificate says the tech was asked.

ipcMain.handle('fp:list-models', async () => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from('fp_models')
      .select('id, manufacturer, model, item_type, has_impact_indicator')
      .order('manufacturer').order('model');
    if (error) return { ok: false, error: error.message };
    return { ok: true, models: data || [] };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// A model's own checks if it has been given any, otherwise its equipment
// type's — so "add a check to this model" starts from the standard checklist
// rather than a blank page. `inherited` says which of the two came back.
ipcMain.handle('fp:get-checks', async (_event, modelId) => {
  try {
    const sb = await getSupabase();
    const { data: checks, error: ce } = await sb.rpc('fp_checks_for_authoring', {
      p_model_id: modelId,
    });
    if (ce) return { ok: false, error: ce.message };

    const { data: tpls, error: te } = await sb
      .from('fp_check_templates')
      .select('id, version, published_at')
      .eq('model_id', modelId)
      .order('version', { ascending: false })
      .limit(1);
    if (te) return { ok: false, error: te.message };

    return {
      ok: true,
      version: tpls && tpls.length ? tpls[0].version : 0,
      published: !!(tpls && tpls.length && tpls[0].published_at),
      inherited: !!(checks || []).length && !!(checks || [])[0].inherited,
      checks: checks || [],
    };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// ── Fall protection records ────────────────────────────────────────────────
// Browsing, correcting and deleting what the field recorded. Every write goes
// through a SECURITY DEFINER function that supersedes rather than overwrites
// and demands a reason — see supabase/migrations/15_fp_records.sql for why a certificate
// is never destroyed.
ipcMain.handle('fpr:list', async (_event, opts) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('fp_records', {
      p_search: (opts && opts.search) || null,
      p_status: (opts && opts.status) || null,
      p_limit: (opts && opts.limit) || 100,
      p_offset: (opts && opts.offset) || 0,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, result: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('fpr:detail', async (_event, assetId) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('fp_record_detail', { p_asset_id: assetId });
    if (error) return { ok: false, error: error.message };
    return { ok: true, detail: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

function fprWrite(channel, rpc) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      const sb = await getSupabase();
      const { data, error } = await sb.rpc(rpc, { p: payload });
      if (error) return { ok: false, error: error.message };
      return { ok: true, result: typeof data === 'string' ? JSON.parse(data) : data };
    } catch (err) { return { ok: false, error: String(err) }; }
  });
}
fprWrite('fpr:amend',       'amend_fp_inspection');
fprWrite('fpr:delete',      'delete_fp_inspection');
fprWrite('fpr:restore',     'restore_fp_inspection');
fprWrite('fpr:update-asset', 'update_fp_asset');
fprWrite('fpr:mark-pushed', 'mark_fp_bsi_pushed');

ipcMain.handle('fpr:pending-bsi', async (_event, workOrder) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('fp_pending_bsi', { p_work_order: workOrder || null });
    if (error) return { ok: false, error: error.message };
    return { ok: true, pending: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// ── Certificate views ──────────────────────────────────────────────────────
// Who has been reading certificates. The interesting question is office versus
// field, and that is answered by the network the view came from — so labelling
// networks is part of the same screen. See supabase/migrations/14_certificate_views.sql
// for why an address is never stored.
ipcMain.handle('views:summary', async (_event, days) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('certificate_view_summary', { p_days: days || 30 });
    if (error) return { ok: false, error: error.message };
    return { ok: true, summary: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('views:networks', async () => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.from('known_networks')
      .select('*').order('label', { ascending: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true, networks: data || [] };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('views:save-network', async (_event, net) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('save_known_network', { p: net });
    if (error) return { ok: false, error: error.message };
    return { ok: true, network: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('views:delete-network', async (_event, id) => {
  try {
    const sb = await getSupabase();
    const { error } = await sb.rpc('delete_known_network', { p_id: id });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// What this machine's address looks like from the server. The only reliable way
// for a lead to label his own office is to be told what to type.
ipcMain.handle('views:my-network', async () => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('my_network');
    if (error) return { ok: false, error: error.message };
    return { ok: true, network: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// ── Support inbox ──────────────────────────────────────────────────────────
// What techs have reported from the field app. Visible only to whoever is
// flagged is_developer in the database — see supabase/migrations/13_support.sql. That is a
// property of the signed-in user, checked server-side by every one of these
// functions, so hiding the screen here is presentation and not the security
// boundary.
//
// `am-i-developer` exists so the home screen can leave the card out entirely
// for everybody else, rather than showing a button that always errors.
ipcMain.handle('support:am-i-developer', async () => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('is_developer');
    if (error) return { ok: true, developer: false };
    return { ok: true, developer: data === true };
  } catch (_) { return { ok: true, developer: false }; }
});

// Anybody signed in can file one. The developer's inbox already reads these;
// until now only the phone app could write one, so a lead watching an import go
// wrong had to go and find a phone.
ipcMain.handle('support:submit', async (_event, ticket) => {
  try {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { ok: false, error: 'Sign in first — a ticket has to come from somebody.' };
    const { data, error } = await sb.rpc('submit_support_ticket', {
      p: {
        subject: ticket && ticket.subject,
        body: ticket && ticket.body,
        client_id: (ticket && ticket.clientId) || crypto.randomUUID(),
      },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, ticket: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('support:inbox', async (_event, status) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('developer_support_inbox', { p_status: status || null });
    if (error) return { ok: false, error: error.message };
    const tickets = typeof data === 'string' ? JSON.parse(data) : data;
    return { ok: true, tickets: tickets || [] };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('support:counts', async () => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('developer_support_counts');
    if (error) return { ok: false, error: error.message };
    return { ok: true, counts: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('support:reply', async (_event, ticketId, body) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('reply_support_ticket', {
      p: { ticket_id: ticketId, body: body },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, ticket: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('support:set-status', async (_event, ticketId, status) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('set_support_ticket_status', {
      p: { ticket_id: ticketId, status: status },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, ticket: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('support:mark-read', async (_event, ticketId) => {
  try {
    const sb = await getSupabase();
    const { error } = await sb.rpc('mark_support_ticket_read', { p: { ticket_id: ticketId } });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// ── Onboarding: crew, and subcontractors ───────────────────────────────────
// Both are server-checked: add_crew_member follows the working context (so the
// office acting as a subcontractor adds THEIR crew), add_subcontractor refuses
// unless the caller really is the umbrella and is not acting as anybody.
// See supabase/migrations/22_onboarding_rpcs.sql.
ipcMain.handle('team:add', async (_event, member) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('add_crew_member', {
      p: {
        user_id: member && member.userId,
        email:   member && member.email,
        name:    member && member.name,
      },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, accountId: data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// Inviting goes through an Edge Function, not from here: creating an auth user
// needs the service-role key, and that key must never be inside something a
// customer can install. supabase/functions/invite-user holds it; this passes
// the signed-in user's token so the function can check who is asking.
ipcMain.handle('invite:send', async (_event, invite) => {
  try {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { ok: false, error: 'Sign in first.' };

    const { data, error } = await sb.functions.invoke('invite-user', {
      body: {
        email:      invite && invite.email,
        name:       invite && invite.name,
        kind:       invite && invite.kind,          // 'crew' | 'subcontractor'
        rep_number: invite && invite.repNumber,
        credits:    invite && invite.credits,
      },
    });
    // A non-2xx from the function arrives as an error whose body holds the
    // reason. Surfacing "Edge Function returned a non-2xx status code" instead
    // would hide the sentence that says what to do.
    if (error) {
      let detail = error.message;
      try {
        const body = await error.context?.json?.();
        if (body && body.error) detail = body.error;
      } catch (_) { /* keep error.message */ }
      return { ok: false, error: detail };
    }
    if (data && data.error) return { ok: false, error: data.error };
    return { ok: true, result: data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('team:remove', async (_event, opts) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('remove_crew_member', {
      p: { user_id: opts && opts.userId, reason: opts && opts.reason },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, result: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('team:restore', async (_event, opts) => {
  try {
    const sb = await getSupabase();
    const { error } = await sb.rpc('restore_crew_member', { p: { user_id: opts && opts.userId } });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('subs:list', async () => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('my_subcontractors');
    if (error) return { ok: false, error: error.message };
    return { ok: true, subs: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('subs:add', async (_event, sub) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('add_subcontractor', {
      p: {
        user_id:    sub && sub.userId,
        email:      sub && sub.email,
        name:       sub && sub.name,
        rep_number: sub && sub.repNumber,
        // Blank means 0 — a balance is set deliberately, never inherited.
        credits:    sub && sub.credits !== '' && sub.credits != null ? Number(sub.credits) : 0,
      },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, sub: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// ── Working context: whose account am I in ─────────────────────────────────
// The umbrella (Batavia) can act as a lead subcontractor, to show them how the
// job is done or to see exactly what they see. While a session is active EVERY
// query and every write runs as that account — see supabase/migrations/20_impersonation.sql.
//
// The server decides who may act as whom; this is the transport. The renderer
// must never be the thing that enforces it, and must never cache the answer:
// a session expires on its own, so the context is re-read rather than assumed.
ipcMain.handle('ctx:get', async () => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('my_context');
    if (error) return { ok: false, error: error.message };
    const ctx = typeof data === 'string' ? JSON.parse(data) : data;

    // The balance that matters is the one that will be charged, which while
    // acting as somebody is THEIRS. Read through RLS rather than a new RPC —
    // 18's accounts policy already lets the umbrella see accounts beneath it,
    // and a null here just leaves the badge showing what it showed before.
    if (ctx && ctx.impersonating && ctx.account_id) {
      const { data: acct } = await sb
        .from('accounts').select('credits').eq('id', ctx.account_id).maybeSingle();
      if (acct) ctx.credits = acct.credits;
    }
    return { ok: true, ctx };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('ctx:start', async (_event, opts) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('start_impersonation', {
      p: {
        account_id: opts && opts.accountId,
        reason:     opts && opts.reason,
        minutes:    opts && opts.minutes ? Number(opts.minutes) : 60,
      },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, session: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('ctx:stop', async () => {
  try {
    const sb = await getSupabase();
    const { error } = await sb.rpc('stop_impersonation');
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// ── Equipment types ────────────────────────────────────────────────────────
// The type owns the checklist: a body harness is checked as a body harness
// whoever made it. fp_type_catalog() already returns each type with its current
// checks, which is exactly what this screen needs.
ipcMain.handle('fp:list-types', async () => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('fp_type_catalog');
    if (error) return { ok: false, error: error.message };
    const types = typeof data === 'string' ? JSON.parse(data) : data;
    return { ok: true, types: types || [] };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('fp:save-type', async (_event, type) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('save_fp_equipment_type', { p: type });
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('fp:publish-type-checks', async (_event, typeId, checks) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('publish_fp_type_checks', {
      p_type_id: typeId,
      p_checks: checks,
    });
    if (error) return { ok: false, error: error.message };
    const res = typeof data === 'string' ? JSON.parse(data) : data;
    return { ok: true, version: res && res.version };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('fp:save-model', async (_event, model) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('save_fp_model', { p: model });
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('fp:publish-checks', async (_event, modelId, checks) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('publish_fp_checks', {
      p_model_id: modelId,
      p_checks: checks,
    });
    if (error) return { ok: false, error: error.message };
    const res = typeof data === 'string' ? JSON.parse(data) : data;
    return { ok: true, version: res && res.version };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// ── IPC: automation lifecycle ─────────────────────────────────────────────────

// Writes go through the record_inspections RPC rather than a direct upsert.
// The RPC supersedes an existing record instead of overwriting it, and carries
// forward any value this write omits — so a re-import can no longer blank out
// notes a tech typed, and two techs on the same serial no longer erase each
// other. See supabase/migrations/04_inspections_v2.sql.
async function recordInspections(sb, rows, workOrderId, techName, source) {
  const records = rows.map(row => {
    const rec = { serial_num: row.serial, tech_name: techName, source: source || 'office' };
    if (workOrderId) rec.work_order_id = workOrderId;
    if (row.brand)   rec.brand  = row.brand;
    if (row.type)    rec.type   = row.type;
    if (row.length)  rec.length = row.length;
    // inspection_date and next_due_date are left to the RPC: it defaults to
    // today and today + 1 year.
    if (row.inspection_date) rec.inspection_date = row.inspection_date;
    if (row.next_due_date)   rec.next_due_date   = row.next_due_date;
    if (row.notes)           rec.notes           = row.notes;
    return rec;
  });

  let written = 0;
  const errors = [];
  for (let i = 0; i < records.length; i += 100) {
    const batch = records.slice(i, i + 100);
    const { data, error } = await sb.rpc('record_inspections', { p: batch });
    if (error) errors.push(error.message);
    else written += (data ?? batch.length);
  }
  return { written, errors };
}

// ── Importing what the field collected, without a CSV in the middle ────────
// The merge screen could show a lead what his techs captured and then leave
// him to ask them for a CSV and import that — a round trip through a phone,
// an email and a Downloads folder, for records the office already had.
//
// This writes the merged set to a CSV in the format the importer already
// understands and hands back the path. Deliberately a real file rather than a
// new code path into the runner: the diff, the part matching, the cost flags
// and the re-run behaviour are all exercised exactly as they are for a CSV a
// tech sends in, so there is one import to trust rather than two.
ipcMain.handle('merge:to-csv', async (_event, payload) => {
  try {
    const items = (payload && payload.items) || [];
    const workOrderId = (payload && payload.workOrderId) || '';
    if (!items.length) return { ok: false, error: 'Nothing to import.' };

    // Every part any record carries becomes a column, so the importer sees the
    // same shape a tech's own export would give it.
    const partNames = [];
    items.forEach(it => (it.parts || []).forEach(p => {
      const n = String(p.name || '').trim();
      if (n && !partNames.includes(n)) partNames.push(n);
    }));

    const headers = ['Row#', 'Serial #', 'Location ID', 'Brand', 'Type', 'Length', 'Description']
      .concat(partNames);
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const lines = [headers.join(',')];
    items.forEach((it, i) => {
      const byName = {};
      (it.parts || []).forEach(p => { byName[String(p.name || '').trim()] = p.qty || 1; });
      const row = [
        i + 1,
        it.serialNum || '',
        it.locationId || '',
        it.brand || '',
        it.type || '',
        it.length || '',
        it.notes || '',
      ].concat(partNames.map(n => {
        const qty = byName[n];
        if (!qty) return '';
        // The same inline quantity the CSV format already uses: "(2) G13".
        return qty > 1 ? `(${qty}) ${n}` : n;
      }));
      lines.push(row.map(esc).join(','));
    });

    const dir = path.join(app.getPath('temp'), 'lia-field-imports');
    fs.mkdirSync(dir, { recursive: true });
    const safeWo = String(workOrderId).replace(/[^A-Za-z0-9_-]+/g, '-') || 'work-order';
    const file = path.join(dir, `field-${safeWo}-${Date.now()}.csv`);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    return { ok: true, path: file, rows: items.length, parts: partNames.length };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.on('automation:start', async (_event, csvPath, workOrderId) => {
  // Kill any previous run (e.g. user clicked Start Over without stopping first)
  if (automationChild) { automationChild.kill(); automationChild = null; }

  // Populated in the Supabase block; used in the 'complete' handler to auto-log inspections
  let _sb = null, _techName = 'Lia Import', _serials = [];

  // Consume a credit if Supabase is configured
  const cfg = readConfig();
  if (cfg.supabase?.url && cfg.supabase?.anonKey) {
    try {
      _sb = await getSupabase();

      // Get logged-in tech name for the inspection record
      const { data: { session: _sess } } = await _sb.auth.getSession();
      if (_sess) {
        let _prof = null;
        try { ({ data: _prof } = await _sb.rpc('get_my_profile')); } catch {}
        const _p = _prof ? (typeof _prof === 'string' ? JSON.parse(_prof) : _prof) : null;
        _techName = (_p?.name) || _sess.user.email || 'Lia Import';
      }

      // Collect rows from the CSV now (file is still present at start time)
      try {
        const Papa = require('papaparse');
        const _content = fs.readFileSync(csvPath, 'utf-8');
        const _parsed = Papa.parse(_content, { header: true, skipEmptyLines: true });
        // Records from a work-order-less import still upload — they simply
        // cannot be matched to a work order later, which is the tradeoff the
        // screen states before the run starts.
        _serials = _parsed.data
          .map(r => ({
            serial: (r['Serial #'] ?? '').trim(),
            brand:  (r['Brand']    ?? '').trim() || null,
            type:   (r['Type']     ?? '').trim() || null,
            length: (r['Length']   ?? '').trim() || null,
          }))
          .filter(r => r.serial);
      } catch {}

      // Preflight only — nothing is charged here. This used to call
      // consume_credit before the browser even launched, so cancelling at the
      // diff card, a missing Chrome, or a crashed run all cost a credit for
      // work that never happened. The charge now happens in the 'complete'
      // handler, gated on success.
      //
      // We still check up front so a tech with no credits is stopped now
      // rather than after importing 200 ladders.
      // An import with no work order is allowed and simply is not billed.
      // Blank must never become a work order of its own: it used to fall back
      // to the literal 'unknown', and under (account, wo_key) uniqueness that
      // made the FIRST blank import charge and every one after it free for
      // ever. So no work order means no work_orders row, no preflight and no
      // charge — not a shared one called "unknown".
      const _billable = typeof workOrderId === 'string' && workOrderId.trim() !== '';
      const { data: pre, error } = _billable
        ? await _sb.rpc('preflight_work_order', { p_wo_number: workOrderId })
        : { data: null, error: null };
      if (error) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('automation:credit-error', error.message);
        }
        return;
      }
      const preflight = typeof pre === 'string' ? JSON.parse(pre) : pre;
      if (preflight && preflight.can_run === false) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('automation:credit-error',
            'No import credits remaining — contact your administrator.');
        }
        return;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('automation:preflight', preflight);
      }
    } catch (err) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('automation:credit-error', String(err));
      }
      return;
    }
  }

  // When packaged, playwright is asarUnpacked into app.asar.unpacked/node_modules.
  // The runner lives in Resources/ (extraResources) and can't find it via normal
  // resolution, so we add NODE_PATH pointing to the unpacked node_modules.
  const unpackedModules = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
  const nodePath = [unpackedModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);

  automationChild = fork(getRunnerPath(), [csvPath], {
    execPath: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRIGHT_BROWSERS_PATH: getPlaywrightBrowsersPath(),
      BATAVIA_LOGS_DIR: getLogsDir(),
      NODE_PATH: nodePath,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  let buffer = '';
  automationChild.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (!mainWindow || mainWindow.isDestroyed()) return;
        switch (event.type) {
          case 'log':               mainWindow.webContents.send('automation:log', event.message); break;
          case 'waiting-for-ready': mainWindow.webContents.send('automation:waiting-for-ready'); break;
          case 'diff':              mainWindow.webContents.send('automation:diff', event.result); break;
          case 'complete':
            mainWindow.webContents.send('automation:complete', event);
            mainWindow.show();
            mainWindow.focus();
            app.focus({ steal: true });
            // Charge and log only for a run that actually succeeded. This used
            // to fire on every 'complete', so a failed or cancelled run still
            // wrote inspection records for ladders that were never imported.
            if (event.success && _sb && _billable) {
              (async () => {
                try {
                  const { data, error } = await _sb.rpc('charge_work_order', {
                    p_wo_number: workOrderId,
                    p_scope: 'ladder',
                  });
                  if (error) throw new Error(error.message);
                  const res = typeof data === 'string' ? JSON.parse(data) : data;
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('automation:credit-ok', res);
                  }
                } catch (err) {
                  // The import already landed in BSI, so this is a billing
                  // problem, not an import failure — say so rather than
                  // implying the work was lost.
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('automation:billing-warning', String(err));
                  }
                }
                if (_serials.length > 0) {
                  await recordInspections(_sb, _serials, workOrderId, _techName, 'office')
                    .catch(() => {});
                }
              })();
            }
            break;
          case 'error':             mainWindow.webContents.send('automation:error', event.message); break;
          case 'paused':            mainWindow.webContents.send('automation:paused');  break;
          case 'resumed':           mainWindow.webContents.send('automation:resumed'); break;
        }
      } catch { /* ignore non-JSON */ }
    }
  });

  automationChild.stderr.on('data', (chunk) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('automation:log', '[STDERR] ' + chunk.toString());
  });

  automationChild.on('exit', (code) => {
    automationChild = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('automation:exited', code);
  });
});

ipcMain.on('automation:analyze', () => {
  if (automationChild?.stdin) automationChild.stdin.write(JSON.stringify({ type: 'ready' }) + '\n');
});

ipcMain.on('automation:choice', (_event, value) => {
  if (automationChild?.stdin) automationChild.stdin.write(JSON.stringify({ type: 'choice', value }) + '\n');
});

ipcMain.on('automation:stop', () => {
  if (automationChild) { automationChild.kill(); automationChild = null; }
});

ipcMain.on('automation:pause', () => {
  if (automationChild?.stdin) automationChild.stdin.write(JSON.stringify({ type: 'pause' }) + '\n');
});

ipcMain.on('automation:resume', () => {
  if (automationChild?.stdin) automationChild.stdin.write(JSON.stringify({ type: 'resume' }) + '\n');
});

// ── Job assignment ─────────────────────────────────────────────────────────
// The lead's plan for the day: which work orders exist, who is on each, and
// how much has landed. Every write is lead-gated server-side in
// supabase/migrations/16_assignments.sql — the desktop only decides what to draw.
ipcMain.handle('jobs:board', async (_event, status) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('job_board', { p_status: status || null });
    if (error) return { ok: false, error: error.message };
    return { ok: true, jobs: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('jobs:detail', async (_event, jobId) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('job_detail', { p_job_id: jobId });
    if (error) return { ok: false, error: error.message };
    return { ok: true, detail: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('jobs:team', async () => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('team_members');
    if (error) return { ok: false, error: error.message };
    return { ok: true, team: typeof data === 'string' ? JSON.parse(data) : data };
  } catch (err) { return { ok: false, error: String(err) }; }
});

for (const [channel, rpc] of [['jobs:save', 'save_job'],
                              ['jobs:close', 'close_job'],
                              ['jobs:delete', 'delete_job']]) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      const sb = await getSupabase();
      const { data, error } = await sb.rpc(rpc, { p: payload });
      if (error) return { ok: false, error: error.message };
      return { ok: true, result: typeof data === 'string' ? JSON.parse(data) : data };
    } catch (err) { return { ok: false, error: String(err) }; }
  });
}

// ── Fall protection → BSI ──────────────────────────────────────────────────
// A second automation run, separate from the ladder importer's child so that
// starting one cannot kill the other mid-import.
//
// The important behaviour is in the 'fp-pushed' branch below: each box is
// marked pushed in the database THE MOMENT IT LANDS, not when the run finishes.
// BSI drops connections and kills popups, and a run that dies at item 20 of 40
// must leave the database knowing those 20 went in. Otherwise the re-run adds
// them a second time and the customer is billed twice for the same inspection.
let fpChild = null;

ipcMain.on('fp:push-start', async (_event, items) => {
  if (fpChild) return;

  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fp-push:error', 'Nothing to push.');
    }
    return;
  }

  let payloadPath;
  try {
    payloadPath = path.join(app.getPath('temp'), `lia-fp-push-${Date.now()}.json`);
    fs.writeFileSync(payloadPath, JSON.stringify(list), { mode: 0o600 });
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fp-push:error', 'Could not stage the records: ' + String(err));
    }
    return;
  }

  const unpackedModules = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
  const nodePath = [unpackedModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);

  fpChild = fork(getRunnerPath(), ['--fp', payloadPath], {
    execPath: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRIGHT_BROWSERS_PATH: getPlaywrightBrowsersPath(),
      BATAVIA_LOGS_DIR: getLogsDir(),
      NODE_PATH: nodePath,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  const cleanup = () => { try { fs.unlinkSync(payloadPath); } catch {} };

  let buffer = '';
  fpChild.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      switch (event.type) {
        case 'log':               win && win.webContents.send('fp-push:log', event.message); break;
        case 'waiting-for-ready': win && win.webContents.send('fp-push:waiting'); break;
        case 'fp-pushed':
          // Persist first, tell the screen second. If this write fails the run
          // keeps going — but the operator is told, because an unrecorded box
          // is exactly what causes a double push later.
          (async () => {
            try {
              const sb = await getSupabase();
              const { error } = await sb.rpc('mark_fp_bsi_pushed', {
                p: { items: [{ inspection_id: event.inspectionId, box_ref: event.boxRef }] },
              });
              if (error) throw new Error(error.message);
              win && win.webContents.send('fp-push:pushed', event);
            } catch (err) {
              win && win.webContents.send('fp-push:log',
                `[WARN] ${event.serialNum} was added to BSI but could not be recorded here (` +
                `${String(err)}). Re-running may add it again — check the work order first.`);
            }
          })();
          break;
        case 'complete':
          win && win.webContents.send('fp-push:complete', event);
          if (win) { win.show(); win.focus(); app.focus({ steal: true }); }
          break;
        case 'error':             win && win.webContents.send('fp-push:error', event.message); break;
      }
    }
  });

  fpChild.stderr.on('data', (chunk) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fp-push:log', '[STDERR] ' + chunk.toString());
    }
  });

  fpChild.on('exit', (code) => {
    fpChild = null;
    cleanup();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fp-push:exited', code);
  });
});

ipcMain.on('fp:push-ready', () => {
  if (fpChild?.stdin) fpChild.stdin.write(JSON.stringify({ type: 'ready' }) + '\n');
});

ipcMain.on('fp:push-stop', () => {
  if (fpChild) { fpChild.kill(); fpChild = null; }
});

ipcMain.handle('app:get-logs-dir', () => getLogsDir());

// ── IPC: sample CSV template ──────────────────────────────────────────────────

const SAMPLE_CSV = [
  'Row#,Serial #,Location ID,Brand,Type,Length,Description,C&S,Rope,SLS-1,A,B,C,D',
  '1,1509436,1,LG,Ext,28,Ladder Repair,M23,R28L,,,Lgh92,Lgh123WP,RC',
  '2,1669421,78,LG,Ext,28,Ladder Repair,M23,R28L,,,(2) Lgh26p,Hlm100,RC',
  '3,1669497,13,LG,Ext,28,Ladder Repair,M23,R28L,,,(2) LGE26p,Hlm100,RC',
].join('\r\n');

ipcMain.handle('csv:save-sample', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save CSV Template',
    defaultPath: 'lia-template.csv',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, SAMPLE_CSV);
  return result.filePath;
});

// ── Inspection Log: historical import ────────────────────────────────────────

const INSPECTION_SAMPLE = [
  'Serial #,Inspection Date,Tech Name,Work Order #,Next Due Date,Notes,Brand,Type,Length',
  '1509436,2026-01-15,Nathan,WO-101,2027-01-15,Annual inspection,LG,Ext,28',
  '1669421,2026-01-15,Nathan,WO-101,2027-01-15,,LG,Ext,28',
  '1669497,2026-01-15,Nathan,WO-101,,Repaired — recheck in 6 months,LG,Ext,24',
].join('\r\n');

ipcMain.handle('inspections:save-sample', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Inspection CSV Template',
    defaultPath: 'inspection-template.csv',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, INSPECTION_SAMPLE, 'utf-8');
  return result.filePath;
});

ipcMain.handle('inspections:parse-csv', (_event, filePath) => {
  const Papa = require('papaparse');
  const checked = resolveCsvPath(filePath);
  if (checked.error) return { error: checked.error };

  let content;
  try { content = fs.readFileSync(checked.path, 'utf-8'); }
  catch (err) { return { error: `Cannot read file: ${err.message}` }; }

  const result = Papa.parse(content, { header: true, skipEmptyLines: true });
  if (result.errors.length > 0) {
    const fatal = result.errors.find(e => e.type === 'Delimiter' || e.type === 'Quotes');
    if (fatal) return { error: `CSV parse error: ${fatal.message}` };
  }

  const records = [];
  const skipped = [];
  result.data.forEach((row, idx) => {
    const rowNum = idx + 2;
    const serial = (row['Serial #'] || '').trim();
    if (!serial) { skipped.push({ row: rowNum, reason: 'Missing Serial #' }); return; }
    const dateRaw = (row['Inspection Date'] || '').trim();
    // Validate date if provided
    if (dateRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      skipped.push({ row: rowNum, reason: `Invalid date format "${dateRaw}" — use YYYY-MM-DD` });
      return;
    }
    records.push({
      serial_num:      serial,
      inspection_date: dateRaw || new Date().toISOString().split('T')[0],
      tech_name:       (row['Tech Name']    || '').trim() || null,
      work_order_id:   (row['Work Order #'] || '').trim() || null,
      next_due_date:   (row['Next Due Date']|| '').trim() || null,
      notes:           (row['Notes']        || '').trim() || null,
      brand:           (row['Brand']        || '').trim() || null,
      type:            (row['Type']         || '').trim() || null,
      length:          (row['Length']       || '').trim() || null,
    });
  });
  return { records, skipped };
});

ipcMain.handle('inspections:upload', async (_event, records) => {
  try {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { ok: false, error: 'Not logged in — sign in first to upload inspections.' };

    // Same write path as an automated run — record_inspections supersedes
    // rather than overwrites, and carries forward anything this write omits.
    // Empty values are stripped so they cannot clear an existing field.
    const results = { inserted: 0, errors: [] };
    for (let i = 0; i < records.length; i += 50) {
      const batch = records.slice(i, i + 50).map(r => {
        const clean = { source: 'manual' };
        for (const [k, v] of Object.entries(r)) { if (v != null && v !== '') clean[k] = v; }
        return clean;
      });
      const { data, error } = await sb.rpc('record_inspections', { p: batch });
      if (error) {
        results.errors.push(`Rows ${i + 1}–${i + batch.length}: ${error.message}`);
      } else {
        results.inserted += (data ?? batch.length);
      }
    }
    return { ok: true, ...results };
  } catch (err) { return { ok: false, error: String(err) }; }
});

ipcMain.handle('history:load', async () => {
  try {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { ok: false, error: 'Not signed in.' };

    // Resolve user's display name for the manual-upload fallback
    const { data: profile } = await sb
      .from('users').select('name').eq('id', session.user.id).single();
    const techName = profile?.name || null;

    // ── PRIMARY: work orders tracked via usage_log (Office Mode) ─────────────
    const { data: usage, error: uErr } = await sb
      .from('usage_log')
      .select('work_order_id, consumed_at')
      .order('consumed_at', { ascending: false });
    if (uErr) return { ok: false, error: uErr.message };

    const seen = new Set();
    const orderedWOs = [];
    for (const u of usage || []) {
      if (!seen.has(u.work_order_id)) {
        seen.add(u.work_order_id);
        orderedWOs.push(u);
      }
    }

    const woIds = orderedWOs.map(u => u.work_order_id);
    let primaryLadders = [];
    if (woIds.length) {
      const { data: ladders, error: lErr } = await sb
        .from('inspections')
        .select('serial_num, inspection_date, brand, type, length, work_order_id, next_due_date, tech_name')
        .in('work_order_id', woIds)
        .order('serial_num');
      if (lErr) return { ok: false, error: lErr.message };
      primaryLadders = ladders || [];
    }

    const laddersByWO = {};
    for (const l of primaryLadders) {
      if (!laddersByWO[l.work_order_id]) laddersByWO[l.work_order_id] = [];
      laddersByWO[l.work_order_id].push(l);
    }

    const groups = orderedWOs.map(u => ({
      work_order_id: u.work_order_id,
      consumed_at:   u.consumed_at,
      source:        'office',
      ladders:       laddersByWO[u.work_order_id] || [],
    }));

    // ── FALLBACK: manually uploaded via Log Inspections (matched by tech_name) ─
    if (techName) {
      const { data: manual } = await sb
        .from('inspections')
        .select('serial_num, inspection_date, brand, type, length, work_order_id, next_due_date, tech_name')
        .eq('tech_name', techName)
        .order('inspection_date', { ascending: false });

      // Keep only rows not already covered by the usage_log query
      const extras = (manual || []).filter(l => !woIds.includes(l.work_order_id));

      // Group by work_order_id when present, otherwise bucket by inspection_date
      const manualGroups = {};
      for (const l of extras) {
        const key = l.work_order_id || `__date_${l.inspection_date}`;
        if (!manualGroups[key]) {
          manualGroups[key] = {
            work_order_id: l.work_order_id || null,
            consumed_at:   l.inspection_date,
            source:        'manual',
            ladders:       [],
          };
        }
        manualGroups[key].ladders.push(l);
      }
      groups.push(...Object.values(manualGroups));
    }

    return { ok: true, groups };
  } catch (e) { return { ok: false, error: String(e) }; }
});
