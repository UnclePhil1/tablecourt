/* Table – staking, from the browser's side.
 *
 * There is no blockchain in this file and no key of any kind. Every question about money is asked of
 * the server, which is the only thing holding a FossaPay key, and the answer it gives is the answer.
 *
 * What this file must never do is decide anything. It does not work out who won, what a stake is
 * worth, or whether a pot may be paid — it asks, and it draws what comes back. A browser can be
 * edited by whoever is looking at it, so anything it decides is a thing a player can decide for
 * themselves. The server re-reads the match, the amounts and the two players' answers from the
 * database for every single request, and takes none of them from what is sent.
 *
 * The money itself is held in the business's FossaPay wallet, not by this page and not by a program.
 */
const Stake = (function () {
  const cfg = k => (window.TABLE_CONFIG || {})[k];
  /** Staking is offered only where the server has been set up for it. */
  const configured = () => cfg('STAKING') !== false;
  const CURRENCY = 'USDT';

  let mine = null;              // this player's wallet, once asked for
  let asking = null;

  /* ---------- talking to our own server ---------- */
  async function ask(path, opts) {
    opts = opts || {};
    const token = await bearer();
    if (!token) throw new Error('Sign in to stake on a match.');
    let res;
    try {
      res = await fetch('/api/' + path, {
        method: opts.method || 'GET',
        headers: Object.assign(
          { Authorization: 'Bearer ' + token },
          opts.body ? { 'Content-Type': 'application/json' } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* handled below */ }
    if (!res.ok) {
      const err = new Error((json && json.error && json.error.message) || 'That did not work.');
      err.code = json && json.error && json.error.code;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  /** The signed-in player's access token, which is how the server knows who is asking. */
  async function bearer() {
    try {
      const { data } = await Auth.client.auth.getSession();
      return (data && data.session && data.session.access_token) || null;
    } catch (e) { return null; }
  }

  /* ---------- this player's wallet ---------- */

  /** Where this player deposits, and what is there. Cached, because the lobby asks often. */
  async function wallet(force) {
    if (mine && !force) return mine;
    if (asking && !force) return asking;
    asking = ask('wallet').then(w => { mine = w; asking = null; return w; })
                          .catch(e => { asking = null; throw e; });
    return asking;
  }

  /** Open one. Creates the FossaPay customer and wallet, which only the server can do. */
  async function openWallet() {
    mine = await ask('wallet', { method: 'POST' });
    return mine;
  }

  const forget = () => { mine = null; asking = null; };

  /* ---------- the two things a player does with money ---------- */

  /**
   * Put this player's stake into the pot. The amount comes from the match, not from here: the server
   * reads it from the database, so there is nothing to pass and nothing to tamper with.
   */
  const put = code => ask('stake', { method: 'POST', body: { code: code } });

  /**
   * Settle the match. Pays the winner the two players agreed on, or returns both stakes if they
   * disagreed or nobody confirmed. Either player may call it; it pays the same person either way.
   */
  const settle = code => ask('settle', { method: 'POST', body: { code: code } });

  /* ---------- reading amounts for display ---------- */

  /** Money is decimal. Kept as strings, and only ever compared as integers of the smallest unit. */
  function units(amount, dec) {
    const s = String(amount == null ? '' : amount).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('That is not an amount.');
    const [whole, frac = ''] = s.split('.');
    if (frac.length > (dec || 6)) throw new Error('That amount is more precise than the token allows.');
    return BigInt(whole + frac.padEnd(dec || 6, '0'));
  }
  function show(u, dec) {
    dec = dec || 6;
    const s = BigInt(u).toString().padStart(dec + 1, '0');
    return (s.slice(0, s.length - dec) + '.' + s.slice(s.length - dec)).replace(/\.?0+$/, '') || '0';
  }
  /** Roughly what a winner takes, for showing before a match. The server's figure is the real one. */
  function roughWin(stake) {
    try {
      const u = units(stake);
      return show(u * 2n - (u / 100n) * 2n);
    } catch (e) { return null; }
  }

  return {
    configured, wallet, openWallet, forget, put, settle, units, show, roughWin,
    get currency() { return CURRENCY; },
    get known() { return mine; }
  };
})();
