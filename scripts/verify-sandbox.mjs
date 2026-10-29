// Verify the Windows ACL sandbox chain still works and stays windowless.
//
// The runner only ships in the Windows build of DSH (package
// `dsh-sandbox-windows-acl`); on macOS/Linux and on installs without that
// package this script exits 0 with a clear "skipped" message so it is safe to
// run from any machine / CI job.
//
// Usage:
//   node scripts/verify-sandbox.mjs [workspace]
//
// Resolution (all overridable, no hard-coded machine paths):
//   workspace : argv[2] > $DSH_VSC_SANDBOX_WORKSPACE > process.cwd()
//   node      : $DSH_VSC_NODE_PATH > process.execPath (the node running this script)
//   dsh root  : $DSH_ROOT or $DSH_VSC_DSH_ROOT (path to the installed
//               @deepseek-ai/dsh package) > `npm root -g` +
//               @deepseek-ai/dsh > `npm prefix -g` + node_modules + ...
//               > well-known global prefixes (APPDATA on Windows).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function npm(args) {
  try {
    const out =
      process.platform === "win32"
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

function globalNodeModulesDirs() {
  const dirs = [];
  const root = npm(["root", "-g"]);
  if (root) dirs.push(root);
  const prefix = npm(["prefix", "-g"]);
  if (prefix) dirs.push(join(prefix, "node_modules"));
  if (process.platform === "win32") {
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, "npm", "node_modules"));
  } else {
    dirs.push(
      "/usr/local/lib/node_modules",
      "/usr/lib/node_modules",
      join(process.env.HOME ?? "", ".npm-global", "lib", "node_modules")
    );
  }
  return [...new Set(dirs.filter(Boolean))];
}

function findDshRoot() {
  if (process.env.DSH_ROOT) return process.env.DSH_ROOT;
  if (process.env.DSH_VSC_DSH_ROOT) return process.env.DSH_VSC_DSH_ROOT;
  for (const dir of globalNodeModulesDirs()) {
    const candidate = join(dir, "@deepseek-ai", "dsh");
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return "";
}

function skipped(reason) {
  console.log(`[sandbox] skipped: ${reason}`);
  process.exit(0);
}

const runnerRel = join("node_modules", "@deepseek-ai", "dsh-sandbox-windows-acl", "lib", "runner.js");

// Why: the ACL runner is a Windows-only package; nothing to verify elsewhere.
if (process.platform !== "win32") {
  skipped(`dsh-sandbox-windows-acl is Windows-only (platform: ${process.platform})`);
}

const node = process.env.DSH_VSC_NODE_PATH || process.execPath;
if (!node || !existsSync(node)) skipped(`node executable not found: ${node || "(empty)"}`);

const dshRoot = findDshRoot();
if (!dshRoot) {
  skipped(
    "global @deepseek-ai/dsh not found — install it with `npm i -g @deepseek-ai/dsh` " +
      "or set DSH_ROOT / DSH_VSC_DSH_ROOT to the installed package directory"
  );
}

const runner = join(dshRoot, runnerRel);
if (!existsSync(runner)) {
  skipped(`dsh-sandbox-windows-acl is not installed in ${dshRoot} (package absent from this DSH build)`);
}

const workspace = process.argv[2] || process.env.DSH_VSC_SANDBOX_WORKSPACE || process.cwd();
const temp = process.env.DSH_VSC_SANDBOX_TEMP || tmpdir();
if (!existsSync(workspace)) skipped(`workspace directory does not exist: ${workspace}`);

console.log(`[sandbox] node      : ${node}`);
console.log(`[sandbox] dsh root  : ${dshRoot}`);
console.log(`[sandbox] runner    : ${runner}`);
console.log(`[sandbox] workspace : ${workspace}`);
console.log(`[sandbox] temp      : ${temp}`);

try {
  const out = execFileSync(
    node,
    [
      runner,
      "--workspace",
      workspace,
      "--temp",
      temp,
      "--mode",
      "read-only",
      "--",
      "powershell",
      "-NoProfile",
      "-Command",
      "Write-Output sandbox-chain-ok",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 20000 }
  );
  const text = out.trim();
  if (!text.includes("sandbox-chain-ok")) {
    console.error(`[sandbox] FAILED: runner exited 0 but output was unexpected: ${JSON.stringify(text)}`);
    process.exit(1);
  }
  console.log(`[sandbox] OK — sandbox chain works, windowless (output: ${text})`);
} catch (error) {
  console.error(`[sandbox] FAILED status=${error.status ?? "?"}`);
  if (error.stdout) console.error(`stdout: ${String(error.stdout).trim()}`);
  if (error.stderr) console.error(`stderr: ${String(error.stderr).trim()}`);
  if (error.code === "EPERM" || error.code === "EACCES") {
    console.error(
      "[sandbox] the child process could not start (EPERM/EACCES) — this environment forbids spawning " +
        "children with piped stdio; re-run it from a normal terminal."
    );
  }
  process.exit(1);
}
