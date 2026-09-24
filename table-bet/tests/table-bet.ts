/* Table – what the escrow must and must not allow.
 *
 * The happy path matters least here. Most of these are attempts to take money that is not yours: pay
 * out on one signature, change your answer once you have seen theirs, send the fee somewhere else, be
 * paid as a winner you are not, settle the same match twice. Each of those has to fail for a named
 * reason, and the balances afterwards have to add up to the last unit.
 *
 * Run with:  anchor test
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError } from "@coral-xyz/anchor";
import { TableBet } from "../target/types/table_bet";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";

const CODE_LEN = 10;
const DEC = 6;                       // USDC's decimals, so the numbers read like money
const ONE = 10 ** DEC;
const STAKE = 10 * ONE;              // 10 USDC each
const PLAY_SECS = 10 * 60;

/** A match code as the program wants it: upper-case, zero-padded to a fixed width. */
function code(s: string): number[] {
  const b = Buffer.alloc(CODE_LEN);
  Buffer.from(s.toUpperCase()).copy(b);
  return Array.from(b);
}

describe("table-bet", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.TableBet as Program<TableBet>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // The fee wallet is a constant inside the program, so the test has to read it rather than pick it.
  const FEE_WALLET = new PublicKey(
    program.idl.constants.find((c) => c.name === "FEE_WALLET" || c.name === "feeWallet")!.value.replace(/"/g, "")
  );

  let mint: PublicKey;
  let feeTokens: PublicKey;

  const matchPda = (c: number[]) =>
    PublicKey.findProgramAddressSync([Buffer.from("match"), Buffer.from(c)], program.programId)[0];

  async function fund(kp: Keypair, amount = STAKE * 5) {
    const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    const ata = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, kp.publicKey);
    if (amount > 0) await mintTo(provider.connection, payer, mint, ata.address, payer, amount);
    return ata.address;
  }

  /** A pair of funded players and the accounts a match between them needs. */
  async function players() {
    const host = Keypair.generate(), guest = Keypair.generate();
    const hostTokens = await fund(host), guestTokens = await fund(guest);
    return { host, guest, hostTokens, guestTokens };
  }

  async function openMatch(c: number[], p: Awaited<ReturnType<typeof players>>, stake = STAKE, secs = PLAY_SECS) {
    const game = matchPda(c);
    await program.methods
      .open(c, p.guest.publicKey, new anchor.BN(stake), new anchor.BN(secs))
      .accounts({
        host: p.host.publicKey,
        game,
        mint,
        vault: await getAssociatedTokenAddress(mint, game, true),
        hostTokens: p.hostTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([p.host])
      .rpc();
    return game;
  }

  async function joinMatch(game: PublicKey, p: Awaited<ReturnType<typeof players>>, who = p.guest, tokens = p.guestTokens) {
    await program.methods
      .join()
      .accounts({
        guest: who.publicKey,
        game,
        vault: await getAssociatedTokenAddress(mint, game, true),
        guestTokens: tokens,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([who])
      .rpc();
  }

  const claim = (game: PublicKey, who: Keypair, winner: "host" | "guest") =>
    program.methods
      .claim(winner === "host" ? { host: {} } : { guest: {} })
      .accounts({ player: who.publicKey, game })
      .signers([who])
      .rpc();

  async function settle(game: PublicKey, p: Awaited<ReturnType<typeof players>>, opts: {
    winner?: PublicKey; winnerTokens?: PublicKey; feeTokens?: PublicKey; feeWallet?: PublicKey; caller?: Keypair;
  } = {}) {
    const winner = opts.winner ?? p.host.publicKey;
    const caller = opts.caller ?? p.host;
    await program.methods
      .settle()
      .accounts({
        caller: caller.publicKey,
        game,
        vault: await getAssociatedTokenAddress(mint, game, true),
        host: p.host.publicKey,
        winner,
        mint,
        winnerTokens: opts.winnerTokens ?? (await getAssociatedTokenAddress(mint, winner)),
        feeWallet: opts.feeWallet ?? FEE_WALLET,
        feeTokens: opts.feeTokens ?? feeTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([caller])
      .rpc();
  }

  // The vault is owned by the match PDA, which is off the ed25519 curve, so its associated token
  // address has to be asked for with allowOwnerOffCurve — the default throws instead.
  const refund = async (game: PublicKey, p: Awaited<ReturnType<typeof players>>, who = p.host) =>
    program.methods
      .refund()
      .accounts({
        player: who.publicKey,
        game,
        vault: await getAssociatedTokenAddress(mint, game, true),
        host: p.host.publicKey,
        hostTokens: p.hostTokens,
        guestTokens: p.guestTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([who])
      .rpc();

  /** The reason a transaction was refused, so a test can insist on the right one. */
  async function refusedWith(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof AnchorError) return e.error.errorCode.code;
      const s = String((e as any).logs?.join("\n") ?? e);
      const m = s.match(/Error Code: (\w+)/) ?? s.match(/custom program error: 0x([0-9a-f]+)/i);
      return m ? m[1] : s.slice(0, 200);
    }
    throw new Error("that was allowed when it should have been refused");
  }

  const bal = async (a: PublicKey) => Number((await getAccount(provider.connection, a)).amount);

  before(async () => {
    mint = await createMint(provider.connection, payer, payer.publicKey, null, DEC);
    // The fee wallet is a real address on mainnet with nobody's key here, so only its token account
    // is needed; the program creates it on first payout, but creating it up front lets the tests read
    // a balance before and after.
    feeTokens = await getAssociatedTokenAddress(mint, FEE_WALLET);
  });

  it("pays the winner and takes 1% of each stake when both players agree", async () => {
    const p = await players();
    const c = code("AGREE1");
    const game = await openMatch(c, p);
    await joinMatch(game, p);

    const vault = await getAssociatedTokenAddress(mint, game, true);
    assert.equal(await bal(vault), 2 * STAKE, "both stakes should be in the pot");
    const hostBefore = await bal(p.hostTokens);

    await claim(game, p.host, "host");
    await claim(game, p.guest, "host");
    await settle(game, p);

    assert.equal(await bal(p.hostTokens), hostBefore + 19.8 * ONE, "winner takes 19.8");
    assert.equal(await bal(feeTokens), 0.2 * ONE, "platform takes 0.2");
    assert.equal(await provider.connection.getAccountInfo(vault), null, "the pot should be closed, not left holding dust");
    assert.deepEqual((await program.account.match.fetch(game)).state, { settled: {} });
  });

  it("will not pay out on one player's word alone", async () => {
    const p = await players();
    const game = await openMatch(code("ONESIDE"), p);
    await joinMatch(game, p);
    await claim(game, p.host, "host");           // the host says it won; the guest has said nothing
    assert.equal(await refusedWith(() => settle(game, p)), "ResultIncomplete");
  });

  it("refunds both and charges nothing when the two disagree", async () => {
    const p = await players();
    const game = await openMatch(code("ARGUE"), p);
    await joinMatch(game, p);
    const hostBefore = await bal(p.hostTokens), guestBefore = await bal(p.guestTokens);
    const feeBefore = await bal(feeTokens);

    await claim(game, p.host, "host");
    await claim(game, p.guest, "guest");         // each says it won
    assert.equal(await refusedWith(() => settle(game, p)), "ResultDisputed");

    await refund(game, p);
    assert.equal(await bal(p.hostTokens), hostBefore + STAKE, "host gets its own stake back");
    assert.equal(await bal(p.guestTokens), guestBefore + STAKE, "guest gets its own stake back");
    assert.equal(await bal(feeTokens), feeBefore, "a refund must not be charged a fee");
  });

  it("will not let a player change their answer once it is in", async () => {
    const p = await players();
    const game = await openMatch(code("NOSWAP"), p);
    await joinMatch(game, p);
    await claim(game, p.guest, "guest");
    assert.equal(await refusedWith(() => claim(game, p.guest, "host")), "AlreadyClaimed");
    await claim(game, p.guest, "guest");         // saying the same thing again is a retry, and fine
  });

  it("will not take an answer from someone who was not playing", async () => {
    const p = await players();
    const game = await openMatch(code("STRANGE"), p);
    await joinMatch(game, p);
    const stranger = Keypair.generate();
    await fund(stranger, 0);
    assert.equal(await refusedWith(() => claim(game, stranger, "host")), "NotYourMatch");
  });

  it("cannot be settled twice", async () => {
    const p = await players();
    const game = await openMatch(code("TWICE"), p);
    await joinMatch(game, p);
    await claim(game, p.host, "guest");
    await claim(game, p.guest, "guest");
    await settle(game, p, { winner: p.guest.publicKey });
    const again = await refusedWith(() => settle(game, p, { winner: p.guest.publicKey }));
    assert.oneOf(again, ["WrongState", "AccountNotInitialized", "ConstraintAssociated", "AccountNotFound"]);
  });

  it("will not pay someone who is not the agreed winner", async () => {
    const p = await players();
    const game = await openMatch(code("WRONGW"), p);
    await joinMatch(game, p);
    await claim(game, p.host, "host");
    await claim(game, p.guest, "host");          // both agree the host won
    const thief = Keypair.generate();
    await fund(thief, 0);
    assert.equal(
      await refusedWith(() => settle(game, p, { winner: thief.publicKey })),
      "WrongWinner"
    );
  });

  it("will not let the fee be sent anywhere but the built-in wallet", async () => {
    const p = await players();
    const game = await openMatch(code("FEEGRAB"), p);
    await joinMatch(game, p);
    await claim(game, p.host, "host");
    await claim(game, p.guest, "host");

    const thief = Keypair.generate();
    const thiefTokens = await fund(thief, 0);
    // Point both the fee's owner and its token account at somebody else.
    const asOwner = await refusedWith(() =>
      settle(game, p, { feeWallet: thief.publicKey, feeTokens: thiefTokens })
    );
    assert.equal(asOwner, "WrongFeeWallet");
    // Keep the real owner but swap the token account underneath it.
    const asAccount = await refusedWith(() => settle(game, p, { feeTokens: thiefTokens }));
    assert.oneOf(asAccount, ["ConstraintAssociated", "ConstraintTokenOwner", "AccountNotInitialized"]);
    // The pot is untouched by either attempt, and settles normally afterwards.
    await settle(game, p);
    assert.deepEqual((await program.account.match.fetch(game)).state, { settled: {} });
  });

  it("will not refund while the match is still live and undisputed", async () => {
    const p = await players();
    const game = await openMatch(code("TOOSOON"), p);
    await joinMatch(game, p);
    assert.equal(await refusedWith(() => refund(game, p)), "NotRefundableYet");
    await claim(game, p.host, "host");           // one answer is not a disagreement either
    assert.equal(await refusedWith(() => refund(game, p)), "NotRefundableYet");
  });

  it("gives the host its stake back if nobody ever joined, and not after", async () => {
    const p = await players();
    const game = await openMatch(code("NOSHOW"), p);
    const before = await bal(p.hostTokens);
    await program.methods
      .cancel()
      .accounts({
        host: p.host.publicKey,
        game,
        vault: await getAssociatedTokenAddress(mint, game, true),
        hostTokens: p.hostTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([p.host])
      .rpc();
    assert.equal(await bal(p.hostTokens), before + STAKE);

    // Once the guest's money is in, the host cannot simply walk off with the pot.
    const q = await players();
    const live = await openMatch(code("NOWALK"), q);
    await joinMatch(live, q);
    const stopped = await refusedWith(() =>
      program.methods
        .cancel()
        .accounts({
          host: q.host.publicKey,
          game: live,
          vault: getAssociatedTokenAddress(mint, live, true) as any,
          hostTokens: q.hostTokens,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([q.host])
        .rpc()
    );
    assert.equal(stopped, "WrongState");
  });

  it("will not let a stranger take the invited player's seat", async () => {
    const p = await players();
    const game = await openMatch(code("SEAT"), p);
    const gatecrasher = Keypair.generate();
    const theirTokens = await fund(gatecrasher);
    assert.equal(
      await refusedWith(() => joinMatch(game, p, gatecrasher, theirTokens)),
      "NotYourMatch"
    );
  });

  it("refuses a nonsense match", async () => {
    const p = await players();
    assert.equal(await refusedWith(() => openMatch(code("ZERO"), p, 0)), "StakeTooSmall");
    assert.equal(await refusedWith(() => openMatch(code("SHORT"), p, STAKE, 5)), "BadDeadline");
    assert.equal(
      await refusedWith(() => openMatch(code("FOREVER"), p, STAKE, 60 * 60 * 24 * 30)),
      "BadDeadline"
    );
    const solo = { ...p, guest: p.host };
    assert.equal(await refusedWith(() => openMatch(code("SOLO"), solo)), "PlayingYourself");
  });
});
