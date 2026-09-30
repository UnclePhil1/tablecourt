/* Table – the profile page: money in, money out.
 *
 * Two different wallets appear here and they are easy to confuse, so the page never uses the bare
 * word for either:
 *
 *   The one the game holds for you. A custodial wallet at FossaPay with an address you deposit to.
 *   You do not have its keys; the business does. This is what a stake is paid from.
 *
 *   Your own wallet. Phantom or similar, connected here only so the game knows where to send money
 *   when you take it out. It is never asked to sign anything.
 *
 * A balance that can be funded and staked but not withdrawn would be a trap, so the way out is on the
 * same page as the way in.
 */
const Profile = (function () {
  const $ = s => document.querySelector(s);
  let wallet = null, busy = false, saved = null;

  const say = (t, bad) => {
    const el = $('#profMsg');
    if (!el) return;
    el.textContent = t || '';
    el.classList.toggle('bad', !!bad);
  };
  const short = a => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');

  /** Draw everything from what the server and the table say, never from what is on screen. */
  async function load() {
    if (!Auth.signedIn) return;
    $('#profName').textContent = '@' + (Auth.username || '—');
    saved = (Auth.profile && Auth.profile.wallet) || null;
    paintPayout();
    listWallets();

    if (!Stake.configured()) {
      $('#profBals').textContent = '';
      $('#profBalNote').textContent = 'Staking is switched off in this build.';
      return;
    }
    try {
      wallet = await Stake.wallet(true);
      paintBalance();
    } catch (e) {
      $('#profBals').textContent = '';
      $('#profBalNote').textContent = Err.say(e, 'read your balance');
    }
  }

  function paintBalance() {
    const open = $('#profOpen'), dep = $('#profDeposit'), wd = $('#profWithdraw'), box = $('#profBals');
    box.textContent = '';
    if (!wallet || !wallet.linked) {
      box.appendChild(one('—', ''));
      $('#profBalNote').textContent = 'You have no wallet yet. Setting one up takes a moment and costs nothing.';
      open.hidden = false; dep.hidden = true; wd.hidden = true;
      return;
    }
    open.hidden = true;
    dep.hidden = false;
    $('#profAddr').textContent = wallet.address || '';

    /* One figure per token. A balance that could not be read is shown as a dash, never as zero — a
       player seeing 0 reads it as their money having gone, which is the worse thing to say wrongly. */
    const bals = wallet.balances;
    if (!bals) {
      box.appendChild(one('—', ''));
      $('#profBalNote').textContent = 'Your balance could not be read just now. It has not changed.';
      wd.hidden = true;
      return;
    }
    const held = [];
    (wallet.currencies || Object.keys(bals)).forEach(c => {
      const b = bals[c];
      if (!b) return;
      box.appendChild(one(b.amount, b.label, b.amount === '0'));
      if (b.amount !== '0') held.push(c);
    });
    $('#profBalNote').textContent = held.length
      ? 'This is what you stake with.'
      : 'Empty. Send USDT, USDC or SOL on Solana to the address below.';

    // Taking money out needs somewhere to send it and something to send, so it appears only then.
    fillCurrencies($('#profCur'), held.length ? held : (wallet.currencies || []));
    wd.hidden = !(saved && held.length);
    onCurrencyChange();
  }

  /** One balance: the number, and what it is. */
  function one(amount, label, zero) {
    const d = document.createElement('div');
    if (zero) d.className = 'zero';
    const b = document.createElement('b'); b.textContent = amount;
    const s = document.createElement('span'); s.textContent = label;
    d.appendChild(b); d.appendChild(s);
    return d;
  }

  function fillCurrencies(sel, list) {
    if (!sel) return;
    const was = sel.value;
    sel.textContent = '';
    (list || []).forEach(c => {
      const o = document.createElement('option');
      o.value = c; o.textContent = Stake.labelOf(c);
      sel.appendChild(o);
    });
    if (was && list.indexOf(was) >= 0) sel.value = was;
  }

  /** What you have, of whichever token is picked. */
  function onCurrencyChange() {
    const sel = $('#profCur');
    const c = sel && sel.value;
    const b = wallet && wallet.balances && wallet.balances[c];
    $('#profMax').textContent = b ? 'you have ' + b.amount + ' ' + b.label : '';
  }

  function paintPayout() {
    const p = $('#profPayout');
    p.hidden = !saved;
    p.textContent = saved || '';
    $('#profPayoutNote').textContent = saved
      ? 'Money you take out is sent here. Connect a different wallet to change it.'
      : 'Connect a Solana wallet. Money you take out is sent there.';
  }

  /** The wallets this browser can see. Only their address is wanted; nothing is ever signed. */
  function listWallets() {
    const box = $('#profWallets');
    if (!box) return;
    box.textContent = '';
    const found = Wallets.list();
    $('#profNoWallet').hidden = !!found.length;
    found.forEach(w => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wbtn';
      if (w.icon) {
        const img = document.createElement('img');
        img.src = w.icon; img.alt = ''; img.width = 20; img.height = 20;
        b.appendChild(img);
      }
      b.appendChild(document.createTextNode(w.name));
      b.onclick = () => connect(w);
      box.appendChild(b);
    });
  }

  /** Ask a wallet for its address and save it as where this player's money goes. */
  async function connect(w) {
    if (busy) return;
    busy = true; say('Waiting for your wallet…');
    try {
      const addr = await Wallets.connect(w);
      if (!addr) throw new Error('That wallet did not share an address.');
      await Auth.setWallet(addr);
      saved = addr;
      paintPayout(); paintBalance();
      say('Money you take out will be sent to ' + short(addr) + '.');
    } catch (e) {
      say(Err.say(e, 'connect a wallet'), true);
    }
    busy = false;
  }

  /** Send this player's own money to their own wallet. */
  async function withdraw() {
    if (busy) return;
    const amount = ($('#profAmount').value || '').trim();
    if (!amount) return say('Enter an amount to take out.', true);
    busy = true; $('#profSend').disabled = true; say('Sending…');
    try {
      const sel = $('#profCur');
      const out = await Stake.withdraw(amount, sel && sel.value);
      $('#profAmount').value = '';
      say('Sent ' + out.arriving + ' ' + (out.currency || '') + ' to ' + short(out.to)
        + (out.fee && out.fee !== '0' ? ' (' + out.fee + ' fee)' : '')
        + '. It can take a minute to arrive.');
      Stake.forget();
      wallet = await Stake.wallet(true).catch(() => wallet);
      paintBalance();
    } catch (e) {
      say(Err.say(e, 'withdraw'), true);
    }
    busy = false; $('#profSend').disabled = false;
  }

  function wire() {
    const o = $('#profOpen'), c = $('#profCopy'), s = $('#profSend');
    if (o) o.onclick = async () => {
      if (busy) return;
      busy = true; o.disabled = true; say('Setting up your wallet…');
      try { wallet = await Stake.openWallet(); paintBalance(); say('Ready. Send USDT, USDC or SOL on Solana to the address above.'); }
      catch (e) { say(Err.say(e, 'set up your wallet'), true); }
      busy = false; o.disabled = false;
    };
    if (c) c.onclick = async () => {
      // An address that silently failed to copy gets typed by hand, and money follows the typo.
      const ok = await Clip.copy($('#profAddr').textContent);
      c.textContent = ok ? 'Copied' : 'Blocked';
      setTimeout(() => { c.textContent = 'Copy address'; }, 1600);
      if (!ok) say('Copying is blocked here. The address is above — select it by hand.', true);
    };
    if (s) s.onclick = withdraw;
    const cur = $('#profCur');
    if (cur) cur.onchange = onCurrencyChange;
    // Wallets announce themselves a moment after the page loads, so the list is redrawn when they do.
    Wallets.onChange(() => { if (!$('#profile').hidden) listWallets(); });
  }

  return { wire, load };
})();
