// Lia Field — photos.js
//
// Photos of failed equipment: made small, kept on the phone, sent up.
//
// They used to live as data URLs inside the job, in localStorage — the same
// ~5 MB that holds every job on the phone. Fifteen or so failures and saving a
// job started throwing. And nothing ever uploaded them. So:
//
//   · compress()  — a JPEG no longer than 1280 px on its long edge, stepped down
//                   in quality until it is ~200 KB or less. Storage is billed by
//                   the byte and a defect photo does not need 12 MP to show a
//                   cut strap. The bucket refuses anything over 1 MB anyway.
//   · put/get/del — the file itself in IndexedDB, which is sized for it; the job
//                   keeps only the photo's id and size.
//   · upload()    — the queue's sender for 'fp_photo' (see sync.js): the file to
//                   the private fp-photos bucket under <account>/<id>.jpg, then
//                   record_fp_photo() files it against its inspection. The copy
//                   on the phone is deleted once the server has both.
//
// Part of the field app. A CLASSIC script, not a module — see storage.js.

(function (root) {
  'use strict';

  var DB_NAME = 'lia-photos';
  var STORE = 'photos';
  var BUCKET = 'fp-photos';

  // Long edge and JPEG quality, tried in order until the result is small enough.
  var STEPS = [[1280, 0.6], [1280, 0.45], [1024, 0.45]];
  var TARGET_BYTES = 200 * 1024;

  var _db = null;
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = root.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error || new Error('Could not open photo storage.')); };
    });
  }

  function run(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var out;
        var r = fn(t.objectStore(STORE));
        if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { resolve(out === undefined ? null : out); };
        t.onerror = t.onabort = function () { reject(t.error || new Error('Photo storage failed.')); };
      });
    });
  }

  function put(rec) { return run('readwrite', function (s) { s.put(rec); }).then(function () { return rec; }); }
  function get(id) { return run('readonly', function (s) { return s.get(id); }); }
  function del(id) { return run('readwrite', function (s) { s.delete(id); }); }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(src);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read that photo.')); };
      img.src = url;
    });
  }

  function encode(img, maxPx, quality) {
    var scale = Math.min(1, maxPx / Math.max(img.width, img.height));
    var c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) {
        if (b) resolve({ blob: b, width: c.width, height: c.height, bytes: b.size });
        else reject(new Error('Could not compress that photo.'));
      }, 'image/jpeg', quality);
    });
  }

  // A File or Blob off the camera → the smallest acceptable JPEG.
  function compress(src) {
    return loadImage(src).then(function (img) {
      var i = 0;
      function next(best) {
        if (best && (best.bytes <= TARGET_BYTES || i >= STEPS.length)) return best;
        if (i >= STEPS.length) return best;
        var s = STEPS[i++];
        return encode(img, s[0], s[1]).then(function (r) {
          return next(!best || r.bytes < best.bytes ? r : best);
        });
      }
      return next(null);
    });
  }

  // A data URL, as older builds stored photos, back into a Blob. Decoded by
  // hand: fetch() on a data: URL is subject to the bundle's connect-src.
  function blobFromDataUrl(dataUrl) {
    var m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    var bin = m[2] ? root.atob(m[3]) : decodeURIComponent(m[3]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] || 'image/jpeg' });
  }

  function isDuplicate(err) {
    return !!err && (String(err.statusCode) === '409' || /already exists|duplicate/i.test(err.message || ''));
  }

  // The queue's sender. Resolves { error } like every other sendOne branch, so
  // the queue's retry rules apply unchanged.
  function upload(sb, payload) {
    return get(payload.photo_id).then(function (rec) {
      // The file is gone from this phone — storage cleared, or a previous
      // attempt finished and this is a replay. Nothing left that could ever be
      // sent, so the entry is done rather than retried forever.
      if (!rec) {
        if (root.console) console.warn('fp_photo: no local copy of ' + payload.photo_id + '; dropping the upload');
        return { data: null, error: null };
      }
      return sb.rpc('my_account_id').then(function (r) {
        if (r.error) return { error: r.error };
        if (!r.data) return { error: { message: 'No account — contact your administrator' } };
        var path = r.data + '/' + payload.photo_id + '.jpg';
        return sb.storage.from(BUCKET).upload(path, rec.blob, { contentType: 'image/jpeg', upsert: false })
          .then(function (u) {
            // Already there means an earlier attempt uploaded it and lost the
            // response. The file is the same; go on and file it.
            if (u.error && !isDuplicate(u.error)) return { error: u.error };
            return sb.rpc('record_fp_photo', { p: {
              storage_path: path,
              serial_num: payload.serial_num,
              captured_at: payload.captured_at,
              photo_captured_at: payload.photo_captured_at || null,
              bytes: rec.bytes || payload.bytes || null,
              width: rec.width || payload.width || null,
              height: rec.height || payload.height || null,
            } });
          })
          .then(function (res) {
            if (res && !res.error) return del(payload.photo_id).catch(function () {}).then(function () { return res; });
            return res;
          });
      });
    }).catch(function (err) { return { error: { message: (err && err.message) || 'Photo upload failed.' } }; });
  }

  root.LiaPhotos = {
    compress: compress,
    put: put,
    get: get,
    del: del,
    blobFromDataUrl: blobFromDataUrl,
    upload: upload,
    TARGET_BYTES: TARGET_BYTES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
