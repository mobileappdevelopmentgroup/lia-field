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

  // ── Onboarding ───────────────────────────────────────────────────────────
  teamMembers:    ()       => ipcRenderer.invoke('jobs:team'),
  addCrewMember:  (member) => ipcRenderer.invoke('team:add', member),
  removeCrewMember:(opts)   => ipcRenderer.invoke('team:remove', opts),
  restoreCrewMember:(opts)  => ipcRenderer.invoke('team:restore', opts),
  sendInvite:     (invite)  => ipcRenderer.invoke('invite:send', invite),
  listSubs:       ()       => ipcRenderer.invoke('subs:list'),
  addSubcontractor:(sub)   => ipcRenderer.invoke('subs:add', sub),

  // ── Working context (acting as a subcontractor) ──────────────────────────
  getContext:   ()      => ipcRenderer.invoke('ctx:get'),
  startActingAs:(opts)  => ipcRenderer.invoke('ctx:start', opts),
  stopActingAs: ()      => ipcRenderer.invoke('ctx:stop'),

  // ── File & CSV ───────────────────────────────────────────────────────────
  openCsv:       ()         => ipcRenderer.invoke('dialog:open-csv'),
  parseCsv:      (filePath) => ipcRenderer.invoke('csv:parse', filePath),
  saveSampleCsv: ()         => ipcRenderer.invoke('csv:save-sample'),
  getLogsDir:    ()         => ipcRenderer.invoke('app:get-logs-dir'),

  // ── Multi-tech merge ─────────────────────────────────────────────────────
  fieldList:       (archived)    => ipcRenderer.invoke('field:list', archived),
  fieldSetArchived:(p)           => ipcRenderer.invoke('field:set-archived', p),
  fieldAmend:      (p)           => ipcRenderer.invoke('field:amend', p),
  fieldDelete:     (p)           => ipcRenderer.invoke('field:delete', p),
  fieldRestore:    (p)           => ipcRenderer.invoke('field:restore', p),
  mergeWorkOrders: ()            => ipcRenderer.invoke('merge:work-orders'),
  mergePull:       (workOrderId) => ipcRenderer.invoke('merge:pull', workOrderId),
  mergeToCsv:      (payload)     => ipcRenderer.invoke('merge:to-csv', payload),

  // ── Fall protection catalog ──────────────────────────────────────────────
  fpListModels:    ()                 => ipcRenderer.invoke('fp:list-models'),
  fpGetChecks:     (modelId)          => ipcRenderer.invoke('fp:get-checks', modelId),
  fpSaveModel:     (model)            => ipcRenderer.invoke('fp:save-model', model),
  fpPublishChecks: (modelId, checks)  => ipcRenderer.invoke('fp:publish-checks', modelId, checks),
  // Fall protection records — browse, correct, delete. Corrections supersede
  // and are audited; nothing here overwrites a certificate.
  fprList:        (opts)     => ipcRenderer.invoke('fpr:list', opts),
  fprDetail:      (assetId)  => ipcRenderer.invoke('fpr:detail', assetId),
  fprAmend:       (payload)  => ipcRenderer.invoke('fpr:amend', payload),
  fprDelete:      (payload)  => ipcRenderer.invoke('fpr:delete', payload),
  fprRestore:     (payload)  => ipcRenderer.invoke('fpr:restore', payload),
  fprUpdateAsset: (payload)  => ipcRenderer.invoke('fpr:update-asset', payload),
  fprPendingBsi:  (wo)       => ipcRenderer.invoke('fpr:pending-bsi', wo),
  fprMarkPushed:  (payload)  => ipcRenderer.invoke('fpr:mark-pushed', payload),

  // Pushing fall protection work onto a BSI work order. Its own child process
  // and its own channels, so it cannot collide with a ladder import in flight.
  fpPushStart: (items) => ipcRenderer.send('fp:push-start', items),
  fpPushReady: ()      => ipcRenderer.send('fp:push-ready'),
  fpPushStop:  ()      => ipcRenderer.send('fp:push-stop'),
  onFpPushLog:      (cb) => on('fp-push:log',      (_e, msg) => cb(msg)),
  onFpPushWaiting:  (cb) => on('fp-push:waiting',  ()        => cb()),
  onFpPushPushed:   (cb) => on('fp-push:pushed',   (_e, rec) => cb(rec)),
  onFpPushComplete: (cb) => on('fp-push:complete', (_e, res) => cb(res)),
  onFpPushError:    (cb) => on('fp-push:error',    (_e, msg) => cb(msg)),
  onFpPushExited:   (cb) => on('fp-push:exited',   (_e, code) => cb(code)),

  // Job assignment — the lead's plan for the day. Writes are lead-gated in the
  // database; these just carry the payload.
  jobsBoard:  (status)  => ipcRenderer.invoke('jobs:board', status),
  jobsDetail: (jobId)   => ipcRenderer.invoke('jobs:detail', jobId),
  jobsTeam:   ()        => ipcRenderer.invoke('jobs:team'),
  jobsSave:   (payload) => ipcRenderer.invoke('jobs:save', payload),
  jobsClose:  (payload) => ipcRenderer.invoke('jobs:close', payload),
  jobsDelete: (payload) => ipcRenderer.invoke('jobs:delete', payload),

  // Certificate views — who has been reading certificates, and the network
  // labels that decide office versus field.
  viewsSummary:       (days)   => ipcRenderer.invoke('views:summary', days),
  viewsNetworks:      ()       => ipcRenderer.invoke('views:networks'),
  viewsSaveNetwork:   (net)    => ipcRenderer.invoke('views:save-network', net),
  viewsDeleteNetwork: (id)     => ipcRenderer.invoke('views:delete-network', id),
  viewsMyNetwork:     ()       => ipcRenderer.invoke('views:my-network'),

  // Support inbox — developer only. The gate is server-side (see
  // supabase/migrations/13_support.sql); this flag only decides whether the card is drawn.
  supportAmIDeveloper: ()                    => ipcRenderer.invoke('support:am-i-developer'),
  supportSubmit:   (ticket) => ipcRenderer.invoke('support:submit', ticket),
  supportInbox:        (status)              => ipcRenderer.invoke('support:inbox', status),
  supportCounts:       ()                    => ipcRenderer.invoke('support:counts'),
  supportReply:        (ticketId, body)      => ipcRenderer.invoke('support:reply', ticketId, body),
  supportSetStatus:    (ticketId, status)    => ipcRenderer.invoke('support:set-status', ticketId, status),
  supportMarkRead:     (ticketId)            => ipcRenderer.invoke('support:mark-read', ticketId),

  fpListTypes:     ()                 => ipcRenderer.invoke('fp:list-types'),
  fpSaveType:      (type)             => ipcRenderer.invoke('fp:save-type', type),
  fpPublishTypeChecks: (typeId, checks) => ipcRenderer.invoke('fp:publish-type-checks', typeId, checks),

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
  onCreditOk:        (cb) => on('automation:credit-ok',         (_e, res)    => cb(res)),
  onPreflight:       (cb) => on('automation:preflight',          (_e, res)    => cb(res)),
  onBillingWarning:  (cb) => on('automation:billing-warning',    (_e, msg)    => cb(msg)),
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
