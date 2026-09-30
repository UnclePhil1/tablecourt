/* Table – the staking parts of the interface.
 *
 * Every panel here is drawn from what the server said. It works nothing out for itself: not who won,
 * not what a payout is worth, not whether a pot may be released. A browser is editable by whoever is
 * looking at it, so anything decided here is a thing a player could decide in their own favour.
 *
 * The state a staked match moves through:
 *
 *   nobody has paid   -> both players see "Stake 10"
 *   one has paid      -> they wait, the other still sees the button
 *   both have paid    -> the match may start, and not before
 *   played and agreed -> the winner collects
 *
 * Whose stake is in comes from the database, through stake_in_host and stake_in_guest, which only the
 * server writes and only after FossaPay confirmed the transfer.
 */
const StakeUI = (function () {
  const $ = s => document.querySelector(s);
  let busy = false, poll = null, lastTx = null, wallet = null;
  const hooks = { onLockedChange: () => {} };

  const on = g => !!(g && g.stake_status && g.stake_status !== 'none');
  const iAmHost = () => Net.role === 'host';
  /** Did this player's own stake reach the pot? The server's record, not a guess. */
  const minePaid = g => !!(g && (iAmHost() ? g.stake_in_host : g.stake_in_guest));
  const theirsPaid = g => !!(g && (iAmHost() ? g.stake_in_guest : g.stake_in_host));
  /** Both stakes in. A staked match must not start before this. */
  const locked = () => { const g = Net.game; return on(g) && minePaid(g) && theirsPaid(g); };

  const say = (el, t) => { const e = $(el); if (e) e.textContent = t || ''; };

  /* ---------- creating a match ---------- */
  async function paintForm() {
    const row = $('#stakeRow');
    if (!row) return;
    row.hidden = !(Stake.configured() && Auth.signedIn);
    if (row.hidden) return;

    const amount = $('#onStake'), cur = $('#onStakeCur');
    /* Not ready yet. The controls stay on screen so people can see what is coming, but they cannot be
       used, and wanted() below returns nothing whatever is in them — so a match cannot be staked even
       if the disabled attribute is edited away, which in a browser takes about four seconds. */
    if (Stake.comingSoon()) {
      row.classList.add('soon');
      if (amount) { amount.disabled = true; amount.value = ''; amount.placeholder = '—'; }
      if (cur) { cur.disabled = true; fillCurrencies(Stake.currencies); }
      say('#stakeUnit', 'coming soon');
      say('#stakeNote', 'Playing for a stake is not switched on yet. Matches are free to play in the meantime.');
      return;
    }

    row.classList.remove('soon');
    if (amount) { amount.disabled = false; amount.placeholder = '0'; }
    if (cur) cur.disabled = false;
    say('#stakeUnit', 'optional');
    say('#stakeNote', 'Both players put up the same. The winner takes the pot less 1% of each stake.');
    fillCurrencies(Stake.currencies);
    try {
      wallet = await Stake.wallet();
      if (wallet && !wallet.linked) {
        say('#stakeNote', 'Staking opens a wallet for you the first time you put money up.');
        return;
      }
      const bals = wallet && wallet.balances;
      if (!bals) return;
      // Only offer tokens they actually hold; staking one they have none of only fails later.
      const held = (wallet.currencies || Object.keys(bals)).filter(c => bals[c] && bals[c].amount !== '0');
      if (held.length) {
        fillCurrencies(held);
        say('#stakeNote', 'You have ' + held.map(c => bals[c].amount + ' ' + bals[c].label).join(', ')
          + '. The winner takes the pot less 1% of each stake.');
      } else {
        say('#stakeNote', 'Your wallet is empty — add money on your profile before staking a match.');
      }
    } catch (e) { Err.log(e, 'read your wallet'); }
  }

  /** The tokens offered on the host form. */
  function fillCurrencies(list) {
    const sel = $('#onStakeCur');
    if (!sel) return;
    const was = sel.value;
    sel.textContent = '';
    (list || []).forEach(c => {
      const o = document.createElement('option');
      o.value = c; o.textContent = Stake.labelOf(c);
      sel.appendChild(o);
    });
    if (was && (list || []).indexOf(was) >= 0) sel.value = was;
  }

  /** Which token the host picked, for the match they are about to create. */
  function wantedCurrency() {
    const sel = $('#onStakeCur');
    return (sel && sel.value) || Stake.defaultCurrency;
  }

  /** What the host typed, or null. Refuses nonsense here so the table never sees it. */
  function wanted() {
    // The single place a stake is read from, so the one place it has to be refused while it is closed.
    if (!Stake.open()) return null;
    const el = $('#onStake');
    if (!el || !$('#stakeRow') || $('#stakeRow').hidden) return null;
    const v = (el.value || '').trim();
    if (!v || Number(v) === 0) return null;
    if (!/^\d+(\.\d+)?$/.test(v)) throw new Error('That stake is not a number.');
    if (Number(v) <= 0) throw new Error('A stake has to be more than nothing.');
    return v;
  }

  /* ---------- the card you wait on ---------- */
  async function refresh() {
    const box = $('#onStakeBox');
    if (!box) return;
    let g = Net.game;
    if (!on(g)) { box.hidden = true; stopPoll(); return; }
    box.hidden = false;
    const was = locked();
    // The other player pays from their own browser, so the only way to learn of it is to ask again.
    g = (await Net.refreshGame()) || g;
    paintWait();
    if (locked() !== was) hooks.onLockedChange();
  }

  function paintWait() {
    const g = Net.game;
    if (!on(g)) return;
    const amt = String(g.stake_amount || '0');
    const cur = Stake.labelOf(g.stake_token);
    const btn = $('#onStakePay');
    say('#onStakeAmt', amt + ' ' + cur + ' each');
    btn.hidden = true;
    btn.disabled = busy;
    const tx = $('#onStakeTx');
    if (tx) tx.hidden = !lastTx;

    const them = iAmHost() ? (g.guest_name || 'them') : (g.host_name || 'them');
    if (!g.guest_name) { say('#onStakeMsg', 'Nothing is put up until the other player arrives.'); return; }

    if (minePaid(g) && theirsPaid(g)) {
      const win = Stake.roughWin(amt, g.stake_token);
      say('#onStakeMsg', 'Both stakes are in.' + (win ? ' The winner takes about ' + win + ' ' + cur + '.' : ''));
      return;
    }
    if (minePaid(g)) { say('#onStakeMsg', 'Yours is in. Waiting for @' + them + ' to put theirs up.'); return; }

    btn.hidden = false;
    btn.textContent = busy ? 'Paying…' : 'Stake ' + amt + ' ' + cur;
    say('#onStakeMsg', theirsPaid(g)
      ? '@' + them + ' has paid. Put yours up and the match can start.'
      : 'Put up ' + amt + ' ' + cur + '. Either of you can go first.');
  }

  /** Pay this player's stake in. The amount is the server's business, so none is sent. */
  async function pay() {
    if (busy || !on(Net.game)) return;
    busy = true; paintWait();
    try {
      const w = await Stake.wallet();
      if (!w || !w.linked) await Stake.openWallet();
      const out = await Stake.put(Net.game.code);
      lastTx = out && out.tx;
      Stake.forget();
      busy = false;
      await refresh();
    } catch (e) {
      busy = false; paintWait();
      Err.show(e, 'staking');
    }
  }

  /* ---------- the card at the end ---------- */
  async function refreshOver() {
    const box = $('#overStake');
    if (!box) return;
    if (!on(Net.game)) { box.hidden = true; return; }
    box.hidden = false;
    await Net.refreshGame();
    paintOver();
  }

  function paintOver() {
    const g = Net.game;
    const btn = $('#overStakeAct');
    if (!btn) return;
    btn.hidden = true; btn.disabled = busy;
    const tx = $('#overStakeTx');
    if (tx) tx.hidden = !lastTx;
    if (!on(g)) { say('#overStakeMsg', 'Nothing was staked on this match.'); return; }

    if (g.stake_status === 'paid') { say('#overStakeMsg', 'Paid out.'); return; }
    if (g.stake_status === 'refunded') { say('#overStakeMsg', 'Stakes returned. Nobody was charged.'); return; }
    if (g.stake_status !== 'locked') { say('#overStakeMsg', 'This match was never fully staked.'); return; }

    const iSaid = g.my_claim;
    const theySaid = g.they_claimed;
    const them = iAmHost() ? (g.guest_name || 'them') : (g.host_name || 'them');

    if (!iSaid) { say('#overStakeMsg', 'Confirm the result above. Nothing pays out until you both do.'); return; }
    if (!theySaid) { say('#overStakeMsg', 'Yours is in. Waiting for @' + them + ' to confirm.'); return; }

    if (g.result_state === 'disputed') {
      btn.hidden = false;
      btn.dataset.act = 'settle';
      btn.textContent = busy ? 'Working…' : 'Take your stake back';
      say('#overStakeMsg', 'You disagree on who won, so nobody is paid and nobody is charged.');
      return;
    }
    // Agreed. Who won is the server's to say; this only asks it to settle.
    const iWon = g.my_claim === (iAmHost() ? 'host' : 'guest');
    btn.hidden = false;
    btn.dataset.act = 'settle';
    btn.textContent = busy ? 'Working…' : (iWon ? 'Collect your winnings' : 'Release the pot');
    say('#overStakeMsg', iWon
      ? 'You both agree. Collecting sends the pot to you, less the 1% fee.'
      : 'You both agree, so the pot is theirs. They can collect it themselves — this only sends it over.');
  }

  /** Collect, release, or take back — the server decides which of those it actually is. */
  async function act() {
    if (busy || !on(Net.game)) return;
    busy = true; paintOver();
    try {
      const out = await Stake.settle(Net.game.code);
      lastTx = out && out.tx;
      Stake.forget();
      busy = false;
      await refreshOver();
      if (out && out.paid) toast('Paid: ' + out.amount + ' ' + (out.currency || ''));
      else if (out && out.refunded) toast('Stakes returned.');
    } catch (e) {
      busy = false; paintOver();
      Err.show(e, 'staking');
    }
  }
  function toast(t) { const el = $('#overStakeMsg'); if (el) el.textContent = t; }

  /* ---------- keeping up with the other player ---------- */
  function startPoll(which) {
    stopPoll();
    const tick = which === 'over' ? refreshOver : refresh;
    tick();
    poll = setInterval(() => { if (!document.hidden && !busy) tick(); }, 5000);
  }
  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  function wire() {
    const p = $('#onStakePay'), a = $('#overStakeAct');
    if (p) p.onclick = pay;
    if (a) a.onclick = act;
  }

  return {
    wire, paintForm, wanted, wantedCurrency, refresh, refreshOver, startPoll, stopPoll,
    isOn: () => on(Net.game),
    locked,
    reset() { lastTx = null; busy = false; stopPoll(); },
    onLockedChange(f) { hooks.onLockedChange = f; }
  };
})();
