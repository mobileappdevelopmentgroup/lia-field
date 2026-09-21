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
  if (typeof renderJobsUpload === 'function') renderJobsUpload();
  const all    = loadJobs();
  const sorted = Object.values(all).sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const body   = $('jobs-body');
  [...body.querySelectorAll('.job-card:not(.assigned)')].forEach(el => el.remove());
  renderAssignedList();
  // "No jobs yet" while the lead's assignments are sitting right above it reads
  // as though the assignments were not real.
  const assignedCount = window.LiaAssignments ? window.LiaAssignments.list().length : 0;
  $('jobs-empty').style.display = (sorted.length === 0 && assignedCount === 0) ? '' : 'none';
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

// ════════════════════════════════════════════════════════════════
// Assigned jobs
// ════════════════════════════════════════════════════════════════
// What the lead pushed to this phone, drawn above the tech's own jobs.
//
// Read from the local cache, never from the network — see assignments.js. The
// refresh happens at startup and in the background; drawing must never wait on
// it, because the common case is a tech opening the app in a truck with one bar.

function renderAssignedList() {
  const body = $('assigned-body');
  if (!body || !window.LiaAssignments) return;
  const asg = window.LiaAssignments;
  const jobs = asg.list();
  body.innerHTML = '';
  if (!jobs.length) return;

  const hdr = document.createElement('div');
  hdr.className = 'asg-hdr';
  hdr.innerHTML = '<span>Assigned to you</span>' +
    // Said plainly rather than hidden: a tech acting on a three-day-old plan
    // should know that is what he is doing.
    `<span class="asg-stale">${esc(asgAge(asg.fetchedAt()))}</span>`;
  body.appendChild(hdr);

  jobs.forEach(a => {
    const sc = SCOPES[a.scope] || SCOPES.ladder;
    const local = asg.localFor(a.id);
    const closed = a.status !== 'open';
    const card = document.createElement('div');
    card.className = 'job-card assigned' + (closed ? ' closed' : '');
    const bits = [];
    if (a.site) bits.push(esc(a.site));
    if (a.due_date) bits.push('due ' + esc(a.due_date));
    bits.push(`${a.mine_count || 0} by you`);
    // Only shown when the lead turned sharing on. Showing a team total to a
    // tech who is not allowed to see the team's work would leak the size of it.
    if (a.share_peer_work) bits.push(`${a.team_count || 0} on the job`);

    card.innerHTML = `
      <div class="job-card-info">
        <div class="job-card-name">${esc(a.title || a.wo_number || 'Work order')}</div>
        <div class="job-card-meta">
          <span class="scope-badge ${sc.badge}">${esc(sc.label)}</span>
          <span class="asg-badge${a.team_wide ? ' team' : ''}">${a.team_wide ? 'Team' : 'You'}</span>
          WO# ${esc(a.wo_number || '')} · ${bits.join(' · ')}
        </div>
        ${a.notes ? `<div class="asg-note">${esc(a.notes)}</div>` : ''}
        ${closed ? '<div class="asg-note">Closed by your lead. Anything you already recorded has been kept.</div>' : ''}
      </div>
      <div class="job-actions">
        ${a.share_peer_work ? `<button class="btn-g" style="font-size:13px;padding:7px 10px;" data-asg-team="${esc(a.id)}">Team</button>` : ''}
        <button class="btn-p" style="font-size:13px;padding:7px 12px;" data-asg="${esc(a.id)}">${local ? 'Open' : 'Start'}</button>
      </div>`;

    card.querySelector('[data-asg]').addEventListener('click', () => {
      const job = window.LiaAssignments.adopt(a);
      if (job) openJob(job.id);
    });
    const team = card.querySelector('[data-asg-team]');
    if (team) team.addEventListener('click', () => openTeamSheet(a));
    body.appendChild(card);
  });
}
window.renderAssignedList = renderAssignedList;

// ── What the team has done ──────────────────────────────────────────────────
// Read-only, always. Seeing another tech's inspection is not permission to
// change it, and there is deliberately nothing on this sheet that can.
function openTeamSheet(assigned) {
  $('team-sheet').classList.remove('hidden');
  $('sheet-backdrop').classList.remove('hidden');
  $('team-ttl').textContent = assigned.title || ('WO# ' + (assigned.wo_number || ''));
  $('team-desc').textContent = 'Loading…';
  $('team-list').innerHTML = '';

  window.LiaAssignments.detail(assigned.id).then(d => {
    if (!d) {
      // Not an error worth a red banner: he is offline, and the sheet is a
      // convenience. Say what happened and leave him to get on with it.
      $('team-desc').textContent = 'Needs a connection. Your own work is unaffected.';
      return;
    }
    const recs = d.records || [];
    const prog = d.progress || [];
    const total = prog.reduce((n, p) => n + (p.n || 0), 0);
    $('team-desc').textContent =
      `${total} item${total === 1 ? '' : 's'} recorded on this job. This list is read-only.`;
    $('team-list').innerHTML =
      (prog.length
        ? '<div class="asg-ro">' + prog.map(p =>
            `${esc(p.who || 'Unattributed')} — ${p.n}`).join(' · ') + '</div>'
        : '') +
      (recs.length
        ? recs.map(r => `
            <div class="asg-peer">
              <span>${esc(r.serial || '')}</span>
              <span style="color:var(--muted);">${esc(r.item_type || '')}</span>
              <span class="asg-who">${r.mine ? 'you' : esc(r.who || '')} · ${esc(r.date || '')}</span>
            </div>`).join('')
        : '<div class="asg-ro">Nothing recorded yet.</div>');
  });
}

function closeTeamSheet() {
  $('team-sheet').classList.add('hidden');
  $('sheet-backdrop').classList.add('hidden');
}

const _btnCloseTeam = $('btn-close-team');
if (_btnCloseTeam) _btnCloseTeam.addEventListener('click', closeTeamSheet);

function asgAge(at) {
  if (!at) return '';
  const mins = Math.floor((Date.now() - new Date(at)) / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 2) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

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
