// Lia Field — training.js
//
// Training and test accounts (migration 41). Signed in to one, the phone shows
// a purple bar across every screen, so a trainee is never unsure whether what
// they record reaches a customer, and a link to the account's own certificates,
// which are never on the public site and open only through a preview token.
//
// Part of the field app. Classic script — see the note in storage.js.
//
// Like the job list, this is a convenience and can never get in the way: the
// answer is cached, a failed fetch keeps the last answer, and nothing in the
// capture path reads it. The SERVER is what keeps training off the public
// certificates — this bar only says so.

(function (root) {
  'use strict';

  var KEY = 'lia-training';
  var CERT_SITE = 'https://lia.mobileappdevelopmentgroup.com/';

  function read() {
    try {
      var c = JSON.parse(localStorage.getItem(KEY) || 'null');
      return c && typeof c === 'object' ? c : null;
    } catch (_) { return null; }
  }

  function isTraining() { var c = read(); return !!(c && c.is_training); }

  // The account's certificates, marked TEST on the site. `src=app` so opening
  // them from here is never counted as a customer visit (the server ignores
  // training items anyway).
  function previewUrl(wo) {
    var c = read();
    if (!c || !c.is_training || !c.token) return '';
    var w = wo || (c.work_orders && c.work_orders[0]) || '';
    return CERT_SITE + '?preview=' + encodeURIComponent(c.token) +
      (w ? '&wo=' + encodeURIComponent(w) : '') + '&src=app';
  }

  function render() {
    if (typeof document === 'undefined' || !document.body) return;
    var bar = document.getElementById('training-bar');
    var c = read();
    if (!c || !c.is_training) { if (bar) bar.remove(); document.body.classList.remove('is-training'); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'training-bar';
      bar.setAttribute('role', 'status');
      document.body.insertBefore(bar, document.body.firstChild);
    }
    document.body.classList.add('is-training');
    bar.textContent = '';
    var label = document.createElement('span');
    label.textContent = 'TRAINING ACCOUNT — nothing here goes on a public certificate or a bill';
    bar.appendChild(label);
    var url = previewUrl();
    if (url) {
      var a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener';
      a.id = 'training-certs';
      a.textContent = 'Certificates';
      bar.appendChild(a);
    }
  }

  /** Asks the server. NEVER rejects; a failure keeps the last answer. */
  function refresh() {
    var sync = root.LiaSync;
    if (!sync) return Promise.resolve(isTraining());
    return sync.client().then(function (sb) {
      if (!sb) return isTraining();
      return sb.auth.getSession().then(function (r) {
        if (!r.data || !r.data.session) return isTraining();
        return sb.rpc('my_context').then(function (res) {
          if (res.error || !res.data) return isTraining();
          var ctx = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          try {
            localStorage.setItem(KEY, JSON.stringify({
              is_training: !!ctx.is_training,
              token: ctx.is_training ? (ctx.training_preview_token || '') : '',
              work_orders: ctx.is_training ? (ctx.training_bsi_work_orders || []) : [],
              account_name: ctx.account_name || '',
              at: new Date().toISOString(),
            }));
          } catch (_) { /* quota: the bar is a convenience */ }
          render();
          return !!ctx.is_training;
        });
      });
    }).catch(function () { return isTraining(); });
  }

  // Sign-out: the next person on this phone is not in training.
  function clear() {
    try { localStorage.removeItem(KEY); } catch (_) {}
    render();
  }

  root.LiaTraining = { refresh: refresh, clear: clear, isTraining: isTraining, previewUrl: previewUrl, render: render };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
    else render();
  }
})(typeof window !== 'undefined' ? window : globalThis);
