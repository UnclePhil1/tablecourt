/* Makes and tops up the devnet token used for testing staked matches.
 *
 *   node mint.mjs make            once: creates the mint, prints its address for js/config.js
 *   node mint.mjs give <wallet> <amount>   mints test tokens to somebody so they can stake
 *
 * Six decimals, to behave exactly like USDC. On mainnet this is replaced by real USDC and there is no
 * mint authority to hand out anything.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getMint } from "@solana/spl-token";
import { readFileSync } from "fs";
import { homedir } from "os";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(homedir() + "/.config/solana/id.json", "utf8")))
);
const [cmd, ...rest] = process.argv.slice(2);

/** STAKE_MINT out of js/config.js, which is JavaScript rather than JSON, so it is read by pattern. */
function mintFromConfig() {
  const src = readFileSync(new URL("../../js/config.js", import.meta.url), "utf8");
  const m = src.match(/STAKE_MINT:\s*'([^']+)'/);
  if (!m) throw new Error("No STAKE_MINT in js/config.js. Run `node mint.mjs make` first.");
  return m[1];
}

/** A Solana address, or a clear complaint. Catches a pasted placeholder before a confusing failure. */
function address(s, what) {
  if (!s) throw new Error(`Need ${what}.`);
  if (/[<>]/.test(s)) throw new Error(`That is the example text, not an address: ${s}`);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new Error(`${s} is not a Solana address.`);
  return new PublicKey(s);
}

try {
  if (cmd === "make") {
    const mint = await createMint(conn, payer, payer.publicKey, null, 6);
    console.log("mint address :", mint.toBase58());
    console.log("authority    :", payer.publicKey.toBase58());
    console.log("\nPut this in js/config.js as STAKE_MINT.");
  } else if (cmd === "give") {
    const [wallet, amount] = rest;
    if (!wallet || !amount) {
      console.error("usage: node mint.mjs give <wallet> <amount>   (a real address, no angle brackets)");
      process.exit(1);
    }
    const to = address(wallet, "a wallet to give them to");
    if (!/^\d+(\.\d+)?$/.test(amount)) { console.error(`${amount} is not an amount.`); process.exit(1); }
    const mintStr = process.env.STAKE_MINT || mintFromConfig();
    const mint = new PublicKey(mintStr);
    const dec = (await getMint(conn, mint)).decimals;
    const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, to);
    const units = BigInt(Math.round(Number(amount) * 10 ** dec));
    await mintTo(conn, payer, mint, ata.address, payer, units);
    console.log(`gave ${amount} to ${wallet}`);
    console.log("token account:", ata.address.toBase58());
  } else {
    console.error("usage: node mint.mjs make | node mint.mjs give <wallet> <amount>");
    process.exit(1);
  }
} catch (e) {
  console.error(String(e && e.message || e));
  process.exit(1);
}
