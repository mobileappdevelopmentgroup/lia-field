'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
    ? path.join(process.resourcesPath, '..', 'config.json')
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
  const partCols = headers.filter((h) => !METADATA_COLS.has(h));
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

ipcMain.on('automation:start', async (_event, csvPath, workOrderId) => {
  if (automationChild) return;

  // Consume a credit if Supabase is configured
  const cfg = readConfig();
  if (cfg.supabase?.url && cfg.supabase?.anonKey) {
    try {
      const sb = await getSupabase();
      const { data, error } = await sb.rpc('consume_credit', { p_work_order_id: workOrderId || 'unknown' });
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

  automationChild = fork(getRunnerPath(), [csvPath], {
    execPath: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRIGHT_BROWSERS_PATH: getPlaywrightBrowsersPath(),
      BATAVIA_LOGS_DIR: getLogsDir(),
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
            break;
          case 'error':             mainWindow.webContents.send('automation:error', event.message); break;
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

// ── Field Mode: job storage ───────────────────────────────────────────────────

function getJobsDir() { return path.join(app.getPath('userData'), 'lia-jobs'); }

function ensureJobsDir() {
  if (!fs.existsSync(getJobsDir())) fs.mkdirSync(getJobsDir(), { recursive: true });
}

ipcMain.handle('field:list-jobs', () => {
  ensureJobsDir();
  return fs.readdirSync(getJobsDir())
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(getJobsDir(), f), 'utf-8'));
        return { id: j.id, name: j.name, workOrderNum: j.workOrderNum, ladderCount: (j.ladders || []).length, updatedAt: j.updatedAt };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
});

ipcMain.handle('field:get-job', (_event, id) => {
  try { return JSON.parse(fs.readFileSync(path.join(getJobsDir(), `${id}.json`), 'utf-8')); }
  catch { return null; }
});

ipcMain.handle('field:save-job', (_event, job) => {
  ensureJobsDir();
  job.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(getJobsDir(), `${job.id}.json`), JSON.stringify(job, null, 2), 'utf-8');
  return { ok: true };
});

ipcMain.handle('field:delete-job', (_event, id) => {
  try { fs.unlinkSync(path.join(getJobsDir(), `${id}.json`)); return { ok: true }; }
  catch { return { ok: false }; }
});

function buildJobCsv(job) {
  const ladders = job.ladders || [];
  const maxParts = ladders.reduce((m, l) => Math.max(m, (l.parts || []).length), 0);
  const partCols = Array.from({ length: maxParts }, (_, i) => String.fromCharCode(65 + i));
  const headers = ['Row#', 'Serial #', 'Location ID', 'Brand', 'Type', 'Length', 'Description', ...partCols];

  const rows = ladders.map((l, idx) => {
    const row = {
      'Row#': idx + 1,
      'Serial #': l.serialNum || '',
      'Location ID': l.locationId || '',
      'Brand': l.brand || '',
      'Type': l.type || '',
      'Length': l.length || '',
      'Description': l.desc || '',
    };
    (l.parts || []).forEach((p, i) => {
      const col = String.fromCharCode(65 + i);
      row[col] = p.qty > 1 ? `(${p.qty}) ${p.name}` : (p.name || '');
    });
    return row;
  });

  const escape = v => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [
    headers.map(escape).join(','),
    ...rows.map(r => headers.map(h => escape(r[h] ?? '')).join(',')),
  ];
  return lines.join('\r\n');
}

// Export job for Lia Office Mode — returns path to the generated CSV
ipcMain.handle('field:export-for-lia', (_event, job) => {
  try {
    const csv = buildJobCsv(job);
    const dest = path.join(app.getPath('userData'), 'field-export.csv');
    fs.writeFileSync(dest, csv, 'utf-8');
    return { ok: true, path: dest };
  } catch (err) { return { ok: false, error: String(err) }; }
});

// Export job to a user-chosen file
ipcMain.handle('field:export-csv-dialog', async (_event, job) => {
  const safeName = (job.name || 'job').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'job';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Job as CSV',
    defaultPath: `${safeName}.csv`,
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const csv = buildJobCsv(job);
  fs.writeFileSync(result.filePath, csv, 'utf-8');
  return result.filePath;
});

// ── Inspection Log: historical import ────────────────────────────────────────

const INSPECTION_SAMPLE = [
  'Serial #,Inspection Date,Tech Name,Work Order #,Next Due Date,Notes',
  '1509436,2026-01-15,Nathan,WO-101,2027-01-15,Annual inspection',
  '1669421,2026-01-15,Nathan,WO-101,2027-01-15,',
  '1669497,2026-01-15,Nathan,WO-101,,Repaired — recheck in 6 months',
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
      tech_name:       (row['Tech Name'] || '').trim() || null,
      work_order_id:   (row['Work Order #'] || '').trim() || null,
      next_due_date:   (row['Next Due Date'] || '').trim() || null,
      notes:           (row['Notes'] || '').trim() || null,
    });
  });
  return { records, skipped };
});

ipcMain.handle('inspections:upload', async (_event, records) => {
  try {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { ok: false, error: 'Not logged in — sign in first to upload inspections.' };

    // Insert in batches of 50
    const results = { inserted: 0, errors: [] };
    for (let i = 0; i < records.length; i += 50) {
      const batch = records.slice(i, i + 50);
      const { error } = await sb.from('inspections').insert(batch);
      if (error) {
        results.errors.push(`Rows ${i + 1}–${i + batch.length}: ${error.message}`);
      } else {
        results.inserted += batch.length;
      }
    }
    return { ok: true, ...results };
  } catch (err) { return { ok: false, error: String(err) }; }
});
