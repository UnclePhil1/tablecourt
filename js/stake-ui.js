/* Table – the staking parts of the interface.

   Kept out of js/app.js because none of it runs unless a match is actually staked, and because the one
   rule that matters here is easier to see when it is not buried in lobby code: **the chain is asked, the
   table is only told**. Every panel below is painted from Stake.read(), which reads the escrow account
   itself. js/net.js is informed afterwards so the lobby and the explorer have something to show, and
   nothing is ever decided from what it says.

   The order is forced by the escrow: the program wants the guest named when the pot is opened, so the
   host cannot put money up until somebody has actually joined. That is why the stake is collected in the
   waiting card rather than on the form that creates the match.

   A wallet window is never opened without the player pressing something first. */
const StakeUI = (function () {
  const $ = s => document.querySelector(s);
  let chain = null;           // the escrow account, or null when no pot exists yet
  let poll = null, busy = false, lastTx = null;
  const hooks = { onLockedChange: () => {} };

  const on = g => !!(g && g.stake_status && g.stake_status !== 'none');
  const mine = g => (Net.role === 'host' ? g.host_wallet : g.guest_wallet);
  const theirs = g => (Net.role === 'host' ? g.guest_wallet : g.host_wallet);
  const iAmHost = () => Net.role === 'host';
  /** True once both stakes are in. Until then a staked match must not be allowed to start. */
  const locked = () => !!(chain && chain.state === 'locked');

  const short = a => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
  const say = (el, t) => { const e = $(el); if (e) e.textContent = t || ''; };
  function txLink(el, sig) {
    const a = $(el);
    if (!a) return;
    a.hidden = !sig;
    if (sig) a.href = Stake.txUrl(sig);
  }

  /* ---------- the form that creates a match ---------- */
  function paintForm() {
    const row = $('#stakeRow');
    if (!row) return;
    // No token configured, or no wallet on this account: staking simply is not offered. Better than
    // offering it and failing at the moment money is involved. Either way of signing in can carry a
    // wallet — one is the account itself, the other added it to a profile — so both are checked.
    const can = Stake.configured() && !!((Auth.profile && Auth.profile.wallet) || Auth.wallet);
    row.hidden = !can;
    if (!can) return;
    say('#stakeUnit', 'optional · both players put up the same');
    say('#stakeNote', 'Devnet test coins, worth nothing. The winner takes the pot less 1% of each stake.');
  }
  /** What the host typed, or null for an unstaked match. Throws on nonsense rather than staking it. */
  function wanted() {
    const el = $('#onStake');
    if (!el || $('#stakeRow').hidden) return null;
    const v = (el.value || '').trim();
    if (!v || Number(v) === 0) return null;
    if (!/^\d+(\.\d+)?$/.test(v)) throw new Error('That stake is not a number.');
    if (Number(v) <= 0) throw new Error('A stake has to be more than nothing.');
    return v;
  }

  /* ---------- the waiting card ---------- */
  async function refresh() {
    const g = Net.game;
    const box = $('#onStakeBox');
    if (!box) return;
    if (!on(g)) { box.hidden = true; chain = null; stopPoll(); return; }
    box.hidden = false;
    const was = locked();
    try { chain = await Stake.read(g.code); }
    catch (e) { Err.log(e, 'read the stake'); }
    paintWait();
    if (locked() !== was) hooks.onLockedChange();
  }

  function paintWait() {
    const g = Net.game;
    if (!on(g)) return;
    const amt = (chain ? chain.amount : g.stake_amount) || '0';
    say('#onStakeAmt', amt + ' each');
    const btn = $('#onStakePay');
    btn.hidden = true;
    btn.disabled = busy;
    txLink('#onStakeTx', lastTx);

    if (!theirs(g)) {
      say('#onStakeMsg', 'Nothing is put up until the other player arrives.');
      return;
    }
    if (!chain) {
      // No pot yet. Only the host can make one, because the program wants the guest named in it.
      if (iAmHost()) {
        btn.hidden = false;
        btn.textContent = busy ? 'Waiting for your wallet…' : 'Put up ' + amt;
        say('#onStakeMsg', 'You go first: this opens the pot and names @' + (g.guest_name || 'them') + ' as the only person who can match it.');
      } else {
        say('#onStakeMsg', 'Waiting for @' + (g.host_name || 'the host') + ' to put their stake up.');
      }
      return;
    }
    if (chain.state === 'open') {
      if (iAmHost()) {
        say('#onStakeMsg', 'Yours is in. Waiting for @' + (g.guest_name || 'them') + ' to match it.');
      } else {
        btn.hidden = false;
        btn.textContent = busy ? 'Waiting for your wallet…' : 'Match ' + amt;
        say('#onStakeMsg', '@' + (g.host_name || 'the host') + ' has put up ' + amt + '. Match it and the match can start.');
      }
      return;
    }
    if (chain.state === 'locked') {
      const s = Stake.split(chain.units, chain.feeBps);
      say('#onStakeMsg', 'Both stakes are in. The winner takes ' +
        Stake.fromUnits(s.toWinner, chain.decimals) + ', once you both agree who that was.');
      return;
    }
    say('#onStakeMsg', chain.state === 'settled' ? 'This pot has already been paid out.' : 'This pot was returned.');
  }

  /** The one button on the waiting card: put your own stake up. */
  async function pay() {
    const g = Net.game;
    if (!on(g) || busy) return;
    const me = mine(g), them = theirs(g);
    if (!me) return fail(new Error('Connect a Solana wallet before staking.'));
    if (!them) return fail(new Error('Nobody has joined yet, so there is nothing to stake against.'));
    busy = true; paintWait();
    try {
      // Refuse before opening a wallet window, so the player is not asked to sign something that cannot
      // work. The program would reject it anyway; this just says why in words.
      const amt = (chain ? chain.amount : g.stake_amount);
      const held = await Stake.balance(me);
      if (held && Stake.toUnits(amt, held.decimals) > held.units) {
        throw new Error('You have ' + held.amount + ' and this needs ' + amt + '.');
      }
      let sig;
      if (!chain) sig = await Stake.open(g.code, them, amt, me);
      else if (chain.state === 'open') sig = await Stake.join(g.code, me);
      else return;
      lastTx = sig;
      busy = false;
      await refresh();
      // Tell the table only after the chain has it, and only as something to display.
      if (locked()) await Net.stakeStep('locked', sig);
    } catch (e) {
      busy = false;
      paintWait();
      fail(e);
    }
  }
  const fail = e => { Err.show(e, 'staking'); };

  /* ---------- the card at the end ---------- */
  async function refreshOver() {
    const g = Net.game;
    const box = $('#overStake');
    if (!box) return;
    if (!on(g)) { box.hidden = true; return; }
    box.hidden = false;
    try { chain = await Stake.read(g.code); } catch (e) { Err.log(e, 'read the stake'); }
    paintOver();
  }

  function paintOver() {
    const g = Net.game;
    const btn = $('#overStakeAct');
    btn.hidden = true; btn.disabled = busy;
    txLink('#overStakeTx', lastTx);
    if (!chain) { say('#overStakeMsg', 'Nothing was staked on this match.'); return; }

    if (chain.state === 'settled') { say('#overStakeMsg', 'Paid out.'); return; }
    if (chain.state === 'refunded') { say('#overStakeMsg', 'Stakes returned. Nobody was charged.'); return; }

    const meSide = iAmHost() ? 'host' : 'guest';
    const isaid = iAmHost() ? chain.hostSaid : chain.guestSaid;
    const theysaid = iAmHost() ? chain.guestSaid : chain.hostSaid;
    const expired = Date.now() >= chain.deadline;

    if (!isaid) {
      btn.hidden = false;
      btn.textContent = busy ? 'Waiting for your wallet…' : 'Confirm the result';
      say('#overStakeMsg', 'The pot pays out only when you both say who won. Confirming is what releases it.');
      return;
    }
    if (isaid && theysaid && isaid !== theysaid) {
      btn.hidden = false;
      btn.textContent = busy ? 'Waiting for your wallet…' : 'Take your stake back';
      say('#overStakeMsg', 'You disagree on who won, so nobody is paid and nobody is charged.');
      btn.dataset.act = 'refund';
      return;
    }
    if (chain.agreed) {
      const s = Stake.split(chain.units, chain.feeBps);
      const iWon = (chain.hostSaid === meSide);
      btn.hidden = false;
      btn.textContent = busy ? 'Waiting for your wallet…' : (iWon ? 'Collect ' + Stake.fromUnits(s.toWinner, chain.decimals) : 'Pay out');
      say('#overStakeMsg', iWon
        ? 'You both agree. Collecting sends the pot to you, less the 1% fee.'
        : 'You both agree. Either of you can release the pot; it goes to them either way.');
      btn.dataset.act = 'settle';
      return;
    }
    if (expired) {
      btn.hidden = false;
      btn.textContent = 'Take your stake back';
      btn.dataset.act = 'refund';
      say('#overStakeMsg', 'They never confirmed and the time is up, so you can take your own stake back.');
      return;
    }
    say('#overStakeMsg', 'Yours is in. Waiting for @' + (iAmHost() ? (g.guest_name || 'them') : (g.host_name || 'them')) + ' to confirm.');
  }

  /** Confirm, collect, or take back — whichever the card is currently offering. */
  async function act() {
    const g = Net.game;
    if (!on(g) || busy || !chain) return;
    const me = mine(g);
    const what = $('#overStakeAct').dataset.act || 'claim';
    busy = true; paintOver();
    try {
      let sig;
      if (what === 'settle') { sig = await Stake.settle(g.code, me); await Net.stakeStep('paid', sig); }
      else if (what === 'refund') { sig = await Stake.refund(g.code, me); await Net.stakeStep('refunded', sig); }
      else {
        // Who won, from this player's own point of view, not from the score the host sent.
        const mineIdx = S.me > 0 ? 0 : 1;
        const iWon = S.score[mineIdx] > S.score[1 - mineIdx];
        sig = await Stake.claim(g.code, iWon, me, iAmHost());
      }
      lastTx = sig;
      busy = false;
      await refreshOver();
    } catch (e) { busy = false; paintOver(); fail(e); }
  }

  /* ---------- keeping up with the other player ---------- */
  // The escrow is the shared truth and the other side changes it from their own browser, so it is
  // re-read rather than guessed at. Only while a staking panel is actually on screen.
  function startPoll(which) {
    stopPoll();
    const tick = which === 'over' ? refreshOver : refresh;
    tick();
    poll = setInterval(() => {
      if (document.hidden || busy) return;
      tick();
    }, 5000);
  }
  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  function wire() {
    const pay$ = $('#onStakePay'), act$ = $('#overStakeAct');
    if (pay$) pay$.onclick = pay;
    if (act$) act$.onclick = act;
  }

  return {
    wire, paintForm, wanted, refresh, refreshOver, startPoll, stopPoll,
    isOn: () => on(Net.game),
    locked,
    reset() { chain = null; lastTx = null; busy = false; stopPoll(); },
    onLockedChange(f) { hooks.onLockedChange = f; }
  };
})();
