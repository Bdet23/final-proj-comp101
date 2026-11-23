'use strict';

/* ==========================================================================
   Sound: short synthesized effects and an ambient loop (Web Audio API, no
   audio files).

   Ambient "campaign headquarters" loop: a low pad with a slow pulse.
   - Starts the first time the player clicks Start tutorial or Play a map
     (browsers block audio until a click), fading in over 2 seconds.
   - One continuous loop for the whole session: new maps and lessons do not
     restart it. It speeds up while the current map is legal.
   - Drops to 40% volume while the start screen is open through Menu.
   - Fades out for an election and fades back in when the results close.
   - Mute silences everything at once; a muted game never starts the loop
     until the player unmutes.
   ========================================================================== */

const Sound = (() => {
  const MUTE_KEY = 'gerrymander.muted';
  const SFX_VOLUME = 0.22;
  const AMBIENT_VOLUME = 0.07;
  const TEMPO = { normal: 60, legal: 80 }; // pulse beats per minute
  const CHORDS = [ // a slow progression of low chords (Hz)
    [110.0, 164.81, 220.0, 277.18],
    [98.0, 146.83, 196.0, 246.94],
    [87.31, 130.81, 174.61, 220.0],
    [98.0, 146.83, 196.0, 233.08],
  ];

  let ctx = null;
  let master = null;
  let sfxBus = null;
  let ambientBus = null;
  let noiseBuffer = null;
  let muted = false;
  try { muted = window.localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { /* storage is optional */ }

  let ambientWanted = false; // the player has started playing
  let scheduler = null;
  let nextBeat = 0;
  let beat = 0;
  let level = 1;             // 1 playing, 0.4 menu, 0 election
  let ducked = false;
  let menuOpen = false;
  let legal = false;

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = SFX_VOLUME;
    sfxBus.connect(master);
    ambientBus = ctx.createGain();
    ambientBus.gain.value = 0;
    ambientBus.connect(master);
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return true;
  }

  // One enveloped oscillator note.
  function tone({ freq, to = null, type = 'sine', start = 0, dur = 0.12, vol = 0.5, attack = 0.005, bus = sfxBus, at = null }) {
    const t0 = at ?? ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(bus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noise({ start = 0, dur = 0.06, vol = 0.3, freq = 900 }) {
    const t0 = ctx.currentTime + start;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(sfxBus);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  const effects = {
    paint: () => tone({ freq: 880, type: 'triangle', dur: 0.05, vol: 0.25 }),
    erase: () => tone({ freq: 440, type: 'triangle', dur: 0.06, vol: 0.22 }),
    legal: () => {
      tone({ freq: 660, dur: 0.14, vol: 0.3 });
      tone({ freq: 990, start: 0.1, dur: 0.25, vol: 0.3 });
    },
    buzz: () => tone({ freq: 140, type: 'sawtooth', dur: 0.3, vol: 0.2 }),
    tick: () => tone({ freq: 1600, type: 'square', dur: 0.02, vol: 0.08 }),
    thud: () => tone({ freq: 120, to: 45, dur: 0.3, vol: 0.6 }),
    event: () => {
      tone({ freq: 784, dur: 0.18, vol: 0.18 });
      tone({ freq: 1046.5, start: 0.12, dur: 0.3, vol: 0.18 });
    },
    drumroll: () => {
      for (let i = 0; i < 16; i++) noise({ start: i * 0.06, dur: 0.05, vol: 0.12 + i * 0.015, freq: 700 + i * 30 });
    },
    fanfare: (start = 0) => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone({ freq: f, type: 'triangle', start: start + i * 0.12, dur: i === 3 ? 0.6 : 0.16, vol: 0.35 }));
    },
    fall: (start = 0) => tone({ freq: 392, to: 165, type: 'triangle', start, dur: 0.9, vol: 0.35 }),
  };

  function play(name, ...args) {
    if (muted || !ensure()) return;
    effects[name](...args);
  }

  // Results: the ambient loop fades out, a drum-roll, then a win or loss sting.
  function election(won) {
    duck();
    if (muted || !ensure()) return;
    effects.drumroll();
    if (won) effects.fanfare(1.05); else effects.fall(1.05);
  }

  // ---------- Ambient loop ----------
  function playBeat(t, b) {
    // the slow pulse: a soft, low thump
    tone({ freq: 70, to: 42, dur: 0.45, vol: 0.55, at: t, bus: ambientBus });
    // the pad: a new chord every 8 beats, fading in and out under the pulse
    if (b % 8 === 0) {
      const spb = 60 / (legal ? TEMPO.legal : TEMPO.normal);
      const len = spb * 8;
      const chord = CHORDS.at((b / 8) % CHORDS.length);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      filter.connect(ambientBus);
      for (const f of chord) {
        for (const detune of [-4, 4]) {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.value = f;
          osc.detune.value = detune;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(0.09, t + Math.min(1.5, len / 3));
          g.gain.setValueAtTime(0.09, t + len - 0.5);
          g.gain.linearRampToValueAtTime(0.0001, t + len + 1.2);
          osc.connect(g).connect(filter);
          osc.start(t);
          osc.stop(t + len + 1.3);
        }
      }
    }
  }

  function schedule() {
    const spb = 60 / (legal ? TEMPO.legal : TEMPO.normal);
    while (nextBeat < ctx.currentTime + 0.3) {
      playBeat(nextBeat, beat);
      nextBeat += spb;
      beat++;
    }
  }

  function applyLevel(fade) {
    if (!ctx) return;
    const target = ambientWanted && !muted ? AMBIENT_VOLUME * level : 0;
    const now = ctx.currentTime;
    ambientBus.gain.cancelScheduledValues(now);
    ambientBus.gain.setValueAtTime(ambientBus.gain.value, now);
    ambientBus.gain.linearRampToValueAtTime(target, now + fade);
  }

  function runLoop() {
    if (scheduler || muted || !ensure()) return;
    nextBeat = ctx.currentTime + 0.1;
    scheduler = setInterval(schedule, 100);
    schedule();
  }

  // Called on the first click of Start tutorial or Play a map.
  function startAmbient() {
    ambientWanted = true;
    if (muted) return;
    runLoop();
    level = menuOpen ? 0.4 : 1;
    applyLevel(2);
  }

  function duck() {
    ducked = true;
    level = 0;
    applyLevel(0.6);
  }

  function resume() {
    if (!ducked) return;
    ducked = false;
    level = menuOpen ? 0.4 : 1;
    applyLevel(2);
  }

  function setMenuOpen(open) {
    menuOpen = open;
    if (ducked) return;
    level = open ? 0.4 : 1;
    applyLevel(1);
  }

  function setLegal(v) {
    legal = !!v;
  }

  function setMuted(m) {
    muted = !!m;
    try { window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* optional */ }
    if (ctx) master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02);
    if (!muted && ambientWanted) {
      runLoop();
      applyLevel(1);
    }
  }

  return {
    play, election, startAmbient, duck, resume, setMenuOpen, setLegal, setMuted,
    isMuted: () => muted,
    // for tests
    state: () => ({ ctx: ctx ? ctx.state : null, ambientWanted, looping: !!scheduler, level, muted, legal }),
  };
})();
