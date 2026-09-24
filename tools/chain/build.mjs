/* Builds vendor/solana.js from entry.js.
 *
 *   cd tools/chain && npm install && npm run build
 *
 * Run this only when the Solana or Anchor packages need changing. The output is committed, so a normal
 * checkout needs neither node nor this directory — which is the whole point of vendoring it.
 *
 * Node's globals have to be shimmed because both packages still expect Buffer and process to exist.
 * Leaving that to chance produces a bundle that loads fine and then fails on the first transaction.
 */
import { build } from "esbuild";
import { writeFileSync, statSync, readFileSync } from "fs";
import { createHash } from "crypto";

const OUT = "../../vendor/solana.js";

const shim = `
// Both packages still reach for Node's globals. Supply just enough of them, before anything else runs.
import { Buffer as NodeBuffer } from "buffer";
if (typeof window !== "undefined") {
  if (!window.Buffer) window.Buffer = NodeBuffer;
  if (!window.global) window.global = window;
  if (!window.process) window.process = { env: {}, browser: true, version: "", nextTick: (f, ...a) => setTimeout(() => f(...a), 0) };
}
`;

writeFileSync("_shim.js", shim);

const result = await build({
  entryPoints: ["entry.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  inject: ["_shim.js"],
  outfile: OUT,
  metafile: true,
  logLevel: "info",
});

const kb = (statSync(OUT).size / 1024).toFixed(0);
const hash = createHash("sha256").update(readFileSync(OUT)).digest("hex").slice(0, 8);
console.log(`\nvendor/solana.js  ${kb} KB  sha256:${hash}`);
console.log("Remember: python3 tools/stamp.py, so browsers cannot pair it with an older index.html.");

const big = Object.entries(result.metafile.outputs[OUT].inputs)
  .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
  .slice(0, 8);
console.log("\nlargest contributors:");
for (const [file, info] of big) {
  console.log(`  ${(info.bytesInOutput / 1024).toFixed(0).padStart(4)} KB  ${file}`);
}
