import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as vscode from "vscode";
import { checkDshPristine, PRISTINE_HOST_VERSION } from "./overlay/pristine";
import {
  buildHarnessEnv,
  depsActionableMessage,
  depsSummaryLines,
  describePnpm,
  missingHarnessDeps,
  resolveDeps,
  resolvePnpm,
  runCaptured,
  type DepsConfig,
  type DepsResolutions,
  type PnpmResolution,
} from "./deps";

let child: ChildProcess | undefined;

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
 * Multi-window guard entry (bundled from src/harness/guard.ts). The harness is
 * spawned THROUGH this wrapper so it cannot outlive every dsh-vsc window: the
 * guard polls the client heartbeats under %TEMP%\dsh-vsc-clients and kills the
 * tree when the last window goes stale, and dies with the harness otherwise.
 */
const GUARD_SCRIPT = join(__dirname, "harness-guard.mjs");

function guardScriptPath(): string | undefined {
  return existsSync(GUARD_SCRIPT) ? GUARD_SCRIPT : undefined;
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

/* ------------------------------------------------------------------ *
 * Cross-platform dependency diagnostics (cached for callers)
 * ------------------------------------------------------------------ */

let depsCache: DepsResolutions | null = null;
let depsCacheAt = 0;
/** Re-probe after a minute: the user may install Node/DSH while a window is
 *  open; spawn paths force a fresh probe regardless. */
const DEPS_CACHE_MS = 60_000;
/** Info-level "deps missing" guidance is logged once per session (the
 *  extension surfaces the same text in the OutputChannel/notification). */
let missingDepsNotified = false;
/** "pnpm missing" hint is logged once per session, not on every spawn. */
let pnpmMissingNotified = false;

/** Read the dshVsc.* bootstrap settings (deps.ts stays vscode-free). */
export function readDepsConfig(): DepsConfig {
  const config = vscode.workspace.getConfiguration("dshVsc");
  return {
    nodePath: config.get<string>("nodePath", ""),
    dshScriptPath: config.get<string>("dshScriptPath", ""),
    pnpmPath: config.get<string>("pnpmPath", ""),
  };
}

/**
 * Node.js / dsh / pnpm resolutions for the auto-start path (cached; `force`
 * re-runs the probes — used before every real spawn and by the settings-page
 * doctor card). Never throws: the resolvers return `{found:false}` + reason.
 */
export async function resolveHarnessDeps(force = false): Promise<DepsResolutions> {
  if (!force && depsCache && Date.now() - depsCacheAt < DEPS_CACHE_MS) return depsCache;
  depsCache = await resolveDeps(readDepsConfig());
  depsCacheAt = Date.now();
  return depsCache;
}

/** Invalidate the cached resolutions (settings changed / tools just installed). */
export function invalidateHarnessDeps(): void {
  depsCache = null;
  missingDepsNotified = false;
}

/** Path of the resolved @deepseek-ai/dsh package.json (version display copy). */
export async function localDshPackageJson(): Promise<string | undefined> {
  const deps = await resolveHarnessDeps();
  if (!deps.dsh.found || !deps.dsh.packageRoot) return undefined;
  const pkg = join(deps.dsh.packageRoot, "package.json");
  return existsSync(pkg) ? pkg : undefined;
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start `dsh web` as a DETACHED, WINDOWLESS background process.
 *
 * Cross-platform bootstrap (see harness/deps.ts): resolve a Node.js >= 24.9.0,
 * the real `@deepseek-ai/dsh/lib/bin.js` entry and a pnpm CLI. The entry is
 * spawned directly with node — never through the `dsh`/`npx` shims: on Windows
 * npm .cmd shims chain cmd.exe → shim → cmd.exe and pop a console; on POSIX
 * they add a shell hop for no benefit. The spawned environment gets the pnpm
 * bin dir prepended to PATH so the official plugin manager (which shells out to
 * `pnpm`) can install/update plugins and the companion bundle.
 *
 * - detached + stdio:'ignore' + unref: the harness is owned by this extension
 *   and is closed when VS Code exits (deactivate → stopHarness); on POSIX the
 *   detached child becomes its own process-group leader so stopHarness can
 *   signal the whole tree.
 * - Uses the SAME data root as the web GUI (~/.dsh): the extension is a shared
 *   client, so "one runs, the other watches" means ONE history. Port ownership
 *   is the natural exclusivity — our instance takes the same port the web GUI
 *   would use (default 3080), so the two can never co-write the same log.
 *
 * Missing Node/dsh logs actionable Chinese guidance (install commands + link)
 * once and returns false immediately — the caller must not burn its
 * auto-spawn retries on a machine that simply does not have the runtime.
 */
export async function startHarness(port: number, log: vscode.OutputChannel, cwd?: string): Promise<boolean> {
  if (isRunning()) return true;
  // Fresh probe on every spawn attempt: the user may have just installed
  // Node/DSH or changed one of the dshVsc.* path overrides.
  const deps = await resolveHarnessDeps(true);
  if (missingHarnessDeps(deps)) {
    if (!missingDepsNotified) {
      missingDepsNotified = true;
      log.appendLine(depsActionableMessage(deps));
    }
    return false;
  }
  missingDepsNotified = false;
  const node = deps.node;
  const dsh = deps.dsh;
  const nodePath = node.path;
  const dshPath = dsh.path;
  if (!nodePath || !dshPath) return false; // unreachable when missingHarnessDeps is false

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

  // pnpm: detected on the machine (PATH / PNPM_HOME / npm global bin). It is an
  // external prerequisite the user installs; never provisioned here.
  const config = readDepsConfig();
  const pnpm: PnpmResolution = await resolvePnpm({
    config,
    ...(nodePath ? { nodePath } : {}),
  });
  log.appendLine(`deps: ${depsSummaryLines(deps).join(" | ")}`);
  if ((!pnpm.found || !pnpm.ok) && !pnpmMissingNotified) {
    pnpmMissingNotified = true;
    log.appendLine(
      `deps: ${describePnpm(pnpm)} — 插件检索/安装会失败；pnpm 属于外部依赖，请自行安装（npm i -g pnpm@11，或设置 dshVsc.pnpmPath），然后重启 DSH 服务/该 dsh web 实例`
    );
  }

  const subRoot = join(dirname(dirname(dshPath)), "node_modules", "@deepseek-ai");
  const rep = checkDshPristine(subRoot);
  if (rep.ok) {
    log.appendLine(`dsh install integrity: pristine (${rep.pristine.length} official files byte-identical to npm release)`);
  } else if (rep.unverified) {
    log.appendLine(
      `dsh install integrity: reference table is for v${PRISTINE_HOST_VERSION}, installed ${rep.dshVersion ?? "unknown"} — verification skipped (run npm run record-pristine when bumping dsh)`
    );
  } else {
    log.appendLine(
      `dsh install integrity: NOT pristine — missing=[${rep.missing.join(", ")}] modified=[${rep.modified.join(", ")}] (the overlay never writes to disk: reinstall with npm i -g @deepseek-ai/dsh@${PRISTINE_HOST_VERSION}; verify via scripts/restore-dsh-pristine.ps1)`
    );
  }

  // Child env: inherited parent env + pnpm/node on PATH (plugin manager) +
  // the overlay --import flag. GITHUB_TOKEN is NOT required and never read
  // from the registry — an inherited token is simply passed through.
  const env = buildHarnessEnv(process.env, node, dsh, pnpm);
  const flag = `--import=${pathToFileURL(overlay).href}`;
  env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${flag}` : flag;
  if (env.GITHUB_TOKEN) {
    log.appendLine(`GITHUB_TOKEN: passed through from the host environment (${env.GITHUB_TOKEN.length} chars; not required)`);
  }

  const args = ["web", "--no-open", "--port", String(port)];
  // Wrap in the multi-window guard when available: the guard supervises the
  // heartbeat liveness contract and kills the harness after an all-windows
  // crash. Missing bundle (dev runs) falls back to the direct spawn — still
  // correct, only the crash-cleanup path is lost.
  const guard = guardScriptPath();
  const spawnArgv = guard ? [guard, dshPath, ...args] : [dshPath, ...args];
  const windowsHide = process.platform === "win32";
  log.appendLine(
    `$ ${nodePath} ${spawnArgv.join(" ")} (direct node, windowless, detached process group, shared ~/.dsh${
      guard ? ", guard-wrapped" : ""
    })`
  );
  if (!guard) log.appendLine("multi-window guard missing (dist/harness-guard.mjs) — direct spawn without crash cleanup");
  if (cwd) log.appendLine(`harness cwd: ${cwd} (VS Code workspace folder — new sessions and the web GUI start here)`);

  const proc = spawn(nodePath, spawnArgv, {
    shell: false,
    // CREATE_NO_WINDOW on Windows; on POSIX windowsHide is ignored.
    windowsHide,
    // detached: on POSIX this makes the child a process-group leader, which is
    // what stopHarness() signals (-pid); on Windows it detaches from the
    // console (the tree is killed with taskkill /T).
    detached: true,
    stdio: "ignore",
    env,
    // The open VS Code folder becomes the harness's default working directory,
    // so sessions created outside the panel (e.g. the web GUI) also land in
    // the workspace instead of the process-inherited cwd.
    ...(cwd ? { cwd } : {}),
  });
  child = proc;
  // The record names the GUARD pid: its command line carries `--port <N>` and
  // a tree kill on it tears down guard + harness together.
  writePidRecord({ pid: proc.pid ?? 0, port, startedAt: new Date().toISOString(), args: [dshPath, ...args] });
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
  if (!pidAlive(rec.pid)) {
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

/**
 * Kill one process TREE, then drop the pid record.
 *
 * Windows: `taskkill /PID <pid> /T /F` (guard + harness + MCP children).
 * POSIX: the harness was spawned detached (= process-group leader), so signal
 * a negative pid to reach guard + harness + descendants: SIGTERM first, then
 * SIGKILL after a short grace period.
 */
function killPid(pid: number): Promise<{ killed: boolean; pid?: number; error?: string }> {
  if (process.platform === "win32") {
    return runCaptured("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 15_000 }).then((result) => {
      clearPidRecord();
      if (result.ok) return { killed: true as const, pid };
      // Fallback: terminate the recorded process directly (single process, no
      // tree). Better a possibly-incomplete kill than a live orphan; only
      // reached when taskkill itself is unavailable/blocked.
      try {
        process.kill(pid);
        return { killed: true as const, pid };
      } catch {
        return { killed: false as const, pid, error: result.error };
      }
    });
  }
  return new Promise((resolve) => {
    signalTree(pid, "SIGTERM");
    const deadline = Date.now() + 3_000;
    const poll = (): void => {
      if (!pidAlive(pid)) {
        clearPidRecord();
        resolve({ killed: true, pid });
        return;
      }
      if (Date.now() >= deadline) {
        signalTree(pid, "SIGKILL");
        clearPidRecord();
        resolve({ killed: true, pid });
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

/** Signal a detached child's process group, falling back to the single pid. */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* not a group leader (or already gone) — fall back to the single process */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/** Live command line of a pid (null when it cannot be read — e.g. the process
 *  already exited or the platform tool is unavailable). PID-reuse guard. */
function commandLineOf(pid: number): Promise<string | null> {
  if (process.platform === "win32") {
    return runCaptured(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { timeoutMs: 8_000 }
    ).then((result) => {
      const line = result.stdout.trim();
      return result.ok && line.length > 0 ? line : null;
    });
  }
  // POSIX: /proc/<pid>/cmdline on Linux; macOS/BSD fall back to `ps`.
  return new Promise((resolve) => {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      if (raw.length > 0) {
        resolve(raw);
        return;
      }
    } catch {
      /* no procfs — use ps below */
    }
    void runCaptured("ps", ["-p", String(pid), "-o", "args="], { timeoutMs: 8_000 }).then((result) => {
      const line = result.stdout.trim();
      resolve(result.ok && line.length > 0 ? line : null);
    });
  });
}
