'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Registers a main→renderer event handler, replacing any handler already bound
// to that channel. The renderer binds these once at load, but going through
// `on()` here means a re-bind (hot reload, a future re-init) can never stack up
// duplicate listeners that fire the same callback N times per event.
// Note: these are deliberately NOT `ipcRenderer.once` — the renderer registers
// at module scope and reuses the same handlers for every automation run, so a
// one-shot listener would leave the second run without a completion handler.
const on = (channel, handler) => {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  // ── Auth ──────────────────────────────────────────────────────────────────
  isSupabaseConfigured: ()                 => ipcRenderer.invoke('auth:is-configured'),
  getSession:           ()                 => ipcRenderer.invoke('auth:get-session'),
  login:                (creds)            => ipcRenderer.invoke('auth:login', creds),
  logout:               ()                 => ipcRenderer.invoke('auth:logout'),
  consumeCredit:        (workOrderId)      => ipcRenderer.invoke('auth:consume-credit', workOrderId),

  // ── File & CSV ───────────────────────────────────────────────────────────
  openCsv:       ()         => ipcRenderer.invoke('dialog:open-csv'),
  parseCsv:      (filePath) => ipcRenderer.invoke('csv:parse', filePath),
  saveSampleCsv: ()         => ipcRenderer.invoke('csv:save-sample'),
  getLogsDir:    ()         => ipcRenderer.invoke('app:get-logs-dir'),

  // ── Automation lifecycle ─────────────────────────────────────────────────
  startAutomation:  (csvPath, workOrderId) => ipcRenderer.send('automation:start', csvPath, workOrderId),
  analyzeWorkOrder: ()                     => ipcRenderer.send('automation:analyze'),
  sendChoice:       (value)               => ipcRenderer.send('automation:choice', value),
  stopAutomation:   ()                     => ipcRenderer.send('automation:stop'),
  pauseAutomation:  ()                     => ipcRenderer.send('automation:pause'),
  resumeAutomation: ()                     => ipcRenderer.send('automation:resume'),

  // ── Events: main → renderer ──────────────────────────────────────────────
  onLog:             (cb) => on('automation:log',               (_e, msg)    => cb(msg)),
  onWaitingForReady: (cb) => on('automation:waiting-for-ready', ()           => cb()),
  onDiff:            (cb) => on('automation:diff',              (_e, result) => cb(result)),
  onComplete:        (cb) => on('automation:complete',          (_e, result) => cb(result)),
  onError:           (cb) => on('automation:error',             (_e, msg)    => cb(msg)),
  onExited:          (cb) => on('automation:exited',            (_e, code)   => cb(code)),
  onCreditOk:        (cb) => on('automation:credit-ok',         (_e, left)   => cb(left)),
  onCreditError:     (cb) => on('automation:credit-error',      (_e, msg)    => cb(msg)),
  onPaused:          (cb) => on('automation:paused',            ()           => cb()),
  onResumed:         (cb) => on('automation:resumed',           ()           => cb()),

  // ── Inspection Log ───────────────────────────────────────────────────────
  saveInspectionSample: ()           => ipcRenderer.invoke('inspections:save-sample'),
  parseInspectionCsv:   (filePath)   => ipcRenderer.invoke('inspections:parse-csv', filePath),
  uploadInspections:    (records)    => ipcRenderer.invoke('inspections:upload', records),

  // ── Work History ─────────────────────────────────────────────────────────
  loadHistory: () => ipcRenderer.invoke('history:load'),
});
