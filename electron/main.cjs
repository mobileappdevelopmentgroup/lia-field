'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');

let mainWindow = null;
let automationChild = null;

// ── Metadata columns that are not "part" columns ─────────────────────────────
const METADATA_COLS = new Set(['Row#', 'Serial #', 'Location ID', 'Brand', 'Type', 'Length', 'Description']);

function parsePartValue(val) {
  const v = (val ?? '').trim();
  if (!v) return null;
  let m = v.match(/^\((\d+)\)\s*(.+)$/);
  if (m) {
    const qty = parseInt(m[1], 10);
    const term = m[2].trim();
    return term ? { searchTerm: term, quantity: qty } : null;
  }
  m = v.match(/^(.+?)\s*\((\d+)\)$/);
  if (m) {
    const term = m[1].trim();
    const qty = parseInt(m[2], 10);
    return term ? { searchTerm: term, quantity: qty } : null;
  }
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
  const fs = require('fs');
  const Papa = require('papaparse');

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { error: `Cannot read file: ${err.message}` };
  }

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
    if (!serial) {
      skipped.push({ row: rowNum, serialNum: '(blank)', reason: 'Missing Serial #' });
      return;
    }
    const parts = partCols.map((col) => parsePartValue(row[col])).filter(Boolean);
    records.push({
      serialNum: serial,
      truckId: (row['Location ID'] ?? '').trim(),
      brand: (row['Brand'] ?? '').trim(),
      type: (row['Type'] ?? '').trim(),
      length: (row['Length'] ?? '').trim(),
      desc: (row['Description'] ?? '').trim(),
      parts,
    });
  });

  return { records, skipped };
});

// ── IPC: automation lifecycle ─────────────────────────────────────────────────

ipcMain.on('automation:start', (_event, csvPath) => {
  if (automationChild) return;

  automationChild = fork(getRunnerPath(), [csvPath], {
    execPath: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRIGHT_BROWSERS_PATH: getPlaywrightBrowsersPath(),
      BATAVIA_LOGS_DIR: getLogsDir(),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
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
        if (!mainWindow) return;
        switch (event.type) {
          case 'log':               mainWindow.webContents.send('automation:log', event.message); break;
          case 'waiting-for-ready': mainWindow.webContents.send('automation:waiting-for-ready'); break;
          case 'complete':          mainWindow.webContents.send('automation:complete', event); break;
          case 'error':             mainWindow.webContents.send('automation:error', event.message); break;
        }
      } catch { /* ignore non-JSON */ }
    }
  });

  automationChild.stderr.on('data', (chunk) => {
    if (mainWindow) mainWindow.webContents.send('automation:log', '[STDERR] ' + chunk.toString());
  });

  automationChild.on('exit', (code) => {
    automationChild = null;
    if (mainWindow) mainWindow.webContents.send('automation:exited', code);
  });
});

ipcMain.on('automation:begin', () => {
  if (automationChild?.stdin) {
    automationChild.stdin.write(JSON.stringify({ type: 'ready' }) + '\n');
  }
});

ipcMain.on('automation:stop', () => {
  if (automationChild) { automationChild.kill(); automationChild = null; }
});

ipcMain.handle('app:get-logs-dir', () => getLogsDir());
