// Lia Field — scan.js
//
// Barcode scanning: live viewfinder via getUserMedia, decoded with the
// native BarcodeDetector where it exists and ZXing everywhere else.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step. Modules would need a
// server, and the app has to run from file:// and from a Capacitor bundle.

// ── Barcode scanner ───────────────────────────────────────────────────────────
// In-app live viewfinder — getUserMedia, auto-decode every 400 ms, tap for
// immediate attempt. BarcodeDetector (Android Chrome) → ZXing (iOS + others).
// Falls back to OS camera photo if getUserMedia is denied.

let _scanStream = null, _scanInterval = null, _scanDecoding = false, _scanFailCount = 0;

// DecodeHintType.TRY_HARDER (enum value 3) isn't exported by the @zxing/browser UMD
// bundle, but the numeric value is stable. It makes the 1D readers also try a
// 90°-rotated pass, so vertically-oriented barcodes decode as reliably as horizontal ones.
const ZXING_HINTS = new Map([[3, true]]);

$('btn-scan').addEventListener('click', () => {
  // The keyboard and the viewfinder fight for the same half of the screen, and
  // on Android the keyboard wins — the scanner opens behind it. Put it away
  // first, then scan; the decoded serial lands in the field either way.
  const a = document.activeElement;
  if (a && typeof a.blur === 'function') a.blur();
  startScan();
});
$('btn-scan-cancel').addEventListener('click', stopScan);
$('scan-photo-input-fallback').addEventListener('change', _onFallbackPhotoCaptured);

async function startScan() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.();
    if (caps?.zoom) {
      await track.applyConstraints({ advanced: [{ zoom: Math.min(3, caps.zoom.max) }] });
    }
    $('scan-video').srcObject = stream;
    await $('scan-video').play();
    _scanStream = stream;
  } catch (_) {
    $('scan-photo-input-fallback').click();
    return;
  }
  _scanFailCount = 0;
  _scanDecoding = false;
  $('scan-hint').textContent = "Aim at barcode — tap if it doesn't auto-read";
  $('scan-hint').classList.remove('warn');
  $('scan-overlay').classList.remove('hidden');
  _scanInterval = setInterval(_autoDecodeTick, 400);
  $('scan-overlay').addEventListener('click', _manualDecodeTick);
}

function stopScan() {
  clearInterval(_scanInterval);
  _scanInterval = null;
  $('scan-overlay').removeEventListener('click', _manualDecodeTick);
  if (_scanStream) {
    _scanStream.getTracks().forEach(t => t.stop());
    _scanStream = null;
  }
  $('scan-video').srcObject = null;
  $('scan-overlay').classList.add('hidden');
}

async function _decodeScanCanvas() {
  const video = $('scan-video');
  const canvas = $('scan-canvas');
  if (!video.videoWidth) return null;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  if ('BarcodeDetector' in window) {
    try {
      const bitmap = await createImageBitmap(canvas);
      const hits = await new BarcodeDetector({
        formats: ['code_39', 'code_128', 'qr_code', 'ean_13', 'ean_8', 'upc_a'],
      }).detect(bitmap);
      bitmap.close?.();
      if (hits.length) return hits[0].rawValue.trim();
    } catch (_) {}
  }
  // ZXing via JPEG blob URL (iOS + others without BarcodeDetector)
  try {
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.88));
    const url = URL.createObjectURL(blob);
    try {
      const result = await new ZXingBrowser.BrowserMultiFormatReader(ZXING_HINTS).decodeFromImageUrl(url);
      if (result?.getText()) return result.getText().trim();
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (_) {}
  return null;
}

async function _autoDecodeTick() {
  if (_scanDecoding) return;
  _scanDecoding = true;
  const result = await _decodeScanCanvas().catch(() => null);
  _scanDecoding = false;
  if (result) {
    _onScanSuccess(result);
  } else {
    _scanFailCount++;
    if (_scanFailCount === 10) {
      $('scan-hint').textContent = 'Move closer or tap to scan now';
      $('scan-hint').classList.remove('warn');
    }
  }
}

async function _manualDecodeTick(e) {
  e.stopPropagation();
  clearInterval(_scanInterval);
  _scanDecoding = false;
  const result = await _decodeScanCanvas().catch(() => null);
  if (result) {
    _onScanSuccess(result);
    return;
  }
  $('fi-serial').value = '';
  updateSerialWarnState();
  playSound('scanFail');
  $('scan-hint').textContent = "Couldn't read — try again";
  $('scan-hint').classList.add('warn');
  await new Promise(r => setTimeout(r, 700));
  $('scan-hint').classList.remove('warn');
  $('scan-hint').textContent = "Aim at barcode — tap if it doesn't auto-read";
  _scanDecoding = false;
  _scanInterval = setInterval(_autoDecodeTick, 400);
}

function _onScanSuccess(value) {
  // A fall protection job borrows this scanner, so route the result there
  // instead of into the ladder serial field.
  if (window._fpAwaitScan) {
    window._fpAwaitScan = false;
    playSound('scan');
    stopScan();
    if (typeof fpLookup === 'function') fpLookup(value);
    return;
  }
  $('fi-serial').value = value;
  playSound(updateSerialWarnState() ? 'scanFail' : 'scan');
  stopScan();
}

// Fallback: decode a photo from the OS camera (used only when getUserMedia is denied)
async function _onFallbackPhotoCaptured(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  $('scan-hint').textContent = 'Reading photo…';
  $('scan-hint').classList.remove('warn');
  $('scan-overlay').classList.remove('hidden');
  const code = await _decodeImageFile(file);
  if (code) {
    $('fi-serial').value = code;
    playSound(updateSerialWarnState() ? 'scanFail' : 'scan');
    $('scan-overlay').classList.add('hidden');
  } else {
    $('fi-serial').value = '';
    updateSerialWarnState();
    playSound('scanFail');
    $('scan-hint').textContent = "Couldn't read the barcode — try again";
    $('scan-hint').classList.add('warn');
    await new Promise(r => setTimeout(r, 1100));
    $('scan-hint').classList.remove('warn');
    $('scan-overlay').classList.add('hidden');
    $('scan-photo-input-fallback').click();
  }
}

async function _decodeImageFile(file) {
  if ('BarcodeDetector' in window) {
    try {
      const bitmap = await createImageBitmap(file);
      const hits = await new BarcodeDetector({
        formats: ['code_39', 'code_128', 'qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e'],
      }).detect(bitmap);
      bitmap.close?.();
      if (hits.length) return hits[0].rawValue.trim();
    } catch (_) {}
  }
  try {
    const url = URL.createObjectURL(file);
    try {
      const result = await new ZXingBrowser.BrowserMultiFormatReader(ZXING_HINTS).decodeFromImageUrl(url);
      if (result?.getText()) return result.getText().trim();
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (_) {}
  return null;
}
