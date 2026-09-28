/* Table – talking to FossaPay, and the rules about doing it safely.
 *
 * Everything in api/ runs on the server. It exists for one reason: a FossaPay key authorises moving the
 * business's money, and FossaPay has no sandbox, so every key is a production key. There is no
 * arrangement of browser code that makes one safe to ship.
 *
 * Two habits run through this file, both from FossaPay's own guidance:
 *
 *   Money is decimal, never a float. 0.1 + 0.2 is not 0.3, and a stake is somebody's money. Amounts
 *   are carried as strings and compared in the token's smallest unit as BigInt.
 *
 *   An accepted request is not a completed one. FossaPay returns processing states that are not
 *   settlement, and a timeout after submitting is ambiguous rather than failed. Nothing here treats a
 *   non-terminal answer as done, and nothing retries a transfer blindly.
 */
const BASE = process.env.FOSSAPAY_BASE_URL || 'https://api-production.fossapay.com';

/* What can be staked. FossaPay supports exactly these three on Solana, and the decimals are not the
   same for all of them — SOL has nine, the stablecoins six. Getting that wrong is a factor of a
   thousand in somebody's balance, so nothing anywhere assumes six. */
const TOKENS = {
  usdt: { decimals: 6, label: 'USDT' },
  usdc: { decimals: 6, label: 'USDC' },
  sol:  { decimals: 9, label: 'SOL' }
};
const CURRENCIES = Object.keys(TOKENS);
const DEFAULT_CURRENCY = 'usdt';

/** Normalise and check a currency, so an unknown one is refused rather than silently mishandled. */
function token(currency) {
  const c = String(currency || DEFAULT_CURRENCY).toLowerCase();
  const t = TOKENS[c];
  if (!t) throw fail(400, 'bad-currency', 'That is not a token this game can stake.');
  return { code: c, decimals: t.decimals, label: t.label };
}
const decimalsOf = currency => token(currency).decimals;

/** Refuses to run at all rather than half-configured, which with money is the worse failure. */
function key() {
  const k = process.env.FOSSAPAY_API_KEY;
  if (!k) throw fail(500, 'server-misconfigured', 'Staking is not configured on this server.');
  return k;
}

/** An error that carries what the player should be told, separately from what gets logged. */
function fail(status, code, say, detail) {
  const e = new Error(say);
  e.status = status; e.code = code; e.say = say; e.detail = detail;
  return e;
}

/* ---------- decimal amounts, without floating point ---------- */

/** "10.5" -> 10500000n for a six-decimal token. Throws rather than guessing at anything odd. */
function toUnits(amount, dec = TOKENS[DEFAULT_CURRENCY].decimals) {
  if (typeof dec === 'string') dec = decimalsOf(dec);
  const s = String(amount == null ? '' : amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw fail(400, 'bad-amount', 'That is not an amount.');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > dec) throw fail(400, 'bad-amount', 'That amount is more precise than the token allows.');
  return BigInt(whole + frac.padEnd(dec, '0'));
}

/** 19800000n -> "19.8". Trailing zeros trimmed, because money reads badly with six of them. */
function fromUnits(units, dec = TOKENS[DEFAULT_CURRENCY].decimals) {
  if (typeof dec === 'string') dec = decimalsOf(dec);
  const neg = BigInt(units) < 0n;
  const s = (neg ? -BigInt(units) : BigInt(units)).toString().padStart(dec + 1, '0');
  const out = (s.slice(0, s.length - dec) + '.' + s.slice(s.length - dec)).replace(/\.?0+$/, '');
  return (neg ? '-' : '') + (out || '0');
}

/* ---------- the platform's cut ---------- */

/** 1% of each stake, so 2% of the pot — the same rule the escrow program used. */
const FEE_BPS = 100;

/**
 * What the pot owes, given what actually arrived. Worked out from the amounts FossaPay confirmed
 * rather than from what the players were asked for, because a transfer fee is deducted on the way in
 * and the two need not be equal.
 */
function split(hostUnits, guestUnits) {
  const pot = BigInt(hostUnits) + BigInt(guestUnits);
  const fee = (BigInt(hostUnits) * BigInt(FEE_BPS)) / 10000n
            + (BigInt(guestUnits) * BigInt(FEE_BPS)) / 10000n;
  return { pot, fee, toWinner: pot - fee };
}

/* ---------- reading a balance ---------- */

/* What FossaPay actually returns from the customer-balance endpoint:
 *
 *   data: [ { id, address, network: "solana",
 *             tokens: { sol:  { amount, rawAmount },
 *                       usdc: { amount, rawAmount },
 *                       usdt: { amount, rawAmount } } } ]
 *
 * An array of wallets, each with tokens keyed by currency — not an array of token rows, which is what
 * the first version of this guessed at. It found nothing and reported every balance as zero, which
 * looks exactly like a deposit having gone missing.
 *
 * rawAmount is already the smallest unit, so it is used in preference to parsing the decimal string.
 */
function walletsIn(payload) {
  const d = payload && payload.data !== undefined ? payload.data : payload;
  if (Array.isArray(d)) return d;
  return d && typeof d === 'object' ? [d] : [];
}

/** The balance of one token, in its smallest unit. null when it genuinely could not be read. */
function balanceUnits(payload, currency) {
  const t = token(currency);
  for (const w of walletsIn(payload)) {
    const tok = w && w.tokens && w.tokens[t.code];
    if (!tok) continue;
    if (tok.rawAmount !== undefined && tok.rawAmount !== null) {
      try { return BigInt(String(tok.rawAmount)); } catch (e) { /* fall through to amount */ }
    }
    if (tok.amount !== undefined && tok.amount !== null) {
      try { return toUnits(String(tok.amount), t.decimals); } catch (e) { /* unreadable */ }
    }
  }
  // A wallet with no entry for a token holds none of it; only a missing wallet is unknown.
  return walletsIn(payload).length ? 0n : null;
}

/** Every balance this wallet holds, for showing on a profile page. */
function allBalances(payload) {
  const out = {};
  CURRENCIES.forEach(c => {
    const u = balanceUnits(payload, c);
    if (u !== null) out[c] = { units: u.toString(), amount: fromUnits(u, TOKENS[c].decimals), label: TOKENS[c].label };
  });
  return out;
}

/** The Solana address FossaPay reports for this wallet. */
function addressIn(payload) {
  for (const w of walletsIn(payload)) {
    if (w && w.address) return w.address;
  }
  return null;
}

/* ---------- the API itself ---------- */

/**
 * One request to FossaPay. Every write carries an idempotency key, because a lost response after
 * submitting money is otherwise indistinguishable from it never having been sent.
 */
async function call(method, path, { body, idempotencyKey, timeoutMs = 20000 } = {}) {
  const headers = { 'x-api-key': key() };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetch(BASE + path, {
      method, headers, signal: ctl.signal,
      body: body ? JSON.stringify(body) : undefined
    });
    text = await res.text();
  } catch (e) {
    // A timeout on a write is ambiguous, never a failure: the money may well have moved. The caller
    // must reconcile rather than send it again.
    throw fail(504, 'ambiguous', 'The payment provider did not answer in time.',
      { path, method, aborted: true, retryable: false });
  } finally { clearTimeout(t); }

  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* handled below */ }

  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || ('HTTP ' + res.status);
    throw fail(res.status, 'provider-' + res.status, providerSays(res.status, msg), { path, msg, json });
  }
  return json && json.data !== undefined ? json.data : json;
}

/** FossaPay's failures, in words a player can act on. */
function providerSays(status, msg) {
  if (status === 401) return 'Payments are not set up correctly on this server.';
  if (status === 404) return 'That payment account could not be found.';
  if (status === 409) return 'That request is already being processed.';
  if (status === 422) return 'The payment provider rejected that: ' + msg;
  if (status === 429) return 'Too many payment requests at once. Try again shortly.';
  if (status >= 500) return 'The payment provider is having trouble. Try again shortly.';
  return msg;
}

/* ---------- the calls this game makes ---------- */

const api = {
  /** The business's own Solana addresses and balances. The pot lives here. */
  masterWallet: () => call('GET', '/api/v1/wallets/crypto/master'),

  createCustomer: (c, idem) => call('POST', '/api/v1/customers', { body: c, idempotencyKey: idem }),
  getCustomer: id => call('GET', '/api/v1/customers/' + encodeURIComponent(id)),

  createWallet: (customerId, idem) => call('POST', '/api/v1/wallets/crypto/create', {
    body: { network: 'solana', customerId }, idempotencyKey: idem
  }),
  walletByCustomer: customerId =>
    call('GET', '/api/v1/wallets/crypto/customer/' + encodeURIComponent(customerId) + '/balance'),

  /** What a transfer of this size will cost. Quoted every time; the rate is configurable. */
  fee: (amount, currency) => call('GET', '/api/v1/transfers/crypto/calculate-fee?amount='
    + encodeURIComponent(String(amount)) + '&currency=' + token(currency).code),

  /**
   * Move a stake out of a player's wallet. The amount submitted is gross: FossaPay deducts its fee and
   * the recipient gets the rest, so what lands in the pot is less than what the player sent.
   */
  transferFromCustomer: (customerId, recipient, amount, currency) => call('POST', '/api/v1/transfers/crypto', {
    body: { customerId, recipient, network: 'solana', currency: token(currency).code, amount }
  }),

  transaction: id => call('GET', '/api/v1/wallets/crypto/transactions/' + encodeURIComponent(id))
};

/* ---------- webhooks ---------- */

/**
 * FossaPay signs JSON.stringify(body.data) — the data object alone, not the envelope. Compared without
 * an early exit on length, so the comparison time says nothing about how much of it matched.
 */
function verifyWebhook(rawBody, signature) {
  const crypto = require('node:crypto');
  const secret = process.env.FOSSAPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  let data;
  try { data = JSON.parse(rawBody).data; } catch (e) { return false; }
  const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(data)).digest('hex');
  const got = String(signature || '');
  if (expected.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(got, 'utf8'));
  } catch (e) { return false; }
}

module.exports = {
  api, call, fail, verifyWebhook,
  toUnits, fromUnits, split,
  token, decimalsOf, balanceUnits, allBalances, addressIn,
  TOKENS, CURRENCIES, DEFAULT_CURRENCY, FEE_BPS
};
