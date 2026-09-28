/* POST /api/stake  { code }  — move this player's stake from their wallet into the business master wallet
 *
 * This is where a stake stops being the player's and starts being held. Two things follow from that,
 * and both are load-bearing:
 *
 * The amount is decided here, not sent by the browser. A client that could name its own stake could
 * name a smaller one and still play for the pot.
 *
 * What lands is not what was sent. FossaPay deducts its transfer fee from the gross amount, so the
 * pot receives less than the player paid. The amount actually received is recorded, and the payout is
 * worked out from that rather than from what was asked for. Paying out the asked-for amount would
 * have the business quietly cover every transfer fee out of its own float.
 */
const { api, fail, toUnits, fromUnits, CURRENCY } = require('./_fossa');
const { whoIs, selectAsServer, patchAsServer, handler, only } = require('./_auth');

/** The business address the pot is held at. Read from FossaPay, never from a request. */
async function masterAddress() {
  const m = await api.masterWallet();
  const rows = Array.isArray(m) ? m : (m && (m.addresses || m.wallets)) || [];
  const sol = rows.find(r => String(r.network || r.chain || 'solana').toLowerCase() === 'solana');
  const addr = (sol && (sol.address || sol.walletAddress))
    || (m && (m.address || m.solanaAddress));
  if (!addr) throw fail(502, 'no-master', 'The payout account is not reachable just now.');
  return addr;
}

module.exports = handler(async (req) => {
  only('POST', req);
  const me = await whoIs(req);
  const code = String((req.body && req.body.code) || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{4,10}$/.test(code)) throw fail(400, 'bad-code', 'That is not a match code.');

  const games = await selectAsServer('games', 'code=eq.' + encodeURIComponent(code) +
    '&select=code,host_key,guest_key,status,stake_status,stake_amount,stake_token,stake_in_host,stake_in_guest');
  if (!games || !games.length) throw fail(404, 'no-match', 'No match with that code.');
  const g = games[0];

  // Which seat this player is in. Taken from the match, never from the request.
  const key = 'u:' + me.id;
  const side = g.host_key === key ? 'host' : g.guest_key === key ? 'guest' : null;
  if (!side) throw fail(403, 'not-yours', 'You are not in that match.');

  if (!g.stake_amount || g.stake_status === 'none') throw fail(400, 'no-stake', 'Nothing is staked on that match.');
  if (g.stake_status === 'paid' || g.stake_status === 'refunded') {
    throw fail(409, 'settled', 'That match has already been settled.');
  }
  if (String(g.stake_token || '').toLowerCase() !== CURRENCY) {
    throw fail(400, 'wrong-token', 'That match is staked in something this server cannot move.');
  }
  // Already in. Saying so is not an error: it is what a retry after a dropped connection looks like.
  const already = side === 'host' ? g.stake_in_host : g.stake_in_guest;
  if (already) return { already: true, side, tx: already };

  const profiles = await selectAsServer('profiles',
    'id=eq.' + encodeURIComponent(me.id) + '&select=fossa_customer_id,fossa_address');
  const customerId = profiles && profiles[0] && profiles[0].fossa_customer_id;
  if (!customerId) throw fail(400, 'no-wallet', 'Open a staking wallet before putting money up.');

  const want = String(g.stake_amount);
  const wantUnits = toUnits(want);

  /* Refuse before moving anything, rather than after. FossaPay deducts its fee from the amount sent,
     so a player needs the stake plus that fee in their wallet for the pot to receive the full stake. */
  const [quote, balance] = await Promise.all([
    api.fee(want).catch(() => null),
    api.walletByCustomer(customerId).catch(() => null)
  ]);
  const feeUnits = quote && quote.feeAmount !== undefined ? toUnits(String(quote.feeAmount)) : 0n;
  const held = balanceUnits(balance);
  if (held !== null && held < wantUnits) {
    throw fail(400, 'short', 'You have ' + fromUnits(held) + ' USDT and this stake needs ' + want + '.');
  }

  /* The transfer. There is no idempotency key on this endpoint, so a timeout is ambiguous: the money
     may well have gone. Nothing is retried here — the player is told to check, and the next attempt
     sees the recorded transaction and stops. */
  const sent = await api.transferFromCustomer(customerId, await masterAddress(), want);
  const txId = sent && (sent.id || sent.transactionId || sent.reference);
  if (!txId) throw fail(502, 'no-receipt', 'The transfer went out but the provider gave no receipt. Do not send it again — check your balance.');

  /* What actually arrived, which is the gross less FossaPay's fee. The payout is computed from this,
     so the business is never quietly funding the difference. */
  const netUnits = wantUnits - feeUnits;
  const patch = {};
  patch[side === 'host' ? 'stake_in_host' : 'stake_in_guest'] = txId;
  // What the pot received. The payout is worked out from this, never from the asked-for stake.
  patch[side === 'host' ? 'stake_net_host' : 'stake_net_guest'] = fromUnits(netUnits < 0n ? 0n : netUnits);
  const other = side === 'host' ? g.stake_in_guest : g.stake_in_host;
  if (other) patch.stake_status = 'locked';       // both are in
  await patchAsServer('games', 'code=eq.' + encodeURIComponent(code), patch);

  return {
    side,
    tx: txId,
    sent: want,
    fee: fromUnits(feeUnits),
    intoPot: fromUnits(netUnits < 0n ? 0n : netUnits),
    bothIn: !!other,
    // Not settlement. FossaPay reports processing states that are not finality, and this is one.
    status: (sent && sent.status) || 'processing'
  };
});

/** USDT held by a wallet, in the token's smallest unit, or null when it cannot be read. */
function balanceUnits(balance) {
  if (!balance) return null;
  const list = balance.balances || balance.tokens || balance.assets;
  const row = Array.isArray(list)
    ? list.find(b => String(b.currency || b.symbol || b.asset || '').toLowerCase() === CURRENCY)
    : null;
  const raw = row ? (row.amount !== undefined ? row.amount : row.balance)
                  : (balance.usdt !== undefined ? balance.usdt : null);
  if (raw === null || raw === undefined) return null;
  try { return toUnits(String(raw)); } catch (e) { return null; }
}
