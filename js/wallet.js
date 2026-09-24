/* Table – external Solana wallets (Phantom, Solflare, Backpack and any wallet that follows the Wallet Standard).
   No sign-in service is involved. We only ask the wallet for its public address. */
const Wallets = (function () {
  const found = new Map(), subs = [];
  const notify = () => subs.forEach(f => { try { f(); } catch (e) { console.error(e); } });
  const isSol = w => Array.isArray(w.chains) && w.chains.some(c => String(c).startsWith('solana:')) && w.features && w.features['standard:connect'];

  // 1. Wallet Standard: wallets announce themselves to the page
  const api = { register(...ws) { ws.forEach(w => { if (isSol(w) && !found.has(w.name)) { found.set(w.name, { name: w.name, icon: w.icon, std: w }); notify(); } }); return () => {}; } };
  try {
    addEventListener('wallet-standard:register-wallet', e => { try { e.detail(api); } catch (x) { /* ignore */ } });
    dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  } catch (e) { /* older browsers */ }

  // 2. Older wallets that only add themselves to window
  const legacy = [['Phantom', () => window.phantom && window.phantom.solana], ['Solflare', () => window.solflare], ['Backpack', () => window.backpack && window.backpack.solana || window.backpack], ['Solana wallet', () => window.solana]];
  function scan() {
    legacy.forEach(([name, get]) => {
      let p; try { p = get(); } catch (e) { return; }
      if (!p || typeof p.connect !== 'function') return;
      const dup = [...found.keys()].some(k => k.toLowerCase().includes(name.toLowerCase().split(' ')[0]));
      if (!dup) { found.set(name, { name, legacy: p }); notify(); }
    });
  }
  [0, 400, 1500].forEach(ms => setTimeout(scan, ms));   // some wallets inject a little after the page loads

  async function addressOf(w) {
    if (w.std) {
      const { accounts } = await w.std.features['standard:connect'].connect();
      const a = (accounts || []).find(x => (x.chains || []).some(c => String(c).startsWith('solana:'))) || (accounts || [])[0];
      if (!a) throw new Error('The wallet did not share an account.');
      return a.address;
    }
    const r = await w.legacy.connect();
    const pk = (r && r.publicKey) || w.legacy.publicKey;
    if (!pk) throw new Error('The wallet did not share an account.');
    return pk.toString();
  }
  /* The object that actually signs a staking transaction.

     Signing in only needs an address, which every wallet will give up. Signing a transaction needs the
     older provider interface — a signTransaction method on the wallet object — which is what Anchor
     drives and which Phantom, Solflare and Backpack all still expose. A wallet that speaks only Wallet
     Standard can prove who it is but cannot be used to stake, and is told so rather than failing
     obscurely halfway through a payment.

     The address is checked, not assumed: somebody can sign in with one wallet and later switch the
     active account inside it, and staking from the wrong account would send money to a stranger. */
  async function signerFor(address) {
    scan();
    const able = [...found.values()].filter(w => w.legacy && typeof w.legacy.signTransaction === 'function');
    if (!able.length) {
      throw new Error('This wallet cannot sign payments in the browser. Phantom, Solflare or Backpack can.');
    }
    for (const w of able) {
      const p = w.legacy;
      let pk = p.publicKey && p.publicKey.toString();
      if (!pk) { try { await p.connect(); } catch (e) { continue; } pk = p.publicKey && p.publicKey.toString(); }
      if (pk && pk === address) return p;
    }
    throw new Error('Your wallet is on a different account now. Switch back to ' +
      address.slice(0, 4) + '…' + address.slice(-4) + ', then try again.');
  }

  return {
    list() { scan(); return [...found.values()].map(w => ({ name: w.name, icon: w.icon, _w: w })); },
    signerFor,
    connect: item => addressOf(item._w),
    onChange: f => subs.push(f),
    installUrl: 'https://phantom.app/download',
    openInPhantom: () => 'https://phantom.app/ul/browse/' + encodeURIComponent(location.href) + '?ref=' + encodeURIComponent(location.origin),
    openInSolflare: () => 'https://solflare.com/ul/v1/browse/' + encodeURIComponent(location.href) + '?ref=' + encodeURIComponent(location.origin)
  };
})();
