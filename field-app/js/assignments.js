// Lia Field — assignments.js
//
// The jobs the lead has pushed to this phone.
//
// Part of the field app. Classic script — see the note in storage.js.
//
// ── The rule this is built around ──────────────────────────────────────────
// The assignment list is a CONVENIENCE, never a gate. A tech sent somewhere at
// short notice, in a basement with no signal, must still be able to make a job
// and record against it — so nothing here can block creating one, and a fetch
// that fails is not an error the tech has to clear. It just leaves yesterday's
// list on screen, marked as of when it was fetched.
//
// That is also why the list is cached in localStorage rather than re-fetched
// per screen: a phone that has been offline since Tuesday still shows Tuesday's
// plan, which is far more use than an empty screen and a spinner.
//
// ── Adopting ───────────────────────────────────────────────────────────────
// Opening an assigned job creates an ordinary local job, pinned to that work
// order number and scope. From then on capture is exactly what it always was —
// local first, uploaded when there is signal. Nothing in the capture path
// learns about assignments, which is deliberate: a bug here must not be able to
// stop a tech working.

(function (root) {
  'use strict';

  var KEY = 'lia-assigned-jobs';

  function readCache() {
    try {
      var c = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!c || !Array.isArray(c.jobs)) return { jobs: [], at: null };
      return c;
    } catch (_) { return { jobs: [], at: null }; }
  }

  function writeCache(jobs) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ jobs: jobs, at: new Date().toISOString() }));
    } catch (_) { /* quota — the list is a convenience, not data at risk */ }
  }

  function list()    { return readCache().jobs; }
  function fetchedAt(){ return readCache().at; }

  /**
   * Pulls the current plan. NEVER rejects: the caller is app startup, and a
   * failure there must leave the app working on what it already had rather than
   * showing an error a tech cannot act on.
   *
   * Resolves { ok, jobs, offline } so a caller that wants to say "as of
   * Tuesday" can, without having to catch anything.
   */
  function refresh() {
    var sync = root.LiaSync;
    if (!sync) return Promise.resolve({ ok: false, jobs: list(), offline: true });
    return sync.client().then(function (sb) {
      if (!sb) return { ok: false, jobs: list(), offline: true };
      return sb.auth.getSession().then(function (r) {
        if (!r.data || !r.data.session) return { ok: false, jobs: list(), offline: true };
        return sb.rpc('my_jobs', { p_closed_days: 2 }).then(function (res) {
          if (res.error) return { ok: false, jobs: list(), offline: true };
          var jobs = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          if (!Array.isArray(jobs)) return { ok: false, jobs: list(), offline: true };
          writeCache(jobs);
          return { ok: true, jobs: jobs, offline: false };
        });
      });
    }).catch(function () {
      // An app shipped ahead of its migration lands here too — my_jobs does not
      // exist yet. Same handling: keep working, say nothing.
      return { ok: false, jobs: list(), offline: true };
    });
  }

  /**
   * The peer work the lead has chosen to share, plus the job's own totals.
   * Read-only by construction: the server sends only what this tech may see —
   * see job_detail() in supabase/16_assignments.sql — so there is nothing here
   * that filters, and nothing that could be defeated by reading the response.
   */
  function detail(jobId) {
    var sync = root.LiaSync;
    if (!sync || !jobId) return Promise.resolve(null);
    return sync.client().then(function (sb) {
      if (!sb) return null;
      return sb.rpc('job_detail', { p_job_id: jobId }).then(function (res) {
        if (res.error || !res.data) return null;
        return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      });
    }).catch(function () { return null; });
  }

  // A local job already made for this assignment, if there is one. Matched on
  // the assignment id rather than the work order number so that a tech who
  // separately made his own job for the same number keeps both — his and the
  // assigned one — rather than having one silently absorb the other.
  function localFor(assignedId, jobs) {
    var all = jobs || (root.loadJobs ? root.loadJobs() : {});
    var keys = Object.keys(all);
    for (var i = 0; i < keys.length; i++) {
      if (all[keys[i]] && all[keys[i]].assignedId === assignedId) return all[keys[i]];
    }
    return null;
  }

  /**
   * Turns an assignment into an ordinary local job, or returns the one already
   * made for it. The work order number and scope come from the lead and are
   * marked as fixed, because a tech retyping a number the office already
   * decided is the whole reason the office could not match up the day's work.
   */
  function adopt(assigned) {
    if (!assigned || !root.loadJobs) return null;
    var all = root.loadJobs();
    var existing = localFor(assigned.id, all);
    var now = new Date().toISOString();

    if (existing) {
      // The lead can rename a job or move its date after it has been adopted.
      existing.workOrderNum = assigned.wo_number || existing.workOrderNum;
      existing.assignedTitle = assigned.title || '';
      existing.assignedStatus = assigned.status || 'open';
      existing.sharePeerWork = !!assigned.share_peer_work;
      existing.updatedAt = now;
      all[existing.id] = existing;
      root.saveJobs(all);
      return existing;
    }

    var job = {
      id: (root.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'a' + Date.now(),
      name: assigned.title || assigned.site || ('Work Order ' + (assigned.wo_number || '')),
      workOrderNum: assigned.wo_number || '',
      scope: assigned.scope === 'fall_protection' ? 'fall_protection' : 'ladder',
      ladders: [], items: [],
      // What makes it an assigned job rather than one the tech made.
      assignedId: assigned.id,
      assignedTitle: assigned.title || '',
      assignedSite: assigned.site || '',
      assignedNotes: assigned.notes || '',
      assignedStatus: assigned.status || 'open',
      sharePeerWork: !!assigned.share_peer_work,
      createdAt: now, updatedAt: now,
    };
    all[job.id] = job;
    root.saveJobs(all);
    return job;
  }

  // Assignments this phone has not been opened yet, so the list can show what
  // is new without the tech having to remember what he saw yesterday.
  function unopened() {
    var all = root.loadJobs ? root.loadJobs() : {};
    return list().filter(function (a) {
      return a.status === 'open' && !localFor(a.id, all);
    });
  }

  var api = {
    list: list,
    fetchedAt: fetchedAt,
    refresh: refresh,
    detail: detail,
    adopt: adopt,
    localFor: localFor,
    unopened: unopened,
    _writeCache: writeCache,
    _key: KEY,
  };

  root.LiaAssignments = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
