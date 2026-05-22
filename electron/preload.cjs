'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // File & CSV
  openCsv:       ()         => ipcRenderer.invoke('dialog:open-csv'),
  parseCsv:      (filePath) => ipcRenderer.invoke('csv:parse', filePath),
  saveSampleCsv: ()         => ipcRenderer.invoke('csv:save-sample'),
  getLogsDir:    ()         => ipcRenderer.invoke('app:get-logs-dir'),

  // Automation lifecycle
  startAutomation: (csvPath) => ipcRenderer.send('automation:start', csvPath),
  analyzeWorkOrder: ()       => ipcRenderer.send('automation:analyze'),
  sendChoice:    (value)     => ipcRenderer.send('automation:choice', value),
  stopAutomation: ()         => ipcRenderer.send('automation:stop'),

  // Events from main → renderer
  onLog:             (cb) => ipcRenderer.on('automation:log',               (_e, msg)    => cb(msg)),
  onWaitingForReady: (cb) => ipcRenderer.on('automation:waiting-for-ready', ()           => cb()),
  onDiff:            (cb) => ipcRenderer.on('automation:diff',              (_e, result) => cb(result)),
  onComplete:        (cb) => ipcRenderer.on('automation:complete',          (_e, result) => cb(result)),
  onError:           (cb) => ipcRenderer.on('automation:error',             (_e, msg)    => cb(msg)),
  onExited:          (cb) => ipcRenderer.on('automation:exited',            (_e, code)   => cb(code)),
});
