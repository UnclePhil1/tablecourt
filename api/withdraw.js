/* POST /api/withdraw  { amount }  — send a player's own money to their own wallet
 *
 * The way out. A custodial balance that can be funded and staked but never withdrawn is the worst
 * state a system like this can be in, so this endpoint is not optional decoration around the profile
 * page — it is the thing that makes holding somebody's money defensible at all.
 *
 * It moves a player's own funds from their own FossaPay wallet to the address on their own profile.
 * It never touches the business master wallet, so no pot and nobody else's stake can leave through
 * here however it is called.
 *
 * The destination is read from the database, not from the request. A withdrawal address that could be
 * named in the call would let anyone who got hold of a session send the balance wherever they liked;
 * making them save it first means changing it is an account change, visible on the profile page.
 */
const { api, fail, toUnits, fromUnits, token, balanceUnits } = require('./_fossa');
const { whoIs, selectAsServer, handler, only } = require('./_auth');

/** A Solana address, roughly. Base58, right length. The provider does the real validation. */
const looksLikeAddress = a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || ''));

module.exports = handler(async (req) => {
  only('POST', req);
  const me = await whoIs(req);

  const rows = await selectAsServer('profiles',
    'id=eq.' + encodeURIComponent(me.id) + '&select=fossa_customer_id,fossa_address,wallet');
  const p = rows && rows[0];
  if (!p || !p.fossa_customer_id) throw fail(400, 'no-wallet', 'Set up your wallet before taking money out.');

  const to = p.wallet;
  if (!to) throw fail(400, 'no-destination', 'Connect a Solana wallet on your profile first. That is where money is sent.');
  if (!looksLikeAddress(to)) throw fail(400, 'bad-destination', 'The wallet saved on your profile does not look like a Solana address.');
  // Sending to the custodial wallet itself would be a fee paid to move money nowhere.
  if (p.fossa_address && to === p.fossa_address) {
    throw fail(400, 'same-address', 'That is the address you deposit to. Connect your own wallet instead.');
  }

  // Which token to send. Checked against the supported list, so an unknown one is refused here
  // rather than being passed to the provider as whatever the caller typed.
  const t = token((req.body && req.body.currency) || undefined);
  const amount = String((req.body && req.body.amount) || '').trim();
  const wantUnits = toUnits(amount, t.decimals);           // throws on anything that is not an amount
  if (wantUnits <= 0n) throw fail(400, 'bad-amount', 'Enter an amount to take out.');

  /* Refuse before moving anything. FossaPay deducts its fee from the amount submitted, so a player
     asking for everything they hold would get slightly less than they asked for — which is correct,
     but worth saying rather than surprising them with. */
  const [balance, quote] = await Promise.all([
    api.walletByCustomer(p.fossa_customer_id).catch(() => null),
    api.fee(amount, t.code).catch(() => null)
  ]);
  const held = balanceUnits(balance, t.code);
  if (held !== null && wantUnits > held) {
    throw fail(400, 'short', 'You have ' + fromUnits(held, t.decimals) + ' ' + t.label + ' and asked for ' + amount + '.');
  }
  const feeUnits = quote && quote.feeAmount !== undefined ? toUnits(String(quote.feeAmount), t.decimals) : 0n;
  if (feeUnits >= wantUnits) {
    throw fail(400, 'too-small', 'That is too small to send: the network fee would be more than the amount.');
  }

  /* No idempotency key on this endpoint, so a timeout is ambiguous rather than failed — the money may
     already have gone. Nothing is retried here. The player is told to check their balance, which is
     the only honest answer when the provider did not say. */
  const sent = await api.transferFromCustomer(p.fossa_customer_id, to, amount, t.code);
  const tx = sent && (sent.id || sent.transactionId || sent.hash || sent.transactionHash);
  if (!tx) {
    throw fail(502, 'no-receipt', 'The withdrawal went out but the provider gave no receipt. Do not send it again — check your balance first.');
  }

  return {
    sent: amount,
    currency: t.label,
    fee: fromUnits(feeUnits, t.decimals),
    arriving: fromUnits(wantUnits - feeUnits, t.decimals),
    to,
    tx,
    // Not settlement. FossaPay reports processing states that are not finality.
    status: (sent && sent.status) || 'processing'
  };
});
