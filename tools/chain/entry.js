/* What vendor/solana.js exposes to the game.
 *
 * Deliberately narrow: only the pieces js/stake.js actually needs. The full Solana and Anchor packages
 * are large, and everything exported here is weight every player downloads the moment they open a
 * staked match, so anything not used is left out.
 *
 * Built by tools/chain/build.mjs. Nothing imports this file at runtime — the bundle it produces is
 * committed to vendor/ like three.min.js, so the site still has no build step.
 */
import { Connection, PublicKey, Transaction, SystemProgram, Keypair } from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

window.SolanaKit = {
  Connection, PublicKey, Transaction, SystemProgram, Keypair,
  AnchorProvider, Program, BN,
  getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
};
