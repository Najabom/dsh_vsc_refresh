#!/usr/bin/env node
/**
 * Install the freshly built VSIX into THIS machine's VS Code.
 *
 * `npm run install:local` runs `npm run package` first, then this script:
 *   1. picks the newest dsh-vsc-<version>.vsix in the repo root,
 *   2. uninstalls the legacy dev id (local.dsh-vsc) when present — two copies of
 *      the same extension would fight over the same views/commands,
 *   3. installs the VSIX with `code --install-extension --force`,
 *   4. prints the installed version (`code --list-extensions --show-versions`).
 *
 * The extension id is `najabom.dsh-vsc` (publisher changed from "local"), so a
 * window reload is needed after installing.
 *
 * Maintainer/dev convenience only — NOT part of the shipped extension. The
 * `code` CLI is located the same way the extension's own updater does it, with
 * a PATH scan as fallback.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? "code.cmd" : "code";
const LEGACY_IDS = ["local.dsh-vsc"];
const TARGET_ID = "najabom.dsh-vsc";

function fail(message) {
  console.error(`install-local: ${message}`);
  process.exit(1);
}

/** Newest `dsh-vsc-<version>.vsix` in the repo root. */
function newestVsix() {
  const candidates = readdirSync(repoRoot)
    .filter((name) => /^dsh-vsc-\d.*\.vsix$/i.test(name))
    .map((name) => ({ name, path: join(repoRoot, name), mtime: statSync(join(repoRoot, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) {
    fail("no dsh-vsc-*.vsix found — run `npm run package` first (or use `npm run install:local`).");
  }
  return candidates[0];
}

/** `code` CLI candidates (same locations the extension's updater probes). */
function codeCliCandidates() {
  const out = [];
  const root = process.env.VSCODE_APP_ROOT; // optional override for portable installs
  if (root) {
    out.push(join(root, "bin", EXE));
    out.push(join(dirname(root), "bin", EXE));
    out.push(join(dirname(dirname(root)), "bin", EXE));
  }
  if (IS_WINDOWS) {
    if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "bin", EXE));
    if (process.env.ProgramFiles) out.push(join(process.env.ProgramFiles, "Microsoft VS Code", "bin", EXE));
    if (process.env["ProgramFiles(x86)"]) out.push(join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "bin", EXE));
    // VS Code Insiders
    if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code Insiders", "bin", EXE));
  } else if (process.platform === "darwin") {
    out.push("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
    out.push("/usr/local/bin/code", "/opt/homebrew/bin/code");
  } else {
    out.push("/usr/bin/code", "/usr/share/code/bin/code", "/snap/bin/code", "/usr/local/bin/code");
  }
  for (const entry of (process.env.PATH ?? "").split(IS_WINDOWS ? ";" : ":").filter(Boolean)) {
    out.push(join(entry, EXE));
  }
  return [...new Set(out)];
}

function findCodeCli() {
  for (const candidate of codeCliCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Quote one argv item for a cmd.exe command line (paths never contain quotes). */
function cmdQuote(arg) {
  if (arg.includes('"')) fail(`refusing an argument containing a quote: ${arg}`);
  return `"${arg}"`;
}

function runCode(cli, args, { allowFailure = false } = {}) {
  try {
    // Windows: the `code` CLI is a .cmd shim; cmd /c with a *single quoted
    // command string* is the reliable form (execFile-style argv gets escaped
    // into literal \"…\" by the CreateProcess quoting rules).
    const output = IS_WINDOWS
      ? execSync([cli, ...args].map(cmdQuote).join(" "), {
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : execFileSync(cli, args, { encoding: "utf8" });
    return { ok: true, output: `${output}`.trim() };
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim();
    if (allowFailure) return { ok: false, output };
    fail(`\`${cli} ${args.join(" ")}\` failed: ${output || error.message}`);
  }
}

const cli = findCodeCli();
if (!cli) {
  fail(
    "VS Code CLI (`code`) not found. Install the VSIX manually: " +
      "Command Palette → “Extensions: Install from VSIX…”, or add the `code` command to PATH " +
      "(macOS: Shell Command: Install 'code' command in PATH)."
  );
}

const vsix = newestVsix();
console.log(`install-local: CLI   ${cli}`);
console.log(`install-local: VSIX  ${vsix.path}`);

for (const legacy of LEGACY_IDS) {
  const result = runCode(cli, ["--uninstall-extension", legacy], { allowFailure: true });
  console.log(`install-local: uninstall legacy ${legacy}: ${result.ok ? "removed" : "not installed (skipped)"}`);
}

runCode(cli, ["--install-extension", vsix.path, "--force"]);
console.log(`install-local: installed ${TARGET_ID} from ${vsix.name}`);

const listed = runCode(cli, ["--list-extensions", "--show-versions"], { allowFailure: true });
const row = listed.ok ? listed.output.split(/\r?\n/).find((line) => line.toLowerCase().startsWith("najabom.dsh-vsc")) : "";
console.log(`install-local: ${row ? `detected ${row}` : "installed (rerun `code --list-extensions --show-versions` to confirm)"}`);
console.log('install-local: reload the VS Code window (Command Palette → "Developer: Reload Window") to activate the new build.');
