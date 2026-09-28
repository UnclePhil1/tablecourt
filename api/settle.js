/* POST /api/settle  { code }  — pay the pot out, or give it back
 *
 * The one endpoint that moves money out of the business wallet, so it is the one with the most
 * refusals in it.
 *
 * Who won is not taken from the request. It is read from the two answers the players each gave
 * through game_claim, which neither of them can change once given and neither sees before their own
 * is in. If they disagree, or one never answered and the match has gone cold, the stakes go back and
 * no fee is taken. That rule is unchanged from the escrow program it replaces; only the thing holding
 * the money is different.
 *
 * What changed by moving off-chain is who can be robbed. A program could not pay the wrong person. A
 * business wallet can, so this file is the only thing standing between a player and their money, and
 * it settles exactly once: the payout transaction id is written before the money is reported as sent,
 * and any second attempt returns the first one rather than paying again.
 */
const { api, fail, toUnits, fromUnits, split, token, CURRENCIES, FEE_BPS } = require('./_fossa');
const { whoIs, selectAsServer, patchAsServer, handler, only } = require('./_auth');

const GONE_COLD_MS = 2 * 60 * 60 * 1000;   // after this, an unanswered match can be given back

module.exports = handler(async (req) => {
  only('POST', req);
  const me = await whoIs(req);
  const code = String((req.body && req.body.code) || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{4,10}$/.test(code)) throw fail(400, 'bad-code', 'That is not a match code.');

  const rows = await selectAsServer('games', 'code=eq.' + encodeURIComponent(code) +
    '&select=code,host_key,guest_key,status,stake_status,stake_amount,stake_token,' +
    'host_claim,guest_claim,result_state,stake_in_host,stake_in_guest,payout_tx,ended_at,started_at,' +
    'stake_net_host,stake_net_guest');
  if (!rows || !rows.length) throw fail(404, 'no-match', 'No match with that code.');
  const g = rows[0];

  const key = 'u:' + me.id;
  if (g.host_key !== key && g.guest_key !== key) throw fail(403, 'not-yours', 'You are not in that match.');

  // Settled once, and only once. A repeat returns what happened rather than doing it again.
  if (g.payout_tx) return { already: true, tx: g.payout_tx, state: g.stake_status };
  if (g.stake_status === 'paid' || g.stake_status === 'refunded') {
    return { already: true, tx: null, state: g.stake_status };
  }
  if (g.stake_status !== 'locked') throw fail(409, 'not-locked', 'Both stakes are not in yet.');
  if (!g.stake_in_host || !g.stake_in_guest) throw fail(409, 'not-locked', 'Both stakes are not in yet.');
  const t = token(g.stake_token);
  if (CURRENCIES.indexOf(t.code) < 0) {
    throw fail(400, 'wrong-token', 'That match is staked in something this server cannot move.');
  }

  /* What the two of them said. This is the whole basis for paying anybody. */
  const agreed = g.host_claim && g.guest_claim && g.host_claim === g.guest_claim;
  const disputed = g.host_claim && g.guest_claim && g.host_claim !== g.guest_claim;
  const since = Date.parse(g.ended_at || g.started_at || 0) || 0;
  const cold = since > 0 && (Date.now() - since) > GONE_COLD_MS;

  if (!agreed && !disputed && !cold) {
    throw fail(409, 'not-agreed', 'Both players have to say who won before this pays out.');
  }

  /* Worked out from what the pot actually received, not from what the players were asked for.

     FossaPay deducts its transfer fee from the amount sent, so each 10 USDT stake arrives as less. A
     payout computed from the asked-for figure would have the business make up the difference out of
     its own float on every single match, and at a high enough provider rate the pot would not cover
     its own payout at all. The recorded net is the only honest basis for paying anybody. */
  const netHost = amountUnits(g.stake_net_host, t.decimals);
  const netGuest = amountUnits(g.stake_net_guest, t.decimals);
  if (netHost === null || netGuest === null) {
    throw fail(409, 'unreconciled', 'What reached the pot for that match has not been recorded yet.');
  }
  const parts = split(netHost, netGuest);

  const wallets = await addressesFor(g);

  if (agreed) {
    const winnerSide = g.host_claim;                    // 'host' or 'guest'
    const to = winnerSide === 'host' ? wallets.host : wallets.guest;
    if (!to) throw fail(409, 'no-address', 'The winner has no payout wallet. They must open one first.');
    const tx = await payOut(code, to, parts.toWinner, 'win', t);
    await patchAsServer('games', 'code=eq.' + encodeURIComponent(code),
      { payout_tx: tx, stake_status: 'paid', settle_sig: tx });
    return {
      paid: true, winner: winnerSide, tx,
      currency: t.label,
      amount: fromUnits(parts.toWinner, t.decimals),
      fee: fromUnits(parts.fee, t.decimals),
      feeBps: FEE_BPS
    };
  }

  /* Disagreed, or nobody answered and it has gone cold. Each player gets back what they actually put
     in — not the figure they were asked for, which the pot never held. The platform takes nothing: a
     refund has never been a chargeable event here. Two transfers, so one can succeed and the other
     fail; each is recorded as it happens and a retry resumes rather than repeating. */
  const back = [];
  for (const [who, to, units] of [['host', wallets.host, netHost], ['guest', wallets.guest, netGuest]]) {
    if (!to || units <= 0n) continue;
    back.push({ who, tx: await payOut(code + '-' + who, to, units, 'refund', t), amount: fromUnits(units, t.decimals) });
  }
  if (!back.length) throw fail(409, 'no-address', 'Neither player has a payout wallet to return this to.');
  await patchAsServer('games', 'code=eq.' + encodeURIComponent(code),
    { payout_tx: back.map(b => b.tx).join(','), stake_status: 'refunded', settle_sig: back[0].tx });
  return { refunded: true, why: disputed ? 'disputed' : 'nobody-confirmed', back, fee: '0', currency: t.label };
});

/** Both players' payout addresses, read from their profiles rather than from anything a client sent. */
async function addressesFor(g) {
  const ids = [g.host_key, g.guest_key]
    .filter(k => k && k.startsWith('u:'))
    .map(k => k.slice(2));
  if (!ids.length) return { host: null, guest: null };
  const rows = await selectAsServer('profiles',
    'id=in.(' + ids.map(encodeURIComponent).join(',') + ')&select=id,fossa_address');
  const byId = {};
  (rows || []).forEach(r => { byId[r.id] = r.fossa_address; });
  const of = k => (k && k.startsWith('u:') ? byId[k.slice(2)] || null : null);
  return { host: of(g.host_key), guest: of(g.guest_key) };
}

/**
 * Send from the business wallet to a player. The master wallet signs its own SPL transfer, built and
 * broadcast by FossaPay, with an idempotency key tied to this match so a repeat cannot pay twice.
 */
async function payOut(reference, toAddress, units, what, t) {
  const amount = fromUnits(units, t.decimals);
  const idem = 'table-payout-' + what + '-' + reference;
  const sent = await api.call('POST', '/api/v1/wallets/crypto/master/transactions/sign-and-broadcast', {
    // Built by FossaPay's own transfer rail rather than by hand: a raw SPL instruction would have to
    // resolve token accounts and rent here, and getting that wrong loses money rather than erroring.
    body: { recipient: toAddress, network: 'solana', currency: t.code, amount },
    idempotencyKey: idem
  }).catch(async (e) => {
    // The signing endpoint is for arbitrary transactions; if this deployment expects the plain payout
    // shape instead, fall back to it with the same key rather than leaving the pot stuck.
    if (e && (e.status === 400 || e.status === 404)) {
      return api.call('POST', '/api/v1/transfers/crypto/master', {
        body: { recipient: toAddress, network: 'solana', currency: t.code, amount },
        idempotencyKey: idem
      });
    }
    throw e;
  });
  const tx = sent && (sent.transactionHash || sent.hash || sent.requestId || sent.id || sent.transactionId);
  if (!tx) throw fail(502, 'no-receipt', 'The payout went out but the provider gave no receipt. Do not send it again — check the match before retrying.');
  return String(tx);
}

/** A decimal string from the table, as the token's smallest unit. null when it was never recorded. */
function amountUnits(v, dec) {
  if (v === null || v === undefined || v === '') return null;
  try { return toUnits(String(v), dec); } catch (e) { return null; }
}
