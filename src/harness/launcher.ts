import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as vscode from "vscode";
import { checkDshPristine } from "./overlay/pristine";

let child: ChildProcess | undefined;
let launcher: { node: string; script: string } | null = null;

/**
 * Runtime overlay (in-memory patch) entry: dist/overlay-register.mjs is
 * bundled by esbuild (see esbuild.js) and injected into the harness process
 * via NODE_OPTIONS=--import=<file-url>. It registers an ESM loader that
 * applies the browser-auth bypass delta to the module SOURCE as the harness
 * loads it — the official dsh files on disk stay pristine (pure bridge; see
 * src/harness/overlay/deltas.ts + internal/runtime-overlay.md).
 */
const OVERLAY_REGISTER = join(__dirname, "overlay-register.mjs");

function overlayRegisterPath(): string | undefined {
  return existsSync(OVERLAY_REGISTER) ? OVERLAY_REGISTER : undefined;
}

/**
 * Persistent record of the harness this extension auto-started, so a detached
 * background instance is never "invisible": the file names the PID, port and
 * start time, and deactivate clears it. Re-run of the shutdown logic reads it
 * to decide whether a still-alive process is ours to stop.
 */
export const HARNESS_PID_FILE = join(tmpdir(), "dsh-vsc-harness.pid");

export interface HarnessPidRecord {
  pid: number;
  port: number;
  startedAt: string;
  args: string[];
}

export function writePidRecord(record: HarnessPidRecord): void {
  try {
    writeFileSync(HARNESS_PID_FILE, JSON.stringify(record, null, 2), "utf8");
  } catch {
    /* a missing pid file must never break lifecycle */
  }
}

export function clearPidRecord(): void {
  try {
    rmSync(HARNESS_PID_FILE, { force: true });
  } catch {
    /* noop */
  }
}

export function readPidRecord(): HarnessPidRecord | null {
  try {
    if (!existsSync(HARNESS_PID_FILE)) return null;
    return JSON.parse(readFileSync(HARNESS_PID_FILE, "utf8")) as HarnessPidRecord;
  } catch {
    return null;
  }
}

/**
 * Whether the harness is "ours" and still alive.
 *
 * Two sources of truth:
 * 1. The live ChildProcess handle (`child`) — set when THIS module spawned it.
 * 2. The persistent pid record (`%TEMP%\dsh-vsc-harness.pid`) — survives
 *    extension reloads, where `child` is wiped (module re-import) but the
 *    detached instance we spawned keeps running.
 *
 * After a reload the pid record is the ONLY proof an instance is ours; without
 * this fallback `dsh.stop` / deactivate would say "not ours" and leave an
 * orphan harness on the port forever (observed in deactivate logs: owned=false
 * with a live pid record).
 */
export function isRunning(): boolean {
  if (child !== undefined && child.exitCode === null) return true;
  return isPidRecordAlive();
}

/** True when the pid record names a process that is still alive. */
function isPidRecordAlive(): boolean {
  const rec = readPidRecord();
  if (!rec || rec.pid <= 0) return false;
  try {
    process.kill(rec.pid, 0); // signal 0 = existence probe, no side effects
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the child env: inherit the parent, but ensure GITHUB_TOKEN is present
 * and inject the runtime overlay --import flag.
 *
 * The web profile fails the whole boot when GITHUB_TOKEN is missing
 * (mcp-github config becomes invalid), so fall back to the persistent Windows
 * user env when the process env lacks it (e.g. VS Code launched from a stale
 * session).
 *
 * NODE_OPTIONS (not argv) is the injection mechanism on purpose: it applies
 * to the top-level harness process AND any node child it may spawn, with one
 * flag. The overlay register file lives in dist/ next to extension.js and is
 * bundled into the vsix (dist/** is not in .vscodeignore).
 */
async function resolveSpawnEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!env.GITHUB_TOKEN) {
    const userToken = await readWindowsUserEnv("GITHUB_TOKEN");
    if (userToken) env.GITHUB_TOKEN = userToken;
  }
  const register = overlayRegisterPath();
  if (register) {
    const flag = `--import=${pathToFileURL(register).href}`;
    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${flag}` : flag;
  }
  return env;
}

function readWindowsUserEnv(name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("reg", ["query", "HKCU\\Environment", "/v", name], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(undefined);
      const match = new RegExp(`${name}\\s+REG_\\S+\\s+(.+)`).exec(stdout);
      resolve(match ? match[1].trim() : undefined);
    });
  });
}

function runWhereAll(name: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("where.exe", [name], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(
        stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      );
    });
  });
}

async function resolveNodePath(): Promise<string | undefined> {
  const hits = await runWhereAll("node");
  const exe = hits.find((h) => h.toLowerCase().endsWith(".exe"));
  if (exe) return exe;
  for (const candidate of ["C:\\Program Files\\nodejs\\node.exe", "C:\\Program Files (x86)\\nodejs\\node.exe"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the real dsh entry script. We must NOT launch through `dsh`/`npx`
 * shims: npm .cmd shims chain `cmd.exe → dsh.cmd → cmd.exe`, and the inner cmd
 * opens its own visible console even when the outer spawn used windowsHide.
 * Spawning `node lib/bin.js` directly with windowsHide (CREATE_NO_WINDOW)
 * keeps the whole harness tree windowless (the MCP SDK already hides its own
 * server children).
 */
async function resolveDshScript(): Promise<string | undefined> {
  // Prefer the .cmd shim (e.g. %APPDATA%\npm\dsh.cmd); `where` may list a
  // bare extensionless `dsh` first, which is not executable by CreateProcess.
  const hits = await runWhereAll("dsh");
  const shim = hits.find((h) => h.toLowerCase().endsWith(".cmd"));
  if (shim) {
    try {
      const content = readFileSync(shim, "utf8");
      // The shim references the script as e.g. "%dp0%\node_modules\@deepseek-ai\dsh\lib\bin.js"
      const m = /((?:node_modules\\)?@deepseek-ai\\dsh\\lib\\bin\.js)/.exec(content);
      if (m) {
        let rel = m[1].replace(/\//g, "\\");
        if (!rel.startsWith("node_modules")) rel = "node_modules\\" + rel;
        const candidate = join(shim.replace(/[^\\/]+$/, ""), rel);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      /* fall through to npm prefix */
    }
  }
  // Fallback: derive from the global npm prefix. execFile CANNOT launch a .cmd
  // directly (CreateProcess EINVAL), so go through cmd.exe /c.
  const comspec = process.env.ComSpec || "cmd.exe";
  const prefix = await new Promise<string | undefined>((resolve) => {
    execFile(comspec, ["/c", "npm", "prefix", "-g"], { windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  });
  if (prefix) {
    const candidate = join(prefix, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function resolveLauncher(): Promise<{ node: string; script: string } | null> {
  if (launcher) return launcher;
  try {
    const node = await resolveNodePath();
    const script = await resolveDshScript();
    if (!node || !script) return null;
    launcher = { node, script };
    return launcher;
  } catch (error) {
    // Never let a resolution failure hang or crash the watch loop.
    return null;
  }
}

/** Path of the resolved @deepseek-ai/dsh package.json (version display copy). */
export async function localDshPackageJson(): Promise<string | undefined> {
  const l = await resolveLauncher();
  if (!l) return undefined;
  const pkg = join(dirname(dirname(l.script)), "package.json");
  return existsSync(pkg) ? pkg : undefined;
}

/**
 * Start `dsh web` as a DETACHED, WINDOWLESS background process (no console,
 * no cmd shim). Direct `node bin.js` spawn with windowsHide = CREATE_NO_WINDOW:
 * - detached + stdio:'ignore' + unref: the harness is owned by this extension
 *   and is closed when VS Code exits (deactivate → stopHarness).
 * - no console anywhere in the tree, so there is nothing to close and nothing
 *   to kill by accident.
 * - GITHUB_TOKEN resolved (process env, then Windows user env).
 * - Uses the SAME data root as the web GUI (~/.dsh): the extension is a shared
 *   client, so "one runs, the other watches" means ONE history. Port ownership
 *   is the natural exclusivity — our instance takes the same port the web GUI
 *   would use (default 3080), so the two can never co-write the same log.
 * Stop it with the `dsh.stop` command or by closing VS Code
 * (taskkill /T kills the whole tree).
 */
export async function startHarness(port: number, log: vscode.OutputChannel, cwd?: string): Promise<boolean> {
  if (isRunning()) return true;
  const env = await resolveSpawnEnv();
  const l = await resolveLauncher();
  if (!l) {
    log.appendLine("cannot resolve node/dsh for the silent launch — PATH missing `node` or the `dsh` shim; run `dsh web` manually for now");
    return false;
  }
  // Runtime overlay status + official-body integrity (read-only, cheap).
  const overlay = overlayRegisterPath();
  if (!overlay) {
    // Without the auth bypass the spawned instance answers 401 to every call:
    // it would occupy the port and write ~/.dsh while staying unusable. Refuse
    // to spawn a dead harness instead.
    log.appendLine(
      "runtime overlay MISSING (dist/overlay-register.mjs) — refusing to start an unreachable harness; run `npm run build` and reinstall the extension"
    );
    return false;
  }
  log.appendLine(`runtime overlay: on (${overlay} — in-memory auth-bypass patch; official dsh files untouched)`);
  const subRoot = join(dirname(dirname(l.script)), "node_modules", "@deepseek-ai");
  const rep = checkDshPristine(subRoot);
  if (rep.ok) {
    log.appendLine(`dsh install integrity: pristine (${rep.pristine.length} official files byte-identical to npm release)`);
  } else {
    log.appendLine(
      `dsh install integrity: NOT pristine — missing=[${rep.missing.join(", ")}] modified=[${rep.modified.join(", ")}] (the overlay never writes to disk: reinstall with npm i -g @deepseek-ai/dsh@0.1.7-rc.2; verify via scripts/restore-dsh-pristine.ps1)`
    );
  }
  const args = ["web", "--no-open", "--port", String(port)];
  log.appendLine(`$ ${l.node} ${l.script} ${args.join(" ")} (direct node, windowless, detached, shared ~/.dsh)`);
  if (cwd) log.appendLine(`harness cwd: ${cwd} (VS Code workspace folder — new sessions and the web GUI start here)`);
  log.appendLine(
    env.GITHUB_TOKEN
      ? `GITHUB_TOKEN: ${env.GITHUB_TOKEN.length} chars (${process.env.GITHUB_TOKEN ? "process env" : "Windows user env fallback"})`
      : "GITHUB_TOKEN: MISSING — dsh web will fail to boot (mcp-github config)"
  );
  const proc = spawn(l.node, [l.script, ...args], {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
    env,
    // The open VS Code folder becomes the harness's default working directory,
    // so sessions created outside the panel (e.g. the web GUI) also land in
    // the workspace instead of the process-inherited cwd.
    ...(cwd ? { cwd } : {}),
  });
  child = proc;
  writePidRecord({ pid: proc.pid ?? 0, port, startedAt: new Date().toISOString(), args: [l.script, ...args] });
  // Exit/error handlers only clear state that still belongs to THIS process:
  // after a stop→start (or reload→start) the old child's async exit event
  // would otherwise wipe the new instance's handle and pid record — leaving a
  // live orphan the extension can no longer see or stop.
  proc.on("exit", (code) => {
    log.appendLine(`auto-started dsh web exited (code ${code})`);
    if (child === proc) {
      child = undefined;
      clearPidRecord();
    }
  });
  proc.on("error", (err) => {
    log.appendLine(`dsh web spawn error: ${err.message}`);
    if (child === proc) {
      child = undefined;
      clearPidRecord();
    }
  });
  proc.unref();
  return true;
}

/** Kill the auto-started harness (and its whole process tree). Only ever
 *  touches the process THIS extension spawned (live handle, or the pid record
 *  left behind by a previous session after an extension reload); a
 *  pre-existing/shared harness is never killed. Resolves with what actually
 *  happened. */
export function stopHarness(): Promise<{ killed: boolean; pid?: number; error?: string }> {
  let pid: number | undefined;
  if (child !== undefined && child.exitCode === null) {
    pid = child.pid;
    child = undefined;
    if (pid === undefined) return Promise.resolve({ killed: false });
    return killPid(pid);
  }
  // Reload case: `child` was wiped but the pid record may still name the
  // instance we spawned. Adopt it (if the process is still alive) so the
  // orphan can be cleaned up.
  const rec = readPidRecord();
  if (!rec || rec.pid <= 0) {
    clearPidRecord();
    return Promise.resolve({ killed: false });
  }
  try {
    process.kill(rec.pid, 0);
  } catch {
    clearPidRecord(); // record is stale — process already dead
    return Promise.resolve({ killed: false });
  }
  return commandLineOf(rec.pid).then((cmdline) => {
    if (cmdline !== null && !cmdline.includes(`--port ${rec.port}`)) {
      // PID got reused by an unrelated process — never kill a stranger.
      clearPidRecord();
      return { killed: false as const };
    }
    return killPid(rec.pid);
  });
}

/** taskkill one process tree, then drop the pid record. */
function killPid(pid: number): Promise<{ killed: boolean; pid?: number; error?: string }> {
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
      clearPidRecord();
      resolve(error ? { killed: false, pid, error: error.message } : { killed: true, pid });
    });
  });
}

/** Live command line of a pid (null when it cannot be read — e.g. the process
 *  already exited or CIM is unavailable). Used as the PID-reuse guard. */
function commandLineOf(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const line = stdout.trim();
        resolve(line.length > 0 ? line : null);
      }
    );
  });
}
