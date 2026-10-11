// Lia Field — truck.js
//
// My truck: what is on the trucks this tech is assigned to, and the three
// things they do to it — used one, loaded some, counted the shelf.
//
// Part of the field app. Classic script — see the note in storage.js.
//
// The server is the truth (supabase/migrations/34_vehicle_inventory.sql). The phone keeps:
//
//   * the last answer from my_vehicles(), cached in localStorage like the job
//     list, so a tech with no signal still sees their truck, marked as of when
//     it was fetched. Cleared on sign-out: one company's trucks must not show
//     for whoever signs in next. Never backed up — the server has it.
//   * the changes not yet uploaded. Each is an ordinary upload-queue entry
//     ('stock_move', deferrable: never dropped, never holding up an
//     inspection), and also listed here so the screen can show it on top of
//     the cached numbers until the server has it.
//
// A count is "there are N on the shelf as of now". It is sent with the moment
// it was taken, and the server works out the rest — a tech counting offline in
// the morning does not wipe out a load the office recorded at noon.

(function (root) {
  'use strict';

  var KEY = 'lia-my-vehicles';
  var PENDING_KEY = 'lia-truck-pending';

  function read(k, dflt) {
    try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? dflt : v; }
    catch (_) { return dflt; }
  }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

  function cache() { return read(KEY, { data: null, at: null }); }
  function data() { return cache().data; }
  function fetchedAt() { return cache().at; }
  function vehicles() { var d = data(); return (d && Array.isArray(d.vehicles)) ? d.vehicles : []; }
  function warehouses() { var d = data(); return (d && Array.isArray(d.warehouses)) ? d.warehouses : []; }
  function pending() { return read(PENDING_KEY, []); }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (_) {}
  }

  function setData(d) { write(KEY, { data: d, at: new Date().toISOString() }); }

  // Pulls the trucks. Never rejects, like every pull: no signal, or a database
  // without 34, leaves what the phone had.
  function pull(sb) {
    if (!sb) return Promise.resolve(false);
    return sb.rpc('my_vehicles').then(function (r) {
      if (r.error || !r.data) return false;
      setData(typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
      // What was sent before this answer is in it now; stop adding it on top.
      var p = pending();
      var out = p.filter(function (m) { return !m.sent; });
      if (out.length !== p.length) write(PENDING_KEY, out);
      return true;
    }).catch(function () { return false; });
  }

  function refresh() {
    var sync = root.LiaSync;
    if (!sync) return Promise.resolve(false);
    return sync.client().then(function (sb) { return sb ? pull(sb) : false; }).catch(function () { return false; });
  }

  function key(p) { return String(p || '').trim().toUpperCase(); }

  // The truck's lines with this phone's unsent changes on top. A pending count
  // replaces the number; uses and loads after it add to it.
  function lines(vehicleId) {
    var v = vehicles().filter(function (x) { return x.id === vehicleId; })[0];
    var out = {};
    (v && v.lines || []).forEach(function (l) {
      out[key(l.part_number)] = { part_number: key(l.part_number), qty: l.qty, par: l.par, pending: 0 };
    });
    pending().filter(function (m) { return m.location_id === vehicleId; })
      .sort(function (a, b) { return a.captured_at < b.captured_at ? -1 : 1; })
      .forEach(function (m) {
        var k = key(m.part_number);
        var l = out[k] || (out[k] = { part_number: k, qty: 0, par: null, pending: 0 });
        if (m.reason === 'count') l.qty = m.counted_qty;
        else l.qty += m.reason === 'use' ? -m.qty : m.qty;
        l.pending++;
      });
    return Object.keys(out).sort().map(function (k) {
      var l = out[k];
      l.need = l.par != null ? Math.max(l.par - l.qty, 0) : 0;
      return l;
    });
  }

  function primary() {
    var vs = vehicles();
    return (vs.filter(function (v) { return v.primary; })[0] || vs[0] || null);
  }

  // One change: queued for upload and shown at once.
  function record(move) {
    var m = {
      client_id: (root.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'sm-' + Date.now() + Math.random(),
      location_id: move.location_id,
      reason: move.reason,
      part_number: key(move.part_number),
      qty: move.reason === 'count' ? null : Math.abs(Math.round(move.qty)),
      counted_qty: move.reason === 'count' ? Math.max(0, Math.round(move.counted_qty)) : null,
      from_location_id: move.from_location_id || null,
      captured_at: new Date().toISOString(),
    };
    if (!m.location_id || !m.part_number) return null;
    var p = pending(); p.push(m); write(PENDING_KEY, p);
    if (root.LiaSync) {
      root.LiaSync.enqueue({ clientId: m.client_id, kind: 'stock_move', payload: m });
    }
    return m;
  }

  // Which truck is theirs today: where ladder parts come off. Shown at once,
  // sent through the queue so it survives no signal.
  function choose(vehicleId) {
    var d = data();
    if (!d || !Array.isArray(d.vehicles)) return;
    d.vehicles.forEach(function (v) { v.primary = v.id === vehicleId; });
    write(KEY, { data: d, at: fetchedAt() });
    if (root.LiaSync) {
      root.LiaSync.enqueue({ clientId: 'truck-' + vehicleId + '-' + Date.now(), kind: 'stock_truck',
                             payload: { location_id: vehicleId } });
    }
  }

  // The server has a change. It stays on screen until the next pull brings
  // numbers that include it — dropped now, the count would jump back and forth.
  function sent(clientId) {
    var p = pending();
    var hit = false;
    p.forEach(function (m) { if (m.client_id === clientId) { m.sent = true; hit = true; } });
    if (hit) write(PENDING_KEY, p);
  }
  if (root.addEventListener) {
    root.addEventListener('lia-record-sent', function (e) {
      if (e.detail && e.detail.kind === 'stock_move') {
        sent(e.detail.clientId);
        // Fetch numbers that include it.
        refresh().then(function () { if (typeof root.renderTruck === 'function') root.renderTruck(); });
      }
    });
  }

  root.LiaTruck = {
    KEY: KEY,
    PENDING_KEY: PENDING_KEY,
    vehicles: vehicles,
    warehouses: warehouses,
    lines: lines,
    primary: primary,
    data: data,
    fetchedAt: fetchedAt,
    pending: pending,
    pull: pull,
    refresh: refresh,
    record: record,
    choose: choose,
    clear: clear,
    _setData: setData,
  };
})(typeof window !== 'undefined' ? window : globalThis);

// ── The screen ──────────────────────────────────────────────────────────────
(function (root) {
  'use strict';
  var T = root.LiaTruck;
  var doc = root.document;
  if (!T || !doc) return;
  var byId = function (id) { return doc.getElementById(id); };
  var h = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };

  var _sel = null;          // the truck on screen
  var _shortOnly = false;
  var _sheet = null;        // { reason, part }

  function current() {
    var vs = T.vehicles();
    return vs.filter(function (v) { return v.id === _sel; })[0] || T.primary();
  }

  function ago(at) {
    if (!at) return '';
    var m = Math.floor((Date.now() - new Date(at)) / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return m + ' min ago';
    var hr = Math.floor(m / 60);
    return hr < 24 ? hr + ' h ago' : Math.floor(hr / 24) + ' d ago';
  }

  // The card on the jobs screen. Only for someone the office put on a truck.
  function renderTruckCard() {
    var card = byId('truck-card');
    if (!card) return;
    var vs = T.vehicles();
    if (!vs.length) { card.style.display = 'none'; return; }
    var v = T.primary();
    var short = T.lines(v.id).filter(function (l) { return l.need > 0; }).length;
    card.style.display = '';
    card.innerHTML = '<span>🚚</span><span><strong>My truck</strong> · ' + h(v.name) +
      '<span class="tc-sub">' + (vs.length > 1 ? vs.length + ' trucks · ' : '') + 'Use, load and count parts</span></span>' +
      (short ? '<span class="tc-short">' + short + ' short</span>' : '');
  }

  function renderTruck() {
    renderTruckCard();
    var list = byId('truck-list');
    if (!list) return;
    var vs = T.vehicles();
    var v = current();
    if (!v) {
      byId('truck-picker').innerHTML = '';
      byId('truck-asof').textContent = '';
      list.innerHTML = '<div class="job-empty">You are not on a truck. The office puts you on one in Lia Office → Inventory.</div>';
      return;
    }
    _sel = v.id;
    byId('truck-title').textContent = v.name + (v.unit ? ' · ' + v.unit : '');
    byId('truck-picker').innerHTML = vs.length > 1 ? vs.map(function (x) {
      return '<button class="jf-btn' + (x.id === v.id ? ' on' : '') + '" data-truck="' + h(x.id) + '">' +
        h(x.name) + (x.primary ? ' ★' : '') + '</button>';
    }).join('') + (v.primary ? '' : '<button class="jf-btn" id="truck-mine">Make this my truck today</button>') : '';
    var d = T.data() || {};
    var pend = T.pending().filter(function (m) { return !m.sent; }).length;
    byId('truck-asof').textContent =
      'As of ' + (ago(T.fetchedAt()) || 'never') +
      (pend ? ' · ' + pend + ' change' + (pend === 1 ? '' : 's') + ' waiting to upload' : '') +
      (d.auto_deduct && v.primary ? ' · Parts you record on ladders come off this truck.' : '');

    var q = String((byId('truck-q') || {}).value || '').trim().toUpperCase();
    var rows = T.lines(v.id).filter(function (l) {
      if (_shortOnly && !(l.need > 0)) return false;
      return !q || l.part_number.indexOf(q) >= 0;
    });
    list.innerHTML = rows.length ? rows.map(function (l) {
      return '<div class="truck-row' + (l.need > 0 ? ' short' : '') + '" data-part="' + h(l.part_number) + '">' +
        '<div class="tr-main"><span class="tr-pn">' + h(l.part_number) + '</span>' +
        '<span class="tr-sub">' + (l.par != null ? 'Par ' + l.par + (l.need > 0 ? ' · short ' + l.need : '') : 'No par') +
        (l.pending ? ' · not uploaded yet' : '') + '</span></div>' +
        '<span class="tr-qty' + (l.qty < 0 ? ' neg' : '') + '">' + l.qty + '</span>' +
        '<button class="tr-use" data-act="use">−1</button>' +
        '<button class="tr-load" data-act="load">+</button>' +
        '<button class="tr-count" data-act="count">Count</button></div>';
    }).join('') : '<div class="job-empty">' + (q || _shortOnly ? 'Nothing matches.' : 'Nothing on this truck yet.') + '</div>';
    var s = byId('truck-short');
    if (s) s.classList.toggle('on', _shortOnly);
  }

  function openSheet(reason, part) {
    var v = current();
    if (!v) return;
    _sheet = { reason: reason, part: part };
    byId('truck-sheet-title').textContent = (reason === 'count' ? 'Count ' : 'Load ') + part +
      (reason === 'count' ? ' — how many are on the truck now?' : ' — how many?');
    var qty = byId('truck-sheet-qty');
    qty.value = '';
    qty.placeholder = reason === 'count' ? 'On the truck now' : 'How many';
    var from = byId('truck-sheet-from');
    var whs = T.warehouses();
    from.style.display = reason === 'load' && whs.length ? '' : 'none';
    from.innerHTML = '<option value="">Not from a warehouse</option>' + whs.map(function (w) {
      return '<option value="' + h(w.id) + '">From ' + h(w.name) + '</option>';
    }).join('');
    byId('truck-sheet').classList.remove('hidden');
    setTimeout(function () { qty.focus(); }, 50);
  }

  function closeSheet() { _sheet = null; byId('truck-sheet').classList.add('hidden'); }

  function saveSheet() {
    if (!_sheet) return;
    var n = Number(byId('truck-sheet-qty').value);
    if (byId('truck-sheet-qty').value === '' || !Number.isFinite(n) || n < 0 || (_sheet.reason === 'load' && n === 0)) {
      byId('truck-sheet-qty').focus();
      return;
    }
    var v = current();
    T.record(_sheet.reason === 'count'
      ? { location_id: v.id, reason: 'count', part_number: _sheet.part, counted_qty: n }
      : { location_id: v.id, reason: 'load', part_number: _sheet.part, qty: n,
          from_location_id: byId('truck-sheet-from').value || null });
    closeSheet();
    renderTruck();
  }

  function openTruck() {
    if (typeof goScreen === 'function') goScreen('truck');
    renderTruck();
    T.refresh().then(function (ok) { if (ok) renderTruck(); });
  }

  function wire() {
    var card = byId('truck-card');
    if (card) card.addEventListener('click', openTruck);
    var back = byId('btn-truck-back');
    if (back) back.addEventListener('click', function () {
      if (typeof goScreen === 'function') goScreen('jobs');
      if (typeof renderJobList === 'function') renderJobList();
    });
    var list = byId('truck-list');
    if (list) list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var part = b.closest('[data-part]').dataset.part;
      var v = current();
      if (b.dataset.act === 'use') {
        T.record({ location_id: v.id, reason: 'use', part_number: part, qty: 1 });
        try { if (navigator.vibrate) navigator.vibrate(25); } catch (_) {}
        renderTruck();
      } else {
        openSheet(b.dataset.act, part);
      }
    });
    var picker = byId('truck-picker');
    if (picker) picker.addEventListener('click', function (e) {
      var b = e.target.closest('[data-truck]');
      if (b) { _sel = b.dataset.truck; renderTruck(); return; }
      if (e.target.id === 'truck-mine') { T.choose(_sel); renderTruck(); }
    });
    var q = byId('truck-q');
    if (q) q.addEventListener('input', renderTruck);
    var s = byId('truck-short');
    if (s) s.addEventListener('click', function () { _shortOnly = !_shortOnly; renderTruck(); });
    var add = byId('truck-new-go');
    var addIn = byId('truck-new-part');
    var addGo = function () {
      var pn = String(addIn.value || '').trim().toUpperCase();
      if (!pn) { addIn.focus(); return; }
      addIn.value = '';
      openSheet('load', pn);
    };
    if (add) add.addEventListener('click', addGo);
    if (addIn) addIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addGo(); } });
    var c = byId('truck-sheet-cancel'); if (c) c.addEventListener('click', closeSheet);
    var ok = byId('truck-sheet-ok'); if (ok) ok.addEventListener('click', saveSheet);
    var qty = byId('truck-sheet-qty');
    if (qty) qty.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveSheet(); } });
    var sheet = byId('truck-sheet');
    if (sheet) sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wire); else wire();

  root.renderTruck = renderTruck;
  root.renderTruckCard = renderTruckCard;
  root.openTruck = openTruck;
})(typeof window !== 'undefined' ? window : globalThis);
