/* Table – the staking half of a 1v1.

   Everything here talks to the escrow program in table-bet/. The money is held on Solana and the rules
   are enforced there; this file only builds transactions and asks the player's wallet to sign them.

   Nothing in this file is trusted by anything. The table's record of a stake is a copy kept for the
   lobby to display, written after the fact by whichever browser happened to send the transaction. The
   chain is the only account of who was paid, which is why every step here hands its signature back and
   why `read()` goes to the chain rather than to the table.

   The Solana packages are large — about 585KB — and most matches are not staked, so vendor/solana.js is
   fetched the first time it is actually needed rather than on every page load.

   Amounts: the player types 10 and means 10 USDC. The program counts in the mint's smallest unit, so
   the decimals are read off the mint itself rather than assumed, because getting that wrong by a factor
   of a million is the kind of mistake that only shows up once real money is in. */
const Stake = (function () {
  const PROGRAM_ID = '9FMrUJ9Ahmxqagixp89t29rs6HoP5KckZLtsgVrnnrAU';
  const CODE_LEN = 10;
  const MATCH_SEED = 'match';
  // A match runs for at most this long before either player may take their own stake back. It has to
  // sit inside the range the program allows, or opening the escrow is refused.
  const PLAY_SECS = 2 * 60 * 60;

  const cfg = k => (window.TABLE_CONFIG || {})[k];
  const rpcUrl = () => cfg('SOLANA_RPC') || 'https://api.devnet.solana.com';
  /** The token a stake is denominated in. Devnet USDC unless configured otherwise. */
  const mintAddress = () => cfg('STAKE_MINT') || '';

  let kit = null, loading = null, conn = null, idl = null;
  const decimalsOf = {};        // mint address -> decimals, read from the chain once

  /** True when this build has a token configured to stake in. */
  const configured = () => !!mintAddress();

  /* ---------- loading the heavy part, once, and only when asked ---------- */
  function load() {
    if (kit) return Promise.resolve(kit);
    if (loading) return loading;
    loading = (async () => {
      if (!window.SolanaKit) {
        await new Promise((res, rej) => {
          const el = document.createElement('script');
          el.src = 'vendor/solana.js' + ((window.TABLE_LAZY || {})['vendor/solana.js'] || '');
          el.onload = res;
          el.onerror = () => rej(new Error('Could not load the part of the game that handles money.'));
          document.head.appendChild(el);
        });
      }
      if (!window.SolanaKit) throw new Error('Could not load the part of the game that handles money.');
      kit = window.SolanaKit;
      idl = await (await fetch('vendor/table_bet.idl.json')).json();
      if (idl.address !== PROGRAM_ID) {
        throw new Error('The staking rules on this page do not match the program they would be sent to.');
      }
      conn = new kit.Connection(rpcUrl(), 'confirmed');
      return kit;
    })().catch(e => { loading = null; throw e; });
    return loading;
  }

  /* ---------- the player's wallet ---------- */
  // Signing is always the wallet's own decision, shown in its own window. Nothing here ever sees a key.
  async function signing(addr) {
    const w = await Wallets.signerFor(addr);
    return new kit.AnchorProvider(conn, {
      publicKey: new kit.PublicKey(addr),
      signTransaction: t => w.signTransaction(t),
      signAllTransactions: t => (w.signAllTransactions ? w.signAllTransactions(t) : Promise.all(t.map(x => w.signTransaction(x))))
    }, { commitment: 'confirmed', preflightCommitment: 'confirmed' });
  }
  const program = async addr => new kit.Program(idl, await signing(addr));
  /** Reading state needs no wallet at all, so it must not ask for one. */
  function reader() {
    const nobody = new kit.PublicKey(PROGRAM_ID);
    return new kit.Program(idl, new kit.AnchorProvider(conn, {
      publicKey: nobody, signTransaction: async t => t, signAllTransactions: async t => t
    }, { commitment: 'confirmed' }));
  }

  /* ---------- addresses the program derives ---------- */
  function codeBytes(code) {
    const b = new Uint8Array(CODE_LEN);
    const src = new TextEncoder().encode(String(code || '').toUpperCase());
    if (src.length > CODE_LEN) throw new Error('That match code is too long to stake on.');
    b.set(src);
    return b;
  }
  function matchPda(code) {
    return kit.PublicKey.findProgramAddressSync(
      [window.Buffer.from(MATCH_SEED), window.Buffer.from(codeBytes(code))],
      new kit.PublicKey(PROGRAM_ID)
    )[0];
  }
  // The pot is owned by the match itself, which is not a key on the curve, so its token address has to
  // be asked for with allowOwnerOffCurve. The default throws instead of returning the right answer.
  const vaultFor = (mint, game) => kit.getAssociatedTokenAddress(mint, game, true);

  /* ---------- amounts ---------- */
  async function decimals(mintStr) {
    if (decimalsOf[mintStr] != null) return decimalsOf[mintStr];
    const info = await conn.getParsedAccountInfo(new kit.PublicKey(mintStr));
    const d = info && info.value && info.value.data && info.value.data.parsed
      && info.value.data.parsed.info && info.value.data.parsed.info.decimals;
    if (typeof d !== 'number') throw new Error('That token could not be read, so the stake cannot be worked out.');
    decimalsOf[mintStr] = d;
    return d;
  }
  /** "10" -> 10000000 for a six-decimal token, without floating point anywhere near it. */
  function toUnits(amount, dec) {
    const s = String(amount).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('That is not an amount.');
    const [whole, frac = ''] = s.split('.');
    if (frac.length > dec) throw new Error('That amount is more precise than the token allows.');
    return BigInt(whole + frac.padEnd(dec, '0'));
  }
  const fromUnits = (units, dec) => {
    const s = BigInt(units).toString().padStart(dec + 1, '0');
    const out = (s.slice(0, -dec || undefined) + '.' + s.slice(-dec)).replace(/\.?0+$/, '');
    return out || '0';
  };
  /** What the winner takes and what the platform takes, worked out the same way the program does it. */
  function split(units, feeBps) {
    const u = BigInt(units), bps = BigInt(feeBps);
    const feeEach = (u * bps) / 10000n;
    return { toWinner: u * 2n - feeEach * 2n, fee: feeEach * 2n };
  }

  /* ---------- reading ---------- */
  /** What the chain says about this match, or null if no escrow was ever opened for it. */
  async function read(code) {
    await load();
    const pda = matchPda(code);
    const m = await reader().account.match.fetchNullable(pda);
    if (!m) return null;
    const dec = await decimals(m.mint.toBase58());
    const state = Object.keys(m.state)[0];
    const side = c => (c ? Object.keys(c)[0] : null);
    return {
      address: pda.toBase58(),
      state: state,                                   // open | locked | settled | refunded
      mint: m.mint.toBase58(),
      host: m.host.toBase58(),
      guest: m.guest.toBase58(),
      units: BigInt(m.stake.toString()),
      amount: fromUnits(m.stake.toString(), dec),
      decimals: dec,
      hostSaid: side(m.hostClaim),
      guestSaid: side(m.guestClaim),
      feeBps: m.feeBps,
      deadline: Number(m.deadline) * 1000,
      agreed: !!(m.hostClaim && m.guestClaim && side(m.hostClaim) === side(m.guestClaim))
    };
  }

  /* ---------- the four things a player can do ---------- */

  /** The host locks its own stake in and names the guest who may match it. */
  async function open(code, guestWallet, amount, hostWallet) {
    await load();
    const mintStr = mintAddress();
    if (!mintStr) throw new Error('This build has no staking token set up.');
    const dec = await decimals(mintStr);
    const units = toUnits(amount, dec);
    const mint = new kit.PublicKey(mintStr);
    const game = matchPda(code);
    const p = await program(hostWallet);
    const sig = await p.methods
      .open(Array.from(codeBytes(code)), new kit.PublicKey(guestWallet), new kit.BN(units.toString()), new kit.BN(PLAY_SECS))
      .accounts({
        host: new kit.PublicKey(hostWallet),
        game: game,
        mint: mint,
        vault: await vaultFor(mint, game),
        hostTokens: await kit.getAssociatedTokenAddress(mint, new kit.PublicKey(hostWallet)),
        tokenProgram: kit.TOKEN_PROGRAM_ID,
        associatedTokenProgram: kit.ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: kit.SystemProgram.programId
      })
      .rpc();
    return sig;
  }

  /** The named guest matches the stake. After this the money can only move on an agreed result. */
  async function join(code, guestWallet) {
    await load();
    const m = await read(code);
    if (!m) throw new Error('There is no stake on that match yet.');
    const mint = new kit.PublicKey(m.mint);
    const game = matchPda(code);
    return (await program(guestWallet)).methods
      .join()
      .accounts({
        guest: new kit.PublicKey(guestWallet),
        game: game,
        vault: await vaultFor(mint, game),
        guestTokens: await kit.getAssociatedTokenAddress(mint, new kit.PublicKey(guestWallet)),
        tokenProgram: kit.TOKEN_PROGRAM_ID
      })
      .rpc();
  }

  /** Say who won, on chain, in your own name. Nothing pays out until both players have. */
  async function claim(code, iWon, myWallet, iAmHost) {
    await load();
    const winner = iWon === !!iAmHost ? { host: {} } : { guest: {} };
    return (await program(myWallet)).methods
      .claim(winner)
      .accounts({ player: new kit.PublicKey(myWallet), game: matchPda(code) })
      .rpc();
  }

  /** Both agreed, so pay the winner. Either player may send it; it pays the same person either way. */
  async function settle(code, myWallet) {
    await load();
    const m = await read(code);
    if (!m) throw new Error('There is no stake on that match.');
    if (!m.agreed) throw new Error('You both have to say who won before this can pay out.');
    const winner = new kit.PublicKey(m.hostSaid === 'host' ? m.host : m.guest);
    const mint = new kit.PublicKey(m.mint);
    const game = matchPda(code);
    const feeWallet = new kit.PublicKey(
      idl.constants.find(c => /fee.?wallet/i.test(c.name)).value.replace(/"/g, '')
    );
    return (await program(myWallet)).methods
      .settle()
      .accounts({
        caller: new kit.PublicKey(myWallet),
        game: game,
        vault: await vaultFor(mint, game),
        host: new kit.PublicKey(m.host),
        winner: winner,
        mint: mint,
        winnerTokens: await kit.getAssociatedTokenAddress(mint, winner),
        feeWallet: feeWallet,
        feeTokens: await kit.getAssociatedTokenAddress(mint, feeWallet),
        tokenProgram: kit.TOKEN_PROGRAM_ID,
        associatedTokenProgram: kit.ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: kit.SystemProgram.programId
      })
      .rpc();
  }

  /** Nobody is paid and nobody is charged: each player takes back exactly what they put in. */
  async function refund(code, myWallet) {
    await load();
    const m = await read(code);
    if (!m) throw new Error('There is no stake on that match.');
    const mint = new kit.PublicKey(m.mint);
    const game = matchPda(code);
    return (await program(myWallet)).methods
      .refund()
      .accounts({
        player: new kit.PublicKey(myWallet),
        game: game,
        vault: await vaultFor(mint, game),
        host: new kit.PublicKey(m.host),
        hostTokens: await kit.getAssociatedTokenAddress(mint, new kit.PublicKey(m.host)),
        guestTokens: await kit.getAssociatedTokenAddress(mint, new kit.PublicKey(m.guest)),
        tokenProgram: kit.TOKEN_PROGRAM_ID
      })
      .rpc();
  }

  /** The host takes its stake back because nobody ever joined. */
  async function cancel(code, hostWallet) {
    await load();
    const m = await read(code);
    if (!m) return null;
    const mint = new kit.PublicKey(m.mint);
    const game = matchPda(code);
    return (await program(hostWallet)).methods
      .cancel()
      .accounts({
        host: new kit.PublicKey(hostWallet),
        game: game,
        vault: await vaultFor(mint, game),
        hostTokens: await kit.getAssociatedTokenAddress(mint, new kit.PublicKey(hostWallet)),
        tokenProgram: kit.TOKEN_PROGRAM_ID
      })
      .rpc();
  }

  /** What this player holds of the staking token, so a stake can be refused before a wallet window. */
  async function balance(wallet) {
    await load();
    const mintStr = mintAddress();
    if (!mintStr) return null;
    const dec = await decimals(mintStr);
    try {
      const ata = await kit.getAssociatedTokenAddress(new kit.PublicKey(mintStr), new kit.PublicKey(wallet));
      const acc = await kit.getAccount(conn, ata);
      return { units: BigInt(acc.amount.toString()), amount: fromUnits(acc.amount.toString(), dec), decimals: dec };
    } catch (e) {
      return { units: 0n, amount: '0', decimals: dec };   // no token account yet means none of it held
    }
  }

  return {
    configured, load, read, open, join, claim, settle, refund, cancel, balance,
    split, toUnits, fromUnits, decimals, matchPda: c => (kit ? matchPda(c).toBase58() : null),
    get programId() { return PROGRAM_ID; },
    get mint() { return mintAddress(); },
    get explorer() { return 'https://explorer.solana.com'; },
    txUrl: sig => 'https://explorer.solana.com/tx/' + sig + '?cluster=devnet'
  };
})();
