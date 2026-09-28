/* GET  /api/wallet   — this player's deposit address and USDT balance
 * POST /api/wallet   — create their FossaPay customer and wallet if they have none
 *
 * A player needs somewhere to put money before they can stake any. That is a FossaPay customer with a
 * custodial Solana wallet, created here because creating one needs a key that can move the business's
 * money.
 *
 * Neither FossaPay customers nor their wallets have idempotency. Creating one twice makes two, and the
 * second is an orphan nobody can be paid through. So the mapping is written to the player's profile
 * the moment it exists, every path re-reads it first, and a lost response is reconciled by searching
 * FossaPay for the email rather than by trying again.
 */
const { api, fail } = require('./_fossa');
const { whoIs, rpcAsServer, selectAsServer, handler, only } = require('./_auth');

/** What FossaPay needs to know about a person. Kept to the minimum that will pass validation. */
function identity(profile, email) {
  // FossaPay wants exactly one name per field, letters only. A username is not a legal name, so this
  // is a placeholder until the game asks for a real one — which it will have to before going live,
  // because the provider verifies identities.
  const clean = t => String(t || '').replace(/[^\p{L}'-]/gu, '') || 'Player';
  return {
    type: 'individual',
    firstName: clean(profile && profile.username),
    lastName: 'Table',
    emailAddress: email,
    mobileNumber: process.env.FOSSAPAY_DEFAULT_PHONE || '+2348000000000',
    dateOfBirth: '1990-01-01',
    address: 'Not collected',
    city: 'Lagos',
    country: 'Nigeria'
  };
}

async function readProfile(userId) {
  const rows = await selectAsServer('profiles',
    'id=eq.' + encodeURIComponent(userId) + '&select=id,username,fossa_customer_id,fossa_address');
  if (!rows || !rows.length) throw fail(404, 'no-profile', 'Choose a username before staking.');
  return rows[0];
}

/** The balance FossaPay reports for a wallet, in USDT, as a decimal string. */
function usdtOf(balance) {
  const list = (balance && (balance.balances || balance.tokens || balance.assets)) || [];
  const row = Array.isArray(list)
    ? list.find(b => String(b.currency || b.symbol || b.asset || '').toLowerCase() === 'usdt')
    : null;
  if (row) return String(row.amount !== undefined ? row.amount : (row.balance !== undefined ? row.balance : '0'));
  if (balance && balance.usdt !== undefined) return String(balance.usdt);
  return '0';
}

module.exports = handler(async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') only('GET', req);
  const me = await whoIs(req);
  const profile = await readProfile(me.id);

  // Already linked: just report where they deposit and what is there.
  if (profile.fossa_customer_id && profile.fossa_address) {
    let balance = '0';
    try {
      balance = usdtOf(await api.walletByCustomer(profile.fossa_customer_id));
    } catch (e) {
      // A balance that cannot be read is worth saying nothing about rather than saying zero, which a
      // player would read as their money having gone.
      balance = null;
    }
    return { linked: true, address: profile.fossa_address, currency: 'usdt', balance };
  }

  if (req.method !== 'POST') return { linked: false, address: null, currency: 'usdt', balance: null };
  if (!me.email) throw fail(400, 'no-email', 'A staking account needs the email address on your profile.');

  /* Creating the customer. FossaPay has no idempotency here, so an ambiguous failure is resolved by
     looking for the email rather than by submitting the same identity again. */
  let customerId = profile.fossa_customer_id;
  if (!customerId) {
    try {
      const c = await api.createCustomer(identity(profile, me.email), 'table-cust-' + me.id);
      customerId = c && c.id;
    } catch (e) {
      const existing = await findByEmail(me.email);
      if (!existing) throw e;
      customerId = existing;
    }
    if (!customerId) throw fail(502, 'no-customer', 'Could not open a staking account just now.');
  }

  /* And the wallet. Only one Solana wallet can exist per customer, so a second attempt reconciles. */
  let address = profile.fossa_address;
  if (!address) {
    try {
      const w = await api.createWallet(customerId, 'table-wallet-' + me.id);
      address = w && (w.address || (w.wallet && w.wallet.address));
    } catch (e) {
      const bal = await api.walletByCustomer(customerId).catch(() => null);
      address = bal && (bal.address || (bal.wallet && bal.wallet.address));
      if (!address) throw e;
    }
  }
  if (!address) throw fail(502, 'no-wallet', 'Could not open a staking wallet just now.');

  // Written as the server: an address decides where a payout goes, so a browser must not be able to
  // claim one. fossa_link keeps whatever is already there rather than overwriting it.
  await rpcAsServer('fossa_link', { p_user: me.id, p_customer: customerId, p_address: address });

  let balance = '0';
  try { balance = usdtOf(await api.walletByCustomer(customerId)); } catch (e) { balance = null; }
  return { linked: true, address, currency: 'usdt', balance, created: true };
});

/* Find a customer this merchant already has for that email.
 *
 * This is the reconciliation FossaPay's documentation asks for: customer creation has no idempotency,
 * so after an ambiguous failure the safe move is to look for the record rather than submit the same
 * identity again and risk a second customer that nobody can be paid through. */
async function findByEmail(email) {
  try {
    const { call } = require('./_fossa');
    const page = await call('GET', '/api/v1/customers?limit=100&search=' + encodeURIComponent(email));
    const rows = (page && (page.customers || page.data || page.items)) || (Array.isArray(page) ? page : []);
    const hit = rows.find(r => String(r.emailAddress || r.email || '').toLowerCase() === email.toLowerCase());
    return hit ? hit.id : null;
  } catch (e) { return null; }
}
