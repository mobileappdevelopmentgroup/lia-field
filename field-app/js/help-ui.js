// Lia Field — help-ui.js
//
// The Help screen: the manual, the sample workflows, and the ticket thread with
// the developer.
//
// One screen with several views rather than several screens, because a tech
// reading a topic and then raising a ticket about it should not lose his place,
// and because Back has to mean one obvious thing on a phone.
//
// Content lives in help.js and ticket state in support.js; this file is only
// rendering and wiring.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step.

// index | topic | workflow | tickets | thread | new
let _helpView = 'index';
let _helpArg = null;
let _helpQuery = '';
let _helpReturn = 'jobs';   // the screen Back goes to

function helpOpen(from) {
  _helpReturn = from || 'jobs';
  _helpView = 'index';
  _helpArg = null;
  goScreen('help');
  helpRender();
  // Answers and status changes arrive while the app is closed, so the list is
  // refreshed on the way in rather than only on a pull.
  if (window.LiaSupport) window.LiaSupport.refresh().then(helpRender).catch(() => {});
}

function helpBack() {
  if (_helpView === 'topic' || _helpView === 'workflow') { _helpView = 'index'; _helpArg = null; }
  else if (_helpView === 'thread' || _helpView === 'new') { _helpView = 'tickets'; _helpArg = null; }
  else if (_helpView === 'tickets') { _helpView = 'index'; }
  else { goScreen(_helpReturn); if (typeof renderJobList === 'function') renderJobList(); return; }
  helpRender();
}

function helpRender() {
  const body = $('help-body');
  const ttl = $('help-title');
  if (!body) return;

  const unread = window.LiaSupport ? window.LiaSupport.unreadCount() : 0;
  const badge = $('help-tickets-badge');
  if (badge) {
    badge.textContent = unread ? String(unread) : '';
    badge.style.display = unread ? '' : 'none';
  }

  if (_helpView === 'topic')    return helpRenderTopic(body, ttl);
  if (_helpView === 'workflow') return helpRenderWorkflow(body, ttl);
  if (_helpView === 'tickets')  return helpRenderTickets(body, ttl);
  if (_helpView === 'thread')   return helpRenderThread(body, ttl);
  if (_helpView === 'new')      return helpRenderNew(body, ttl);
  return helpRenderIndex(body, ttl);
}

// ── The index ───────────────────────────────────────────────────────────────

function helpRenderIndex(body, ttl) {
  if (ttl) ttl.textContent = 'Help';
  const H = window.LiaHelp;
  const matching = H.search(_helpQuery);
  const searching = !!_helpQuery.trim();

  let html = `
    <div class="help-search-wrap">
      <input type="search" id="help-search" class="field-input" placeholder="Search help…"
             autocomplete="off" autocapitalize="none" value="${esc(_helpQuery)}">
    </div>`;

  if (searching && !matching.length) {
    // A dead end is where a tech decides the help is useless. Never leave one:
    // if we cannot answer it, offer the person who can.
    html += `<div class="help-empty">
        Nothing matches “${esc(_helpQuery)}”.
        <div class="help-empty-sub">Ask instead — it goes straight to the developer.</div>
        <button class="btn-p help-ask-btn" id="help-btn-ask-empty">Ask about this</button>
      </div>`;
  } else {
    if (!searching) {
      html += `<div class="help-hero">
          <div class="help-hero-ttl">New to this?</div>
          <div class="help-hero-sub">Read <em>What this app is for</em>, then follow a
            sample workflow start to finish. About five minutes.</div>
        </div>`;
    }

    H.groups().forEach(group => {
      const inGroup = matching.filter(t => t.group === group);
      if (!inGroup.length) return;
      html += `<div class="help-group-hdr">${esc(group)}</div>`;
      inGroup.forEach(t => {
        html += `<button class="help-item" data-topic="${esc(t.id)}">
            <span class="help-item-ttl">${esc(t.title)}</span>
            <span class="help-item-sub">${esc(t.blurb)}</span>
          </button>`;
      });
    });

    if (!searching) {
      html += '<div class="help-group-hdr">Sample workflows</div>';
      H.workflows().forEach(w => {
        html += `<button class="help-item" data-workflow="${esc(w.id)}">
            <span class="help-item-ttl">${esc(w.title)}</span>
            <span class="help-item-sub">${esc(w.when)}</span>
          </button>`;
      });
    }
  }

  html += helpAskCard();
  body.innerHTML = html;

  const search = $('help-search');
  if (search) {
    search.addEventListener('input', () => {
      _helpQuery = search.value;
      const at = search.selectionStart;
      helpRender();
      // Re-rendering the list blows away focus mid-word otherwise.
      const again = $('help-search');
      if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch (_) {} }
    });
  }
  helpWireCommon(body);
}

// Shown at the bottom of every view. Documentation that cannot answer the
// question has to hand off to something that can.
function helpAskCard() {
  const n = window.LiaSupport ? window.LiaSupport.list().length : 0;
  return `
    <div class="help-ask">
      <div class="help-ask-ttl">Still stuck, or got an idea?</div>
      <div class="help-ask-sub">Send it straight to the developer. Say what you
        expected and what happened — the app attaches the rest.</div>
      <button class="btn-p help-ask-btn" id="help-btn-ask">Send a message</button>
      ${n ? `<button class="btn-g help-ask-btn" id="help-btn-mine" style="margin-top:6px;">
               My messages (${n})</button>` : ''}
    </div>`;
}

function helpWireCommon(body) {
  body.querySelectorAll('[data-topic]').forEach(el => {
    el.addEventListener('click', () => {
      _helpView = 'topic'; _helpArg = el.dataset.topic; helpRender();
      const s = $('help-scroll'); if (s) s.scrollTop = 0;
    });
  });
  body.querySelectorAll('[data-workflow]').forEach(el => {
    el.addEventListener('click', () => {
      _helpView = 'workflow'; _helpArg = el.dataset.workflow; helpRender();
      const s = $('help-scroll'); if (s) s.scrollTop = 0;
    });
  });
  ['help-btn-ask', 'help-btn-ask-empty'].forEach(id => {
    const b = $(id);
    if (b) b.addEventListener('click', () => { _helpView = 'new'; _helpArg = null; helpRender(); });
  });
  const mine = $('help-btn-mine');
  if (mine) mine.addEventListener('click', () => { _helpView = 'tickets'; helpRender(); });
}

// ── A topic ─────────────────────────────────────────────────────────────────

function helpBlock(b) {
  if (b.type === 'p')    return `<p class="help-p">${b.text}</p>`;
  if (b.type === 'note') return `<div class="help-note">${b.text}</div>`;
  if (b.type === 'warn') return `<div class="help-warn">${b.text}</div>`;
  if (b.type === 'steps') {
    return '<ol class="help-steps">' + b.list.map(s => `<li>${s}</li>`).join('') + '</ol>';
  }
  if (b.type === 'shot') {
    // A screenshot that has not been captured must not leave a broken frame in
    // the middle of the instructions; the words stand on their own.
    return `<figure class="help-shot">
        <img src="${esc(b.src)}" alt="${esc(b.caption)}" loading="lazy"
             onerror="this.closest('figure').style.display='none'">
        <figcaption>${esc(b.caption)}</figcaption>
      </figure>`;
  }
  return '';
}

function helpRenderTopic(body, ttl) {
  const t = window.LiaHelp.byId(_helpArg);
  if (!t) { _helpView = 'index'; return helpRender(); }
  if (ttl) ttl.textContent = t.title;
  body.innerHTML = `<div class="help-doc">${t.body.map(helpBlock).join('')}</div>` + helpAskCard();
  helpWireCommon(body);
}

function helpRenderWorkflow(body, ttl) {
  const w = window.LiaHelp.workflows().filter(x => x.id === _helpArg)[0];
  if (!w) { _helpView = 'index'; return helpRender(); }
  if (ttl) ttl.textContent = w.title;
  body.innerHTML = `
    <div class="help-doc">
      <div class="help-when">${esc(w.when)}</div>
      <ol class="help-steps big">${w.list.map(s => `<li>${s}</li>`).join('')}</ol>
    </div>` + helpAskCard();
  helpWireCommon(body);
}

// ── Tickets ─────────────────────────────────────────────────────────────────

const HELP_KINDS = [
  { v: 'bug',        label: 'Something is broken' },
  { v: 'suggestion', label: 'I have an idea' },
  { v: 'question',   label: 'I have a question' },
  { v: 'other',      label: 'Something else' },
];

// Phrased as what it is costing him, not as an abstract priority. A tech has no
// way to judge "P1 vs P2", but he knows exactly whether he can finish the job.
const HELP_SEVERITIES = [
  { v: 'blocking', label: 'I cannot finish the job' },
  { v: 'annoying', label: 'I can work around it' },
  { v: 'idea',     label: 'Just an idea' },
];

function helpRenderNew(body, ttl) {
  if (ttl) ttl.textContent = 'Send a message';
  body.innerHTML = `
    <div class="help-doc">
      <div class="field-ig">
        <div class="field-label">What kind of thing is it?</div>
        <div class="field-ig-wrap">
          <select class="field-input" id="tk-kind">
            ${HELP_KINDS.map(k => `<option value="${k.v}">${esc(k.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-ig">
        <div class="field-label">How much is it costing you?</div>
        <div class="field-ig-wrap">
          <select class="field-input" id="tk-sev">
            ${HELP_SEVERITIES.map(s => `<option value="${s.v}"${s.v === 'annoying' ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-ig">
        <div class="field-label">One line — what is it about?</div>
        <div class="field-ig-wrap">
          <input type="text" class="field-input" id="tk-subject"
                 placeholder="e.g. Scanner will not focus" autocomplete="off">
        </div>
      </div>
      <div class="field-ig">
        <div class="field-label">What happened?</div>
        <div class="field-ig-wrap">
          <textarea class="field-input help-textarea" id="tk-body" rows="7"
            placeholder="What you were doing, what you expected, and what it did instead. Serial numbers help."></textarea>
        </div>
      </div>
      <div class="help-attached">
        The app attaches this automatically, so you do not have to know it:
        <span>version ${esc((window.LiaSupport ? window.LiaSupport.context().app_version : '') || '—')}</span>
        <span>${esc(window.LiaSupport ? window.LiaSupport.context().platform : '')}</span>
        <span>screen: ${esc(window.LiaSupport ? window.LiaSupport.currentScreen() : '')}</span>
      </div>
      <div class="help-hint" id="tk-msg"></div>
      <button class="add-ladder-btn" id="tk-send">Send</button>
    </div>`;

  const send = $('tk-send');
  if (send) send.addEventListener('click', helpSubmitTicket);
}

function helpSubmitTicket() {
  const msg = $('tk-msg');
  const bodyEl = $('tk-body');
  if (!bodyEl || !bodyEl.value.trim()) {
    if (msg) { msg.textContent = 'Write what happened first.'; msg.className = 'help-hint warn'; }
    if (bodyEl) bodyEl.focus();
    return;
  }
  let ticket;
  try {
    ticket = window.LiaSupport.submit({
      kind: ($('tk-kind') || {}).value,
      severity: ($('tk-sev') || {}).value,
      subject: ($('tk-subject') || {}).value,
      body: bodyEl.value,
    });
  } catch (e) {
    if (msg) { msg.textContent = e.message; msg.className = 'help-hint warn'; }
    return;
  }
  if (typeof playSound === 'function') playSound('ladder');
  _helpView = 'thread';
  _helpArg = ticket.clientId;
  helpRender();
  const s = $('help-scroll'); if (s) s.scrollTop = 0;
}

function helpRenderTickets(body, ttl) {
  if (ttl) ttl.textContent = 'My messages';
  const list = window.LiaSupport ? window.LiaSupport.list() : [];

  let html = '<div class="help-doc">';
  if (!list.length) {
    html += `<div class="help-empty">You have not sent anything yet.
      <div class="help-empty-sub">Anything that is broken, confusing, or missing
        is worth sending.</div></div>`;
  } else {
    list.forEach(t => {
      const sent = !!t.id;
      html += `<button class="help-ticket${t.unread ? ' unread' : ''}" data-ticket="${esc(t.clientId)}">
          <div class="help-ticket-top">
            <span class="help-ticket-ttl">${esc(t.subject || (t.body || '').slice(0, 60) || 'Message')}</span>
            ${t.unread ? '<span class="help-ticket-dot"></span>' : ''}
          </div>
          <div class="help-ticket-meta">
            <span class="help-status ${sent ? esc(t.status || 'new') : 'waiting'}">${esc(window.LiaSupport.statusLabel(t))}</span>
            ${t.ref ? `<span class="help-ref">${esc(t.ref)}</span>` : ''}
          </div>
        </button>`;
    });
  }
  html += '</div>' + helpAskCard();
  body.innerHTML = html;

  body.querySelectorAll('[data-ticket]').forEach(el => {
    el.addEventListener('click', () => {
      _helpView = 'thread'; _helpArg = el.dataset.ticket; helpRender();
      const s = $('help-scroll'); if (s) s.scrollTop = 0;
    });
  });
  helpWireCommon(body);
}

function helpRenderThread(body, ttl) {
  const t = (window.LiaSupport.list() || []).filter(x => x.clientId === _helpArg)[0];
  if (!t) { _helpView = 'tickets'; return helpRender(); }
  if (ttl) ttl.textContent = t.ref || 'Message';

  const sent = !!t.id;
  // The confirmation the tech actually needs: it arrived, here is what to quote,
  // and here is where it stands. Not a toast that disappears.
  const confirm = sent
    ? `<div class="help-confirm ok">
         <div class="help-confirm-ttl">Received — reference ${esc(t.ref || '')}</div>
         <div class="help-confirm-sub">${esc(window.LiaSupport.statusLabel(t))}.
           Answers appear here, and the app tells you when one arrives.</div>
       </div>`
    : `<div class="help-confirm wait">
         <div class="help-confirm-ttl">Saved on this phone</div>
         <div class="help-confirm-sub">It has not reached the developer yet — it goes
           by itself as soon as you have signal. Nothing is lost in the meantime.</div>
       </div>`;

  const msgs = (t.messages || []).map(m => `
      <div class="help-msg ${m.author_role === 'developer' ? 'dev' : 'me'}">
        <div class="help-msg-who">${esc(m.author_role === 'developer' ? (m.author_name || 'Developer') : 'You')}${m.pending ? ' · sending' : ''}</div>
        <div class="help-msg-body">${esc(m.body)}</div>
        <div class="help-msg-when">${esc(helpWhen(m.created_at))}</div>
      </div>`).join('');

  body.innerHTML = `
    <div class="help-doc">
      ${confirm}
      <div class="help-thread">${msgs}</div>
      ${sent ? `
        <div class="field-ig" style="margin-top:10px;">
          <div class="field-label">Add something</div>
          <div class="field-ig-wrap">
            <textarea class="field-input help-textarea" id="tk-reply" rows="4"
              placeholder="Anything else that would help…"></textarea>
          </div>
        </div>
        <div class="help-hint" id="tk-reply-msg"></div>
        <button class="btn-p" id="tk-reply-send" style="width:100%;padding:12px;">Send reply</button>`
      : ''}
    </div>`;

  if (t.unread) window.LiaSupport.markRead(t.clientId);

  const send = $('tk-reply-send');
  if (send) send.addEventListener('click', () => {
    const ta = $('tk-reply');
    const msg = $('tk-reply-msg');
    if (!ta || !ta.value.trim()) {
      if (msg) { msg.textContent = 'Write something first.'; msg.className = 'help-hint warn'; }
      return;
    }
    try { window.LiaSupport.reply(t.clientId, ta.value); }
    catch (e) { if (msg) { msg.textContent = e.message; msg.className = 'help-hint warn'; } return; }
    helpRender();
  });
}

function helpWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  if (mins < 1440) return Math.floor(mins / 60) + 'h ago';
  return d.toLocaleDateString();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

(function helpWire() {
  const back = $('help-back');
  if (back) back.addEventListener('click', helpBack);

  const tickets = $('help-btn-tickets');
  if (tickets) tickets.addEventListener('click', () => {
    _helpView = _helpView === 'tickets' ? 'index' : 'tickets';
    helpRender();
  });

  // Every entry point into help. Both are always available: a tech who cannot
  // start a job is exactly the one who needs the manual.
  ['btn-help-jobs', 'btn-help-detail'].forEach(id => {
    const b = $(id);
    if (b) b.addEventListener('click', () => helpOpen(id === 'btn-help-detail' ? 'detail' : 'jobs'));
  });

  // A reply that lands while the app is open should light up without a reload.
  if (window.LiaSupport) {
    window.LiaSupport.onChange(() => {
      helpBadgeRender();
      if (document.getElementById('screen-help') &&
          document.getElementById('screen-help').classList.contains('active')) helpRender();
    });
  }
})();

// The dot on the Help button, so an answer is noticed without opening anything.
function helpBadgeRender() {
  const n = window.LiaSupport ? window.LiaSupport.unreadCount() : 0;
  ['help-dot-jobs', 'help-dot-detail'].forEach(id => {
    const el = $(id);
    if (el) el.style.display = n ? '' : 'none';
  });
}
