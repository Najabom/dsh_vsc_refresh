// Regenerate the runtime-overlay integrity table after bumping DSH.
//
//   npm run record-pristine              # verify + show what would change
//   npm run record-pristine -- --write   # rewrite pristine.ts + the restore script
//
// The overlay never writes to the official dsh tree; this only records what
// the installed release looked like so checkDshPristine can detect tampering.
// The version is taken from the installed package, so run it right after
// `npm i -g @deepseek-ai/dsh@<new version>`.
//
// Cross-platform: the dsh root is resolved from (in order)
//   1. $DSH_VSC_DSH_ROOT                         (direct path to the dsh package)
//   2. `npm root -g`                              (cwd-independent on every OS)
//   3. `npm prefix -g` + node_modules
//   4. well-known global npm prefixes             (APPDATA on Windows, /usr/local/... elsewhere)
// On Windows the npm CLI is invoked through cmd.exe (npm.cmd shim); on
// POSIX it is executed directly. A failed lookup is never fatal — the next
// strategy is tried.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const isWindows = process.platform === "win32";
const DSH_PACKAGE = ["@deepseek-ai", "dsh"];

/** Run the npm CLI and return trimmed stdout, or "" when it cannot run. */
function npm(args) {
  try {
    const out = isWindows
      ? execFileSync(process.env.ComSpec || "cmd.exe", ["/c", "npm", ...args], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 60000,
        })
      : execFileSync("npm", args, { encoding: "utf8", timeout: 60000 });
    return out.trim();
  } catch {
    return "";
  }
}

/** Directories that hold a `node_modules` with global packages. */
function globalNodeModulesDirs() {
  const dirs = [];
  const npmRoot = npm(["root", "-g"]);
  if (npmRoot) dirs.push(npmRoot);
  const prefix = npm(["prefix", "-g"]);
  if (prefix) dirs.push(join(prefix, "node_modules"));
  if (isWindows) {
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, "npm", "node_modules"));
  } else {
    dirs.push("/usr/local/lib/node_modules", "/usr/lib/node_modules", join(homedir(), ".npm-global", "lib", "node_modules"));
  }
  return [...new Set(dirs.filter(Boolean))];
}

/** Absolute path of the installed @deepseek-ai/dsh package, or "" if absent. */
function findDshRoot() {
  const candidates = [];
  if (process.env.DSH_VSC_DSH_ROOT) candidates.push(process.env.DSH_VSC_DSH_ROOT);
  for (const dir of globalNodeModulesDirs()) candidates.push(join(dir, ...DSH_PACKAGE));
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, "package.json"))) return candidate;
  }
  return "";
}

const dshRoot = findDshRoot();
if (!dshRoot) {
  console.error(
    "cannot find the global @deepseek-ai/dsh install.\n" +
      "  install it first (npm i -g @deepseek-ai/dsh) or point DSH_VSC_DSH_ROOT at the package directory.\n" +
      "  searched:\n" +
      (process.env.DSH_VSC_DSH_ROOT ? `    $DSH_VSC_DSH_ROOT=${process.env.DSH_VSC_DSH_ROOT}\n` : "") +
      globalNodeModulesDirs()
        .map((dir) => `    ${join(dir, ...DSH_PACKAGE)}`)
        .join("\n")
  );
  process.exit(1);
}
console.log(`dsh root:   ${dshRoot}`);

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
    console.error(`missing file in this dsh release: ${rel} (expected under ${subRoot})`);
    process.exit(1);
  }
  hashes[rel] = createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

const recordedVersion = /export const PRISTINE_HOST_VERSION = "([^"]+)";/.exec(source)?.[1] ?? "";
console.log(`dsh version: ${version}`);
for (const rel of rels) {
  const state = Object.keys(hashes).includes(rel) && source.includes(`"${rel}": "${hashes[rel]}"`) ? "same" : "NEW";
  console.log(`  ${rel}\n    ${hashes[rel]} (${state})`);
}

if (!process.argv.includes("--write")) {
  if (recordedVersion === version) {
    console.log(`\nrecorded table is up to date for dsh ${version} (re-run with --write only after a manual table edit)`);
  } else {
    console.log(
      `\nrecorded table is for dsh ${recordedVersion || "?"} — this install is ${version}.\n` +
        "re-run with --write to update pristine.ts + scripts/restore-dsh-pristine.ps1"
    );
  }
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
console.log(`\nupdated: ${join("src", "harness", "overlay", "pristine.ts")}`);

// The restore script is generated, not hand-maintained: it must always carry
// the same version + hashes as pristine.ts. Regenerating it wholesale also
// covers the case where it is missing entirely.
const restorePs1 = join(repoRoot, "scripts", "restore-dsh-pristine.ps1");
const ps1Entries = rels
  .map((rel) => `  "${rel.replace(/\//g, "\\")}" = "${hashes[rel]}"`)
  .join("\n");
writeFileSync(
  restorePs1,
  `# restore-dsh-pristine.ps1 [-VerifyOnly]
#
# Verify the official @deepseek-ai/dsh installation is byte-exact to the npm
# registry release (v${version}). The extension applies its deltas at RUNTIME
# as a per-process ESM loader overlay (src/harness/overlay/), so the installed
# tree must stay pristine ("pure bridge": never write DSH official files).
#
# READ-ONLY: this script only verifies, it never writes or restores files.
# On any mismatch it tells you to reinstall the official package:
#   npm i -g @deepseek-ai/dsh@${version}
#
# -VerifyOnly is implied (kept for CLI compatibility).
#
# GENERATED by \`npm run record-pristine -- --write\` — do not edit by hand;
# the reference version + hashes in src/harness/overlay/pristine.ts are the
# source of truth.
param(
  # Read-only verification is the only mode; the switch is kept for CLI
  # compatibility with older documentation.
  [switch]$VerifyOnly
)
$ErrorActionPreference = "Stop"

$expectedDshVersion = "${version}"

# dsh package root: env override, then npm's global prefix, then APPDATA.
$dshRoot = $null
if ($env:DSH_VSC_DSH_ROOT) {
  $dshRoot = $env:DSH_VSC_DSH_ROOT
} else {
  try {
    $prefix = & cmd.exe /c npm prefix -g 2>$null
    if ($LASTEXITCODE -eq 0 -and $prefix) {
      $dshRoot = Join-Path $prefix.Trim() "node_modules\\@deepseek-ai\\dsh"
    }
  } catch { }
  if (-not $dshRoot -and $env:APPDATA) {
    $dshRoot = Join-Path $env:APPDATA "npm\\node_modules\\@deepseek-ai\\dsh"
  }
}
if (-not $dshRoot) {
  Write-Error "cannot locate the global @deepseek-ai/dsh install; set DSH_VSC_DSH_ROOT to the package directory"
  exit 1
}
$subRoot = Join-Path $dshRoot "node_modules\\@deepseek-ai"

# relative path under $subRoot -> pristine SHA256 of the npm release file
$pristine = @{
${ps1Entries}
}

function Get-Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash
}

$failed = 0

foreach ($rel in $pristine.Keys) {
  $file = Join-Path $subRoot $rel
  $label = $rel
  if (-not (Test-Path $file)) {
    Write-Host "[FAIL] $label : file not found: $file" -ForegroundColor Red
    $failed++
    continue
  }

  $hashNow = Get-Sha256 $file
  if ($hashNow -eq $pristine[$rel]) {
    Write-Host "[ok]   $label : pristine ($hashNow)"
  } else {
    Write-Host "[FAIL] $label : NOT pristine (sha256 $hashNow)" -ForegroundColor Red
    Write-Host "       the overlay never writes to disk — reinstall dsh: npm i -g @deepseek-ai/dsh@$expectedDshVersion" -ForegroundColor Red
    $failed++
  }
}

# version sanity
$pkg = Join-Path $dshRoot "package.json"
if (Test-Path $pkg) {
  $ver = (Get-Content $pkg -Raw | ConvertFrom-Json).version
  if ($ver -ne $expectedDshVersion) {
    Write-Host "[warn] installed @deepseek-ai/dsh is $ver ; pristine hashes recorded for $expectedDshVersion — run 'npm run record-pristine -- --write' after upgrading, or reinstall the recorded version" -ForegroundColor Yellow
  }
}

Write-Host ""
if ($failed -gt 0) { exit 1 }
Write-Host "official DSH body is pristine — the runtime overlay (src/harness/overlay) provides the patch in-memory"
`,
  "utf8"
);
console.log(`updated: ${join("scripts", "restore-dsh-pristine.ps1")}`);
