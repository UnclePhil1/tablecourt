/* Table – rules and physics. No drawing code in this file.
   Units are metres and seconds. y = 0 is the table top. z > 0 is the player's side, z < 0 is the CPU side. */
const G = 7, BR = .03, HW = .7625, HL = 1.37, NET = .1525, FLOOR = -.76, PZ = 1.95, REST = .78, HIT = .2, H = 1 / 240;
const KD = .05, KM = .0028;              // air drag, and how strongly spin bends the flight
const MU = .08, GRIP = .2, SPIN = 220;   // table friction, how much the ball grips, spin size
const LEVELS = [
  { n: 'Easy',   sp: 1.3, re: .55, er: .12 },   // sp = CPU speed, re = reaction time, er = CPU aim error
  { n: 'Medium', sp: 1.9, re: .40, er: .09 },
  { n: 'Hard',   sp: 2.6, re: .25, er: .05 }
];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), rnd = (a, b) => a + Math.random() * (b - a);
const hooks = { ui() {}, event() {} };   // the drawing code plugs into these
const emit = (n, d) => hooks.event(n, d);

const ball = { x: 0, y: .3, z: 1.7, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };   // w = spin (rad/s)
const P = { x: 0, y: .25, vx: 0, vy: 0, tx: 0, ty: .25 };                          // player paddle and its target
const C = { x: 0, y: .3, vx: 0, vy: 0, tx: 0, ty: .3, plan: null, wait: 0 };        // far paddle: the CPU, or the other player online
const S = {
  state: 'serve', score: [0, 0], first: 0, level: 1, hits: 0, longest: 0, timer: 0, msg: '',
  rally: { h: 1, serve: false, own: 0, opp: 0, net: false },
  paused: false, attract: false, bot: { t: 0, off: 0, hits: -1 },
  // Online 1v1. me is the side this browser controls: 1 is the near side (z > 0), -1 the far side.
  // vs means both paddles are people. remote means another browser is running the physics, not this one.
  vs: false, remote: false, me: 1, target: 11, names: { '1': 'You', '-1': 'CPU' }, note: null
};
const foe = () => S.names[String(-S.me)] || 'Opponent';
let acc = 0;

/* ---------- ball physics ---------- */
function move(b, dt) {   // gravity + air drag + spin curve
  const sp = Math.hypot(b.vx, b.vy, b.vz);
  b.vx += (-KD * sp * b.vx + KM * (b.wy * b.vz - b.wz * b.vy)) * dt;
  b.vy += (-G - KD * sp * b.vy + KM * (b.wz * b.vx - b.wx * b.vz)) * dt;
  b.vz += (-KD * sp * b.vz + KM * (b.wx * b.vy - b.wy * b.vx)) * dt;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
}
function bounce(b) {     // the table grips the ball: topspin kicks it forward, backspin slows it
  b.y = BR;
  const ux = b.vx + b.wz * BR, uz = b.vz - b.wx * BR, um = Math.hypot(ux, uz) || 1e-6;
  const jm = Math.min(MU * (1 + REST) * Math.abs(b.vy), GRIP * um), jx = -ux / um * jm, jz = -uz / um * jm;
  b.vx += jx; b.vz += jz; b.wx -= 1.5 / BR * jz; b.wz += 1.5 / BR * jx;
  b.vy *= -REST;
}
// Moves the ball one step. Returns what it touched: 't+' or 't-' (table side), 'net', 'floor'.
function advance(b, dt) {
  const py = b.y, pz = b.z;
  move(b, dt);
  if (pz * b.z < 0 && b.y > -.02 && b.y - BR < NET && Math.abs(b.x) < HW + .1) { b.z = pz; b.vz *= -.2; b.vx *= .5; return 'net'; }
  if (b.vy < 0 && py - BR >= 0 && b.y - BR < 0 && Math.abs(b.x) < HW && Math.abs(b.z) < HL) { bounce(b); return b.z > 0 ? 't+' : 't-'; }
  if (b.y < FLOOR + BR) { b.y = FLOOR + BR; b.vy *= -.5; b.vx *= .7; b.vz *= .7; b.wx *= .6; b.wy *= .6; b.wz *= .6; return 'floor'; }
  return null;
}
function spin(b, top, side, dx, dz) {   // top > 0 is topspin, side is side spin
  const m = Math.hypot(dx, dz) || 1;
  b.wx = top * SPIN * dz / m; b.wy = side * SPIN * .8; b.wz = -top * SPIN * dx / m;
}

/* ---------- aiming a shot ---------- */
const flight = (b, vx, vy, vz, T) => { const c = { ...b, vx, vy, vz }, n = Math.ceil(T * 120); for (let i = 0; i < n; i++) move(c, T / n); return c; };
function clears(b, vx, vy, vz) {
  const c = { ...b, vx, vy, vz };
  for (let t = 0; t < 3; t += 1 / 120) { const pz = c.z; move(c, 1 / 120); if (pz * c.z <= 0) return c.y > NET + BR + .04; }
  return false;
}
// Pick a launch speed so the ball lands L metres deep, at side x = xt, after about T seconds, and clears the net.
// It tests the real physics (drag and spin), so a shot lands where it was aimed.
function shoot(b, s, xt, L, T) {
  const tz = -s * L; let vx, vy, vz;
  for (; T < 1.8; T += .05) {
    vx = (xt - b.x) / T; vy = (BR - b.y + .5 * G * T * T) / T; vz = (tz - b.z) / T;
    for (let i = 0; i < 4; i++) { const e = flight(b, vx, vy, vz, T); vx += (xt - e.x) / T; vy += (BR - e.y) / T; vz += (tz - e.z) / T; }
    if (clears(b, vx, vy, vz)) break;
  }
  b.vx = vx; b.vy = vy; b.vz = vz;
}

/* ---------- serving ---------- */
// A serve must bounce on the server's half, then the other half, then reach the receiver at a hittable height.
function tryServe(b, s) {
  const c = { ...b }; let n = 0, t2 = 0;
  for (let t = 0; t < 4; t += 1 / 120) {
    const pz = c.z, e = advance(c, 1 / 120);
    if (e === 'net' || e === 'floor') return 0;
    if (e) { if (n === 2 || (e === 't+') !== (n ? s < 0 : s > 0)) return 0; if (++n === 2) t2 = t; }   // no 3rd bounce before the receiver can hit
    if (n === 2 && pz * s > -PZ && c.z * s <= -PZ) return c.y > -.1 && c.y < .8 ? t2 : 0;
  }
  return 0;
}
function serve(b, s, xt) {
  for (const top of [1, .7, .4, 0]) for (let vz = 3.4; vz <= 5.4; vz += .1) for (let vy = -.6; vy <= 2.2; vy += .1) {
    b.vx = 0; b.vy = vy; b.vz = -s * vz; spin(b, top, 0, 0, -s);
    const t = tryServe(b, s);
    if (!t) continue;
    b.vx = (xt - b.x) / t;
    if (tryServe(b, s)) return;
  }
  b.vx = 0; b.vy = .8; b.vz = -s * 3.6; spin(b, 1, 0, 0, -s);
}
// After a hit: does the ball bounce once on the far half, then reach the receiver at a hittable height?
function tryReturn(b, s) {
  const c = { ...b }; let n = 0;
  for (let t = 0; t < 4; t += 1 / 120) {
    const pz = c.z, e = advance(c, 1 / 120);
    if (e === 'net' || e === 'floor') return false;
    if (e) { if (n || (e === 't+') !== (s < 0)) return false; n = 1; }
    if (n && pz * s > -PZ && c.z * s <= -PZ) return c.y > -.1 && c.y < .8;
  }
  return false;
}

/* ---------- CPU ---------- */
// Where will the ball be when it reaches the plane z?
function predict(z) {
  const c = { ...ball };
  for (let t = 0; t < 4; t += 1 / 120) { const pz = c.z; advance(c, 1 / 120); if ((pz - z) * (c.z - z) <= 0 && pz !== c.z) return c; }
  return null;
}
function plan() {   // the CPU works out where the ball will arrive, with an error that grows on wide balls
  const p = predict(-PZ), L = LEVELS[S.level];
  if (!p) { C.plan = null; return; }
  const e = L.er * (1 + Math.abs(p.x - C.x) * 1.5), g = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2 * e;
  C.plan = { x: p.x + g(), y: clamp(p.y + g() * .6, -.05, .85) };
  C.wait = L.re;
}
function movePaddles(dt) {
  const k = Math.min(1, dt * (S.attract ? 10 : 24)), nx = P.x + (P.tx - P.x) * k, ny = P.y + (P.ty - P.y) * k;
  P.vx += ((nx - P.x) / dt - P.vx) * .5; P.vy += ((ny - P.y) / dt - P.vy) * .5; P.x = nx; P.y = ny;
  if (S.vs) {                                           // online: the far paddle is a person, so it moves like one
    const cx = C.x + (C.tx - C.x) * k, cy = C.y + (C.ty - C.y) * k;
    C.vx += ((cx - C.x) / dt - C.vx) * .5; C.vy += ((cy - C.y) / dt - C.vy) * .5; C.x = cx; C.y = cy;
    return;
  }
  let tx = 0, ty = .3;                                  // the CPU waits in the middle...
  if (C.plan) { C.wait -= dt; if (C.wait > 0) { tx = C.x; ty = C.y; } else { tx = C.plan.x; ty = C.plan.y; } }   // ...then reacts and runs
  const dx = tx - C.x, dy = ty - C.y, d = Math.hypot(dx, dy) || 1, m = Math.min(d, LEVELS[S.level].sp * dt);
  C.vx = dx / d * m / dt; C.vy = dy / d * m / dt; C.x += dx / d * m; C.y += dy / d * m;
}
function bot(dt) {   // plays the human side on the landing page
  const B = S.bot;
  if (S.state === 'serve' && server() > 0) { if ((B.t += dt) > .9) { B.t = 0; doServe(); } return; }
  if (S.state === 'over') { if ((B.t += dt) > 2.5) { B.t = 0; restart(); } return; }
  if (S.state === 'rally' && S.rally.h === -1) {
    if (B.hits !== S.hits) { B.hits = S.hits; B.off = Math.random() < .16 ? rnd(-.4, .4) : rnd(-.16, .16); }   // now and then it misses
    const p = predict(PZ); if (p) { P.tx = p.x + B.off; P.ty = p.y; }
  } else if (S.state !== 'rally') { P.tx = 0; P.ty = .25; }
}

/* ---------- match flow ---------- */
// A note records what happened, not how to word it, and each browser words it from its own side.
// Without this the guest would read "unclephil serves" on their own serve, because the host wrote it.
function wording(n) {
  if (!n) return '';
  if (n.k === 'serve') return n.v === S.me ? 'Your serve. Click to serve' : foe() + ' serves';
  if (n.k === 'rally') return n.v < 3 ? 'Keep it going' : 'Rally ' + n.v;
  if (n.k === 'point') return n.v === S.me ? 'Point for you' : 'Point for ' + foe();
  if (n.k === 'over') return (n.v === S.me ? 'You win!' : foe() + ' wins.') + (S.vs ? '' : ' Click to play again');
  return '';
}
const note = (k, v) => { S.note = { k, v }; S.msg = wording(S.note); hooks.ui(); };
function server() { const t = S.score[0] + S.score[1]; return (S.first + Math.floor(Math.min(t, 20) / 2) + Math.max(0, t - 20)) % 2 ? -1 : 1; }
function hover() {
  const s = server(), p = s > 0 ? P : C;
  Object.assign(ball, { x: clamp(p.x, -.55, .55), y: .3, z: s * 1.7, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 });
}
function nextServe() {
  S.state = 'serve'; S.timer = .9; C.plan = null; hover();
  note('serve', server());
}
function doServe() {
  const s = server(); hover();
  serve(ball, s, s > 0 ? clamp(P.vx * .3, -.55, .55) : rnd(-.5, .5));
  S.rally = { h: s, serve: true, own: 0, opp: 0, net: false }; S.hits = 0; S.state = 'rally';
  if (s > 0 && !S.vs) plan();
  emit('serve', { s, x: ball.x, y: ball.y, z: ball.z }); note('rally', 0);
}
function restart() { S.score = [0, 0]; S.longest = 0; S.first ^= 1; S.paused = false; nextServe(); emit('restart', {}); }
function tap() {
  if (S.paused || S.attract) return;
  if (S.state === 'serve' && server() === S.me) { if (S.remote) emit('want-serve', {}); else doServe(); }
  else if (S.state === 'over' && !S.vs) restart();
}
function setLevel(i) { S.level = i; if (!S.attract) restart(); else hooks.ui(); }
function pause(v) {
  if (S.attract || S.state === 'over') return;
  S.paused = v === undefined ? !S.paused : v; hooks.ui(); emit('pause', { v: S.paused });
}
function startMatch(attract) {
  S.vs = false; S.remote = false; S.me = 1; S.target = 11; S.names = { '1': 'You', '-1': 'CPU' };
  S.attract = !!attract; S.bot.t = 0; S.bot.hits = -1; S.first = 1; restart();   // first = 1 flips to 0: you serve first
}
// Online 1v1. The host is always the near side and runs the physics; the guest is the far side and
// draws what the host sends. Both browsers hold the same world, so only the camera differs.
function startVersus(o) {
  S.attract = false; S.vs = true; S.remote = !!o.remote; S.me = o.me;
  S.target = o.target || 11; S.names = { '1': o.hostName || 'Host', '-1': o.guestName || 'Guest' };
  S.level = 1; S.paused = false; S.first = 1;
  P.tx = 0; P.ty = .25; C.tx = 0; C.ty = .3; C.plan = null;
  restart();
}

function point(w, why) {
  if (S.state !== 'rally') return;
  S.state = 'point'; S.timer = 1.4; S.score[w > 0 ? 0 : 1]++; S.longest = Math.max(S.longest, S.hits);
  emit('point', { w, why, score: S.score.slice() }); note('point', w);
}
function hit(s, cx, cy) {
  const p = s > 0 ? P : C, human = s > 0 || S.vs; let xt, L, T, top, side, pow = 0;
  if (human) {
    pow = clamp(Math.hypot(p.vx, p.vy) / 3.5, 0, 1);
    xt = clamp((cx - p.x) / HIT * .5 + p.vx * .25, -.62, .62); L = .55 + pow * .6; T = .95 - pow * .2;
    top = clamp(p.vy * .4, -1, 1); side = clamp(p.vx * .25, -1, 1);
  } else {
    xt = clamp(-P.x * .7 + rnd(-.3, .3), -.6, .6); L = rnd(.55, 1.1); T = rnd(.7, .9);
    top = rnd(-.2, .7); side = rnd(-.5, .5); C.plan = null; pow = clamp((1.1 - T) * 2, 0, 1);
  }
  Object.assign(ball, { x: cx, y: cy, z: s * PZ });
  for (let l = L; l <= 1.25; l += .1) {           // go a little deeper until the receiver can reach it
    spin(ball, top, side, xt - cx, -s * l - s * PZ);
    shoot(ball, s, xt, l, T);
    if (tryReturn(ball, s)) break;
  }
  const risk = human ? pow * pow * .3 : [.1, .05, .025][S.level] * (.5 + pow);   // hard hits can go wrong
  if (Math.random() < risk) {
    const wide = Math.random() < .5;
    spin(ball, top, side, xt - cx, -s * L - s * PZ);
    shoot(ball, s, wide ? xt + rnd(.3, .5) * (xt > 0 ? 1 : -1) : xt, wide ? L : Math.min(L + rnd(.35, .6), 1.6), T);
  }
  const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
  const kind = speed > 5.0 ? 'smash' : top > .45 ? 'topspin' : top < -.3 ? 'slice' : Math.abs(side) > .5 ? 'curve' : 'return';
  S.rally = { h: s, serve: false, own: 0, opp: 0, net: false }; S.hits++;
  emit('hit', { s, x: cx, y: cy, z: s * PZ, speed, top, side, pow, kind, n: S.hits });
  note('rally', S.hits);
  if (s > 0 && !S.vs) plan();
}
function tick() {
  const px = ball.x, py = ball.y, pz = ball.z, e = advance(ball, H);
  if (S.state !== 'rally') {   // between points the ball keeps moving and still makes sound
    if (e === 'floor') emit('floor', { x: ball.x, y: ball.y, z: ball.z, v: Math.abs(ball.vy) * 2 });
    else if (e && e[0] === 't') emit('bounce', { side: e === 't+' ? 1 : -1, x: ball.x, y: ball.y, z: ball.z, v: ball.vy / REST, table: true });
    return;
  }
  const R = S.rally;
  if (e === 'net') { R.net = true; emit('net', { x: ball.x, y: ball.y, z: ball.z }); }
  else if (e && e[0] === 't') {
    emit('bounce', { side: e === 't+' ? 1 : -1, x: ball.x, y: ball.y, z: ball.z, v: ball.vy / REST, table: true });
    if ((e === 't+' ? 1 : -1) === R.h) { if (R.serve && !R.own && !R.opp) R.own = 1; else return point(-R.h, 'Bad bounce'); }
    else if (++R.opp > 1) return point(R.h, 'Missed');
  } else if (e === 'floor' || Math.abs(ball.z) > 6) return R.opp ? point(R.h, 'Missed') : point(-R.h, R.net ? 'Net' : 'Out');
  if (R.opp === 1) {                                   // the receiver may hit after one bounce
    const s = -R.h, pl = s > 0 ? P : C;
    if (pz * s < PZ && ball.z * s >= PZ) {
      const f = (s * PZ - pz) / (ball.z - pz), cx = px + (ball.x - px) * f, cy = py + (ball.y - py) * f;
      if (Math.hypot(cx - pl.x, cy - pl.y) < HIT) hit(s, cx, cy);
    }
  }
}
function frame(dt) {
  dt = dt || 1 / 60;
  if (S.paused) return;
  if (S.attract) bot(dt);
  movePaddles(dt);
  if (S.remote) { for (acc += dt; acc >= H; acc -= H) advance(ball, H); return; }   // the host owns the rules; just keep the ball flowing
  if (S.state === 'serve') {
    hover(); S.timer -= dt;
    if (server() < 0 && !S.vs && S.timer <= 0) doServe();
    return;
  }
  for (acc += dt; acc >= H; acc -= H) tick();
  if (S.state === 'point' && (S.timer -= dt) <= 0) {
    const [a, b] = S.score;
    if ((a >= S.target || b >= S.target) && Math.abs(a - b) >= 2) {
      const winner = a > b ? 1 : -1;
      S.state = 'over'; emit('over', { won: winner === S.me, score: S.score.slice(), longest: S.longest });
      note('over', winner);
    } else nextServe();
  }
}
