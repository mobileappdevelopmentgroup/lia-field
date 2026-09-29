// Lia Field — support.js
//
// Tickets: raising one, tracking it, and reading the answer.
//
// The thing this has to get right is honesty about state. A tech who taps Send
// in a basement and is told "sent" has been lied to, and when nothing ever comes
// of it he learns the feature does not work and stops using it. So a ticket has
// three visible states and the app never conflates them:
//
//   waiting   written on the phone, not yet at the server. Says so plainly.
//   sent      the server has it, and has given back a reference to quote.
//   answered  somebody has replied, or moved it along.
//
// Submission rides the same upload queue as inspections, keyed by a client-side
// id so a retry after a timeout cannot file the same complaint twice — the
// server returns the original ticket instead. See submit_support_ticket() in
// supabase/13_support.sql.
//
// Part of the field app. Classic script — see the note in storage.js.

(function (root) {
  'use strict';

  var KEY = 'lia-support-tickets';

  function read() {
    try { return JSON.parse(root.localStorage.getItem(KEY) || '[]'); }
    catch (_) { return []; }
  }

  function write(list) {
    try { root.localStorage.setItem(KEY, JSON.stringify(list)); }
    catch (_) { /* quota; the queue still holds the submission itself */ }
  }

  function uuid() {
    return (root.crypto && root.crypto.randomUUID)
      ? root.crypto.randomUUID()
      : 'x' + Date.now() + Math.random().toString(16).slice(2);
  }

  // ── What the app knows and the tech does not ──────────────────────────────
  // Collected automatically because every one of these is something a tech
  // either cannot answer or will answer wrongly, and every one of them is the
  // first thing anyone debugging would ask for.
  //
  // Deliberately NOT collected: anything identifying a customer or a location.
  // A support ticket is not a place to leak a client's site data.
  function context() {
    var nav = root.navigator || {};
    var cap = root.Capacitor;
    var platform = 'web';
    try {
      if (cap && cap.getPlatform) platform = cap.getPlatform();
    } catch (_) {}

    var device = {
      ua: String(nav.userAgent || '').slice(0, 300),
      online: nav.onLine !== false,
      language: nav.language || '',
      screen: root.screen ? (root.screen.width + '×' + root.screen.height) : '',
      native: !!(cap && cap.isNativePlatform && cap.isNativePlatform()),
    };

    // How much unsent work is on the phone, and how stale its catalogue is.
    // "It stopped uploading" and "everything looks new" are the two commonest
    // reports, and both are answered by these two numbers.
    try {
      if (root.LiaSync && root.LiaSync.pendingSummary) {
        var pend = root.LiaSync.pendingSummary();
        device.queued = pend.total;
        device.queueFailing = pend.failing;
      }
    } catch (_) {}

    return {
      app: 'field',
      app_version: typeof LIA_APP_VERSION === 'string' ? LIA_APP_VERSION : '',
      platform: platform,
      device: device,
    };
  }

  // Where the tech was standing when he hit it. Read at submit time rather than
  // asked for, because "which screen were you on" is a question nobody answers
  // accurately an hour later.
  function currentScreen() {
    var el = root.document && root.document.querySelector('.screen.active');
    var id = el && el.id ? el.id.replace(/^screen-/, '') : '';
    // A job screen is really several screens; say which panel was up.
    if (id === 'detail') {
      try {
        if (root._fpBatch) return 'fall protection · tap-through';
        if (typeof root._fpItem !== 'undefined' && root._fpItem) return 'fall protection · item';
        var fp = root.document.getElementById('fp-input-panel');
        if (fp && fp.style.display !== 'none') return 'fall protection';
      } catch (_) {}
      return 'job';
    }
    return id || 'unknown';
  }

  // ── Raising one ───────────────────────────────────────────────────────────
  function submit(draft) {
    draft = draft || {};
    var ctx = context();
    var ticket = {
      clientId: uuid(),
      id: null,
      ref: null,
      kind: draft.kind || 'bug',
      severity: draft.severity || 'annoying',
      subject: String(draft.subject || '').trim(),
      body: String(draft.body || '').trim(),
      status: 'waiting',
      createdAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      unread: false,
      messages: [],
      context: ctx,
      screen: draft.screen || currentScreen(),
    };
    if (!ticket.body) throw new Error('Write what happened first.');

    // The tech's own words go into the thread immediately, so the ticket reads
    // as a conversation from the moment it exists rather than only after it has
    // been uploaded.
    ticket.messages.push({
      author_role: 'reporter', author_name: 'You',
      body: ticket.body, created_at: ticket.createdAt,
    });

    var list = read();
    list.unshift(ticket);
    write(list);

    var sync = root.LiaSync;
    if (sync && sync.enqueue) {
      sync.enqueue({
        clientId: ticket.clientId,
        kind: 'support_ticket',
        payload: {
          client_id: ticket.clientId,
          kind: ticket.kind,
          severity: ticket.severity,
          subject: ticket.subject || null,
          body: ticket.body,
          app: ctx.app,
          app_version: ctx.app_version,
          platform: ctx.platform,
          screen: ticket.screen,
          device: ctx.device,
        },
      });
      // Try immediately: most tickets are raised somewhere with signal, and
      // waiting up to two minutes for the timer to show a reference makes the
      // thing feel broken.
      if (sync.drain && (root.navigator || {}).onLine !== false) {
        Promise.resolve(sync.drain({})).then(function () { return refresh(); })
          .then(function () { notify(); }).catch(function () {});
      }
    }
    return ticket;
  }

  // ── Replying ──────────────────────────────────────────────────────────────
  function reply(clientId, body) {
    var text = String(body || '').trim();
    if (!text) throw new Error('Write something first.');
    var list = read();
    var t = list.filter(function (x) { return x.clientId === clientId; })[0];
    if (!t) throw new Error('That ticket is no longer on this phone.');
    // A ticket the server has never seen has no id to reply against. Its first
    // message has not gone up yet, so there is nothing to add to.
    if (!t.id) throw new Error('This one has not been sent yet. It will go as soon as you have signal.');

    var msgClient = uuid();
    t.messages.push({
      author_role: 'reporter', author_name: 'You',
      body: text, created_at: new Date().toISOString(), pending: true,
    });
    t.lastMessageAt = new Date().toISOString();
    write(list);

    var sync = root.LiaSync;
    if (sync && sync.enqueue) {
      sync.enqueue({
        clientId: msgClient,
        kind: 'support_reply',
        payload: { ticket_id: t.id, client_id: msgClient, body: text },
      });
      if (sync.drain && (root.navigator || {}).onLine !== false) {
        Promise.resolve(sync.drain({})).then(function () { return refresh(); })
          .then(function () { notify(); }).catch(function () {});
      }
    }
    return t;
  }

  // ── Merging what the server knows ─────────────────────────────────────────
  // The server is authoritative for the reference, the status and the
  // developer's replies. The phone is authoritative for anything not yet sent.
  // Merging on client_id is what lets a ticket raised offline become the same
  // ticket once it lands, rather than appearing twice.
  function refresh() {
    var sync = root.LiaSync;
    if (!sync || !sync.client) return Promise.resolve(read());
    if ((root.navigator || {}).onLine === false) return Promise.resolve(read());

    return sync.client().then(function (sb) {
      if (!sb) return read();
      return sb.rpc('my_support_tickets').then(function (r) {
        if (r.error) return read();
        var rows = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || []);
        var list = read();

        rows.forEach(function (row) {
          var local = list.filter(function (x) {
            return (row.client_id && x.clientId === row.client_id) ||
                   (row.id && x.id === row.id);
          })[0];
          if (!local) {
            // Raised from another device, or this phone was reinstalled.
            local = { clientId: row.client_id || row.id, context: null };
            list.unshift(local);
          }
          local.id = row.id;
          local.ref = row.ref;
          local.kind = row.kind;
          local.severity = row.severity;
          local.subject = row.subject;
          local.status = row.status;
          local.createdAt = row.created_at;
          local.lastMessageAt = row.last_message_at;
          local.unread = !!row.unread_reporter;
          local.messages = row.messages || [];
        });

        list.sort(function (a, b) {
          return String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || ''));
        });
        write(list);
        return list;
      }).catch(function () { return read(); });
    }).catch(function () { return read(); });
  }

  function markRead(clientId) {
    var list = read();
    var t = list.filter(function (x) { return x.clientId === clientId; })[0];
    if (!t) return Promise.resolve();
    t.unread = false;
    write(list);
    notify();
    if (!t.id) return Promise.resolve();
    var sync = root.LiaSync;
    if (!sync || !sync.client) return Promise.resolve();
    return sync.client().then(function (sb) {
      if (!sb) return;
      return sb.rpc('mark_support_ticket_read', { p: { ticket_id: t.id } });
    }).catch(function () {});
  }

  // What the badge shows: replies he has not read, plus anything still stuck on
  // the phone — both are things he ought to look at.
  function unreadCount() {
    return read().filter(function (t) { return t.unread; }).length;
  }

  function list() { return read(); }

  // A ticket that has reached the server, in the tech's words rather than the
  // database's. 'waiting' is deliberately not called 'failed': the queue keeps
  // trying, and nothing has been lost.
  function statusLabel(t) {
    if (!t.id) return 'Waiting to send';
    switch (t.status) {
      case 'new':      return 'Sent — not looked at yet';
      case 'open':     return 'Being worked on';
      case 'answered': return 'Answered';
      case 'resolved': return 'Fixed';
      case 'wont_fix': return 'Closed';
      default:         return 'Sent';
    }
  }

  // Anything that wants to redraw when a ticket changes registers here rather
  // than polling.
  var _listeners = [];
  function onChange(fn) { if (typeof fn === 'function') _listeners.push(fn); }
  function notify() { _listeners.forEach(function (fn) { try { fn(); } catch (_) {} }); }

  var api = {
    submit: submit,
    reply: reply,
    refresh: refresh,
    markRead: markRead,
    unreadCount: unreadCount,
    list: list,
    statusLabel: statusLabel,
    context: context,
    currentScreen: currentScreen,
    onChange: onChange,
    notify: notify,
  };

  root.LiaSupport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
