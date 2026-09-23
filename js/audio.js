/* Table – sound.

   Impacts are real clips from assets/audio/sfx/, pitched and levelled a little differently every
   time so a rally does not turn into the same click repeating. Music is a shuffled playlist that
   never runs out: when it reaches the end it reshuffles and keeps going.

   Everything hangs off three gain buses — master, music and effects — so the settings panel can move
   one without touching the others, and the arena can duck the music without touching effects.

   If a clip is missing the old oscillator version of that sound plays instead, so a half-finished
   assets/audio/ folder still leaves the game playable rather than silent. */
const Sfx = (function () {
  const KEY = 'table_audio';
  const DUCK = 0.05;          // music drops to this while a match is on, so you can hear the ball
  const settings = { muted: false, music: 0.55, sfx: 0.9 };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (typeof saved.muted === 'boolean') settings.muted = saved.muted;
    if (typeof saved.music === 'number') settings.music = clamp01(saved.music);
    if (typeof saved.sfx === 'number') settings.sfx = clamp01(saved.sfx);
  } catch (e) { /* private mode, or an older build's value */ }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  let ac, master, musicBus, sfxBus, noiseBuf;
  let ducked = false, loading = null;
  const buffers = Object.create(null);
  let manifest = { sfx: {}, music: [] };
  const watchers = [];
  const announce = () => watchers.forEach(f => { try { f(read()); } catch (e) { Err.log(e, 'sound settings'); } });

  /* ---------- wiring ---------- */
  function unlock() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ac = new AC();
      master = ac.createGain(); master.connect(ac.destination);
      musicBus = ac.createGain(); musicBus.connect(master);
      sfxBus = ac.createGain(); sfxBus.connect(master);
      noiseBuf = ac.createBuffer(1, ac.sampleRate * .3, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      applyVolumes(0);
      load();
    }
    if (ac.state === 'suspended') ac.resume();
    startMusic();                 // browsers only allow this from inside a real tap or click
  }
  function applyVolumes(ramp) {
    if (!ac) return;
    const t = ac.currentTime, r = ramp === undefined ? .12 : ramp;
    const set = (p, v) => { p.cancelScheduledValues(t); p.setTargetAtTime(v, t, Math.max(.001, r / 3)); };
    set(master.gain, settings.muted ? 0 : 1);
    set(sfxBus.gain, settings.sfx);
    set(musicBus.gain, settings.music * (ducked ? DUCK : 1));
  }

  /* ---------- clips ---------- */
  function load() {
    if (loading) return loading;
    // Not force-cache: the manifest changes whenever a track is added, and a stale copy would
    // silently leave the new music out of the playlist.
    loading = fetch('assets/audio/manifest.json')
      .then(r => r.ok ? r.json() : { sfx: {}, music: [] })
      .then(m => {
        manifest = { sfx: m.sfx || {}, music: m.music || [] };
        return Promise.all(Object.keys(manifest.sfx).map(name =>
          fetch(manifest.sfx[name])
            .then(r => r.arrayBuffer())
            .then(b => new Promise((res, rej) => ac.decodeAudioData(b, res, rej)))
            .then(b => { buffers[name] = b; })
            .catch(e => Err.log(e, 'load sound ' + name))));
      })
      .catch(e => Err.log(e, 'load sound manifest'));
    return loading;
  }
  // Where a one-shot sound should be plugged in: through a panner when the browser has one.
  function toSfx(pan) {
    if (!ac.createStereoPanner) return sfxBus;
    const p = ac.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan || 0));
    p.connect(sfxBus);
    return p;
  }
  // Some clips carry silence before the transient and a long tail of nothing after it. Starting a
  // little way in keeps the hit instant instead of arriving late, and stopping early hands the node
  // back rather than holding seconds of silence open on every shot of a rally.
  // Measured from the file: ball.mp3 is 4.03 s long but only 0.02–0.58 s of it makes any sound.
  const TRIM = { ball: { at: 0.018, len: 0.62 } };

  // Small random moves in pitch and level are what stop twenty identical clicks in one rally.
  function play(name, pan, gain, rate) {
    const b = buffers[name];
    if (!ac || settings.muted || !b) return false;
    const src = ac.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = Math.max(.25, rate || 1);
    const g = ac.createGain();
    g.gain.value = Math.max(0, gain === undefined ? 1 : gain);
    src.connect(g);
    g.connect(toSfx(pan));
    const t = TRIM[name];
    if (t) src.start(0, t.at, t.len); else src.start();
    return true;
  }
  const wobble = spread => 1 + (Math.random() - .5) * spread;

  /* ---------- the oscillator fallbacks, used only when a clip is missing ---------- */
  function tone(f, f2, d, v, type, pan, at) {
    const t = ac.currentTime + (at || 0), o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + d);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.001, t + d);
    o.connect(g); g.connect(toSfx(pan)); o.start(t); o.stop(t + d + .02);
  }
  function burst(freq, q, d, v, pan, type) {
    const t = ac.currentTime, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuf; f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.001, t + d);
    s.connect(f); f.connect(g); g.connect(toSfx(pan)); s.start(t, Math.random() * .1); s.stop(t + d + .02);
  }
  const live = () => ac && !settings.muted;

  /* ---------- music ---------- */
  const music = { el: null, order: [], at: 0, started: false };
  function shuffle(n, avoidFirst) {
    const a = [];
    for (let i = 0; i < n; i++) a.push(i);
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    if (a.length > 1 && a[0] === avoidFirst) { const t = a[0]; a[0] = a[1]; a[1] = t; }   // no track twice in a row
    return a;
  }
  function startMusic() {
    if (music.started || !ac) return;
    (loading || Promise.resolve()).then(() => {
      if (music.started || !manifest.music.length) return;
      music.started = true;
      music.el = new Audio();
      music.el.preload = 'auto';
      try { ac.createMediaElementSource(music.el).connect(musicBus); }
      catch (e) { Err.log(e, 'connect music'); }
      // A missing or unplayable track must not end the playlist, so both events move on.
      music.el.addEventListener('ended', next);
      music.el.addEventListener('error', () => { Err.log(new Error('track failed: ' + music.el.src), 'music'); next(); });
      music.order = shuffle(manifest.music.length, -1);
      music.at = 0;
      next(true);
    });
  }
  function next(first) {
    if (!music.el || !manifest.music.length) return;
    if (!first) music.at++;
    if (music.at >= music.order.length) {                 // round again, in a new order
      music.order = shuffle(manifest.music.length, music.order[music.order.length - 1]);
      music.at = 0;
    }
    music.el.src = manifest.music[music.order[music.at]];
    const p = music.el.play();
    if (p && p.catch) p.catch(e => { if (!/NotAllowed/i.test(e && e.name || '')) Err.log(e, 'play music'); });
  }

  /* ---------- what the rest of the game calls ---------- */
  const read = () => ({ muted: settings.muted, music: settings.music, sfx: settings.sfx });
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(read())); } catch (e) { /* private mode */ }
    applyVolumes();
    announce();
  }

  return {
    unlock,
    get muted() { return settings.muted; },
    get settings() { return read(); },
    // What is on now, so the settings panel can show it and a test can check music really started.
    get track() {
      if (!music.el || !music.el.src) return null;
      const file = decodeURIComponent(music.el.src.split('/').pop() || '');
      return { name: file.replace(/\.[a-z0-9]+$/i, ''), playing: !music.el.paused, at: music.el.currentTime,
               index: music.at + 1, of: manifest.music.length };
    },
    skip() { if (music.el) next(); },
    onChange(f) { watchers.push(f); },
    toggle() { settings.muted = !settings.muted; save(); return settings.muted; },
    setMuted(v) { settings.muted = !!v; save(); },
    setMusic(v) { settings.music = clamp01(v); save(); },
    setSfx(v) { settings.sfx = clamp01(v); save(); },
    // The arena drops the music right down so the ball is the loudest thing in the room.
    duck(on) { if (ducked === !!on) return; ducked = !!on; applyVolumes(.6); },

    hit(kind, pan, power) {
      if (!live()) return;
      const p = Math.max(0, Math.min(1, power === undefined ? (kind === 'smash' ? 1 : .4) : power));
      // ball.mp3 is the recorded bat strike; the three generated ones stand in if it is not there.
      const clip = buffers['ball'] ? 'ball'
        : kind === 'smash' || p > .72 ? 'hit-hard' : p > .35 ? 'hit-medium' : 'hit-soft';
      // Harder hits sit a touch lower and louder, the way a heavier strike actually does.
      if (play(clip, pan, .55 + p * .45, wobble(.10) * (1.04 - p * .1))) return;
      const big = kind === 'smash';
      burst(big ? 1800 : 2400, 1.2, .05, big ? .7 : .45, pan);
      tone(big ? 760 : 1000, big ? 380 : 620, .07, big ? .3 : .2, 'triangle', pan);
      if (big) tone(210, 70, .16, .4, 'sine', pan);
    },
    bounce(v, pan) {
      if (!live()) return;
      const hard = Math.max(0, Math.min(1, (v || 0) / 6));
      if (play('bounce-table', pan, .35 + hard * .55, wobble(.14) * (1.06 - hard * .12))) return;
      const a = Math.min(.5, .06 + v * .06);
      tone(520, 300, .05, a, 'sine', pan); burst(3600, 2, .025, a * .6, pan);
    },
    net(pan) {
      if (!live()) return;
      if (play('net', pan, .8, wobble(.12))) return;
      burst(500, .7, .14, .35, 0, 'lowpass'); tone(150, 90, .14, .25, 'sine', 0);
    },
    floor(v, pan) {
      if (!live()) return;
      const hard = Math.max(0, Math.min(1, (v || 0) / 6));
      if (play('floor', pan, .3 + hard * .5, wobble(.12))) return;
      tone(210, 90, .09, Math.min(.3, .05 + v * .04), 'sine', 0);
    },
    serve(pan) {
      if (!live()) return;
      if (play('serve', pan, .6, wobble(.08))) return;
      tone(1300, 900, .04, .12, 'triangle', 0);
    },
    point(win) {
      if (!live()) return;
      if (play(win ? 'point-won' : 'point-lost', 0, .8, 1)) return;
      if (win) { tone(660, 660, .16, .16, 'sine', 0); tone(880, 880, .24, .16, 'sine', 0, .12); tone(1320, 1320, .3, .1, 'sine', 0, .24); }
      else { tone(330, 200, .3, .16, 'sine', 0); tone(240, 140, .4, .14, 'sine', 0, .15); }
    },
    over(win) {
      if (!live()) return;
      if (play(win ? 'match-won' : 'match-lost', 0, .9, 1)) return;
      (win ? [523, 659, 784, 1047] : [392, 330, 262, 196]).forEach((f, i) => tone(f, f, .32, .15, 'triangle', 0, i * .14));
    },
    ui() {
      if (!live()) return;
      if (play('ui', 0, .5, wobble(.06))) return;
      tone(900, 900, .04, .08, 'sine', 0);
    }
  };
})();
