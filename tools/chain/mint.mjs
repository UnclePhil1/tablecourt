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

if (cmd === "make") {
  const mint = await createMint(conn, payer, payer.publicKey, null, 6);
  console.log("mint address :", mint.toBase58());
  console.log("authority    :", payer.publicKey.toBase58());
  console.log("\nPut this in js/config.js as STAKE_MINT.");
} else if (cmd === "give") {
  const [wallet, amount] = rest;
  if (!wallet || !amount) { console.error("need a wallet and an amount"); process.exit(1); }
  const mintStr = process.env.STAKE_MINT || JSON.parse(readFileSync("../../js/config.json", "utf8")).STAKE_MINT;
  const mint = new PublicKey(mintStr);
  const dec = (await getMint(conn, mint)).decimals;
  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, new PublicKey(wallet));
  const units = BigInt(Math.round(Number(amount) * 10 ** dec));
  await mintTo(conn, payer, mint, ata.address, payer, units);
  console.log(`gave ${amount} to ${wallet}`);
  console.log("token account:", ata.address.toBase58());
} else {
  console.error("usage: node mint.mjs make | node mint.mjs give <wallet> <amount>");
  process.exit(1);
}
