/* Table – unfinished business: matches to go back to, and stakes not yet settled.
 *
 * Two things went missing when somebody closed the tab. A match under way was abandoned even though
 * the table still had it. And a staked match that ended without anybody pressing anything left the
 * pot sitting in the business wallet, with the only route to it — the end-of-match card — gone with
 * the page.
 *
 * Every row is drawn from what the table says, and every button asks the server to act. Nothing here
 * decides who won or what anything is worth; it offers, and the server refuses anything it should.
 */
const Purse = (function () {
  const $ = s => document.querySelector(s);
  let rows = [], busy = false, loading = false;
  const hooks = { onResume: () => {} };

  const money = g => !!(g.stake_status && g.stake_status !== 'none');
  const playable = g => g.status === 'open' || g.status === 'live';
  const el = () => $('#purse');

  /** Everything of mine that is not finished. The table already knows; it just has to be asked. */
  async function load() {
    if (loading || !Auth.signedIn) return;
    loading = true;
    try {
      const mine = await Net.myGames();
      rows = (mine || []).filter(g => playable(g) || settleable(g));
    } catch (e) { Err.log(e, 'look for unfinished matches'); }
    loading = false;
    paint();
  }

  /** A staked match with money still in the pot: both paid in, nothing paid out. */
  const settleable = g => money(g)
    && g.stake_status !== 'paid' && g.stake_status !== 'refunded'
    && !!(g.stake_in_host && g.stake_in_guest);

  /** What this player can do about one row, in the fewest words that are still true. */
  function decide(g) {
    if (settleable(g)) {
      const mineIn = g.my_claim;
      const iAmHost = g.role === 'host';
      const them = iAmHost ? (g.guest_name || 'them') : (g.host_name || 'them');
      if (g.result_state === 'disputed') {
        return { do: 'settle', label: 'Take your stake back', why: 'You disagreed on the result.' };
      }
      if (g.result_state === 'agreed') {
        const iWon = mineIn === (iAmHost ? 'host' : 'guest');
        return { do: 'settle', label: iWon ? 'Collect your winnings' : 'Release the pot',
                 why: iWon ? 'You won and it is still sitting there.' : 'They won; this sends it over.' };
      }
      if (!mineIn && !playable(g)) {
        return { do: 'confirm', label: 'Confirm the result', why: 'Nothing pays out until you both say who won.' };
      }
      if (mineIn) return { do: null, label: '', why: 'Waiting for @' + them + ' to confirm.' };
    }
    if (playable(g)) {
      return { do: 'resume', label: g.status === 'live' ? 'Rejoin' : 'Open',
               why: g.status === 'live'
                 ? 'Still going: ' + (g.host_score | 0) + '–' + (g.guest_score | 0)
                 : 'Nobody has joined yet.' };
    }
    return null;
  }

  function paint() {
    const box = el();
    if (!box) return;
    const shown = rows.map(g => ({ g: g, a: decide(g) })).filter(x => x.a);
    box.textContent = '';
    box.hidden = !shown.length;
    if (!shown.length) return;

    const h = document.createElement('p');
    h.className = 'lbl';
    h.textContent = shown.length === 1 ? 'Unfinished' : 'Unfinished · ' + shown.length;
    box.appendChild(h);

    shown.forEach(({ g, a }) => {
      const line = document.createElement('div');
      line.className = 'purserow';
      const left = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = g.title || g.code;
      left.appendChild(name);
      const why = document.createElement('span');
      why.className = 'mini';
      const other = g.role === 'host' ? g.guest_name : g.host_name;
      const stake = money(g) ? (g.stake_amount + ' ' + Stake.labelOf(g.stake_token) + ' · ') : '';
      why.textContent = stake + (other ? '@' + other + ' · ' : '') + a.why;
      left.appendChild(why);
      line.appendChild(left);
      if (a.do) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn' + (a.do === 'settle' ? ' red' : '');
        b.textContent = a.label;
        b.disabled = busy;
        b.onclick = () => run(g, a.do);
        line.appendChild(b);
      }
      box.appendChild(line);
    });
  }

  /** Carry out a row's action. Money goes to the server; a match goes back to the lobby. */
  async function run(g, what) {
    if (busy) return;
    if (what === 'resume') { hooks.onResume(g); return; }
    busy = true; paint();
    try {
      if (what === 'confirm') {
        // Who won, from this player's own side of the score the table kept while they played.
        const iAmHost = g.role === 'host';
        if (g.host_score === g.guest_score) throw new Error('That match has no winner to confirm.');
        const iWon = iAmHost ? g.host_score > g.guest_score : g.guest_score > g.host_score;
        await Net.claimFor(g.code, iWon === iAmHost ? 'host' : 'guest');
      } else if (what === 'settle') {
        await Stake.settle(g.code);
      }
      busy = false;
      await load();
    } catch (e) {
      busy = false; paint();
      Err.show(e, 'staking');
    }
  }

  return {
    load, paint, decide,
    onResume(f) { hooks.onResume = f; },
    get count() { return rows.map(decide).filter(Boolean).length; }
  };
})();
