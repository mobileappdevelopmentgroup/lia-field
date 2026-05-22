'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // File & CSV
  openCsv:   ()         => ipcRenderer.invoke('dialog:open-csv'),
  parseCsv:  (filePath) => ipcRenderer.invoke('csv:parse', filePath),
  getLogsDir: ()        => ipcRenderer.invoke('app:get-logs-dir'),

  // Automation lifecycle
  startAutomation: (csvPath) => ipcRenderer.send('automation:start', csvPath),
  beginAutomation: ()        => ipcRenderer.send('automation:begin'),
  stopAutomation:  ()        => ipcRenderer.send('automation:stop'),

  // Events from main process
  onLog:             (cb) => ipcRenderer.on('automation:log',               (_e, msg)    => cb(msg)),
  onWaitingForReady: (cb) => ipcRenderer.on('automation:waiting-for-ready', ()           => cb()),
  onComplete:        (cb) => ipcRenderer.on('automation:complete',          (_e, result) => cb(result)),
  onError:           (cb) => ipcRenderer.on('automation:error',             (_e, msg)    => cb(msg)),
  onExited:          (cb) => ipcRenderer.on('automation:exited',            (_e, code)   => cb(code)),
});
