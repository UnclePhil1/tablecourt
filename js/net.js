/* Table – online 1v1.

   One browser is the host and runs the physics in js/core.js exactly as it does against the CPU.
   The other is the guest: it draws what the host sends and sends back where its paddle wants to be.
   Both browsers hold the same world — the host is always the near side (z > 0), the guest the far
   side (z < 0) — so only the camera differs between the two screens.

   Live play never touches the database. The two pages talk over a Supabase Realtime broadcast
   channel called "game-<code>". The games table only records who is playing and how it ended.

   Because the host runs the rules, a determined host could cheat. That is the same trust level as
   the rest of the app (see README.md). Money must not ride on a result until a server replays it. */
const Net = (function () {
  const RATE = 50;        // milliseconds between network updates, so 20 a second each way
  const GONE = 7000;      // with no word for this long, treat the other player as disconnected
  const r3 = n => Math.round(n * 1000) / 1000;

  let ch = null, game = null, role = null, sendAt = 0, heard = 0, peer = false, live = false;
  const subs = [];
  const fire = (n, d) => subs.forEach(f => { try { f(n, d); } catch (e) { Err.log(e, 'network event ' + n); } });

  const sb = () => { const c = Auth.client; if (!c) throw new Error('Sign-in is not set up yet.'); return c; };
  const myName = () => Auth.username || 'player';
  const withMe = a => Object.assign({ w: Auth.wallet }, a);
  async function rpc(fn, args) {
    const { data, error } = await sb().rpc(fn, args);
    if (error) throw error;
    return data;
  }

  /* ---------- finding a match ---------- */
  const openGames = () => rpc('game_open', { lim: 30 });
  const myGames = () => rpc('game_mine', withMe({}));

  /* ---------- the channel the two players talk on ---------- */
  // Named after the match's secret channel key, never the code: codes are public in the lobby, and a
  // stranger on the channel could drag the other player's paddle or hang up the match.
  async function channel(g) {
    closeChannel();
    const c = sb().channel('game-' + (g.channel || g.code), { config: { broadcast: { self: false }, presence: { key: role } } });
    c.on('broadcast', { event: 'm' }, ({ payload }) => { heard = performance.now(); handle(payload); });
    c.on('presence', { event: 'sync' }, () => {
      const st = c.presenceState();
      let here = false, name = null;
      Object.keys(st).forEach(k => {
        if (k === role) return;
        here = true;
        const first = st[k] && st[k][0];
        if (first && first.name) name = first.name;
      });
      if (here === peer) return;
      peer = here; if (here) heard = performance.now();
      fire('peer', { here, name });
    });
    await new Promise((res, rej) => {
      c.subscribe(st => {
        if (st === 'SUBSCRIBED') res();
        else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') rej(new Error('Could not reach the match server.'));
      });
    });
    await c.track({ role, name: myName() });
    ch = c;
  }
  const send = m => { if (ch) Promise.resolve(ch.send({ type: 'broadcast', event: 'm', payload: m })).catch(e => Err.log(e, 'send to opponent')); };

  function handle(m) {
    if (!m || !live) return;
    if (m.t === 'bye') { peer = false; return fire('peer', { here: false, bye: true }); }
    if (role === 'host') {
      if (m.t === 'i') { C.tx = m.x; C.ty = m.y; }          // the guest's paddle target
      else if (m.t === 'v') fire('want-serve', {});          // the guest asked to serve
      return;
    }
    if (m.t === 's') snapshot(m);
    else if (m.t === 'e') fire('event', m);
    else if (m.t === 'end') { game = m.game || game; fire('ended', m); }
    else if (m.t === 're') fire('rematch', m);
  }

  // The guest takes the host's ball velocity and spin outright and eases its position across, so the
  // ball keeps flying smoothly between the 20 updates a second rather than stepping.
  function snapshot(m) {
    const b = m.b;
    ball.vx = b[3]; ball.vy = b[4]; ball.vz = b[5];
    ball.wx = b[6]; ball.wy = b[7]; ball.wz = b[8];
    const dx = b[0] - ball.x, dy = b[1] - ball.y, dz = b[2] - ball.z;
    if (dx * dx + dy * dy + dz * dz > .12) { ball.x = b[0]; ball.y = b[1]; ball.z = b[2]; }   // way out: jump
    else { ball.x += dx * .4; ball.y += dy * .4; ball.z += dz * .4; }
    P.tx = b[9]; P.ty = b[10];                                   // the host's paddle
    C.x += (m.c[0] - C.x) * .25; C.y += (m.c[1] - C.y) * .25;    // keep ours near where the host has it
    S.score[0] = m.sc[0]; S.score[1] = m.sc[1];
    S.first = m.fr;                          // so server() agrees with the host about whose serve it is
    S.state = m.st; S.paused = !!m.pz;
    S.note = m.nt || null; S.msg = wording(S.note);   // worded from this player's side, not the host's
    hooks.ui();
  }

  /* ---------- starting and ending a match ---------- */
  async function host(o) {
    o = o || {};
    game = await rpc('game_host', withMe({
      p_target: o.target || 11,
      p_title: o.title || null,
      p_starts_at: o.startsAt || null
    }));
    role = 'host'; await channel(game); live = true;
    return game;
  }
  // Walking away from the lobby leaves the invite standing, so the host can come back to it later.
  // Only Cancel actually ends it.
  function detach() { closeChannel(); game = null; role = null; }
  async function join(code) {
    game = await rpc('game_join', withMe({ p_code: code }));
    role = game.role || 'guest'; await channel(game); live = true;
    return game;
  }
  async function finish(hostScore, guestScore) {          // the host reports, because the host ran the rules
    if (role !== 'host' || !game) return;
    try { game = await rpc('game_finish', withMe({ p_code: game.code, hs: hostScore, gs: guestScore })); }
    catch (e) { Err.log(e, 'report the result'); }
    send({ t: 'end', game });
  }
  async function rematch() {                              // host only: open a new match and pull the guest across
    if (role !== 'host' || !game) return null;
    const g = await rpc('game_host', withMe({ p_target: game.target, p_title: game.title, p_starts_at: null }));
    send({ t: 're', code: g.code });
    await new Promise(r => setTimeout(r, 180));           // let that last message go out before we switch channels
    game = g; role = 'host'; await channel(g); live = true;
    return g;
  }
  // Walking out forfeits the match. Call this with { peerGone: true } when it was the OTHER player who
  // vanished: game_leave always names its caller as the one who left, so reporting it then would hand
  // the win to whoever just pulled the cable. In that case we leave the row alone and let it expire.
  async function leave(opts) {
    if (!game) return;
    const code = game.code;
    send({ t: 'bye' });
    if (!(opts && opts.peerGone)) {
      try { await rpc('game_leave', withMe({ p_code: code })); } catch (e) { Err.log(e, 'leave the match'); }
    }
    closeChannel(); game = null; role = null;
  }
  // Cancel or leave a match you are not currently attached to, straight from the lobby list.
  const cancelByCode = code => rpc('game_leave', withMe({ p_code: code }));

  function closeChannel() {
    if (ch) { try { sb().removeChannel(ch); } catch (e) { /* already gone */ } ch = null; }
    live = false; peer = false;
  }

  /* ---------- called every animation frame ---------- */
  function pump() {
    if (!live || !ch) return;
    const now = performance.now();
    if (peer && now - heard > GONE) { peer = false; fire('peer', { here: false, timeout: true }); }
    if (now < sendAt) return;
    sendAt = now + RATE;
    if (role === 'host') {
      send({
        t: 's',
        b: [r3(ball.x), r3(ball.y), r3(ball.z), r3(ball.vx), r3(ball.vy), r3(ball.vz),
            Math.round(ball.wx), Math.round(ball.wy), Math.round(ball.wz), r3(P.x), r3(P.y)],
        c: [r3(C.x), r3(C.y)],
        sc: S.score.slice(), fr: S.first, st: S.state, nt: S.note, pz: S.paused
      });
    } else {
      send({ t: 'i', x: r3(C.tx), y: r3(C.ty) });
    }
  }
  // The host mirrors the moments that make noise and pop on screen, so the guest sees the same match.
  const RELAY = { hit: 1, serve: 1, bounce: 1, net: 1, point: 1, floor: 1, restart: 1, over: 1 };
  function relay(n, d) {
    if (role === 'host' && live && RELAY[n]) send({ t: 'e', n, d });
  }

  /* ---------- sharing an invite ---------- */
  const inviteUrl = code => location.origin + location.pathname + '#/join/' + code;
  function shareLinks(code, target, title, startsAt) {
    const url = inviteUrl(code), e = encodeURIComponent;
    const when = startsAt ? ' on ' + new Date(startsAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const what = title ? ' "' + title + '"' : '';
    const text = '@' + myName() + ' challenged you to a game of Table' + what + when + '. First to ' + (target || 11) + '. Code ' + code + '.';
    return {
      url, text,
      X: 'https://twitter.com/intent/tweet?text=' + e(text) + '&url=' + e(url),
      WhatsApp: 'https://wa.me/?text=' + e(text + ' ' + url),
      Telegram: 'https://t.me/share/url?url=' + e(url) + '&text=' + e(text),
      Reddit: 'https://www.reddit.com/submit?url=' + e(url) + '&title=' + e(text),
      Facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + e(url)
    };
  }

  addEventListener('pagehide', () => { if (live) send({ t: 'bye' }); });

  const requestServe = () => send({ t: 'v' });     // the guest asks the host to put the ball in play

  return {
    host, join, openGames, myGames, leave, detach, cancelByCode, finish, rematch, pump, relay, requestServe, inviteUrl, shareLinks,
    onChange: f => subs.push(f),
    get game() { return game; },
    get role() { return role; },
    get live() { return live; },
    get peerHere() { return peer; }
  };
})();
