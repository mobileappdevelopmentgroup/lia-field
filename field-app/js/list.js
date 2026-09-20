// Lia Field — list.js
//
// The list of ladders captured on the current job.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step. Modules would need a
// server, and the app has to run from file:// and from a Capacitor bundle.

// ── Ladder list (shows all, newest first) ─────────────────────────────────────
// Mirrors fpRenderPending() on the fall protection screen. A tech who has been
// working all day offline needs to see the backlog is known about, not lost.
function renderPending() {
  const el = document.getElementById('ladder-pending');
  if (!el || !window.LiaSync || !window.LiaSync.pendingSummary) return;
  const p = window.LiaSync.pendingSummary();
  if (!p.total) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.className = 'fp-pending' + (p.failing ? ' warn' : '');
  el.textContent = p.failing
    ? `${p.total} waiting to upload · ${p.failing} not going through`
    : `${p.total} waiting to upload`;
}
window.renderPending = renderPending;

function renderLadderList() {
  renderPending();
  const container = $('ladders-list');
  container.innerHTML = '';
  const ladders = _job.ladders || [];
  $('ladders-hdr').textContent = `Ladders (${ladders.length})`;
  if (!ladders.length) {
    container.innerHTML = '<div class="no-ladders">No ladders added yet</div>';
    return;
  }
  // Read the queue once for the whole list rather than per row: it is a
  // localStorage parse, and forty of them on every keystroke is felt.
  const q = window.LiaSyncState ? window.LiaSyncState.queued() : {};
  ladders.forEach((l, idx) => {
    const meta = [l.brand, l.type, l.length ? l.length + ' ft' : '', l.locationId].filter(Boolean).join(' · ');
    const partsHtml = (l.parts || []).length
      ? l.parts.map(p => `<span class="badge-part">${esc(p.name.toUpperCase())}${p.qty > 1 ? ` ×${p.qty}` : ''}</span>`).join('')
      : '<span style="color:var(--muted);font-size:10px;font-style:italic;">no parts</span>';
    const cfPairs = Object.entries(l.customFields || {});
    const cfHtml  = cfPairs.length ? cfPairs.map(([k,v]) => `${esc(k)}: ${esc(v)}`).join(' · ') : '';
    const card = document.createElement('div');
    const isEditing = idx === _editingIdx;
    card.className = 'ladder-card' + (isEditing ? ' lc-editing expanded' : '');
    card.innerHTML = `
      <div class="lc-body">
        <div class="lc-top">
          <span class="lc-sn">${esc(l.serialNum)}</span>${window.LiaSyncState ? window.LiaSyncState.badge(l.id, q) : ''}
          ${meta ? `<span class="lc-meta">${esc(meta)}</span>` : ''}
        </div>
        <div class="lc-parts">${partsHtml}</div>
        ${cfHtml ? `<div class="lc-custom">${cfHtml}</div>` : ''}
      </div>
      <div class="lc-actions">
        <button class="lc-edit">Edit</button>
        <button class="lc-dup">Duplicate</button>
        <button class="lc-del">Delete</button>
      </div>
    `;
    // Tap card body to expand/collapse; action buttons don't propagate
    card.addEventListener('click', e => {
      if (e.target.closest('.lc-actions')) return;
      const opening = !card.classList.contains('expanded');
      container.querySelectorAll('.ladder-card.expanded').forEach(c => c.classList.remove('expanded'));
      if (opening) card.classList.add('expanded');
    });
    card.querySelector('.lc-edit').addEventListener('click', e => { e.stopPropagation(); editLadder(idx); });
    card.querySelector('.lc-dup').addEventListener('click',  e => { e.stopPropagation(); duplicateLadder(idx); });
    card.querySelector('.lc-del').addEventListener('click',  e => {
      e.stopPropagation();
      _job.ladders.splice(idx, 1);
      renderLadderList();
      scheduleSave();
    });
    container.appendChild(card);
  });
}

// A record landing is the one event a tech is waiting on, so the screen shows
// it as it happens rather than the next time something else redraws.
window.addEventListener('lia-record-sent', function () {
  if (document.getElementById('screen-detail')?.classList.contains('active')) {
    try { renderLadderList(); } catch (_) { renderPending(); }
  } else {
    renderPending();
  }
  if (typeof fpRenderPending === 'function') fpRenderPending();
  if (typeof fpRenderItems === 'function' &&
      document.getElementById('screen-fp')?.classList.contains('active')) fpRenderItems();
});
