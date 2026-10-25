// Regenerate the runtime-overlay integrity table after bumping DSH.
//
//   npm run record-pristine
//   npm run record-pristine -- --write   (also rewrites pristine.ts + the ps1)
//
// The overlay never writes to the official dsh tree; this only records what
// the installed release looked like so checkDshPristine can detect tampering.
// The version is taken from the installed package, so run it right after
// `npm i -g @deepseek-ai/dsh@<new version>`.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function globalPrefix() {
  try {
    const out = execFileSync(process.env.ComSpec || "cmd.exe", ["/c", "npm", "prefix", "-g"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return out.trim();
  } catch {
    return process.env.APPDATA ? join(process.env.APPDATA, "npm") : "";
  }
}

const dshRoot = join(globalPrefix(), "node_modules", "@deepseek-ai", "dsh");
if (!existsSync(join(dshRoot, "package.json"))) {
  console.error(`cannot find the global dsh install at ${dshRoot} (npm i -g @deepseek-ai/dsh first)`);
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(dshRoot, "package.json"), "utf8")).version;
const subRoot = join(dshRoot, "node_modules", "@deepseek-ai");

const pristineTs = join(repoRoot, "src", "harness", "overlay", "pristine.ts");
const source = readFileSync(pristineTs, "utf8");
const rels = [...source.matchAll(/"([^"]+)":\s*"[0-9A-F]{64}"/g)].map((m) => m[1]);
if (rels.length === 0) {
  console.error("no file entries found in pristine.ts");
  process.exit(1);
}

const hashes = {};
for (const rel of rels) {
  const file = join(subRoot, rel);
  if (!existsSync(file)) {
    console.error(`missing file in this dsh release: ${rel}`);
    process.exit(1);
  }
  hashes[rel] = createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

console.log(`dsh version: ${version}`);
for (const rel of rels) console.log(`  ${rel}\n    ${hashes[rel]}`);

if (!process.argv.includes("--write")) {
  console.log("\n(values not written; re-run with --write to update pristine.ts + restore script)");
  process.exit(0);
}

let next = source;
next = next.replace(/export const PRISTINE_HOST_VERSION = "[^"]+";/, `export const PRISTINE_HOST_VERSION = "${version}";`);
next = next.replace(/release \(v[0-9][^)]*\)/, `release (v${version})`);
for (const rel of rels) {
  const re = new RegExp(`("${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":\\s*")[0-9A-F]{64}(")`);
  next = next.replace(re, `$1${hashes[rel]}$2`);
}
writeFileSync(pristineTs, next, "utf8");

const restorePs1 = join(repoRoot, "scripts", "restore-dsh-pristine.ps1");
let ps1 = readFileSync(restorePs1, "utf8");
ps1 = ps1.replace(/\$expectedDshVersion = "[^"]+";/, `$expectedDshVersion = "${version}";`);
ps1 = ps1.replace(/\(v[0-9][^)]*\)\. The extension applies/, `(v${version}). The extension applies`);
for (const rel of rels) {
  const winRel = rel.replace(/\//g, "\\\\");
  const re = new RegExp(`("${winRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" = ")[0-9A-F]{64}(")`);
  ps1 = ps1.replace(re, `$1${hashes[rel]}$2`);
}
writeFileSync(restorePs1, ps1, "utf8");

console.log("\nupdated: src/harness/overlay/pristine.ts, scripts/restore-dsh-pristine.ps1");
