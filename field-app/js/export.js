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

$('btn-share-csv').addEventListener('click', async () => {
  if (!_job) return;
  saveNow();
  const csv      = buildCsv(_job);
  const safeName = (_job.name || 'job').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'job';
  const fileName = `${safeName}.csv`;
  const blob     = new Blob([csv], { type: 'text/csv' });
  const file     = new File([blob], fileName, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: fileName }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});
