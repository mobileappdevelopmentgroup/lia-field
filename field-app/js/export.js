// Lia Field — export.js
//
// CSV export. Kept as the manual hand-off for techs who want a file;
// cloud sync is the default path.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step. Modules would need a
// server, and the app has to run from file:// and from a Capacitor bundle.

// ── CSV export ────────────────────────────────────────────────────────────────
function buildCsv(job) {
  const ladders = job.ladders || [];
  const cfSet = new Set(loadCustomFields());
  ladders.forEach(l => Object.keys(l.customFields || {}).forEach(k => cfSet.add(k)));
  const cfNames = [...cfSet];
  const maxParts = ladders.reduce((m, l) => Math.max(m, (l.parts || []).length), 0);
  const partCols = Array.from({ length: maxParts }, (_, i) => String.fromCharCode(65 + i));
  // Prefixed because three of these collide with real part numbers — "Levelers"
  // is in the seed catalogue, and Claw and V-Rung are part numbers too. A bare
  // column would be imported into BSI as a part to search for.
  const flagCols = LADDER_FLAGS.map(f => `[Flag] ${f.col}`);
  const headers  = [
    'Row#', 'Serial #', 'Location ID', 'Brand', 'Type', 'Length', 'Description',
    ...flagCols, ...cfNames.map(n => `[Custom] ${n}`), ...partCols,
  ];
  const escape = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dataRows = ladders.map((l, idx) => {
    const row = {
      'Row#': idx + 1, 'Serial #': l.serialNum || '',
      'Location ID': l.locationId || '', 'Brand': l.brand || '',
      'Type': l.type || '', 'Length': l.length || '', 'Description': 'Ladder Repair',
    };
    LADDER_FLAGS.forEach((f, i) => {
      const v = (l.flags || {})[f.key];
      row[flagCols[i]] = v === true ? 'Yes' : v === false ? 'No' : '';
    });
    cfNames.forEach(n => { row[`[Custom] ${n}`] = (l.customFields || {})[n] || ''; });
    (l.parts || []).forEach((p, i) => {
      row[String.fromCharCode(65 + i)] = p.qty > 1 ? `(${p.qty}) ${p.name}` : (p.name || '');
    });
    return headers.map(h => escape(row[h] ?? '')).join(',');
  });
  return [headers.map(escape).join(','), ...dataRows].join('\r\n');
}

// ── Handing the file over ─────────────────────────────────────────────────────
//
// Three environments, and the browser's two ways both fail silently in the one
// that matters:
//
//   * Android WebView, which is what the Play build runs in, implements
//     NEITHER. The Web Share API is a Chrome feature, not a WebView one, so
//     `navigator.canShare` is undefined; and a WebView has no download manager
//     wired up, so `<a download>` clicks through to nothing at all. The button
//     appeared to work and produced no file — which is what was reported.
//   * iOS WKWebView does have Web Share, which is why the same button worked
//     on the iPhone and hid the problem.
//   * A real browser (the PWA) has both.
//
// So on a native build the file is written with Capacitor and handed to the
// system share sheet. The web paths stay for the PWA.

function isNative() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

async function shareCsvNative(fileName, csv) {
  const { Filesystem, Share } = window.Capacitor.Plugins;
  if (!Filesystem || !Share) return false;
  // Cache, not Documents: this is a hand-off, not the tech's copy of record —
  // that is the job on the device and, once signed in, the server.
  const written = await Filesystem.writeFile({
    path: fileName,
    data: csv,
    directory: 'CACHE',
    encoding: 'utf8',
  });
  await Share.share({ title: fileName, files: [written.uri] });
  return true;
}

$('btn-share-csv').addEventListener('click', async () => {
  if (!_job) return;
  saveNow();
  const csv      = buildCsv(_job);
  const safeName = (_job.name || 'job').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'job';
  const fileName = `${safeName}.csv`;

  if (isNative()) {
    try {
      if (await shareCsvNative(fileName, csv)) return;
    } catch (err) {
      // A cancelled share sheet is not a failure.
      if (/cancel/i.test(err && err.message || '')) return;
      // Anything else has to be said out loud. A silent no-op here is the bug
      // being fixed: the tech taps, nothing happens, and they assume the file
      // went somewhere.
      setSaveStatus('Could not save the CSV — ' + (err && err.message || err));
      return;
    }
  }

  const blob = new Blob([csv], { type: 'text/csv' });
  const file = new File([blob], fileName, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: fileName }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});
