/* Table – unfinished business: matches to go back to, and money still in escrow.

   Two things go missing when somebody closes the tab. A match under way is simply abandoned, even
   though the table still has it and the other player may be waiting. And a stake sits in the escrow
   with the only route to it — the end-of-match card — gone with the page.

   This is the way back to both. It reads the table for what is unfinished, then asks the chain what is
   actually true of each pot, because the table's `stake_status` is a note somebody's browser left and
   not an account of where the money is. A match the table calls locked may already have been paid.

   Nothing here decides anything about money. Every button ends in js/stake.js, which ends in the
   program. */
const Purse = (function () {
  const $ = s => document.querySelector(s);
  let rows = [], busy = false, loading = false;
  const hooks = { onResume: () => {} };

  const money = g => !!(g.stake_status && g.stake_status !== 'none');
  const playable = g => g.status === 'open' || g.status === 'live';
  const el = () => $('#purse');

  /** Everything of mine that is not finished, each paired with what the chain says about its pot. */
  async function load() {
    if (loading || !Auth.signedIn) return;
    loading = true;
    try {
      const mine = await Net.myGames();
      const out = [];
      for (const g of (mine || [])) {
        let chain = null;
        // Only ask the chain about matches that ever had a stake, so an ordinary match costs nothing.
        if (money(g) && Stake.configured()) {
          try { chain = await Stake.read(g.code); } catch (e) { Err.log(e, 'read a stake'); }
        }
        // A pot already settled or returned is finished business, whatever the table still says.
        if (chain && (chain.state === 'settled' || chain.state === 'refunded')) {
          if (!playable(g)) continue;
          chain = null;
        }
        if (!playable(g) && !chain) continue;      // over, and no money left in it
        out.push({ g: g, chain: chain });
      }
      rows = out;
    } catch (e) { Err.log(e, 'look for unfinished matches'); }
    loading = false;
    paint();
  }

  /** What this player can do about one row, in the fewest words that are still true. */
  function action(row) {
    const { g, chain } = row;
    const me = g.role === 'host' ? g.host_wallet : g.guest_wallet;
    if (chain && me) {
      const side = Stake.sideOf(chain, me);
      // Not our pot. It can happen when a wallet is changed between matches, and every branch below
      // assumes a side, so without this a player is offered buttons that spend their fees on somebody
      // else's match.
      if (!side) return playable(g) ? resume(g) : null;
      const isaid = side && (side === 'host' ? chain.hostSaid : chain.guestSaid);
      const theysaid = side && (side === 'host' ? chain.guestSaid : chain.hostSaid);
      const s = Stake.split(chain.units, chain.feeBps);
      const iWon = chain.agreed && chain.hostSaid === side;
      const expired = Date.now() >= chain.deadline;

      if (chain.state === 'open') {
        return side ? { do: 'stake', label: 'Put up ' + chain.amount, why: 'Your stake is not in yet.' }
                    : null;
      }
      if (chain.agreed) {
        return { do: 'settle',
                 label: iWon ? 'Collect ' + Stake.fromUnits(s.toWinner, chain.decimals) : 'Release the pot',
                 why: iWon ? 'You won and it is still sitting there.' : 'They won; this sends it over.' };
      }
      if (isaid && theysaid) {
        return { do: 'refund', label: 'Take back ' + chain.amount, why: 'You disagreed on the result.' };
      }
      if (!isaid && !playable(g)) {
        return { do: 'confirm', label: 'Confirm the result', why: 'Nothing pays out until you both say who won.' };
      }
      if (expired) {
        return { do: 'refund', label: 'Take back ' + chain.amount, why: 'They never confirmed and the time is up.' };
      }
      if (isaid) return { do: null, label: '', why: 'Waiting for them to confirm.' };
    }
    return playable(g) ? resume(g) : null;
  }
  const resume = g => ({
    do: 'resume', label: g.status === 'live' ? 'Rejoin' : 'Open',
    why: g.status === 'live' ? 'Still going: ' + (g.host_score | 0) + '–' + (g.guest_score | 0)
                             : 'Nobody has joined yet.'
  });

  function paint() {
    const box = el();
    if (!box) return;
    const shown = rows.map(r => ({ r: r, a: action(r) })).filter(x => x.a);
    box.textContent = '';
    box.hidden = !shown.length;
    if (!shown.length) return;

    const h = document.createElement('p');
    h.className = 'lbl';
    h.textContent = shown.length === 1 ? 'Unfinished' : 'Unfinished · ' + shown.length;
    box.appendChild(h);

    shown.forEach(({ r, a }) => {
      const line = document.createElement('div');
      line.className = 'purserow';

      const left = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = r.g.title || r.g.code;
      left.appendChild(name);
      const why = document.createElement('span');
      why.className = 'mini';
      const other = r.g.role === 'host' ? r.g.guest_name : r.g.host_name;
      why.textContent = (other ? '@' + other + ' · ' : '') + a.why;
      left.appendChild(why);
      line.appendChild(left);

      if (a.do) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn' + (a.do === 'settle' || a.do === 'refund' ? ' red' : '');
        b.textContent = a.label;
        b.disabled = busy;
        b.onclick = () => run(r, a.do);
        line.appendChild(b);
      }
      box.appendChild(line);
    });
  }

  /** Carry out one row's action. Money goes through js/stake.js; a match goes back to the lobby. */
  async function run(row, what) {
    if (busy) return;
    const { g } = row;
    if (what === 'resume') { hooks.onResume(g); return; }

    const me = g.role === 'host' ? g.host_wallet : g.guest_wallet;
    if (!me) return Err.show(new Error('Connect the wallet you played that match with.'), 'staking');
    busy = true; paint();
    try {
      let sig = null;
      if (what === 'settle') { sig = await Stake.settle(g.code, me); await Net.stakeStepFor(g.code, 'paid', sig); }
      else if (what === 'refund') { sig = await Stake.refund(g.code, me); await Net.stakeStepFor(g.code, 'refunded', sig); }
      else if (what === 'confirm') {
        // Whoever has the better score on the table's own record won it. The table has this because the
        // host posted it after every point, which is also what makes it safe to read once both have
        // stopped playing: it is the last agreed state, not one side's word now.
        const iWon = g.role === 'host' ? (g.host_score > g.guest_score) : (g.guest_score > g.host_score);
        if (g.host_score === g.guest_score) throw new Error('That match has no winner to confirm.');
        sig = await Stake.claim(g.code, iWon, me);
      } else if (what === 'stake') {
        const them = g.role === 'host' ? g.guest_wallet : g.host_wallet;
        if (!them) throw new Error('The other player has not connected a wallet.');
        sig = await Stake.join(g.code, me);
      }
      busy = false;
      await load();
      if (sig) toastTx(sig);
    } catch (e) {
      busy = false; paint();
      Err.show(e, 'staking');
    }
  }
  function toastTx(sig) {
    const box = el();
    if (!box) return;
    const a = document.createElement('a');
    a.className = 'mini'; a.target = '_blank'; a.rel = 'noopener';
    a.href = Stake.txUrl(sig); a.textContent = 'Done · view on Solana explorer';
    box.appendChild(a);
  }

  return {
    load, paint,
    // Exposed so tools/purse-rules.html can check the decision table without a database, a wallet or a
    // played match. It is a pure function of one row, and the branch it picks decides whether somebody
    // can reach their money, so it is worth being able to test on its own.
    decide: action,
    onResume(f) { hooks.onResume = f; },
    get count() { return rows.map(r => action(r)).filter(Boolean).length; }
  };
})();
