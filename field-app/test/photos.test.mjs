// Failure photos: the upload, and moving the ones older builds left inside jobs.
//
// The Supabase client is a stand-in that records what it was asked, so the test
// can assert the path, the order (file first, then the index) and the retry
// rules without a network. The server side is asserted in
// supabase/test/26_fp_photos_test.sql.
//
// Run via `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

// ── A job saved by an older build, photo and all, inside localStorage ──────
await p.addInitScript(() => {
  if (localStorage.getItem('__seeded')) return;
  localStorage.setItem('__seeded', '1');
  // A 1×1 JPEG, as the old build stored it.
  const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  localStorage.setItem('lia-field-jobs', JSON.stringify({ j1: { id: 'j1', name: 'Old job', scope: 'fall_protection',
    items: [{ id: 'old-1', kind: 'fall_protection', serial_num: 'OLD-1', overall_pass: false,
              capturedAt: '2026-09-01T10:00:00.000Z', checks: [],
              photo: { dataUrl: jpeg, bytes: 600, capturedAt: '2026-09-01T10:00:05.000Z' } }] } }));
});
await p.goto('file://' + ROOT + '/field-app/index.html');
await p.waitForTimeout(700);

const moved = await p.evaluate(() => JSON.parse(localStorage.getItem('lia-field-jobs')).j1.items[0].photo);
ok('a photo an older build left in a job is moved out of it', [!!moved.id, moved.dataUrl], [true, undefined]);
ok('into the photo store', await p.evaluate(id => LiaPhotos.get(id).then(r => !!(r && r.blob && r.blob.size)), moved.id), true);
const q = await p.evaluate(() => JSON.parse(localStorage.getItem('lia-upload-queue') || '[]'));
ok('and queued, against the inspection it was taken for',
   q.filter(e => e.kind === 'fp_photo').map(e => [e.clientId, e.payload.serial_num, e.payload.captured_at]),
   [['old-1:photo', 'OLD-1', '2026-09-01T10:00:00.000Z']]);
await p.reload(); await p.waitForTimeout(500);
ok('only once', await p.evaluate(() => JSON.parse(localStorage.getItem('lia-upload-queue') || '[]')
   .filter(e => e.kind === 'fp_photo').length), 1);

// ── The upload ──────────────────────────────────────────────────────────────
const run = (opts) => p.evaluate(async (opts) => {
  const calls = [];
  const sb = {
    rpc: async (name, args) => { calls.push(['rpc', name, args && args.p ? args.p : null]);
      if (name === 'my_account_id') return { data: 'acct-1', error: null };
      if (name === 'record_fp_photo') return opts.recordFails ? { data: null, error: { message: 'Its inspection has not been uploaded yet' } }
                                                              : { data: 'photo-row', error: null };
      return { data: null, error: null }; },
    storage: { from: (bucket) => ({ upload: async (path, blob, o) => {
      calls.push(['upload', bucket, path, blob.size, o.contentType, o.upsert]);
      return opts.exists ? { data: null, error: { statusCode: '409', message: 'The resource already exists' } } : { data: { path }, error: null };
    } }) },
  };
  const id = crypto.randomUUID();
  if (!opts.missing) await LiaPhotos.put({ id, blob: new Blob([new Uint8Array(1234)], { type: 'image/jpeg' }), bytes: 1234, width: 1280, height: 960 });
  const out = await LiaPhotos.upload(sb, { photo_id: id, serial_num: 'H-1', captured_at: '2026-09-29T14:00:00.000Z', photo_captured_at: '2026-09-29T14:00:03.000Z' });
  const left = !!(await LiaPhotos.get(id));
  return { calls, error: out && out.error ? out.error.message : null, left, id };
}, opts || {});

let r = await run();
ok('the file goes up first, into the account\'s folder, as a JPEG, never overwriting',
   r.calls[1].slice(0, 2).concat([r.calls[1][2] === `acct-1/${r.id}.jpg`, r.calls[1][4], r.calls[1][5]]),
   ['upload', 'fp-photos', true, 'image/jpeg', false]);
ok('then it is filed against its inspection', [r.calls[2][1], r.calls[2][2].storage_path, r.calls[2][2].serial_num,
   r.calls[2][2].captured_at, r.calls[2][2].bytes, r.calls[2][2].width],
   ['record_fp_photo', `acct-1/${r.id}.jpg`, 'H-1', '2026-09-29T14:00:00.000Z', 1234, 1280]);
ok('and the phone\'s copy is deleted once the server has both', [r.error, r.left], [null, false]);

r = await run({ exists: true });
ok('a file already uploaded by an earlier attempt is still filed', [r.calls.map(c => c[1]), r.error],
   [['my_account_id', 'fp-photos', 'record_fp_photo'], null]);

r = await run({ recordFails: true });
ok('if filing fails the error reaches the queue, to retry', r.error, 'Its inspection has not been uploaded yet');
ok('and the phone keeps its copy', r.left, true);

r = await run({ missing: true });
ok('a photo no longer on the phone finishes rather than retrying forever', [r.error, r.calls.length], [null, 0]);

ok('a queued photo counts as waiting to upload',
   await p.evaluate(() => { LiaSync.enqueue({ clientId: 'x:photo', kind: 'fp_photo', payload: {} });
     return LiaSync.pendingSummary().total >= 1; }), true);

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close();
process.exit(fails || errs.length ? 1 : 0);
