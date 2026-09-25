/* Makes and funds two throwaway devnet wallets for tools/stake-e2e.html.
 *
 * These keys are disposable and devnet-only. They are written to tools/e2e-wallets.json, which is
 * git-ignored: a test that needs to sign has to hold a key somewhere, and the only safe key to hold
 * is one that guards nothing.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, getMint } from "@solana/spl-token";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(homedir() + "/.config/solana/id.json", "utf8")))
);
const mintStr = readFileSync("../../js/config.js", "utf8").match(/STAKE_MINT:\s*'([^']+)'/)[1];
const mint = new PublicKey(mintStr);
const dec = (await getMint(conn, mint)).decimals;

const a = Keypair.generate(), b = Keypair.generate();
const tx = new Transaction();
for (const kp of [a, b]) {
  tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: 0.08e9 }));
}
await sendAndConfirmTransaction(conn, tx, [payer]);

for (const kp of [a, b]) {
  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, kp.publicKey);
  await mintTo(conn, payer, mint, ata.address, payer, BigInt(50 * 10 ** dec));
}

writeFileSync("../e2e-wallets.json", JSON.stringify({
  mint: mintStr,
  a: { pubkey: a.publicKey.toBase58(), secret: Array.from(a.secretKey) },
  b: { pubkey: b.publicKey.toBase58(), secret: Array.from(b.secretKey) }
}, null, 1));

console.log("a:", a.publicKey.toBase58(), " 0.08 SOL, 50 coins");
console.log("b:", b.publicKey.toBase58(), " 0.08 SOL, 50 coins");
console.log("written to tools/e2e-wallets.json (git-ignored)");
