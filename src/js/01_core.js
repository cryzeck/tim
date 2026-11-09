// ============================================================================
//  THE IMPROBABLE APPARATUS — a 3D chain-reaction workshop
//  Core: imports, constants, helpers, audio synthesis, persistence
// ============================================================================
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const G = 15;                 // gravity (cells / s^2) — a little brisk, feels toy-like
const DT = 1 / 240;           // fixed physics step: deterministic & tunnel-proof
const MAX_RUN_TIME = 90;      // seconds of machine time before we stop caring
const TAU = Math.PI * 2;
const CHANNELS = ['red', 'blue', 'green', 'yellow'];
const CH_HEX = { red: 0xe5483b, blue: 0x2e7fe0, green: 0x2fae58, yellow: 0xf3c331 };
const CH_CSS = { red: '#e5483b', blue: '#2e7fe0', green: '#2fae58', yellow: '#f3c331' };
const CH_LABEL = { red: 'Rød', blue: 'Blå', green: 'Grønn', yellow: 'Gul' };
const CH_ADJ = { red: 'rød', blue: 'blå', green: 'grønn', yellow: 'gul' };       // en rød plate
const CH_DEF = { red: 'røde', blue: 'blå', green: 'grønne', yellow: 'gule' };   // den røde ledningen

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

// Rotate a local (x,z) offset by r quarter turns, matching THREE rotation.y = r*PI/2
function rotXZ(x, z, r) {
  switch (((r % 4) + 4) % 4) {
    case 0: return [x, z];
    case 1: return [z, -x];
    case 2: return [-x, -z];
    default: return [-z, x];
  }
}

// Small deterministic RNG (mulberry32) for procedural textures & cosmetic jitter
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('improbable.' + key); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('improbable.' + key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }
};

// ----------------------------------------------------------------------------
//  Audio: everything is synthesised on the fly with WebAudio — no samples.
// ----------------------------------------------------------------------------
const Sound = (() => {
  // Two buses into one master: effects and music can be switched off separately.
  // (New storage keys on purpose: an old saved "muted" flag no longer silences everything.)
  let ctx = null, master = null, sfx = null, music = null, noiseBuf = null;
  let sfxOff = store.get('sfxOff', false);
  let musicOff = store.get('musicOff', false);
  let lastHit = 0, hitBudget = 0;
  let hum = null, ducked = false, unlocked = false;
  const MUSIC_VOL = 0.75, MUSIC_DUCK = 0.38;

  function ensure() {
    if (!ctx) {
      try {
        // iPad/iPhone: Web Audio is silenced by the ring/silent switch unless the page
        // asks for the "playback" audio session (Safari 17+).
        try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
        master = ctx.createGain();
        master.gain.value = 0.6;
        master.connect(comp); comp.connect(ctx.destination);
        sfx = ctx.createGain(); sfx.gain.value = sfxOff ? 0 : 1; sfx.connect(master);
        music = ctx.createGain(); music.gain.value = musicOff ? 0 : MUSIC_VOL; music.connect(master);
        const len = ctx.sampleRate;
        noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        const r = rng(7);
        for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
      } catch (e) { ctx = null; }
    }
    // 'suspended' before the first tap, 'interrupted' on iOS after a call or app switch
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && !document.hidden) ctx.resume().catch(() => {});
    return ctx;
  }

  // Must run inside a user gesture: iOS only starts audio from touchend/click/keydown.
  function gestureUnlock() {
    if (!ensure()) return;
    if (!unlocked) {
      unlocked = true;
      try { // a one-sample silent buffer is the classic iOS kick-start
        const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination); s.start(0);
      } catch (e) { /* ignore */ }
    }
    if (!musicOff) Music.start();
  }
  for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) window.addEventListener(ev, gestureUnlock, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) { Music.stop(); ctx.suspend().catch(() => {}); }
    else { ctx.resume().catch(() => {}); if (!musicOff && unlocked) Music.start(); }
  });

  function tone({ f = 440, f2 = null, type = 'sine', dur = 0.2, vol = 0.25, attack = 0.003, delay = 0, q = null, lp = null, at = null, out = null }) {
    if (!ctx || (!out && sfxOff)) return;
    const t0 = at ?? ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = o;
    if (lp) { const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lp; if (q) fl.Q.value = q; o.connect(fl); node = fl; }
    node.connect(g); g.connect(out || sfx);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  function noise({ dur = 0.1, vol = 0.2, f = 1000, f2 = null, q = 1, type = 'bandpass', delay = 0, attack = 0.002, at = null, out = null }) {
    if (!ctx || (!out && sfxOff)) return;
    const t0 = at ?? ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const fl = ctx.createBiquadFilter();
    fl.type = type; fl.frequency.setValueAtTime(f, t0); fl.Q.value = q;
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(fl); fl.connect(g); g.connect(out || sfx);
    src.start(t0, Math.random() * 0.5); src.stop(t0 + dur + 0.05);
  }

  // --------------------------------------------------------------------------
  //  Music: a cheerful little workshop tune, sequenced live (no audio files).
  //  16 bars in C major, 8 swung eighth-notes per bar, looping.
  // --------------------------------------------------------------------------
  const Music = (() => {
    const _ = null;
    const CHORDS = ['C', 'Am', 'F', 'G', 'C', 'Am', 'Dm', 'G', 'F', 'G', 'Em', 'Am', 'F', 'G', 'C', 'C'];
    const TRIAD = { C: [60, 64, 67], Am: [57, 60, 64], F: [53, 57, 60], G: [55, 59, 62], Dm: [50, 53, 57], Em: [52, 55, 59] };
    const ROOT = { C: 48, Am: 45, F: 41, G: 43, Dm: 50, Em: 40 };
    const MELODY = [
      [76, _, 79, _, 81, 79, 76, _], [72, _, 76, _, 74, 72, 69, _], [69, _, 72, _, 77, _, 76, 72], [74, _, _, 71, 74, _, 79, _],
      [76, _, 79, _, 84, _, 79, 76], [81, _, 79, _, 76, _, 72, _], [74, 77, 81, _, 79, 77, 74, _], [71, _, 74, _, 67, _, _, _],
      [72, 72, 69, 72, 77, _, 76, _], [74, 74, 71, 74, 79, _, 77, _], [76, _, 79, _, 83, _, 79, _], [81, _, _, 79, 76, _, 72, _],
      [77, _, 76, _, 72, _, 69, _], [67, _, 71, _, 74, _, 77, _], [76, _, 74, _, 72, _, _, _], [_, _, 67, _, 72, _, _, _]
    ];
    const BPM = 104, EIGHTH = 60 / BPM / 2, SWING = 0.14;
    const hz = m => 440 * Math.pow(2, (m - 69) / 12);
    let timer = 0, step = 0, next = 0;

    function playStep(s, t) {
      const bar = Math.floor(s / 8) % 16, e = s % 8;
      const ch = CHORDS[bar], root = ROOT[ch];
      const m = MELODY[bar][e];
      if (m) { // plucky lead + a soft glockenspiel octave on top
        tone({ f: hz(m), type: 'triangle', dur: 0.32, vol: 0.085, attack: 0.006, at: t, out: music });
        tone({ f: hz(m + 12), type: 'sine', dur: 0.22, vol: 0.022, attack: 0.003, at: t, out: music });
      }
      if (e === 0 || e === 4) tone({ f: hz(root), type: 'triangle', dur: 0.3, vol: 0.13, lp: 700, at: t, out: music });
      if (e === 3 || e === 7) tone({ f: hz(root + (e === 3 ? 7 : 12)), type: 'triangle', dur: 0.14, vol: 0.07, lp: 700, at: t, out: music });
      if (e === 2 || e === 6) for (const n of TRIAD[ch]) tone({ f: hz(n + 12), type: 'sine', dur: 0.14, vol: 0.022, attack: 0.004, at: t, out: music });
      if (e === 0) tone({ f: 120, f2: 48, type: 'sine', dur: 0.16, vol: 0.09, at: t, out: music });
      noise({ dur: 0.035, vol: e % 2 ? 0.022 : 0.011, f: 7500, q: 0.7, type: 'highpass', at: t, out: music });
    }
    function tick() {
      if (!ctx) return;
      const now = ctx.currentTime;
      if (next < now - 0.25) next = now + 0.05; // after a stall, skip ahead instead of bursting
      while (next < now + 0.15) {
        playStep(step, next + (step % 2 ? EIGHTH * SWING : 0));
        next += EIGHTH;
        step = (step + 1) % 128;
      }
    }
    return {
      start() { if (timer || !ctx) return; next = ctx.currentTime + 0.08; timer = setInterval(tick, 25); tick(); },
      stop() { clearInterval(timer); timer = 0; },
      get playing() { return !!timer; }
    };
  })();

  const api = {
    unlock() { gestureUnlock(); },
    get muted() { return sfxOff; },
    setMuted(m) {
      sfxOff = m; store.set('sfxOff', m);
      if (sfx) sfx.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.02);
      if (m) api.setHum(0);
    },
    get musicOff() { return musicOff; },
    get debug() { return { state: ctx && ctx.state, music: Music.playing, unlocked }; },
    setMusic(on) {
      musicOff = !on; store.set('musicOff', musicOff);
      if (music) music.gain.setTargetAtTime(on ? (ducked ? MUSIC_DUCK : MUSIC_VOL) : 0, ctx.currentTime, 0.05);
      if (on) gestureUnlock(); else Music.stop();
    },
    // Quieter music while a machine runs, so the clacks and dings come through.
    duck(on) {
      ducked = on;
      if (music && !musicOff) music.gain.setTargetAtTime(on ? MUSIC_DUCK : MUSIC_VOL, ctx.currentTime, 0.3);
    },
    click() { if (!ensure()) return; tone({ f: 1800, f2: 900, type: 'triangle', dur: 0.05, vol: 0.12 }); },
    hover() { if (!ensure()) return; tone({ f: 2400, type: 'sine', dur: 0.03, vol: 0.03 }); },
    pickup() { if (!ensure()) return; tone({ f: 300, f2: 620, type: 'triangle', dur: 0.12, vol: 0.18 }); },
    place() {
      if (!ensure()) return;
      noise({ dur: 0.08, vol: 0.35, f: 900, q: 2 });
      tone({ f: 180, f2: 90, type: 'sine', dur: 0.12, vol: 0.3 });
    },
    rotate() { if (!ensure()) return; tone({ f: 1200, f2: 1500, type: 'square', dur: 0.04, vol: 0.05, lp: 3000 }); },
    nope() { if (!ensure()) return; tone({ f: 220, f2: 160, type: 'sawtooth', dur: 0.16, vol: 0.12, lp: 900 }); },
    remove() { if (!ensure()) return; tone({ f: 600, f2: 200, type: 'triangle', dur: 0.15, vol: 0.15 }); },
    start() {
      if (!ensure()) return;
      [392, 523, 659].forEach((f, i) => tone({ f, type: 'triangle', dur: 0.18, vol: 0.14, delay: i * 0.06 }));
      noise({ dur: 0.4, vol: 0.06, f: 400, f2: 3000, q: 0.8 });
    },
    reset() { if (!ensure()) return; [659, 523, 392].forEach((f, i) => tone({ f, type: 'triangle', dur: 0.12, vol: 0.1, delay: i * 0.05 })); },
    // Physical impacts — pitched and filtered by material, scaled by impact speed
    hit(mat, speed) {
      if (!ctx || sfxOff) return;
      const now = performance.now();
      if (now - lastHit > 60) { hitBudget = 0; lastHit = now; }
      if (hitBudget++ > 6) return;
      const v = clamp((speed - 0.6) / 7, 0.02, 1);
      const vol = 0.05 + v * 0.4;
      switch (mat) {
        case 'metal':
          tone({ f: 1700 + Math.random() * 600, type: 'sine', dur: 0.25, vol: vol * 0.35 });
          tone({ f: 4300 + Math.random() * 900, type: 'sine', dur: 0.12, vol: vol * 0.15 });
          noise({ dur: 0.03, vol: vol * 0.4, f: 5000, q: 3 });
          break;
        case 'rubber':
          tone({ f: 220 + v * 120, f2: 120, type: 'sine', dur: 0.12, vol: vol * 0.6 });
          break;
        case 'domino':
          noise({ dur: 0.035, vol: vol * 0.7, f: 2600 + Math.random() * 800, q: 6 });
          tone({ f: 1100 + Math.random() * 300, type: 'triangle', dur: 0.04, vol: vol * 0.2 });
          break;
        case 'soft':
          noise({ dur: 0.08, vol: vol * 0.3, f: 500, q: 0.7, type: 'lowpass' });
          break;
        case 'heavy':
          tone({ f: 90, f2: 45, type: 'sine', dur: 0.25, vol: vol * 0.9 });
          noise({ dur: 0.1, vol: vol * 0.5, f: 400, q: 1 });
          break;
        default: // wood
          noise({ dur: 0.06, vol: vol * 0.6, f: 700 + Math.random() * 500, q: 4 });
          tone({ f: 260 + Math.random() * 120, f2: 140, type: 'triangle', dur: 0.08, vol: vol * 0.35 });
      }
    },
    bell() {
      if (!ensure()) return;
      const base = 880;
      [[1, 0.3, 2.2], [2.76, 0.12, 1.4], [5.4, 0.06, 0.8], [8.93, 0.04, 0.5], [0.5, 0.08, 1.8]].forEach(([m, v, d]) =>
        tone({ f: base * m, type: 'sine', dur: d, vol: v, attack: 0.002 }));
    },
    pop() {
      if (!ensure()) return;
      noise({ dur: 0.12, vol: 0.7, f: 1800, q: 0.6, type: 'highpass' });
      tone({ f: 120, f2: 50, type: 'sine', dur: 0.1, vol: 0.4 });
    },
    boing() {
      if (!ensure()) return;
      tone({ f: 140, f2: 520, type: 'sine', dur: 0.22, vol: 0.28 });
      tone({ f: 280, f2: 1040, type: 'triangle', dur: 0.15, vol: 0.06 });
    },
    bumper() {
      if (!ensure()) return;
      tone({ f: 660, f2: 990, type: 'square', dur: 0.09, vol: 0.12, lp: 2500 });
      tone({ f: 1320, type: 'sine', dur: 0.2, vol: 0.08, delay: 0.03 });
    },
    press() {
      if (!ensure()) return;
      tone({ f: 900, type: 'square', dur: 0.05, vol: 0.08, lp: 2000 });
      tone({ f: 1350, type: 'sine', dur: 0.25, vol: 0.12, delay: 0.05 });
    },
    whoosh() { if (!ensure()) return; noise({ dur: 0.35, vol: 0.3, f: 300, f2: 2400, q: 1.2 }); },
    thunk() {
      if (!ensure()) return;
      tone({ f: 140, f2: 60, type: 'sine', dur: 0.18, vol: 0.5 });
      noise({ dur: 0.06, vol: 0.4, f: 1200, q: 1.5 });
    },
    zap() {
      if (!ensure()) return;
      tone({ f: 80, f2: 2000, type: 'sawtooth', dur: 0.18, vol: 0.06, lp: 4000 });
      tone({ f: 1046, type: 'sine', dur: 0.3, vol: 0.1, delay: 0.08 });
    },
    goal() {
      if (!ensure()) return;
      [784, 988, 1175].forEach((f, i) => tone({ f, type: 'triangle', dur: 0.22, vol: 0.14, delay: i * 0.07 }));
    },
    win() {
      if (!ensure()) return;
      const notes = [523, 659, 784, 1046, 784, 1046, 1318];
      notes.forEach((f, i) => {
        tone({ f, type: 'triangle', dur: 0.32, vol: 0.16, delay: i * 0.1 });
        tone({ f: f / 2, type: 'sine', dur: 0.32, vol: 0.1, delay: i * 0.1 });
      });
      noise({ dur: 0.9, vol: 0.08, f: 6000, q: 0.5, type: 'highpass', delay: 0.5 });
    },
    // Continuous whirr for fans & belts while they run
    setHum(level) {
      if (!ctx || sfxOff) { if (hum) { hum.g.gain.setTargetAtTime(0, ctx ? ctx.currentTime : 0, 0.05); } return; }
      if (!hum && level > 0) {
        const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
        const fl = ctx.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = 340; fl.Q.value = 0.9;
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 72;
        const og = ctx.createGain(); og.gain.value = 0.04;
        const lfo = ctx.createBiquadFilter(); lfo.type = 'lowpass'; lfo.frequency.value = 300;
        const g = ctx.createGain(); g.gain.value = 0;
        src.connect(fl); fl.connect(g); o.connect(lfo); lfo.connect(og); og.connect(g); g.connect(sfx);
        src.start(); o.start();
        hum = { g };
      }
      if (hum) hum.g.gain.setTargetAtTime(clamp(level, 0, 1) * 0.16, ctx.currentTime, 0.12);
    }
  };
  return api;
})();
