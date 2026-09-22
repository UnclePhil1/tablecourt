/* Runs js/core.js headless and checks the rules, both against the CPU and in an online 1v1.
   No browser, no network, no database. Run it with:  node tools/test_rules.js            */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');

function load() {
  const ctx = vm.createContext({ Math, console });
  // core.js declares with const at the top level, which vm does not expose on the global object,
  // so re-export what the tests need from inside the same script scope.
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/core.js'), 'utf8')
    + '\n;this.X = { S, P, C, ball, hooks, PZ, LEVELS };', ctx);
  const ev = [];
  ctx.X.hooks.ui = () => {};
  ctx.X.hooks.event = (n, d) => ev.push([n, d]);
  return { g: ctx, X: ctx.X, ev };
}

// A fallible person: aims where the ball will arrive, with a fresh error each exchange.
function player(miss) {
  let at = -1, off = 0;
  return (g, X, side, key) => {
    const S = X.S, pad = side > 0 ? X.P : X.C;
    if (S.state === 'rally' && S.rally.h === -side) {
      if (at !== key()) { at = key(); off = Math.random() < miss ? (Math.random() - .5) * 1.1 : (Math.random() - .5) * .2; }
      const p = g.predict(side * X.PZ);
      if (p) { pad.tx = p.x + off; pad.ty = p.y; }
    } else { pad.tx = 0; pad.ty = side > 0 ? .25 : .3; at = -1; }
  };
}

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

/* ---------- 1. vs CPU, every level ---------- */
[0, 1, 2].forEach(level => {
  const { g, X, ev } = load();
  const S = X.S;
  g.startMatch(false); g.setLevel(level);
  const me = player(.16);
  let guard = 0;
  while (S.state !== 'over' && guard++ < 300000) {
    me(g, X, 1, () => S.hits);
    if (S.state === 'serve' && g.server() === 1 && S.timer <= 0) g.tap();
    g.frame(1 / 60);
  }
  const cpuHits = ev.filter(e => e[0] === 'hit' && e[1].s < 0).length;
  const name = X.LEVELS[level].n;
  check(S.state === 'over', name + ': match never finished');
  check(Math.max(...S.score) >= 11 && Math.abs(S.score[0] - S.score[1]) >= 2, name + ': bad final score ' + S.score);
  check(cpuHits >= 10, name + ': CPU barely returned anything (' + cpuHits + ')');
  check(S.vs === false && S.me === 1, name + ': versus state leaked into the CPU game');
  console.log('  vs CPU ' + name.padEnd(7) + ' ' + String(S.score[0]).padStart(2) + ' - ' + S.score[1] + '   cpu returns: ' + cpuHits);
});

/* ---------- 2. online 1v1 ---------- */
{
  const { g, X, ev } = load();
  const S = X.S;
  g.startVersus({ me: 1, remote: false, target: 11, hostName: 'host_a', guestName: 'guest_b' });
  const near = player(.16), far = player(.16);
  let hostServes = 0, guestServes = 0, guard = 0;
  while (S.state !== 'over' && guard++ < 300000) {
    near(g, X, 1, () => S.hits);
    far(g, X, -1, () => S.hits);
    if (S.state === 'serve' && S.timer <= 0) {
      if (g.server() === 1) { hostServes++; g.tap(); }
      else { guestServes++; g.doServe(); }   // stands in for the host acting on the guest's request
    }
    g.frame(1 / 60);
  }
  const hits = ev.filter(e => e[0] === 'hit');
  const near_ = hits.filter(e => e[1].s > 0), far_ = hits.filter(e => e[1].s < 0);
  const speed = a => a.length ? a.reduce((s, e) => s + e[1].speed, 0) / a.length : 0;
  console.log('  online 1v1      ' + String(S.score[0]).padStart(2) + ' - ' + S.score[1] +
              '   returns ' + near_.length + '/' + far_.length +
              '   serves ' + hostServes + '/' + guestServes);
  check(S.state === 'over', 'online: match never finished');
  check(Math.max(...S.score) >= 11 && Math.abs(S.score[0] - S.score[1]) >= 2, 'online: bad final score ' + S.score);
  check(far_.length >= 20 && near_.length >= 20, 'online: one end barely returned anything');
  check(hostServes > 0 && guestServes > 0, 'online: both ends must serve');
  const sp = Math.abs(speed(near_) - speed(far_)) / Math.max(speed(near_), speed(far_));
  check(sp < .3, 'online: the two ends hit very differently (' + sp.toFixed(2) + ')');

  // The wording is stored side-neutral, so each screen reads it from its own end.
  const hostWords = g.wording(S.note);
  S.me = -1; const guestWords = g.wording(S.note); S.me = 1;
  check(hostWords !== guestWords, 'online: end-of-match wording did not flip per side');
  console.log('  wording         host sees "' + hostWords + '", guest sees "' + guestWords + '"');
}

/* ---------- 3. online, the far paddle must be driven by the person, not the CPU ---------- */
{
  const { g, X, ev } = load();
  const S = X.S, C = X.C;
  const spin = (vs, vy) => {
    const tops = [];
    for (let i = 0; i < 40; i++) {
      S.vs = vs; S.me = 1; S.level = 1;
      Object.assign(C, { x: 0, y: .3, vx: 0, vy });
      S.state = 'rally'; S.rally = { h: 1, serve: false, own: 0, opp: 1, net: false };
      ev.length = 0;
      g.hit(-1, 0, .3);
      const e = ev.find(x => x[0] === 'hit');
      if (e) tops.push(e[1].top);
    }
    return +(tops.reduce((a, b) => a + b, 0) / tops.length).toFixed(3);
  };
  const person = { down: spin(true, -2), flat: spin(true, 0), up: spin(true, 2) };
  const cpu = { down: spin(false, -2), flat: spin(false, 0), up: spin(false, 2) };
  console.log('  far-paddle spin online ' + JSON.stringify(person) + '  vs CPU ' + JSON.stringify(cpu));
  check(person.down < person.flat && person.flat < person.up, 'online: the far paddle ignores how it was swung');
  check(Math.abs(cpu.up - cpu.down) < .15, 'vs CPU: the far paddle should not follow a swing');
}

console.log(fails.length ? '\nFAIL\n  ' + fails.join('\n  ') : '\nPASS  all rule checks');
process.exit(fails.length ? 1 : 0);
