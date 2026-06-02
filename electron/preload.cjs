'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
  onLog:             (cb) => ipcRenderer.on('automation:log',               (_e, msg)    => cb(msg)),
  onWaitingForReady: (cb) => ipcRenderer.on('automation:waiting-for-ready', ()           => cb()),
  onDiff:            (cb) => ipcRenderer.on('automation:diff',              (_e, result) => cb(result)),
  onComplete:        (cb) => ipcRenderer.on('automation:complete',          (_e, result) => cb(result)),
  onError:           (cb) => ipcRenderer.on('automation:error',             (_e, msg)    => cb(msg)),
  onExited:          (cb) => ipcRenderer.on('automation:exited',            (_e, code)   => cb(code)),
  onCreditOk:        (cb) => ipcRenderer.on('automation:credit-ok',        (_e, left)   => cb(left)),
  onCreditError:     (cb) => ipcRenderer.on('automation:credit-error',     (_e, msg)    => cb(msg)),
  onPaused:          (cb) => ipcRenderer.on('automation:paused',           ()           => cb()),
  onResumed:         (cb) => ipcRenderer.on('automation:resumed',          ()           => cb()),

  // ── Inspection Log ───────────────────────────────────────────────────────
  saveInspectionSample: ()           => ipcRenderer.invoke('inspections:save-sample'),
  parseInspectionCsv:   (filePath)   => ipcRenderer.invoke('inspections:parse-csv', filePath),
  uploadInspections:    (records)    => ipcRenderer.invoke('inspections:upload', records),

  // ── Work History ─────────────────────────────────────────────────────────
  loadHistory: () => ipcRenderer.invoke('history:load'),
});
