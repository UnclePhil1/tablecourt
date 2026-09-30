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
  /* Whether staking is on, off, or shown but not yet open.

     'soon' still counts as configured: the money side keeps working, so somebody who already has a
     balance can see it and take it out. Only the offer of a new staked match is withheld. */
  const mode = () => {
    const v = cfg('STAKING');
    return v === false ? 'off' : v === 'soon' ? 'soon' : 'on';
  };
  const configured = () => mode() !== 'off';
  /** Shown, but not usable yet. */
  const comingSoon = () => mode() === 'soon';
  /** Can a player actually stake a match right now? */
  const open = () => mode() === 'on';
  /* What can be staked, and how many decimals each has. SOL has nine and the stablecoins six, so
     nothing here assumes a single figure — a wrong one is a thousandfold error in somebody's balance.
     The server is the authority; this is the fallback until it has been asked. */
  const TOKENS = { usdt: { decimals: 6, label: 'USDT' },
                   usdc: { decimals: 6, label: 'USDC' },
                   sol:  { decimals: 9, label: 'SOL' } };
  const DEFAULT = 'usdt';
  const decimalsOf = c => (TOKENS[String(c || DEFAULT).toLowerCase()] || TOKENS[DEFAULT]).decimals;
  const labelOf = c => (TOKENS[String(c || DEFAULT).toLowerCase()] || TOKENS[DEFAULT]).label;

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
      const off = new Error('Could not reach the server. Check your connection and try again.');
      off.fromApi = true;
      throw off;
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* handled below */ }
    if (!res.ok) {
      /* The server writes its own sentence for the player, so it is passed through rather than
         translated again. Without this the message was replaced with "Something went wrong", which
         is true of everything and tells nobody anything — including whoever has to fix it. */
      const said = json && json.error && json.error.message;
      const err = new Error(said || ('The server answered ' + res.status + ' and said nothing useful.'));
      err.code = (json && json.error && json.error.code) || ('http-' + res.status);
      err.status = res.status;
      err.fromApi = true;
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

  /**
   * Take money out, to the wallet saved on this player's profile. The destination is not sent: the
   * server reads it from the profile, so a tampered request cannot redirect somebody's balance.
   */
  const withdraw = (amount, currency) =>
    ask('withdraw', { method: 'POST', body: { amount: String(amount), currency: currency || DEFAULT } });

  /* ---------- reading amounts for display ---------- */

  /** Money is decimal. Kept as strings, and only ever compared as integers of the smallest unit. */
  function units(amount, currency) {
    const dec = typeof currency === 'number' ? currency : decimalsOf(currency);
    const s = String(amount == null ? '' : amount).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('That is not an amount.');
    const [whole, frac = ''] = s.split('.');
    if (frac.length > dec) throw new Error('That amount is more precise than the token allows.');
    return BigInt(whole + frac.padEnd(dec, '0'));
  }
  function show(u, currency) {
    const dec = typeof currency === 'number' ? currency : decimalsOf(currency);
    const s = BigInt(u).toString().padStart(dec + 1, '0');
    return (s.slice(0, s.length - dec) + '.' + s.slice(s.length - dec)).replace(/\.?0+$/, '') || '0';
  }
  /** Roughly what a winner takes, for showing before a match. The server's figure is the real one. */
  function roughWin(stake, currency) {
    try {
      const u = units(stake, currency);
      return show(u * 2n - (u / 100n) * 2n, currency);
    } catch (e) { return null; }
  }

  return {
    configured, comingSoon, open, wallet, openWallet, forget, put, settle, withdraw, units, show, roughWin,
    decimalsOf, labelOf,
    /** Which tokens can be staked. Taken from the server once it has answered, so the two agree. */
    get currencies() { return (mine && mine.currencies) || Object.keys(TOKENS); },
    get currency() { return labelOf(DEFAULT); },
    get defaultCurrency() { return DEFAULT; },
    get known() { return mine; }
  };
})();
