'use strict';

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { fork } = require('child_process');

let mainWindow = null;
let automationChild = null;

// ── Metadata columns that are not "part" columns ─────────────────────────────
const METADATA_COLS = new Set(['Row#', 'Serial #', 'Location ID', 'Brand', 'Type', 'Length', 'Description']);

function parsePartValue(val) {
  const v = (val ?? '').trim();
  if (!v) return null;
  let m = v.match(/^\((\d+)\)\s*(.+)$/);
  if (m) { const qty = parseInt(m[1], 10); const term = m[2].trim(); return term ? { searchTerm: term, quantity: qty } : null; }
  m = v.match(/^(.+?)\s*\((\d+)\)$/);
  if (m) { const term = m[1].trim(); const qty = parseInt(m[2], 10); return term ? { searchTerm: term, quantity: qty } : null; }
  return { searchTerm: v, quantity: 1 };
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function getRunnerPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'electron-runner.cjs')
    : path.join(__dirname, '..', 'dist', 'electron-runner.cjs');
}

function getPlaywrightBrowsersPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'playwright-browsers');
  return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
}

function getLogsDir() {
  return path.join(app.getPath('documents'), 'Lia Logs');
}

function getConfigPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'config.json')
    : path.join(__dirname, '..', 'config.json');
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
    minWidth: 660,
    minHeight: 600,
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

ipcMain.handle('auth:consume-credit', async (_event, workOrderId) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc('consume_credit', { p_work_order_id: workOrderId || 'unknown' });
    if (error) return { ok: false, error: error.message };
    return { ok: true, creditsLeft: data };
  } catch (err) { return { ok: false, error: String(err) }; }
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

// ── IPC: CSV preview ─────────────────────────────────────────────────────────

ipcMain.handle('csv:parse', (_event, filePath) => {
  const Papa = require('papaparse');
  let content;
  try { content = fs.readFileSync(filePath, 'utf-8'); }
  catch (err) { return { error: `Cannot read file: ${err.message}` }; }

  const result = Papa.parse(content, { header: true, skipEmptyLines: true });
  if (result.errors.length > 0) {
    const fatal = result.errors.find((e) => e.type === 'Delimiter' || e.type === 'Quotes');
    if (fatal) return { error: `CSV parse error: ${fatal.message}` };
  }

  const headers = result.meta.fields ?? [];
  const partCols = headers.filter((h) => !METADATA_COLS.has(h) && !h.startsWith('[Custom] '));
  const records = [];
  const skipped = [];

  result.data.forEach((row, idx) => {
    const rowNum = idx + 2;
    const serial = (row['Serial #'] ?? '').trim();
    if (!serial) { skipped.push({ row: rowNum, serialNum: '(blank)', reason: 'Missing Serial #' }); return; }
    const parts = partCols.map((col) => parsePartValue(row[col])).filter(Boolean);
    records.push({
      serialNum: serial,
      truckId: (row['Location ID'] ?? '').trim(),
      brand:   (row['Brand'] ?? '').trim(),
      type:    (row['Type']  ?? '').trim(),
      length:  (row['Length'] ?? '').trim(),
      desc:    (row['Description'] ?? '').trim(),
      parts,
    });
  });

  return { records, skipped };
});

// ── IPC: automation lifecycle ─────────────────────────────────────────────────

async function autoInsertInspections(sb, rows, workOrderId, techName) {
  const today = new Date().toISOString().split('T')[0];
  const nextDue = new Date();
  nextDue.setFullYear(nextDue.getFullYear() + 1);
  const nextDueStr = nextDue.toISOString().split('T')[0];
  const records = rows.map(row => ({
    serial_num:      row.serial,
    inspection_date: today,
    tech_name:       techName,
    work_order_id:   workOrderId || null,
    next_due_date:   nextDueStr,
    notes:           null,
    brand:           row.brand   || null,
    type:            row.type    || null,
    length:          row.length  || null,
  }));
  for (let i = 0; i < records.length; i += 100) {
    await sb.from('inspections').upsert(records.slice(i, i + 100), {
      onConflict: 'serial_num,inspection_date',
      ignoreDuplicates: false,
    });
  }
}

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
        _serials = _parsed.data
          .map(r => ({
            serial: (r['Serial #'] ?? '').trim(),
            brand:  (r['Brand']    ?? '').trim() || null,
            type:   (r['Type']     ?? '').trim() || null,
            length: (r['Length']   ?? '').trim() || null,
          }))
          .filter(r => r.serial);
      } catch {}

      const { data, error } = await _sb.rpc('consume_credit', { p_work_order_id: workOrderId || 'unknown' });
      if (error) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('automation:credit-error', error.message);
        }
        return;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('automation:credit-ok', data);
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
            if (_sb && _serials.length > 0) {
              autoInsertInspections(_sb, _serials, workOrderId, _techName).catch(() => {});
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
  let content;
  try { content = fs.readFileSync(filePath, 'utf-8'); }
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

    // Upsert in batches of 50: strip null fields so existing values are preserved on conflict
    const results = { inserted: 0, errors: [] };
    for (let i = 0; i < records.length; i += 50) {
      const batch = records.slice(i, i + 50).map(r => {
        const clean = {};
        for (const [k, v] of Object.entries(r)) { if (v != null && v !== '') clean[k] = v; }
        return clean;
      });
      const { error } = await sb.from('inspections').upsert(batch, {
        onConflict: 'serial_num,inspection_date',
        ignoreDuplicates: false,
      });
      if (error) {
        results.errors.push(`Rows ${i + 1}–${i + batch.length}: ${error.message}`);
      } else {
        results.inserted += batch.length;
      }
    }
    return { ok: true, ...results };
  } catch (err) { return { ok: false, error: String(err) }; }
});
