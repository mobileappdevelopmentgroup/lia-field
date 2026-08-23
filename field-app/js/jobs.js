// Lia Field — jobs.js
//
// The jobs screen: the list, creating a job, and choosing its scope.
// A job is single-scope — ladders and fall protection are always separate
// work orders.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step. Modules would need a
// server, and the app has to run from file:// and from a Capacitor bundle.

// ════════════════════════════════════════════════════════════════
// Jobs Screen
// ════════════════════════════════════════════════════════════════
function renderJobList() {
  const all    = loadJobs();
  const sorted = Object.values(all).sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const body   = $('jobs-body');
  [...body.querySelectorAll('.job-card')].forEach(el => el.remove());
  $('jobs-empty').style.display = sorted.length === 0 ? '' : 'none';
  sorted.forEach(job => {
    // A fall protection job counts items, not ladders.
    const count = jobScope(job) === 'fall_protection'
      ? (job.items || []).length
      : (job.ladders || []).length;
    const sc    = SCOPES[jobScope(job)] || SCOPES.ladder;
    const date  = job.updatedAt ? new Date(job.updatedAt).toLocaleDateString() : '';
    const card  = document.createElement('div');
    card.className = 'job-card';
    card.innerHTML = `
      <div class="job-card-info">
        <div class="job-card-name">${esc(job.name || 'Untitled Job')}</div>
        <div class="job-card-meta"><span class="scope-badge ${sc.badge}">${esc(sc.label)}</span>${job.workOrderNum ? `WO# ${esc(job.workOrderNum)} · ` : ''}${count} ${esc(sc.unit)}${count !== 1 ? 's' : ''} · ${date}</div>
      </div>
      <div class="job-actions">
        <button class="btn-p" style="font-size:13px;padding:7px 12px;" data-open="${esc(job.id)}">Open</button>
        <button class="btn-g" style="font-size:13px;padding:7px 10px;color:var(--err);border-color:rgba(var(--err-rgb),.3);" data-del="${esc(job.id)}">✕</button>
      </div>
    `;
    card.querySelector('[data-open]').addEventListener('click', () => openJob(job.id));
    card.querySelector('[data-del]').addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm(`Delete "${job.name || 'Untitled Job'}"?`)) return;
      const all = loadJobs(); delete all[job.id]; saveJobs(all);
      renderJobList();
    });
    body.appendChild(card);
  });
}

const SCOPES = {
  ladder:          { label: 'Ladder',          badge: 'ladder', unit: 'ladder' },
  fall_protection: { label: 'Fall Protection', badge: 'fp',     unit: 'item' },
};
// Jobs created before scopes existed are all ladder jobs.
const jobScope = job => (job && job.scope) || 'ladder';

$('btn-new-job').addEventListener('click', openScopeSheet);
$('btn-cancel-scope').addEventListener('click', closeScopeSheet);

function openScopeSheet() {
  $('scope-sheet').classList.remove('hidden');
  $('sheet-backdrop').classList.remove('hidden');
}
function closeScopeSheet() {
  $('scope-sheet').classList.add('hidden');
  $('sheet-backdrop').classList.add('hidden');
}

document.querySelectorAll('.scope-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    closeScopeSheet();
    createJob(btn.dataset.scope);
  });
});

function createJob(scope) {
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    id, name: '', workOrderNum: '',
    scope: SCOPES[scope] ? scope : 'ladder',
    ladders: [], items: [], createdAt: now, updatedAt: now,
  };
  const all = loadJobs(); all[id] = job; saveJobs(all);
  openJob(id);
}
