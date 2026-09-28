/* Checks the money arithmetic in api/_fossa.js.  node tools/test_money.js
 *
 * FossaPay has no sandbox, so none of the payment flow can be exercised without moving real money.
 * What can be checked without spending anything is the arithmetic, and that is where a mistake is
 * expensive: a rounding error in the wrong direction is somebody's stake, and a payout worked out
 * from the wrong figure drains the business float one match at a time.
 *
 * The invariant that matters most is the last one: a pot must always be able to cover its own payout.
 */
const path = require('path');
const { toUnits, fromUnits, split, FEE_BPS } = require(path.join(__dirname, '..', 'api', '_fossa'));

const fails = [];
const check = (ok, what) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) fails.push(what); };
const threw = fn => { try { fn(); return false; } catch (e) { return true; } };

/* ---------- decimal amounts ---------- */
check(toUnits('10') === 10000000n, 'a whole amount converts');
check(toUnits('10.5') === 10500000n, 'a decimal amount converts');
check(toUnits('0.000001') === 1n, 'the smallest unit converts');
check(fromUnits(19800000n) === '19.8', 'units read back as a decimal');
check(fromUnits(0n) === '0', 'nothing reads as nothing');
check(fromUnits(10000000n) === '10', 'a whole amount loses its trailing zeros');

// Every path that takes an amount takes it from a player or a provider, so none of it is trusted.
['', 'abc', '-5', '1e3', '10.5.5', '  ', null, undefined, '0.0000001'].forEach(bad => {
  check(threw(() => toUnits(bad)), 'refuses ' + JSON.stringify(bad) + ' as an amount');
});

// The whole reason for BigInt: the same sum in floating point is wrong.
check(toUnits('0.1') + toUnits('0.2') === toUnits('0.3'), '0.1 + 0.2 is exactly 0.3 in units');
check(0.1 + 0.2 !== 0.3, '  (and is not, in floating point — which is why none is used)');

/* ---------- the platform's cut ---------- */
{
  const s = split(toUnits('10'), toUnits('10'));
  check(fromUnits(s.pot) === '20', 'two 10 stakes make a pot of 20');
  check(fromUnits(s.fee) === '0.2', 'the platform takes 0.2, being 1% of each stake');
  check(fromUnits(s.toWinner) === '19.8', 'the winner takes 19.8');
  check(s.toWinner + s.fee === s.pot, 'and every unit of the pot is accounted for');
}

// Uneven stakes happen: the two transfer fees need not be identical, so the halves can differ.
{
  const s = split(toUnits('9.95'), toUnits('9.9'));
  check(s.toWinner + s.fee === s.pot, 'an uneven pot still balances to the unit');
}

check(FEE_BPS === 100, 'the shipped fee is 1% of each stake');

// Rounding must never favour the platform: a fee too small to represent is no fee at all.
{
  const s = split(1n, 1n);
  check(s.fee === 0n, 'a stake too small to carry a fee carries none');
  check(s.toWinner === 2n, 'and the winner gets the whole of it');
}

/* ---------- the one that would have cost real money ---------- */
/* A payout worked out from the asked-for stake, rather than from what the pot received, quietly has
   the business cover FossaPay's transfer fee on every match. At a high enough provider rate the pot
   cannot cover its own payout at all and the float drains. This is the check that would have caught
   it, so it is written as the invariant rather than as the example that found it. */
[['0.5%', '0.05'], ['1%', '0.1'], ['1.5%', '0.15'], ['3%', '0.3']].forEach(([label, feeEach]) => {
  const arrived = toUnits('10') - toUnits(feeEach);      // what the pot actually received, per player
  const s = split(arrived, arrived);
  const potHolds = arrived * 2n;
  check(s.toWinner + s.fee === potHolds,
    'at a ' + label + ' provider fee the pot exactly covers its payout (' + fromUnits(potHolds) + ')');
  check(s.toWinner <= potHolds, '  and never pays out more than it holds');
});

// The mistake itself, stated plainly, so nobody reintroduces it.
{
  const asked = toUnits('10');
  const arrived = asked - toUnits('0.15');               // a 1.5% provider fee
  const wrong = split(asked, asked);                     // computed from the asked-for stake
  check(wrong.toWinner > arrived * 2n,
    'computing the payout from the asked-for stake overdraws the pot, which is why it is not done');
}

/* ---------- the webhook signature ---------- */
/* A public URL that acted on an unverified body would be acting on whatever a stranger posted to it.
   FossaPay signs the data object alone, which is the part their own documentation warns is easy to
   get wrong by signing the whole envelope instead. */
{
  const crypto = require('node:crypto');
  process.env.FOSSAPAY_WEBHOOK_SECRET = 'test-secret-for-this-file-only';
  const { verifyWebhook } = require(path.join(__dirname, '..', 'api', '_fossa'));
  const secret = process.env.FOSSAPAY_WEBHOOK_SECRET;
  const body = { eventType: 'checkout.completed', eventId: 'evt_1',
                 data: { reference: 'ABC123', amount: '10.00', status: 'completed' } };
  const raw = JSON.stringify(body);
  const sign = t => crypto.createHmac('sha256', secret).update(t).digest('hex');
  const good = sign(JSON.stringify(body.data));

  check(verifyWebhook(raw, good) === true, 'a correctly signed delivery is accepted');
  check(verifyWebhook(raw, '') === false, 'an unsigned delivery is refused');
  check(verifyWebhook(raw, undefined) === false, 'a missing signature header is refused');
  check(verifyWebhook(raw, good.slice(0, -1) + '0') === false, 'one wrong character is refused');
  check(verifyWebhook(raw, 'short') === false, 'a truncated signature is refused rather than throwing');
  check(verifyWebhook('not json', good) === false, 'an unparseable body is refused');
  check(verifyWebhook(raw, sign(raw)) === false, 'a signature over the whole envelope is refused');
  const tampered = JSON.stringify(Object.assign({}, body, { data: Object.assign({}, body.data, { amount: '1000.00' }) }));
  check(verifyWebhook(tampered, good) === false, 'changing the amount invalidates the signature');
}

console.log('\n' + (fails.length ? 'FAIL  ' + fails.length + ' problem(s)\n  ' + fails.join('\n  ')
                                 : 'PASS  the money arithmetic and the webhook signature hold'));
process.exit(fails.length ? 1 : 0);
