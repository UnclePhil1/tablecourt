/* Table – app controller. Screens, sign-in forms, arena controls, pause menu and on-screen pop-ups. */
(function () {
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const touch = matchMedia('(pointer:coarse)').matches, verb = touch ? 'Tap' : 'Click';
  const pad2 = n => String(n).padStart(2, '0');
  let route = 'landing', guest = false, padMode = false, wanted = null, pendingVersus = null, invite = null;
  let authReady = false;   // routing before sign-in has settled sends every invite through the sign-in screen
  let routed = false;      // set as soon as anything routes, so the boot fallback cannot barge in later

  // A pending invite has to outlive a page reload and a round trip through an email confirmation,
  // so it is kept in sessionStorage rather than a variable.
  const INVITE_KEY = 'table_invite';
  try { invite = sessionStorage.getItem(INVITE_KEY) || null; } catch (e) { /* private mode */ }
  function keepInvite(code) {
    invite = code || null;
    try { code ? sessionStorage.setItem(INVITE_KEY, code) : sessionStorage.removeItem(INVITE_KEY); } catch (e) {}
  }
  // Supabase puts its own tokens in the fragment when it sends someone back, which would wipe a
  // "#/join/CODE" we had put there. The invite travels in the query string instead, where it survives.
  (function readInviteFromQuery() {
    const m = /[?&]invite=([A-Za-z0-9]{4,10})/.exec(location.search);
    if (!m) return;
    keepInvite(m[1].toUpperCase());
    history.replaceState(null, '', location.pathname + location.hash);   // do not re-trigger on refresh
  })();
  let keepNet = false;   // a rematch swaps to a new match, so leaving the arena must not cancel it
  let peerGone = false;  // the other player vanished, so we must not report ourselves as the one leaving
  try { guest = sessionStorage.getItem('table_guest') === '1'; } catch (e) {}

  if (!Scene.init($('#gl'))) {
    const e = $('#err'); e.hidden = false;
    e.textContent = 'This browser cannot show 3D graphics, so the game will not run. Try Chrome, Edge or Safari, and check that hardware acceleration is switched on.';
    Err.log(new Error('WebGL unavailable'), 'start the 3D scene');
    return;
  }

  /* ---------- small helpers ---------- */
  let toastT;
  function toast(t) { const e = $('#toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('on'), 2600); }
  function pop(text, o = {}) {
    const el = document.createElement('div'); el.className = 'pop ' + (o.cls || '') + (o.big ? ' big' : ''); el.textContent = text;
    if (o.sub) { const s = document.createElement('small'); s.textContent = o.sub; el.appendChild(s); }
    el.style.left = o.x + 'px'; el.style.top = o.y + 'px'; $('#pops').appendChild(el); setTimeout(() => el.remove(), o.big ? 1600 : 1000);
  }
  const popAt = (text, x, y, z, cls) => { const p = Scene.project(x, y + .3, z); if (p.front) pop(text, { x: p.x, y: p.y, cls }); };
  function flash(win) { const f = $('#flash'); f.className = ''; void f.offsetWidth; f.className = win ? 'win' : 'lose'; }
  function bump(el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }

  /* ---------- routing ---------- */
  const ROUTES = { '': 'landing', '#/': 'landing', '#/auth': 'auth', '#/play': 'arena', '#/online': 'online', '#/matches': 'explore' };
  const HASH = { landing: '#/', auth: '#/auth', arena: '#/play', online: '#/online', explore: '#/matches' };
  const canPlay = () => Auth.signedIn || guest;
  const canOnline = () => Auth.signedIn;          // online needs a username, so guests have to sign in first
  const navigate = r => { if (location.hash === HASH[r]) onRoute(); else location.hash = HASH[r]; };
  function onRoute() {
    routed = true;
    const inv = /^#\/join\/([A-Za-z0-9]{4,10})$/.exec(location.hash);
    if (inv) {
      keepInvite(inv[1].toUpperCase());
      history.replaceState(null, '', canOnline() ? HASH.online : HASH.auth);
      if (!canOnline()) { wanted = 'online'; return enter('auth'); }
      enter('online'); acceptInvite(invite); return;
    }
    // Someone came back from confirming their email, or reloaded mid-invite.
    if (invite && canOnline() && route !== 'arena') {
      history.replaceState(null, '', HASH.online);
      enter('online'); acceptInvite(invite); return;
    }
    let r = ROUTES[location.hash] || 'landing';
    if (r === 'arena' && !canPlay()) { wanted = 'arena'; history.replaceState(null, '', HASH.auth); r = 'auth'; }
    if (r === 'online' && !canOnline()) { wanted = 'online'; history.replaceState(null, '', HASH.auth); r = 'auth'; }
    enter(r);
  }
  function enter(r) {
    const prev = route; route = r;
    if (prev === 'arena' && r !== 'arena') Vid.stop();           // never leave a camera running
    if (prev === 'arena' && r !== 'arena' && S.vs && !keepNet) Net.leave({ peerGone });   // walking out of a live match
    keepNet = false; peerGone = false;
    $$('.view').forEach(v => { v.hidden = v.id !== r; });
    document.body.className = 'v-' + r;
    closeModals();
    Sfx.duck(r === 'arena');      // music drops right down so the ball is the loudest thing
    if (r === 'arena') {
      const v = pendingVersus; pendingVersus = null;
      if (v) {
        Scene.setSide(v.me); Scene.setMode('arena'); startVersus(v);
        Vid.start(Net.role);
        if (countdownNext) { countdownNext = false; runCountdown(); }
      } else if (S.vs && Net.live) {
        // Already mid-match. Re-entering here would call startMatch and quietly drop both players
        // back into a game against the CPU, so leave the match alone.
        Scene.setSide(S.me); Scene.setMode('arena');
      } else {
        Scene.setSide(1); Scene.setMode('arena'); startMatch(false);
        clearInterval(countT); countT = null; holdUntil = 0; $('#count').hidden = true;
      }
    } else {
      Scene.setSide(1); Scene.setMode('landing');
      if (prev === 'arena' || !S.attract) startMatch(true);
    }
    if (r === 'auth') showAuth();
    if (r === 'online') showLobby(); else stopLobbyPolling();
    if (r === 'explore') startExplore(); else stopExplore();
    refreshUI();
  }
  addEventListener('hashchange', onRoute);

  /* ---------- account chip and buttons on the landing page ---------- */
  function renderAcct() {
    const a = $('#acct'); a.textContent = '';
    if (Auth.signedIn) { const b = document.createElement('b'); b.textContent = '@' + Auth.profile.username; a.appendChild(b); }
    else if (guest) a.textContent = 'Guest';
    $('#signBtn').textContent = Auth.signedIn ? 'Sign out' : 'Sign in';
  }
  $('#playBtn').onclick = () => { Sfx.unlock(); navigate('arena'); };
  $('#onlineBtn').onclick = () => { Sfx.unlock(); navigate('online'); };
  $('#exploreBtn').onclick = () => { Sfx.unlock(); navigate('explore'); };
  $('#signBtn').onclick = async () => {
    if (Auth.signedIn) { await Auth.signOut(); guest = false; try { sessionStorage.removeItem('table_guest'); } catch (e) {} toast('Signed out'); }
    else navigate('auth');
  };
  Auth.onChange(() => {
    renderAcct();
    if (route === 'auth') afterAuth();
  });

  /* ---------- sign-up / sign-in screen ---------- */
  let mode = 'up', tab = 'email';
  const msg = (t, ok) => { const m = $('#authMsg'); m.textContent = t || ''; m.className = 'msg' + (ok ? ' ok' : ''); };
  function setMode(m) {
    mode = m;
    $('#rowUser').hidden = m === 'in';
    $('#authTitle').textContent = m === 'up' ? 'Create your account' : 'Welcome back';
    $('#fGo').textContent = m === 'up' ? 'Create account' : 'Sign in';
    $('#swapText').textContent = m === 'up' ? 'Already have an account?' : 'New to Table?';
    $('#swapLink').textContent = m === 'up' ? 'Sign in' : 'Create one';
    $('#fPass').autocomplete = m === 'up' ? 'new-password' : 'current-password';
    msg('');
  }
  function setTab(t) {
    tab = t;
    $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    $('#emailForm').hidden = t !== 'email'; $('#walletBox').hidden = t !== 'wallet'; msg('');
  }
  function showAuth() {
    resetWallet();
    if (!Auth.enabled) msg(Auth.hasKey ? 'Sign-in could not load. You can still play as a guest.' : 'Sign-in is not set up yet. Add your Supabase key in js/config.js. You can still play as a guest.');
    else Auth.checkSetup().then(r => { if (!r.ok && route === 'auth' && !Auth.signedIn && !$('#authMsg').textContent) msg(Auth.setupHint(r)); });
    afterAuth();
  }
  function afterAuth() {
    if (!Auth.signedIn) return;
    const w = wanted; wanted = null;
    if (invite) { navigate('online'); acceptInvite(invite); return; }
    navigate(w || 'arena');
  }
  const bad = (el, on) => el.classList.toggle('bad', !!on);
  $('#authBack').onclick = () => { wanted = null; navigate('landing'); };
  $$('.tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  $('#swapLink').onclick = e => { e.preventDefault(); setMode(mode === 'up' ? 'in' : 'up'); };
  $('#guestBtn').onclick = () => { guest = true; try { sessionStorage.setItem('table_guest', '1'); } catch (e) {} renderAcct(); wanted = null; navigate('arena'); };
  $('#fUser').addEventListener('blur', async () => {
    const n = Auth.clean($('#fUser').value); if (!n || !Auth.enabled) return;
    if (!Auth.USERNAME.test(n)) { bad($('#fUser'), 1); return msg('Username: 3 to 16 letters, numbers or _'); }
    try { const free = await Auth.usernameFree(n); bad($('#fUser'), !free); msg(free ? 'Nice, that username is free.' : 'That username is taken.', free); } catch (e) { /* ignore */ }
  });
  $('#emailForm').addEventListener('submit', async e => {
    e.preventDefault();
    const u = $('#fUser'), m = $('#fEmail'), p = $('#fPass'), go = $('#fGo');
    if (!Auth.enabled) return msg(Auth.hasKey ? 'Sign-in could not load.' : 'Sign-in is not set up yet. Add your Supabase key in js/config.js.');
    bad(u, 0); bad(m, 0); bad(p, 0);
    if (mode === 'up' && !Auth.USERNAME.test(Auth.clean(u.value))) { bad(u, 1); return msg('Username: 3 to 16 letters, numbers or _'); }
    if (!/^\S+@\S+\.\S+$/.test(m.value.trim())) { bad(m, 1); return msg('Enter a valid email.'); }
    if (p.value.length < 8) { bad(p, 1); return msg('Password needs at least 8 characters.'); }
    go.disabled = true; msg('One moment…');
    try {
      if (mode === 'up') {
        const r = await Auth.signUp({ username: u.value, email: m.value, password: p.value,
                                     next: invite ? '?invite=' + invite : '' });
        if (r.needsConfirm) { setMode('in'); msg('Check your email to confirm your account, then sign in.', true); }
      } else await Auth.signIn({ email: m.value, password: p.value });
    } catch (err) { msg(Err.say(err, mode === 'up' ? 'create account' : 'sign in')); }
    go.disabled = false;
  });
  /* wallet tab: pick a wallet, connect it, then choose a username (first time only) */
  let pendingWallet = null;
  const short = a => a.slice(0, 4) + '…' + a.slice(-4);
  function renderWallets() {
    const box = $('#walletList'), list = Wallets.list(); box.textContent = '';
    list.forEach(w => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'wbtn';
      if (w.icon && /^data:image\//.test(w.icon)) { const i = document.createElement('img'); i.src = w.icon; i.alt = ''; i.width = 26; i.height = 26; b.appendChild(i); }
      const t = document.createElement('span'); t.textContent = w.name; b.appendChild(t);
      b.onclick = () => connectWallet(w); box.appendChild(b);
    });
    box.hidden = !!pendingWallet; $('#walletNone').hidden = list.length > 0 || !!pendingWallet;
  }
  function resetWallet() {
    pendingWallet = null; $('#wUserForm').hidden = true; $('#wUser').value = '';
    $('#walletLead').textContent = 'Connect your Solana wallet. New here? You will choose a username next.'; renderWallets();
  }
  async function connectWallet(w) {
    if (!Auth.enabled) return msg(Auth.hasKey ? 'Sign-in could not load.' : 'Sign-in is not set up yet. Add your Supabase key in js/config.js.');
    msg('Approve the request in your wallet…');
    try {
      const addr = await Wallets.connect(w); msg('One moment…');
      if (await Auth.walletLogin(addr)) { msg(''); return; }          // known wallet: signed in, afterAuth() takes over
      pendingWallet = addr; $('#wAddr').textContent = 'Wallet ' + short(addr); $('#wUserForm').hidden = false;
      $('#walletLead').textContent = 'Wallet connected. Choose a username to finish.'; renderWallets(); msg('');
    } catch (err) { msg(Err.say(err, 'connect wallet')); }
  }
  $('#wUserForm').addEventListener('submit', async e => {
    e.preventDefault(); const i = $('#wUser'); bad(i, 0);
    if (!pendingWallet) return resetWallet();
    if (!Auth.USERNAME.test(Auth.clean(i.value))) { bad(i, 1); return msg('Username: 3 to 16 letters, numbers or _'); }
    msg('One moment…');
    try { await Auth.walletRegister(pendingWallet, i.value); msg(''); } catch (err) { bad(i, 1); msg(Err.say(err, 'choose a username')); }
  });
  Wallets.onChange(renderWallets);
  $('#lnkPh').href = Wallets.openInPhantom(); $('#lnkSf').href = Wallets.openInSolflare();
  setMode('up');


  /* ---------- 1v1 online: lobby, invites, scheduling ---------- */
  const onMsg = (t, ok) => { const m = $('#onMsg'); m.textContent = t || ''; m.className = 'msg' + (ok ? ' ok' : ''); };
  let pollT = null, tickT = null, lobbyBusy = false, lastOpenSig = null, peerName = null;

  // Kick-off time. flatpickr gives a real calendar instead of making people type a date; if it ever
  // fails to load we hand the field back to the browser's own datetime control rather than a bare box.
  let whenPicker = null;
  if (window.flatpickr) {
    whenPicker = flatpickr('#onWhen', {
      enableTime: true, minuteIncrement: 5, minDate: new Date(),
      dateFormat: 'D j M Y, h:i K', static: true, monthSelectorType: 'static'
    });
  } else {
    $('#onWhen').type = 'datetime-local';
    $('#onWhen').placeholder = '';
  }
  // null = play now, false = we could not read it, otherwise a Date
  function pickedStart() {
    if (whenPicker) return whenPicker.selectedDates.length ? whenPicker.selectedDates[0] : null;
    const v = $('#onWhen').value.trim();
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? false : d;
  }
  const clearStart = () => { if (whenPicker) whenPicker.clear(); else $('#onWhen').value = ''; };
  $('#onWhenClear').onclick = () => { clearStart(); onMsg(''); };
  const stopLobbyPolling = () => { clearInterval(pollT); pollT = null; clearInterval(tickT); tickT = null; };

  // How long until a match kicks off. 0 means it is playable now.
  const startsIn = g => (g && g.starts_at) ? Math.max(0, new Date(g.starts_at).getTime() - Date.now()) : 0;
  function countdown(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return 'in ' + s + 's';
    if (s < 3600) return 'in ' + Math.floor(s / 60) + 'm';
    if (s < 86400) return 'in ' + Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm';
    return 'in ' + Math.floor(s / 86400) + 'd';
  }
  const clockOf = iso => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const whenLabel = g => !g.starts_at ? 'Open now' : (startsIn(g) > 0 ? clockOf(g.starts_at) + ' · ' + countdown(startsIn(g)) : 'Starting now');

  // The screen has four faces: pick, host, join, and the waiting card. Only one is ever up.
  const PANES = ['onPick', 'onHostPane', 'onJoinPane', 'onWait'];
  function showPane(name) {
    PANES.forEach(id => { $('#' + id).hidden = id !== name; });
    if (name !== 'onWait') onMsg('');
  }
  function showLobby(pane) {
    onMsg('');
    if (Net.live && Net.game) showWaiting(Net.game);
    else showPane(pane || 'onPick');
    // Say the database is behind before they press anything, rather than after the press fails.
    Auth.checkSetup().then(r => {
      const ready = r.ok;
      $('#onHost').disabled = !ready;
      $('#onJoinForm').querySelector('button').disabled = !ready;
      if (!ready && route === 'online') onMsg(Auth.setupHint(r));
    });
    refreshMine(); refreshChallenges();
    stopLobbyPolling();
    pollT = setInterval(() => {
      if (route !== 'online') return;
      if (!$('#onWait').hidden) return;
      refreshMine(); refreshChallenges();
    }, 6000);
    tickT = setInterval(tick, 1000);
  }
  // Keeps the countdown honest and starts the match the moment both players are here and it is time.
  function tick() {
    if (route !== 'online') return;
    if (!$('#onWait').hidden && Net.game) { waitMsg(); tryStart(); }
    else {
      $$('#onMine .when, #onList .when, #onSoon .when').forEach(el => {
        const iso = el.dataset.at; if (iso) el.textContent = whenLabel({ starts_at: iso });
      });
    }
  }

  function row(g, opts) {
    const li = document.createElement('li');
    li.dataset.code = g.code;
    if (opts.mine) li.className = 'mine';
    const who = document.createElement('b');
    who.textContent = g.title || (opts.mine ? 'Your match' : '@' + g.host_name);
    const meta = document.createElement('span');
    meta.textContent = (g.title && !opts.mine ? '@' + g.host_name + ' · ' : '') + 'First to ' + g.target + ' · ' + g.code;
    const when = document.createElement('span');
    when.className = 'when'; when.textContent = whenLabel(g);
    if (g.starts_at) when.dataset.at = g.starts_at;
    const acts = document.createElement('span'); acts.className = 'acts2';
    opts.buttons.forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.className = 'pill'; b.type = 'button'; b.textContent = label; b.onclick = fn;
      acts.appendChild(b);
    });
    li.append(who, meta, when, acts);
    return li;
  }

  async function refreshMine() {
    const wrap = $('#onMineWrap'), ul = $('#onMine');
    try {
      const rows = await Net.myGames() || [];
      ul.textContent = '';
      wrap.hidden = !rows.length;
      rows.forEach(g => ul.appendChild(row(g, {
        mine: true,
        buttons: [['Open', () => resumeMatch(g.code)], ['Cancel', () => cancelMatch(g.code)]]
      })));
    } catch (e) { wrap.hidden = true; Err.log(e, 'load your matches'); }
  }

  async function refreshChallenges() {
    const ul = $('#onList'), soonUl = $('#onSoon'), soonWrap = $('#onSoonWrap');
    try {
      const rows = await Net.openGames() || [];
      const mineCodes = new Set($$('#onMine li').map(e => e.dataset.code).filter(Boolean));
      const mine = Net.game ? Net.game.code : null;
      const list = rows.filter(g => g.code !== mine && !mineCodes.has(g.code));
      // Redrawing every few seconds would swallow a tap that lands just as the list refreshes.
      const sig = list.map(g => g.code + g.host_name + g.target + (g.title || '') + (g.starts_at || '')).join('|');
      if (sig === lastOpenSig) return;
      lastOpenSig = sig;
      const now = list.filter(g => startsIn(g) <= 0), soon = list.filter(g => startsIn(g) > 0);
      ul.textContent = ''; soonUl.textContent = '';
      if (!now.length) {
        const li = document.createElement('li'); li.className = 'empty';
        li.textContent = 'Nothing open right now. Host one.'; ul.appendChild(li);
      }
      now.forEach(g => ul.appendChild(row(g, { buttons: [['Accept', () => acceptInvite(g.code)]] })));
      soonWrap.hidden = !soon.length;
      soon.forEach(g => soonUl.appendChild(row(g, { buttons: [['Join', () => acceptInvite(g.code)]] })));
    } catch (e) { ul.textContent = ''; lastOpenSig = null; onMsg(Err.say(e, 'load open challenges')); }
  }

  /* the card you sit on while waiting for the other player, or for kick-off */
  function waitMsg() {
    const g = Net.game; if (!g) return;
    const left = startsIn(g);
    const other = Net.role === 'host' ? (peerName || g.guest_name) : g.host_name;
    const bothHere = Net.peerHere && left <= 0;
    let t;
    if (!Net.peerHere) t = Net.role === 'host' ? 'Waiting for an opponent…' : 'Waiting for @' + (g.host_name || 'the host') + ' to arrive…';
    else if (left > 0) t = '@' + (other || 'Your opponent') + ' is here · starts ' + countdown(left);
    else if (Net.role === 'host') t = '@' + (other || 'Your opponent') + ' is ready.';
    else t = '@' + (g.host_name || 'the host') + ' is about to start…';
    $('#onWaitMsg').textContent = t;
    // Only the host starts it, so nobody is dropped into a rally they were not looking at.
    $('#onStart').hidden = !(bothHere && Net.role === 'host');
  }
  function showWaiting(g) {
    showPane('onWait');
    $('#onCodeOut').textContent = g.code;
    $('#onWaitTitle').hidden = !g.title; $('#onWaitTitle').textContent = g.title || '';
    $('#onWaitLbl').textContent = Net.role === 'host' ? 'Your match code' : 'Match code';
    $('#onWaitLead').textContent = g.starts_at
      ? 'Kick-off ' + clockOf(g.starts_at) + '. Share the link and come back then.'
      : 'Share this link. The match starts the moment they open it.';
    $('#onCancel').textContent = Net.role === 'host' ? 'Cancel match' : 'Leave match';
    const box = $('#onShare'); box.textContent = '';
    const links = Net.shareLinks(g.code, g.target, g.title, g.starts_at);
    const copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'pill'; copy.textContent = 'Copy link';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(links.url); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy link'; }, 1600); }
      catch (e) { Err.log(e, 'copy link'); onMsg('Copying is blocked here. The link is: ' + links.url); }
    };
    box.appendChild(copy);
    if (navigator.share) {
      const nat = document.createElement('button');
      nat.type = 'button'; nat.className = 'pill'; nat.textContent = 'Share';
      nat.onclick = () => navigator.share({ title: 'Table', text: links.text, url: links.url }).catch(e => { if (!/abort/i.test(e && e.name || '')) Err.log(e, 'share link'); });
      box.appendChild(nat);
    }
    ['X', 'WhatsApp', 'Telegram', 'Reddit', 'Facebook'].forEach(k => {
      const a = document.createElement('a');
      a.className = 'pill'; a.href = links[k]; a.target = '_blank'; a.rel = 'noopener'; a.textContent = k;
      box.appendChild(a);
    });
    waitMsg();
  }

  // Both players sit on the card until the other is present and the clock has come round; the host
  // then presses Start and both screens count down together.
  function tryStart() {
    if (!Net.game || route !== 'online') return;
    waitMsg();
  }
  function beginMatch() {
    const g = Net.game;
    if (!g || route === 'arena') return;
    const me = Auth.username || 'player';
    const names = Net.role === 'host'
      ? { host_name: me, guest_name: peerName || g.guest_name || 'Guest' }
      : { host_name: g.host_name || peerName || 'Host', guest_name: me };
    countdownNext = true;
    enterVersus(Object.assign({}, g, names), Net.role);
  }
  $('#onStart').onclick = () => { Sfx.unlock(); $('#onStart').hidden = true; Net.go(); beginMatch(); };

  /* ---------- 3 · 2 · 1 ---------- */
  let countdownNext = false, holdUntil = 0, countT = null;
  const held = () => performance.now() < holdUntil;     // no serving until the count is done
  function runCountdown() {
    const box = $('#count'), num = $('#countN');
    clearInterval(countT);
    holdUntil = performance.now() + 3300;
    box.hidden = false; box.classList.remove('go');
    let k = 3;
    const paint = t => { num.textContent = t; num.style.animation = 'none'; void num.offsetWidth; num.style.animation = ''; };
    paint(k); Sfx.ui();
    countT = setInterval(() => {
      k -= 1;
      if (k > 0) { paint(k); Sfx.ui(); }
      else if (k === 0) { box.classList.add('go'); paint('GO'); Sfx.ui(); }
      else { clearInterval(countT); countT = null; box.hidden = true; hooks.ui(); }
    }, 1000);
  }

  async function hostMatch(e) {
    if (e) e.preventDefault();
    if (lobbyBusy) return;
    const picked = pickedStart();
    if (picked === false) return onMsg('That start time is not valid.');
    let startsAt = null;
    if (picked) {
      if (picked.getTime() < Date.now() - 60000) return onMsg('That start time has already passed.');
      startsAt = picked.toISOString();
    }
    lobbyBusy = true; onMsg('Opening a match…');
    try {
      const g = await Net.host({ target: 11, title: $('#onTitle').value.trim(), startsAt });
      $('#onTitle').value = ''; clearStart();
      peerName = null; onMsg(''); showWaiting(g);
    } catch (err) { onMsg(Err.say(err, 'host a match')); }
    lobbyBusy = false;
  }
  async function acceptInvite(code) {
    if (lobbyBusy) return;
    lobbyBusy = true; onMsg('Joining ' + code + '…');
    try {
      const g = await Net.join(code);
      keepInvite(null); $('#onCode').value = '';
      peerName = null; onMsg(''); showWaiting(g); tryStart();
    } catch (e) {
      showPane('onJoinPane');
      onMsg(Err.say(e, 'join a match'));
    }
    lobbyBusy = false;
  }
  const resumeMatch = code => acceptInvite(code);      // re-opening your own match just re-joins it
  async function cancelMatch(code) {
    if (lobbyBusy) return;
    lobbyBusy = true;
    try {
      if (Net.game && Net.game.code === code) await Net.leave();
      else await Net.cancelByCode(code);
      lastOpenSig = null; onMsg('');
    } catch (e) { onMsg(Err.say(e, 'cancel a match')); }
    lobbyBusy = false;
    showPane('onPick');
    refreshMine(); refreshChallenges();
  }
  function enterVersus(g, role) {
    pendingVersus = {
      me: role === 'host' ? 1 : -1, remote: role !== 'host', target: g.target,
      hostName: g.host_name || 'Host', guestName: g.guest_name || 'Guest'
    };
    navigate('arena');
  }
  $('#onHostForm').addEventListener('submit', e => { Sfx.unlock(); hostMatch(e); });
  $('#pickHost').onclick = () => { Sfx.unlock(); showPane('onHostPane'); };
  $('#pickJoin').onclick = () => { Sfx.unlock(); showPane('onJoinPane'); refreshChallenges(); $('#onCode').focus(); };
  $('#hostBack').onclick = () => showPane('onPick');
  $('#joinBack').onclick = () => showPane('onPick');
  $('#onRefresh').onclick = () => { lastOpenSig = null; refreshMine(); refreshChallenges(); };
  $('#onBack').onclick = () => { Net.detach(); navigate('landing'); };
  $('#onWaitBack').onclick = () => { Net.detach(); showLobby(); };      // the invite stays up
  $('#onCancel').onclick = () => cancelMatch(Net.game && Net.game.code);
  $('#onJoinForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#onCode').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,10}$/.test(v)) return onMsg('That is not a match code. They are six characters, like ABC234.');
    acceptInvite(v);
  });

  /* what the network tells us */
  Net.onChange((n, d) => {
    if (n === 'peer') {
      if (d.here) {
        peerName = d.name || peerName;
        if (route === 'online' && !$('#onWait').hidden) { waitMsg(); tryStart(); }
        else $('#link').hidden = true;
        Vid.peerHere();            // they may have missed the first camera offer
        return;
      }
      peerName = null;
      if (route === 'arena' && S.vs && S.state !== 'over') opponentGone(d);
      else if (route === 'online' && !$('#onWait').hidden) waitMsg();
      return;
    }
    if (n === 'want-serve') { if (!held() && S.vs && !S.remote && S.state === 'serve' && server() === -1) doServe(); return; }
    if (n === 'event') { hooks.event(d.n, d.d); return; }                   // the host's match, replayed here
    if (n === 'rtc') { Vid.onSignal(d); return; }
    if (n === 'claim') { paintClaim(d); return; }
    if (n === 'go') { beginMatch(); return; }
    if (n === 'rematch') { acceptInvite(d.code); return; }
    if (n === 'ended') { /* the host has written the result; the over card is already up */ }
  });

  // Walking out and dropping off the network are different things, so say which one happened.
  function opponentGone(d) {
    peerGone = true;
    const who = S.names[String(-S.me)] || 'Your opponent';
    const what = d && d.bye ? ' left the match' : ' lost connection';
    $('#link').hidden = false; $('#link').textContent = who + what;
    toast(who + what);
    setTimeout(() => { if (route === 'arena') navigate('online'); }, 2200);
  }

  /* ---------- seeing and hearing the other player ---------- */
  // Both off until pressed. Nothing is captured and no permission is asked for until then.
  function paintCams() {
    const v = Vid.state;
    // Show the buttons in every 1v1, even where the browser will not allow a camera. Hiding them made
    // the feature look absent rather than unavailable, which is exactly how it was reported.
    $('#btnCam').hidden = !S.vs; $('#btnMic').hidden = !S.vs;
    $('#btnCam').disabled = !v.available; $('#btnMic').disabled = !v.available;
    if (!S.vs || !v.available) { $('#cams').hidden = true; return; }

    $('#btnCam').classList.toggle('on', v.camera);
    $('#btnMic').classList.toggle('on', v.mic);
    $('#btnCam').setAttribute('aria-label', (v.camera ? 'Turn your camera off' : 'Turn your camera on'));
    $('#btnMic').setAttribute('aria-label', (v.mic ? 'Turn your microphone off' : 'Turn your microphone on'));

    const showMe = v.camera, showThem = v.remoteVideo;
    $('#camMe').hidden = !showMe;
    $('#camThem').hidden = !showThem;
    $('#camThemName').textContent = S.names[String(-S.me)] || 'Opponent';
    // A voice with no picture still deserves to be visible, so the tile outlines instead.
    $('#camThem').classList.toggle('talking', v.remoteAudio);
    // Say which of the several possible things went wrong, not just that something did.
    const r = Vid.report(), them = S.names[String(-S.me)] || 'They';
    let note = '';
    if (v.state === 'failed') note = 'Video could not connect on this network';
    else if ((v.camera || v.mic) && r.yourTracks.length === 0) note = 'Your camera gave nothing — check the browser let it through';
    else if (r.connection === 'connecting' && (v.camera || v.mic)) note = 'Connecting…';
    else if ((r.theySayTheyAreSending.camera || r.theySayTheyAreSending.mic) && !v.hasRemote)
      note = them + ' is sending but nothing has arrived — tap Details on any error';
    // Muting the game also mutes the other player, which is right but easy to forget you did.
    else if (v.remoteAudio && Sfx.muted) note = 'Sound is off, so you will not hear them';
    else if ((v.camera || v.mic) && !v.hasRemote) note = 'Waiting for them to turn theirs on';
    else if (v.remoteAudio && !v.remoteVideo) note = them + ' is on mic';
    $('#camNote').textContent = note;
    $('#camNote').hidden = !note;
    $('#cams').hidden = !(showMe || showThem || note);
  }
  function attach() {
    const me = $('#vidMe'), them = $('#vidThem');
    if (me.srcObject !== Vid.localStream) me.srcObject = Vid.localStream || null;
    if (them.srcObject !== Vid.remoteStream) them.srcObject = Vid.remoteStream || null;
    them.muted = Sfx.muted;                 // the master mute should silence a voice too
    them.volume = 1;
    const p = them.play(); if (p && p.catch) p.catch(() => {});
  }
  async function useCam(on) {
    try { Sfx.unlock(); await Vid.setCamera(on); }
    catch (e) { toast(Err.say(e, on ? 'turn the camera on' : 'turn the camera off')); }
    attach(); paintCams();
  }
  async function useMic(on) {
    try { Sfx.unlock(); await Vid.setMic(on); }
    catch (e) { toast(Err.say(e, on ? 'turn the microphone on' : 'turn the microphone off')); }
    attach(); paintCams();
  }
  // Camera and microphone need a secure page. Over plain http on a home network address they simply
  // are not offered by the browser, so say why rather than leaving a dead button.
  const noMedia = () => toast(location.protocol === 'https:' || location.hostname === 'localhost'
    ? 'This browser will not give the game a camera or microphone.'
    : 'Camera and microphone need a secure (https) address. They work on the deployed site, and on localhost.');
  $('#btnCam').onclick = () => Vid.state.available ? useCam(!Vid.state.camera) : noMedia();
  $('#btnMic').onclick = () => Vid.state.available ? useMic(!Vid.state.mic) : noMedia();
  Vid.onChange(() => { attach(); paintCams(); });
  Sfx.onChange(() => { const t = $('#vidThem'); if (t) t.muted = Sfx.muted; });

  /* ---------- the explorer: what is on, what is coming, what has been played ---------- */
  // Public, so it works signed out. Nothing here identifies anyone beyond the username they chose.
  let expTab = 'ongoing', expT = null, expData = null;
  const stopExplore = () => { clearInterval(expT); expT = null; };
  function startExplore() {
    drawExplore();
    refreshExplore();
    stopExplore();
    expT = setInterval(() => { if (route === 'explore') refreshExplore(); }, 6000);
  }
  async function refreshExplore() {
    try {
      expData = await Net.explore();
      drawExplore();
    } catch (e) {
      $('#expNote').textContent = Err.say(e, 'load matches');
    }
  }
  const ago = iso => {
    if (!iso) return '';
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  };
  const when = iso => new Date(iso).toLocaleString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function expRow(g, kind) {
    const li = document.createElement('li');
    const who = document.createElement('span'); who.className = 'who';
    const name = document.createElement('b');
    name.textContent = g.title || (kind === 'upcoming' ? 'Open match' : 'Match');
    const sub = document.createElement('span');
    who.append(name, sub);

    if (kind === 'ongoing') {
      li.className = 'livenow';
      sub.textContent = '@' + g.host_name + ' vs @' + (g.guest_name || 'guest');
      const sc = document.createElement('span'); sc.className = 'sc';
      sc.append(document.createTextNode(g.host_score + ' '));
      const dash = document.createElement('u'); dash.textContent = '–'; sc.appendChild(dash);
      sc.append(document.createTextNode(' ' + g.guest_score));
      const live = document.createElement('span'); live.className = 'when';
      const dot = document.createElement('i'); dot.className = 'dot';
      live.append(dot, document.createTextNode('Live · ' + ago(g.started_at)));
      li.append(who, sc, live);
    } else if (kind === 'upcoming') {
      sub.textContent = '@' + g.host_name + ' · first to ' + g.target;
      const t = document.createElement('span'); t.className = 'when';
      t.textContent = when(g.starts_at) + ' · ' + countdown(startsIn(g));
      t.dataset.at = g.starts_at;
      li.append(who, t);
    } else {
      const winner = g.winner === 'host' ? g.host_name : g.guest_name;
      sub.textContent = '@' + g.host_name + ' vs @' + (g.guest_name || 'guest') +
        (winner ? ' · @' + winner + ' won' : '') + (g.ended_reason === 'left' ? ' (walkover)' : '');
      const sc = document.createElement('span'); sc.className = 'sc';
      sc.append(document.createTextNode(g.host_score + ' '));
      const dash = document.createElement('u'); dash.textContent = '–'; sc.appendChild(dash);
      sc.append(document.createTextNode(' ' + g.guest_score));
      const t = document.createElement('span'); t.className = 'when'; t.textContent = ago(g.ended_at);
      li.append(who, sc, t);
    }
    return li;
  }

  const EMPTY = {
    ongoing: 'Nobody is playing right now.',
    upcoming: 'Nothing scheduled yet.',
    past: 'No finished matches yet.'
  };
  function drawExplore() {
    $$('#explore .tabs button').forEach(b => b.classList.toggle('on', b.dataset.x === expTab));
    const ul = $('#expList');
    ul.textContent = '';
    const rows = (expData && expData[expTab]) || [];
    if (!rows.length) {
      const li = document.createElement('li'); li.className = 'empty';
      li.textContent = expData ? EMPTY[expTab] : 'Loading…';
      ul.appendChild(li);
    } else {
      rows.forEach(g => ul.appendChild(expRow(g, expTab)));
    }
    const n = expData ? (expData.ongoing || []).length : 0;
    $('#expNote').textContent = n ? n + (n === 1 ? ' match' : ' matches') + ' being played now' : '';
  }
  $$('#explore .tabs button').forEach(b => b.onclick = () => { expTab = b.dataset.x; drawExplore(); });
  $('#expBack').onclick = () => navigate('landing');

  /* ---------- sound settings ---------- */
  // One panel, opened from either gear. Sfx owns the values and the saving; this only draws them.
  function paintSound(v) {
    $('#setMute').checked = !v.muted;
    $('#setMuteLabel').textContent = v.muted ? 'Sound off' : 'Sound on';
    $('#setMusic').value = Math.round(v.music * 100);
    $('#setSfx').value = Math.round(v.sfx * 100);
    $('#setMusicVal').textContent = Math.round(v.music * 100) + '%';
    $('#setSfxVal').textContent = Math.round(v.sfx * 100) + '%';
    $('#btnSnd').classList.toggle('off', v.muted);
  }
  function paintTrack() {
    const t = Sfx.track;
    $('#setNow').hidden = !t;
    if (t) $('#setNowName').textContent = t.name + '  (' + t.index + ' of ' + t.of + ')';
  }
  const openSound = () => {
    Sfx.unlock(); paintSound(Sfx.settings); paintTrack();
    $('#setDiagRow').hidden = !S.vs;
    $('#setDiagOut').hidden = true;
    clearInterval(nowT); nowT = setInterval(paintTrack, 2000);
    $('#setM').hidden = false;
  };
  let nowT = null;
  const closeSound = () => { $('#setM').hidden = true; clearInterval(nowT); nowT = null; };
  $('#setSkip').onclick = () => { Sfx.skip(); setTimeout(paintTrack, 600); };
  // During a 1v1 the panel can also hand over everything needed to work out why video is not working.
  $('#setDiag').onclick = async () => {
    const text = JSON.stringify(Vid.report(), null, 2);
    $('#setDiagOut').textContent = text;
    $('#setDiagOut').hidden = false;
    try { await navigator.clipboard.writeText(text); toast('Video diagnostics copied'); }
    catch (e) { toast('Diagnostics shown below'); }
  };
  $('#gearLanding').onclick = openSound;
  $('#gearArena').onclick = openSound;
  $('#setClose').onclick = closeSound;
  $('#setM').addEventListener('click', e => { if (e.target === $('#setM')) closeSound(); });
  $('#setMute').onchange = e => { Sfx.unlock(); Sfx.setMuted(!e.target.checked); if (e.target.checked) Sfx.ui(); };
  $('#setMusic').oninput = e => { Sfx.unlock(); Sfx.setMusic(+e.target.value / 100); };
  $('#setSfx').oninput = e => { Sfx.unlock(); Sfx.setSfx(+e.target.value / 100); };
  $('#setSfx').onchange = () => Sfx.ui();          // a click to hear what you just chose
  Sfx.onChange(paintSound);
  paintSound(Sfx.settings);

  /* ---------- landing extras: opponent picker, shot tips, scoresheet ---------- */
  const TIPS = [
    ['01 —', 'SERVE', 'Toss, bounce, then over the net. Every point starts here.'],
    ['02 —', 'SPIN', 'Swipe up for topspin. Sweep sideways to curve it.'],
    ['03 —', 'SMASH', 'Hit hard to win the point. Hit too hard and it goes out.']
  ];
  let tip = 0;
  setInterval(() => {
    if (route !== 'landing') return; tip = (tip + 1) % TIPS.length;
    $('#anNum').textContent = TIPS[tip][0]; $('#anName').textContent = TIPS[tip][1]; $('#anText').textContent = TIPS[tip][2];
  }, 4500);
  $$('#lvBoxes button').forEach(b => b.onclick = () => setLevel(+b.dataset.l));
  const sheet = []; let sheetN = 0;
  function sheetAdd(name, meta) {
    sheetN++; sheet.push([sheetN, name, meta]); if (sheet.length > 6) sheet.shift();
    const ol = $('#sheet'); ol.textContent = '';
    sheet.forEach(([n, a, b]) => { const li = document.createElement('li'); li.textContent = n + '. ' + a; if (b) { const s = document.createElement('span'); s.textContent = b; li.appendChild(s); } ol.appendChild(li); });
  }
  const cap = s => s[0].toUpperCase() + s.slice(1);

  /* ---------- arena controls ---------- */
  const modalOpen = () => !$('#pauseM').hidden || !$('#overM').hidden;
  function closeModals() { $('#pauseM').hidden = true; $('#overM').hidden = true; }
  const padOn = () => route === 'arena' && (padMode || Scene.wideAngle());
  function refreshUI() {
    const on = padOn(), pad = $('#pad');
    pad.hidden = !on; document.body.classList.toggle('padon', on);
    $('#btnLvl').hidden = S.vs;                     // no CPU level in a 1v1, and no pausing someone else
    $('#btnPause').hidden = S.vs;
    $('#btnLeave').hidden = !S.vs;
    paintCams();
    $('#btnPad').textContent = 'Pad: ' + (padMode ? 'On' : 'Off');
    $('#hint').textContent = padMode ? 'Drag the pad to move. Drag outside to rotate.' : on ? 'Wide angle: use the pad to move.' : touch ? 'Drag to move. Two fingers rotate.' : 'Move to play. Right-drag to rotate. P to pause.';
  }
  const toggleSnd = () => { const m = Sfx.toggle(); if (!m) Sfx.ui(); };
  $('#btnSnd').onclick = () => { Sfx.unlock(); toggleSnd(); };
  $('#btnPause').onclick = () => pause();
  $('#btnLeave').onclick = () => navigate('online');
  $('#btnLvl').onclick = () => { Sfx.unlock(); setLevel((S.level + 1) % LEVELS.length); };
  $('#btnPad').onclick = () => { padMode = !padMode; refreshUI(); };
  $('#btnView').onclick = () => { Scene.resetView(); refreshUI(); };
  $('#mResume').onclick = () => pause(false);
  $('#mRestart').onclick = () => { closeModals(); restart(); };
  $('#mQuit').onclick = () => navigate('landing');
  $('#oAgain').onclick = () => { closeModals(); restart(); };
  $('#oRematch').onclick = async () => {
    $('#oRematch').disabled = true;
    try { await Net.rematch(); keepNet = true; navigate('online'); }
    catch (e) { toast(Err.say(e, 'start a rematch')); navigate('online'); }
    $('#oRematch').disabled = false;
  };
  $('#oQuit').onclick = () => navigate('landing');

  const ptrs = new Map(), padEl = $('#pad'), dot = $('#dot');
  const inPad = e => { const r = padEl.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
  const myPaddle = () => S.me > 0 ? P : C;

  /* ---------- reading the swing ---------- */
  // Where the hand has been on the paddle plane, in metres, over the last tenth of a second. The bat
  // itself follows smoothly for easy aiming; the shot is taken from this instead, so a gentle follow
  // never costs you the ability to hit hard.
  const WINDOW = 110, swing = { pts: [], sx: 0, sy: 0, wind: 0, lastSy: 0, windAt: 0 };
  function swingNote(x, y) {
    const t = performance.now(), p = swing.pts;
    p.push({ x: x, y: y, t: t });
    while (p.length > 2 && t - p[0].t > WINDOW) p.shift();
  }
  function swingRead() {
    const p = swing.pts, t = performance.now();
    while (p.length > 2 && t - p[0].t > WINDOW) p.shift();
    if (p.length < 2 || t - p[p.length - 1].t > 90) {
      swing.sx *= .82; swing.sy *= .82;            // the hand stopped; let the swing die away
    } else {
      const a = p[0], b = p[p.length - 1], dt = (b.t - a.t) / 1000;
      if (dt > .004) {
        const nx = (b.x - a.x) / dt, ny = (b.y - a.y) / dt;
        // Pulled back and then driven forward: a loaded shot, worth more than the speed alone.
        if (swing.lastSy < -.9 && ny > .9) { swing.wind = 1; swing.windAt = t; }
        swing.lastSy = ny;
        swing.sx += (nx - swing.sx) * .5;
        swing.sy += (ny - swing.sy) * .5;
      }
    }
    if (t - swing.windAt > 280) swing.wind = 0; else swing.wind *= .985;
    const me = myPaddle();
    me.sx = swing.sx; me.sy = swing.sy; me.wind = swing.wind;
  }

  function padAim(e) {
    const r = padEl.getBoundingClientRect(), u = clamp((e.clientX - r.left) / r.width, 0, 1), v = clamp((e.clientY - r.top) / r.height, 0, 1);
    const me = myPaddle();
    me.tx = (u - .5) * 2.4 * Scene.flip(); me.ty = .85 - v * .9;
    swingNote(me.tx, me.ty);                       // the pad reads a swing exactly like the pointer does
  }
  addEventListener('pointerdown', e => {
    Sfx.unlock();
    if (route !== 'arena' || modalOpen() || e.target.closest('button,a,input,.modal')) return;
    const p = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: 0, role: 'paddle', bad: e.button === 2 };
    ptrs.set(e.pointerId, p);
    if (ptrs.size > 1) ptrs.forEach(q => { q.role = 'orbit'; q.bad = true; });      // two fingers rotate the view
    else if (e.button === 2 || (!padEl.hidden && !inPad(e))) p.role = 'orbit';       // right-drag, or drag outside the pad
    else if (!padEl.hidden) p.role = 'pad';
    if (p.role === 'pad') padAim(e);
    else if (p.role === 'paddle') { const w = Scene.aim(e.clientX, e.clientY, e.pointerType === 'touch'); if (w) swingNote(w.x, w.y); }
  });
  addEventListener('pointermove', e => {
    if (route === 'landing') { Scene.parallax(e.clientX / innerWidth * 2 - 1, e.clientY / innerHeight * 2 - 1); return; }
    if (route !== 'arena' || modalOpen()) return;
    const p = ptrs.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && padEl.hidden) { const w = Scene.aim(e.clientX, e.clientY, false); if (w) swingNote(w.x, w.y); }
      return;                                      // hovering moves the paddle
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY; p.moved = Math.max(p.moved, Math.hypot(p.x - p.x0, p.y - p.y0));
    if (p.role === 'orbit') { Scene.orbit(dx / ptrs.size, dy / ptrs.size); refreshUI(); }
    else if (p.role === 'pad') padAim(e);
    else { const w = Scene.aim(e.clientX, e.clientY, e.pointerType === 'touch'); if (w) swingNote(w.x, w.y); }
  });
  addEventListener('pointerup', e => {
    const p = ptrs.get(e.pointerId); if (!p) return; ptrs.delete(e.pointerId);
    if (!p.bad && p.moved < 10 && performance.now() - p.t0 < 350 && !held()) tap();   // a quick tap serves
  });
  addEventListener('pointercancel', e => ptrs.delete(e.pointerId));
  addEventListener('contextmenu', e => { if (route === 'arena') e.preventDefault(); });
  addEventListener('keydown', e => {
    if (e.code === 'Escape' && !$('#setM').hidden) { e.preventDefault(); closeSound(); return; }
    if (e.target.tagName === 'INPUT' || route !== 'arena') return;
    const a = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[e.code];
    if (a) { e.preventDefault(); Scene.orbit(a[0], a[1]); refreshUI(); return; }
    if (e.repeat) return;
    Sfx.unlock();
    if (e.code === 'KeyP' || e.code === 'Escape') { e.preventDefault(); if (!$('#overM').hidden || S.vs) return; pause(); }
    else if (e.code === 'Space') { e.preventDefault(); if (S.paused) pause(false); else if (!modalOpen() && !held()) tap(); }
    else if (e.code === 'KeyM') toggleSnd();
  });
  const autoPause = () => { if (route === 'arena' && !S.vs && S.state === 'rally' && !S.paused) pause(true); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
  addEventListener('blur', () => { ptrs.clear(); autoPause(); });

  /* ---------- what the game tells us ---------- */
  const scoreNow = [0, 0];
  hooks.ui = () => {
    const mineIdx = S.me > 0 ? 0 : 1;
    [['#ps', mineIdx], ['#cs', 1 - mineIdx]].forEach(([id, i]) => {
      const el = $(id); el.textContent = pad2(S.score[i]);
      if (S.score[i] > scoreNow[i]) bump(el);
    });
    scoreNow[0] = S.score[0]; scoreNow[1] = S.score[1];
    $('#msg').textContent = S.msg.replace('Click', verb);
    $('#foeName').textContent = foeLabel();
    const lv = LEVELS[S.level];
    $('#btnLvl').textContent = 'Level: ' + lv.n;
    $('#lvNum').textContent = pad2(S.level + 1); $('#lvName').textContent = lv.n + ' CPU';
    $$('#lvBoxes button').forEach(b => b.classList.toggle('on', +b.dataset.l === S.level));
  };
  const REASON_WIN = { Missed: ' missed the return', Net: ' hit the net', Out: ' hit it out', 'Bad bounce': ' faulted' };
  const REASON_LOSE = { Missed: 'You missed it', Net: 'You hit the net', Out: 'Your shot went out', 'Bad bounce': 'Fault' };
  function foeLabel() { return S.vs ? (S.names[String(-S.me)] || 'Rival') : 'CPU'; }   // hoisted: hooks.ui uses it
  hooks.event = (n, d) => {
    if (n === 'want-serve') return Net.requestServe();     // guest asking the host to put the ball in play
    Scene.event(n, d);
    Net.relay(n, d);                                       // host only; it is a no-op otherwise
    if (S.attract || route !== 'arena') { if (S.attract) sheetEvent(n, d); return; }
    const pan = d && d.x !== undefined ? clamp(d.x / 1.5, -1, 1) : 0;
    if (n === 'hit') {
      Sfx.hit(d.kind, pan, d.pow);
      if (d.kind !== 'return') popAt(d.kind.toUpperCase(), d.x, d.y, d.z, d.kind === 'smash' ? 'red' : d.s < 0 ? 'dim' : '');
      if (d.n >= 5 && d.n % 5 === 0) pop('Rally ' + d.n, { x: innerWidth / 2, y: innerHeight * .24, cls: 'red' });
    } else if (n === 'serve') { Sfx.serve(pan); if (d.s > 0) popAt('SERVE', d.x, d.y, d.z, 'dim'); }
    else if (n === 'bounce') Sfx.bounce(d.v, pan);
    else if (n === 'net') { Sfx.net(pan); popAt('NET', d.x, d.y, d.z, 'dim'); }
    else if (n === 'floor') Sfx.floor(d.v, pan);
    else if (n === 'point') {
      const win = d.w === S.me; Sfx.point(win); flash(win);
      const label = win ? 'Point' : foeLabel() + ' point';
      const sub = win ? (REASON_WIN[d.why] ? foeLabel() + REASON_WIN[d.why] : '') : (REASON_LOSE[d.why] || '');
      pop(label, { x: innerWidth / 2, y: innerHeight * .3, big: true, cls: win ? 'win' : 'red', sub });
    } else if (n === 'pause') { $('#pauseM').hidden = !d.v; if (d.v) Sfx.ui(); }
    else if (n === 'over') onOver(d);
  };
  function sheetEvent(n, d) {
    if (n === 'serve') { sheet.length = 0; sheetN = 0; sheetAdd('Serve', ''); }
    else if (n === 'hit') sheetAdd(cap(d.kind), d.speed.toFixed(1) + ' m/s');
    else if (n === 'point') sheetAdd(d.w > 0 ? 'Point: you' : 'Point: CPU', d.score.join('–'));
  }
  async function onOver(d) {
    // d.won is written by whichever browser ran the rules, so work it out from our own side instead.
    const mineIdx = S.me > 0 ? 0 : 1, my = d.score[mineIdx], their = d.score[1 - mineIdx], won = my > their;
    const foeName = foeLabel();
    Sfx.over(won); flash(won);
    $('#overTitle').textContent = won ? 'You win' : (S.vs ? foeName + ' wins' : 'CPU wins');
    $('#overScore').textContent = my + ' – ' + their;
    $('#overM').hidden = false;
    if (S.vs) {
      $('#overStat').textContent = 'Longest rally: ' + d.longest + ' · 1v1 with @' + foeName;
      $('#oAgain').hidden = true; $('#oRematch').hidden = Net.role !== 'host';
      if (Net.role === 'host') await Net.finish(d.score[0], d.score[1]);
      paintClaim(null);
      Net.claimWinner(won);
      return;
    }
    $('#oAgain').hidden = false; $('#oRematch').hidden = true;
    const base = 'Longest rally: ' + d.longest + ' · ' + LEVELS[S.level].n + ' CPU';
    $('#overStat').textContent = base + (Auth.signedIn ? '' : ' · Sign in to save your wins');
    if (Auth.signedIn) {
      const ok = await Auth.saveMatch({ level: LEVELS[S.level].n.toLowerCase(), player_score: d.score[0], cpu_score: d.score[1], won, longest_rally: d.longest });
      if (ok) $('#overStat').textContent = base + ' · Saved';
      else toast(Err.say(Auth.lastSaveError || new Error('The result did not save.'), 'save match'));
    }
  }

  /* Each player says who won, separately, and only a result they agree on can settle a stake. Shown
     even with nothing staked: a disagreement is worth seeing on its own, and this is the path any money
     would take later, so it is better exercised now than switched on for the first time with a bet
     riding on it. */
  function paintClaim(g) {
    const el = $('#overClaim');
    if (!S.vs) { el.hidden = true; return; }
    const odd = Net.scoreDoubts;
    let t;
    if (!g) t = 'Confirming the result\u2026';
    else if (g.result_state === 'agreed') t = 'You both agree on this result.';
    else if (g.result_state === 'disputed') t = 'You and @' + foeLabel() + ' disagree on this result. With a stake on it, you would both be refunded.';
    else t = 'Waiting for @' + foeLabel() + ' to confirm.';
    // The guest cannot prove a rally, but it can see whether the score moved a point at a time.
    if (odd) t += ' \u00b7 ' + odd + ' odd score change' + (odd > 1 ? 's' : '') + ' seen';
    el.textContent = t;
    el.hidden = false;
  }

  /* ---------- go ---------- */
  renderAcct(); enter('landing'); refreshUI();
  // Route once sign-in has settled. A slow or unreachable database must not strand anyone on a blank
  // screen, so give up waiting after four seconds and route as a signed-out visitor.
  Promise.race([
    Auth.init().catch(e => Err.log(e, 'start sign-in')),
    new Promise(r => setTimeout(r, 4000))
  ]).then(() => {
    authReady = true; renderAcct();
    // If the player has already gone somewhere while we were waiting, leave them there.
    if (!routed) onRoute();
    else if (route === 'auth') afterAuth();
  });
  let last = performance.now();
  function step(now) {
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    swingRead();
    frame(dt); Scene.frame(dt);
    if (!padEl.hidden) { const me = myPaddle(); dot.style.left = (50 + me.x / 2.4 * Scene.flip() * 100) + '%'; dot.style.top = ((.85 - me.y) / .9 * 100) + '%'; }
    Net.pump(dt);
  }
  function loop(now) { step(now); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
  // A hidden tab stops requestAnimationFrame. On your own against the CPU that is what pausing is for,
  // but in a 1v1 it would freeze the match for the other player too, so keep it ticking from a timer
  // until the tab comes back. It runs slower while hidden; it does not stop.
  setInterval(() => { if (S.vs && Net.live && performance.now() - last > 250) step(performance.now()); }, 100);
  window.__table = { S, P, C, ball, navigate, Scene };   // handy for testing in the console
})();
