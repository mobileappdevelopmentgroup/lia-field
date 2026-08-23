// Lia Field — sound.js
//
// Feedback sounds, synthesised with WebAudio so nothing has to be bundled.
//
// Part of the field app, split out of index.html. These are CLASSIC scripts,
// not modules: top-level bindings are shared across all of them, load order is
// the order in index.html, and there is no build step. Modules would need a
// server, and the app has to run from file:// and from a Capacitor bundle.

// ── Sound system ──────────────────────────────────────────────────────────────
function loadSounds() {
  try { return JSON.parse(localStorage.getItem('lia-sounds') || '{}'); } catch { return {}; }
}
function saveSounds(s) { localStorage.setItem('lia-sounds', JSON.stringify(s)); }
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}
const _soundDefs = {
  ding: ctx => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    o.start(); o.stop(ctx.currentTime + 0.45);
  },
  beep: ctx => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'square'; o.frequency.value = 1200;
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    o.start(); o.stop(ctx.currentTime + 0.1);
  },
  double: ctx => {
    [0, 0.14].forEach(d => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'square'; o.frequency.value = 1200;
      g.gain.setValueAtTime(0, ctx.currentTime + d);
      g.gain.linearRampToValueAtTime(0.12, ctx.currentTime + d + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + d + 0.1);
      o.start(ctx.currentTime + d); o.stop(ctx.currentTime + d + 0.12);
    });
  },
  chime: ctx => {
    [[880,0],[1100,0.12],[1320,0.24]].forEach(([f,d]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.18, ctx.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + d + 0.35);
      o.start(ctx.currentTime + d); o.stop(ctx.currentTime + d + 0.36);
    });
  },
  buzz: ctx => {
    // Low descending buzz — deliberately the opposite character of the
    // bright success tones, so a failed scan is unmistakable by ear alone.
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(320, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(140, ctx.currentTime + 0.3);
    g.gain.setValueAtTime(0.16, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.34);
    o.start(); o.stop(ctx.currentTime + 0.34);
  }
};
function playSound(event) {
  const prefs = loadSounds();
  const defaults = { ladder: 'chime', scanFail: 'buzz' };
  const choice = prefs[event] ?? defaults[event] ?? 'beep';
  if (choice === 'none') return;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume().then(() => _soundDefs[choice]?.(ctx));
    else _soundDefs[choice]?.(ctx);
  } catch(_) {}
}
