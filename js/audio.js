/* Table – sound. Everything is made with the Web Audio API, so there are no sound files. */
const Sfx = (function () {
  let ac, master, buf, muted = false;
  try { muted = localStorage.getItem('table_muted') === '1'; } catch (e) {}

  function unlock() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ac = new AC(); master = ac.createGain(); master.gain.value = .8; master.connect(ac.destination);
      buf = ac.createBuffer(1, ac.sampleRate * .3, ac.sampleRate);
      const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac.state === 'suspended') ac.resume();
  }
  const dest = pan => { if (!ac.createStereoPanner) return master; const p = ac.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0)); p.connect(master); return p; };
  function tone(f, f2, d, v, type, pan, at) {
    const t = ac.currentTime + (at || 0), o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + d);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.001, t + d);
    o.connect(g); g.connect(dest(pan)); o.start(t); o.stop(t + d + .02);
  }
  function burst(freq, q, d, v, pan, type) {
    const t = ac.currentTime, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = buf; f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.001, t + d);
    s.connect(f); f.connect(g); g.connect(dest(pan)); s.start(t, Math.random() * .1); s.stop(t + d + .02);
  }
  const ok = () => ac && !muted;
  const api = {
    unlock,
    get muted() { return muted; },
    toggle() { muted = !muted; try { localStorage.setItem('table_muted', muted ? '1' : '0'); } catch (e) {} return muted; },
    hit(kind, pan) {            // the paddle striking the ball
      if (!ok()) return;
      const big = kind === 'smash';
      burst(big ? 1800 : 2400, 1.2, .05, big ? .7 : .45, pan);
      tone(big ? 760 : 1000, big ? 380 : 620, .07, big ? .3 : .2, 'triangle', pan);
      if (big) tone(210, 70, .16, .4, 'sine', pan);
    },
    bounce(v, pan) {            // the ball on the table
      if (!ok()) return;
      const a = Math.min(.5, .06 + v * .06);
      tone(520, 300, .05, a, 'sine', pan); burst(3600, 2, .025, a * .6, pan);
    },
    net() { if (!ok()) return; burst(500, .7, .14, .35, 0, 'lowpass'); tone(150, 90, .14, .25, 'sine', 0); },
    floor(v) { if (!ok()) return; tone(210, 90, .09, Math.min(.3, .05 + v * .04), 'sine', 0); },
    serve() { if (!ok()) return; tone(1300, 900, .04, .12, 'triangle', 0); },
    point(win) {
      if (!ok()) return;
      if (win) { tone(660, 660, .16, .16, 'sine', 0); tone(880, 880, .24, .16, 'sine', 0, .12); tone(1320, 1320, .3, .1, 'sine', 0, .24); }
      else { tone(330, 200, .3, .16, 'sine', 0); tone(240, 140, .4, .14, 'sine', 0, .15); }
    },
    over(win) {
      if (!ok()) return;
      (win ? [523, 659, 784, 1047] : [392, 330, 262, 196]).forEach((f, i) => tone(f, f, .32, .15, 'triangle', 0, i * .14));
    },
    ui() { if (!ok()) return; tone(900, 900, .04, .08, 'sine', 0); }
  };
  return api;
})();
