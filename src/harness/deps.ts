/**
 * Cross-platform dependency resolution for the DSH harness bootstrap.
 *
 * The extension is a protocol client, not a DSH distribution: to auto-start a
 * harness it must find
 *   1. a Node.js runtime — @deepseek-ai/dsh declares `engines.node >= 24.9.0`,
 *   2. the real dsh entry script (`<npm-global>/node_modules/@deepseek-ai/dsh/
 *      lib/bin.js`; never the npm `.cmd` shim, which re-enters cmd.exe and pops
 *      a console — see launcher.ts),
 *   3. a pnpm CLI — the official plugin manager shells out to `pnpm` on PATH
 *      (`@deepseek-ai/dsh-plugin-manager`, `pnpmCommand` default "pnpm"), so
 *      plugin installs (including the companion bundle) cannot work without it.
 *      pnpm is an EXTERNAL prerequisite the user installs themselves
 *      (`npm i -g pnpm@11`), like Node and DSH: this module only detects it and
 *      reports an honest, actionable reason when it is missing or too old — it
 *      never downloads or installs anything.
 *
 * Boundaries:
 *  - pure Node builtins only (no `vscode`, no `@deepseek-ai/*` import): VS Code
 *    settings are read by the caller (launcher.ts) and passed in as
 *    {@link DepsConfig}, which keeps this module testable from scratch/ probes
 *    and keeps the "pure bridge" rule (never import DSH internals);
 *  - every resolver is best-effort and NEVER throws — a failed probe returns
 *    `{found:false}` with an actionable Chinese `reason`;
 *  - explicit user overrides (dshVsc.nodePath / dshScriptPath / pnpmPath) win
 *    and are reported as broken instead of being silently ignored.
 */
import { spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/** dsh 0.2.x requires Node.js >= 24.9.0 (see @deepseek-ai/dsh package.json engines). */
export const MIN_NODE_VERSION = "24.9.0";
/** npm package whose CLI entry script the launcher runs. */
export const DSH_PACKAGE_NAME = "@deepseek-ai/dsh";
/**
 * Minimum pnpm major for DSH's plugin manager. DSH calls
 * `pnpm view ... --config.fetch-retries=0`; pnpm 9/10 implement `view` by
 * delegating to npm, which rejects that flag (npm EUNKNOWNCONFIG), so plugin
 * inspection / registry planning fails. pnpm 11 implements it natively.
 */
export const MIN_PNPM_VERSION = "11.0.0";

/** VS Code settings this module consumes (read by launcher.ts). */
export interface DepsConfig {
  /** `dshVsc.nodePath` — explicit node executable. */
  nodePath?: string;
  /** `dshVsc.dshScriptPath` — explicit .../node_modules/@deepseek-ai/dsh/lib/bin.js. */
  dshScriptPath?: string;
  /** `dshVsc.pnpmPath` — explicit pnpm executable. */
  pnpmPath?: string;
}

/** Append-only line logger (the extension passes its OutputChannel). */
export type DepsLog = (line: string) => void;

export type NodeSource = "config" | "path" | "common" | "vscode" | "none";
export type DshSource = "config" | "path" | "npm-prefix" | "common-prefix" | "none";
export type PnpmSource = "config" | "path" | "pnpm-home" | "corepack" | "npm-prefix" | "none";

export interface NodeResolution {
  found: boolean;
  /** node executable (undefined when not found). */
  path?: string;
  version?: string;
  /** version satisfies dsh's `engines.node` (>= 24.9.0). */
  ok: boolean;
  source: NodeSource;
  /** human-readable Chinese note (found: version; missing: why). */
  reason: string;
}

export interface DshResolution {
  found: boolean;
  /** real `lib/bin.js` entry (undefined when not found). */
  path?: string;
  /** package root (`.../@deepseek-ai/dsh`). */
  packageRoot?: string;
  version?: string;
  /** the CLI entry exists on disk. */
  ok: boolean;
  source: DshSource;
  reason: string;
}

export interface PnpmResolution {
  found: boolean;
  /** pnpm executable (file) — on Windows usually `pnpm.cmd`. */
  command?: string;
  /** directory to PREPEND to PATH so the harness plugin manager resolves `pnpm`. */
  binDir?: string;
  version?: string;
  /**
   * version satisfies DSH's plugin-manager floor (>= 11): pnpm 9/10's `view`
   * delegates to npm, which rejects DSH's `--config.fetch-retries` flag.
   */
  ok: boolean;
  source: PnpmSource;
  reason: string;
}

export interface DepsResolutions {
  node: NodeResolution;
  dsh: DshResolution;
  pnpm: PnpmResolution;
}

/**
 * Flat dependency status for UI consumers (settings-page "运行环境" doctor
 * card). Deliberately a stable, serializable shape — see diagnoseDeps().
 */
export interface DepStatus {
  ok: boolean;
  node: { found: boolean; ok: boolean; path?: string; version?: string; reason?: string };
  dsh: { found: boolean; ok: boolean; path?: string; version?: string; reason?: string };
  pnpm: {
    found: boolean;
    ok: boolean;
    path?: string;
    binDir?: string;
    source?: "path" | "pnpm-home" | "corepack" | "npm-global" | "config" | "unknown";
    reason?: string;
  };
}

export interface PnpmResolveOptions {
  config?: DepsConfig;
  /** resolved node executable (corepack shims live next to node/npm). */
  nodePath?: string;
}

/* ------------------------------------------------------------------ *
 * Small process / fs helpers
 * ------------------------------------------------------------------ */

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutable(file: string): boolean {
  if (!isFile(file)) return false;
  if (process.platform === "win32") return true;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** cmd.exe argument quoting for `cmd /c <line>` invocations (npm shims). */
function quoteCmdArg(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Expand `~`, `%VAR%` and `$VAR` in a configured path. */
function expandUser(input: string): string {
  let expanded = input.trim();
  if (expanded === "~") return homedir();
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) return join(homedir(), expanded.slice(2));
  expanded = expanded.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
  expanded = expanded.replace(/\$\{([^}]+)\}/g, (whole, name: string) => process.env[name] ?? whole);
  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) => process.env[name] ?? whole);
  return expanded;
}

interface VscodeConfigApi {
  workspace: {
    getConfiguration(section?: string): {
      get<T>(key: string, defaultValue?: T): T;
    };
  };
}

/**
 * VS Code settings, read lazily through `require("vscode")` so this module
 * still imports cleanly from scratch/ probes outside the extension host.
 * Callers inside the extension pass their config explicitly (launcher.ts).
 */
function readDepsConfigFromHost(): DepsConfig {
  try {
    const vscode = require("vscode") as VscodeConfigApi;
    const config = vscode.workspace.getConfiguration("dshVsc");
    return {
      nodePath: config.get<string>("nodePath", ""),
      dshScriptPath: config.get<string>("dshScriptPath", ""),
      pnpmPath: config.get<string>("pnpmPath", ""),
    };
  } catch {
    return {};
  }
}

/** Parse `v24.22.1` / `24.9.0-rc.1` into comparable numbers. */
export function parseVersion(raw: string | undefined): [number, number, number] | null {
  if (!raw) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Semver-ish `version >= min` for plain x.y.z versions. */
export function versionAtLeast(version: string | undefined, min: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

interface RunResult {
  ok: boolean;
  /** merged stdout+stderr (a TTY-less capture: both streams go to one file). */
  stdout: string;
  /** always empty; kept for call-site symmetry (merged into stdout). */
  stderr: string;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Counter so concurrent captures never share a temp file. */
let captureSeq = 0;

/**
 * Run a file (no shell) and capture its stdout+stderr. Never throws.
 *
 * Output is captured through a regular FILE descriptor handed to the child
 * (`stdio: ["ignore", fd, fd]`) instead of pipes: pipe-based stdio needs the
 * host process to be allowed to create anonymous pipes, which restricted hosts
 * (the DSH Windows agent sandbox is one real example) can deny with EPERM —
 * and huge npm output can also hit pipe-buffer limits. A file redirect works
 * on Windows and POSIX alike and keeps this module testable inside restricted
 * environments.
 *
 * Exported because launcher.ts needs the same capture for taskkill / CIM / ps.
 */
export async function runCaptured(
  file: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const logPath = join(tmpdir(), `dsh-vsc-capture-${process.pid}-${Date.now()}-${captureSeq++}.log`);
  let fd: number;
  try {
    fd = openSync(logPath, "w");
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", error: `无法创建临时捕获文件：${errorMessage(error)}` };
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: Omit<RunResult, "stdout" | "stderr">): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      let output = "";
      try {
        output = readFileSync(logPath, "utf8");
      } catch {
        /* unreadable capture — report no output */
      }
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      try {
        rmSync(logPath, { force: true });
      } catch {
        /* temp cleanup is best-effort (a killed child may still hold the file) */
      }
      resolvePromise({ ...result, stdout: output, stderr: "" });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        stdio: ["ignore", fd, fd],
        windowsHide: process.platform === "win32",
        ...(options.env ? { env: options.env } : {}),
      });
    } catch (error) {
      finish({ ok: false, error: `无法启动进程：${errorMessage(error)}` });
      return;
    }
    child.on("error", (error) => {
      finish({ ok: false, error: error.message });
    });
    child.on("exit", (code) => {
      finish(
        code === 0
          ? { ok: true }
          : { ok: false, error: `命令以退出码 ${code === null ? "?" : String(code)} 结束` }
      );
    });
    timer = setTimeout(() => {
      // Kill the whole tree on timeout: npm.cmd runs under cmd.exe on Windows,
      // so killing only the direct child can leak the real npm process.
      if (process.platform === "win32" && child.pid !== undefined) {
        try {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.on("error", () => undefined);
        } catch {
          /* fall through to child.kill */
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: `命令超时（${timeoutMs}ms）` });
    }, timeoutMs);
  });
}

/** Run a file directly (no shell) and capture output. Thin wrapper for call sites. */
function runOut(
  file: string,
  args: string[],
  timeoutMs = 10_000,
  env?: NodeJS.ProcessEnv
): Promise<RunResult> {
  return runCaptured(file, args, { timeoutMs, ...(env ? { env } : {}) });
}

/**
 * Invocation for a command that may be a Windows `.cmd`/`.bat` shim
 * (CreateProcess cannot launch those directly). Only a best-effort fallback:
 * cmd.exe mangles quoted paths, so shims are preferably resolved to their JS
 * entry and run with the resolved node instead (see shimTargetJs).
 */
function commandInvocation(command: string, args: string[]): { file: string; argv: string[] } {
  const isCmdShim =
    process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command) === true;
  if (!isCmdShim) return { file: command, argv: args };
  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  return {
    file: comspec,
    argv: ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")],
  };
}

/**
 * Windows npm shims (.cmd/.bat/.ps1) launch a JS entry; extract it so the shim
 * never has to go through cmd.exe (whose argument quoting breaks paths that
 * contain spaces — e.g. `%LOCALAPPDATA%\Programs\...` or extension storage).
 * `keyword` narrows the match (e.g. "pnpm" so a corepack shim is not mistaken
 * for the pnpm CLI).
 */
function shimTargetJs(shim: string, keyword: string): string | undefined {
  let content = "";
  try {
    content = readFileSync(shim, "utf8");
  } catch {
    return undefined;
  }
  // Resolve the shim's own-directory markers in place, then pick the JS token.
  const normalized = content.replace(/%dp0%|%~dp0%/gi, dirname(shim).replace(/\\/g, "/"));
  const re = new RegExp(`[^\\s"';]*${keyword}[^\\s"';]*?\\.(?:cjs|js)`, "iu");
  const match = re.exec(normalized);
  if (!match) return undefined;
  let candidate = match[0].replace(/\\/g, "/");
  if (!isAbsolute(candidate)) candidate = resolve(dirname(shim), candidate);
  return isFile(candidate) ? candidate : undefined;
}

/** `--version` of a node binary (`v24.22.1` -> `24.22.1`). */
async function readRuntimeVersion(executable: string): Promise<string | undefined> {
  const result = await runOut(executable, ["--version"], 8_000);
  if (!result.ok) return undefined;
  const match = /(\d+\.\d+\.\d+)/.exec(`${result.stdout} ${result.stderr}`);
  return match ? match[1] : undefined;
}

/** Extract a semver from CLI output (`10.34.9`, `v24.22.1`, `10.0.0-rc.1`). */
function versionFromOutput(output: string): string | undefined {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output);
  return match ? match[1] : undefined;
}

/** `--version` of an arbitrary CLI (pnpm), Windows shims handled. */
async function readCliVersion(command: string, nodePath?: string): Promise<string | undefined> {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    // Prefer `node <cli.js> --version`: cmd.exe cannot take quoted shim paths
    // reliably (spaces in %LOCALAPPDATA% / extension storage).
    const keyword = /pnpm/i.test(command) ? "pnpm" : /npm/i.test(command) ? "npm-cli" : "corepack";
    const js = shimTargetJs(command, keyword);
    if (js && nodePath) {
      const viaNode = await runCaptured(nodePath, [js, "--version"], { timeoutMs: 15_000 });
      if (viaNode.ok) return versionFromOutput(viaNode.stdout);
    }
    const invocation = commandInvocation(command, ["--version"]);
    const result = await runOut(invocation.file, invocation.argv, 15_000);
    return result.ok ? versionFromOutput(result.stdout) : undefined;
  }
  const result = await runOut(command, ["--version"], 15_000);
  return result.ok ? versionFromOutput(result.stdout) : undefined;
}

/* ------------------------------------------------------------------ *
 * PATH / where / which lookups
 * ------------------------------------------------------------------ */

/** PATH entries (Windows entries may be quoted; empty entries ignored). */
function pathDirectories(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  return raw
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0);
}

/**
 * Scan PATH for executable files (what `where`/`which` do, without spawning a
 * subprocess — same result, works on every platform).
 */
function pathLookup(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const directory of pathDirectories()) {
    for (const name of names) {
      const candidate = join(directory, name);
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      if (!isExecutable(candidate)) continue;
      seen.add(key);
      out.push(candidate);
    }
  }
  return out;
}

/** Last-resort fallback when a direct PATH scan finds nothing: the platform CLI. */
async function whichLookup(names: string[]): Promise<string[]> {
  const tool = process.platform === "win32" ? "where.exe" : "which";
  const result = await runOut(tool, names, 8_000);
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/* ------------------------------------------------------------------ *
 * Node.js resolution
 * ------------------------------------------------------------------ */

function nodeExecutableNames(): string[] {
  return process.platform === "win32" ? ["node.exe"] : ["node"];
}

/** Known Node.js install locations (PATH is tried first). */
function commonNodePaths(): string[] {
  const env = process.env;
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const out: string[] = [];
  const push = (file: string | undefined): void => {
    if (file) out.push(file);
  };
  if (process.platform === "win32") {
    if (env.ProgramFiles) push(join(env.ProgramFiles, "nodejs", exe));
    if (env.ProgramW6432) push(join(env.ProgramW6432, "nodejs", exe));
    if (env["ProgramFiles(x86)"]) push(join(env["ProgramFiles(x86)"], "nodejs", exe));
    if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, "Programs", "nodejs", exe));
    if (env.NVM_SYMLINK) push(join(env.NVM_SYMLINK, exe));
    if (env.NVM_HOME) push(join(env.NVM_HOME, "current", exe));
    if (env.NVM_BIN) push(join(env.NVM_BIN, exe));
    if (env.APPDATA) push(join(env.APPDATA, "nvm", "current", exe));
  } else {
    for (const directory of ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/opt/local/bin"]) {
      push(join(directory, exe));
    }
    if (env.NVM_BIN) push(join(env.NVM_BIN, exe));
    if (env.VOLTA_HOME) push(join(env.VOLTA_HOME, "bin", exe));
    push(join(homedir(), ".nvm", "current", "bin", exe));
    push(join(homedir(), ".volta", "bin", exe));
    push(join(homedir(), ".local", "bin", exe));
  }
  return out;
}

async function nodeCandidate(executable: string, source: NodeSource): Promise<NodeResolution | null> {
  if (!isExecutable(executable)) return null;
  const version = await readRuntimeVersion(executable);
  if (!version) {
    return {
      found: true,
      path: executable,
      ok: false,
      source,
      reason: `${executable} 存在但无法运行（node --version 失败）`,
    };
  }
  const ok = versionAtLeast(version, MIN_NODE_VERSION);
  return {
    found: true,
    path: executable,
    version,
    ok,
    source,
    reason: ok ? `v${version}` : `v${version} 低于 dsh 要求的 v${MIN_NODE_VERSION}`,
  };
}

/**
 * Resolve the Node.js runtime: config override -> PATH (`where`/`which`) ->
 * common install locations -> VS Code's own Electron runtime (only when its
 * embedded Node is >= 24.9.0, with ELECTRON_RUN_AS_NODE applied by
 * buildHarnessEnv).
 */
export async function resolveNode(config: DepsConfig = {}): Promise<NodeResolution> {
  const override = config.nodePath?.trim();
  if (override) {
    const candidate = expandUser(override);
    const fromConfig = await nodeCandidate(candidate, "config");
    if (fromConfig) return fromConfig;
    return {
      found: false,
      ok: false,
      source: "config",
      reason: `设置 dshVsc.nodePath 指向的 Node.js 不存在或不可执行：${candidate}（清空该设置可恢复自动探测）`,
    };
  }

  const candidates: Array<{ path: string; source: NodeSource }> = [];
  const seen = new Set<string>();
  const add = (file: string | undefined, source: NodeSource): void => {
    if (!file) return;
    const key = file.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: file, source });
  };
  for (const hit of pathLookup(nodeExecutableNames())) add(hit, "path");
  if (candidates.length === 0) {
    for (const hit of await whichLookup(nodeExecutableNames())) add(hit, "path");
  }
  for (const hit of commonNodePaths()) add(hit, "common");

  // Keep the first found-but-too-old hit so the caller can explain "installed
  // but too old" instead of just "missing".
  let firstFound: NodeResolution | null = null;
  for (const candidate of candidates) {
    const resolved = await nodeCandidate(candidate.path, candidate.source);
    if (!resolved) continue;
    if (!resolved.ok) {
      if (!firstFound) firstFound = resolved;
      continue;
    }
    return resolved;
  }
  if (firstFound) return firstFound;

  // Last resort: the extension host is Electron, so process.execPath is not
  // plain node — but with ELECTRON_RUN_AS_NODE=1 it runs the embedded Node.js.
  // Only offered when that embedded runtime satisfies dsh's engines range.
  const embeddedVersion = process.versions.node;
  if (versionAtLeast(embeddedVersion, MIN_NODE_VERSION) && isFile(process.execPath)) {
    return {
      found: true,
      path: process.execPath,
      version: embeddedVersion,
      ok: true,
      source: "vscode",
      reason: `v${embeddedVersion}（VS Code 内置 Node，以 ELECTRON_RUN_AS_NODE 运行）`,
    };
  }
  return {
    found: false,
    ok: false,
    source: "none",
    reason: `未在 PATH、常见安装位置或 VS Code 运行时中找到 Node.js（需要 >= ${MIN_NODE_VERSION}）`,
  };
}

/* ------------------------------------------------------------------ *
 * @deepseek-ai/dsh entry script resolution
 * ------------------------------------------------------------------ */

function dshBinSegments(): string[] {
  return ["lib", "bin.js"];
}

function dshScriptsFromPrefix(prefix: string): string[] {
  const out: string[] = [];
  const segments = ["node_modules", "@deepseek-ai", "dsh", ...dshBinSegments()];
  if (process.platform === "win32") {
    out.push(join(prefix, ...segments));
  } else {
    // POSIX npm globals: <prefix>/lib/node_modules (also accept a prefix that
    // already IS the global node_modules parent, e.g. ~/.npm-global).
    out.push(join(prefix, "lib", ...segments));
    out.push(join(prefix, ...segments));
  }
  return out.filter(isFile);
}

/**
 * Extract the `.../@deepseek-ai/dsh/lib/bin.js` path an npm shim launches.
 * Handles the Windows `.cmd` (`%dp0%\node_modules\...`), the POSIX shell
 * wrapper (`$basedir/../lib/node_modules/...`) and PowerShell shims.
 */
function dshScriptsFromShim(shim: string): string[] {
  const out: string[] = [];
  const shimDir = dirname(shim);
  // Normal POSIX npm install: <prefix>/bin/dsh is a symlink to the real entry.
  if (process.platform !== "win32") {
    try {
      const real = realpathSync(shim);
      if (real !== shim && isFile(real)) out.push(real);
    } catch {
      /* not a symlink / broken link — parse the shim text below */
    }
  }
  let content = "";
  try {
    content = readFileSync(shim, "utf8");
  } catch {
    return out;
  }
  const normalized = content
    .replace(/%dp0%|%~dp0%/gi, "__SHIM_DIR__")
    .replace(/\$\{?basedir(?:_win)?\}?/gi, "__SHIM_DIR__")
    .replace(/\$PSScriptRoot/gi, "__SHIM_DIR__");
  const scriptPath = /[^\s"'`;]*@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPath.exec(normalized)) !== null) {
    let token = match[0].replace(/\\/g, "/");
    if (token.includes("__SHIM_DIR__")) {
      token = token.replace("__SHIM_DIR__", shimDir.replace(/\\/g, "/"));
      if (isFile(token)) out.push(token);
      continue;
    }
    if (isAbsolute(token)) {
      if (isFile(token)) out.push(token);
      continue;
    }
    const cleaned = token.replace(/^(?:\.\/)+/, "");
    for (const candidate of [resolve(shimDir, token), resolve(shimDir, cleaned), resolve(shimDir, "..", cleaned)]) {
      if (isFile(candidate)) out.push(candidate);
    }
  }
  return [...new Set(out)];
}

/** Well-known global npm prefixes when `npm prefix -g` cannot run. */
function commonGlobalPrefixes(): string[] {
  const env = process.env;
  const out: string[] = [];
  if (process.platform === "win32") {
    if (env.APPDATA) out.push(join(env.APPDATA, "npm"));
    if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, "npm"));
    if (env.ProgramFiles) out.push(join(env.ProgramFiles, "nodejs"));
    if (env.ProgramW6432) out.push(join(env.ProgramW6432, "nodejs"));
    if (env["ProgramFiles(x86)"]) out.push(join(env["ProgramFiles(x86)"], "nodejs"));
  } else {
    out.push("/usr/local", "/usr", "/opt/homebrew", "/opt/local");
    out.push(join(homedir(), ".npm-global"), join(homedir(), ".local"));
  }
  return out;
}

/** `npm prefix -g` (the only part of npm resolution that needs a process). */
export async function npmGlobalPrefix(): Promise<string | undefined> {
  const result =
    process.platform === "win32"
      ? await runCaptured(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm prefix -g"], {
          timeoutMs: 20_000,
        })
      : await runCaptured("npm", ["prefix", "-g"], { timeoutMs: 20_000 });
  if (!result.ok) return undefined;
  const first = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^npm\b/i.test(line) && !/\bwarn\b/i.test(line))[0];
  return first || undefined;
}

async function dshCandidate(script: string, source: DshSource): Promise<DshResolution | null> {
  if (!isFile(script)) return null;
  const packageRoot = dirname(dirname(script));
  let version: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof parsed.version === "string") version = parsed.version;
  } catch {
    /* version is display copy only — the entry script is what matters */
  }
  return {
    found: true,
    path: script,
    packageRoot,
    version,
    ok: true,
    source,
    reason: version ? `v${version}` : "版本未知",
  };
}

/**
 * Resolve the real dsh CLI entry (`lib/bin.js`): config override -> `dsh` on
 * PATH (npm shim parsed, never executed) -> `npm prefix -g` layout -> a few
 * common global prefixes.
 */
export async function resolveDsh(config: DepsConfig = {}): Promise<DshResolution> {
  const override = config.dshScriptPath?.trim();
  if (override) {
    const candidate = expandUser(override);
    const fromConfig = await dshCandidate(candidate, "config");
    if (fromConfig) return fromConfig;
    return {
      found: false,
      ok: false,
      source: "config",
      reason: `设置 dshVsc.dshScriptPath 指向的 lib/bin.js 不存在：${candidate}（清空该设置可恢复自动探测）`,
    };
  }

  // 1) `dsh` on PATH: Windows npm writes dsh.cmd / dsh.ps1; POSIX npm writes a
  //    symlink into <prefix>/bin. Both are parsed back to the real entry.
  const shimNames = process.platform === "win32" ? ["dsh.cmd", "dsh.ps1", "dsh.exe"] : ["dsh"];
  for (const shim of pathLookup(shimNames)) {
    for (const script of dshScriptsFromShim(shim)) {
      const resolved = await dshCandidate(script, "path");
      if (resolved) return resolved;
    }
  }
  for (const shim of await whichLookup(shimNames)) {
    for (const script of dshScriptsFromShim(shim)) {
      const resolved = await dshCandidate(script, "path");
      if (resolved) return resolved;
    }
  }

  // 2) `npm prefix -g` -> node_modules/@deepseek-ai/dsh/lib/bin.js
  const prefix = await npmGlobalPrefix();
  if (prefix) {
    for (const script of dshScriptsFromPrefix(prefix)) {
      const resolved = await dshCandidate(script, "npm-prefix");
      if (resolved) return resolved;
    }
  }

  // 3) Well-known global prefixes (npm prefix -g unavailable: no npm on PATH,
  //    exotic shell, etc.).
  for (const base of commonGlobalPrefixes()) {
    for (const script of dshScriptsFromPrefix(base)) {
      const resolved = await dshCandidate(script, "common-prefix");
      if (resolved) return resolved;
    }
  }

  return {
    found: false,
    ok: false,
    source: "none",
    reason: `未找到 ${DSH_PACKAGE_NAME} 的 lib/bin.js（PATH 上的 dsh、npm 全局安装目录均未命中）`,
  };
}

/* ------------------------------------------------------------------ *
 * pnpm resolution (detect-only: pnpm is user-installed)
 * ------------------------------------------------------------------ */

function pnpmExecutableNames(): string[] {
  return process.platform === "win32" ? ["pnpm.cmd", "pnpm.exe", "pnpm.bat", "pnpm"] : ["pnpm"];
}

async function pnpmCandidate(
  command: string,
  source: PnpmSource,
  nodePath?: string
): Promise<PnpmResolution | null> {
  if (!isExecutable(command)) return null;
  const version = await readCliVersion(command, nodePath);
  // An unreadable version is not proof of an old copy: keep it usable and let
  // the plugin operation itself report any real problem.
  const ok = version === undefined || versionAtLeast(version, MIN_PNPM_VERSION);
  return {
    found: true,
    command,
    binDir: dirname(command),
    version,
    ok,
    source,
    reason: version
      ? ok
        ? `v${version}`
        : `v${version} 过旧：DSH 插件管理需要 pnpm ${MIN_PNPM_VERSION} 及以上（pnpm 9/10 的 view 会转调 npm 并失败）`
      : "版本未知",
  };
}

async function firstPnpm(
  candidates: string[],
  source: PnpmSource,
  nodePath?: string
): Promise<PnpmResolution | null> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const resolved = await pnpmCandidate(candidate, source, nodePath);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Resolve a pnpm CLI: config override -> PATH (`where`/`which`) -> PNPM_HOME ->
 * corepack shims (next to node) -> npm global bin.
 *
 * pnpm is an external prerequisite the user installs themselves
 * (`npm i -g pnpm@11`), like Node.js and DSH: this resolver only detects it and
 * reports an honest reason — it never downloads or installs anything. A copy
 * satisfying {@link MIN_PNPM_VERSION} is preferred; when only an outdated one
 * exists it is returned with `ok:false` so callers can tell the user to upgrade
 * to pnpm 11+ instead of hiding the problem.
 */
export async function resolvePnpm(options: PnpmResolveOptions = {}): Promise<PnpmResolution> {
  const config = options.config ?? {};
  const override = config.pnpmPath?.trim();
  if (override) {
    const candidate = expandUser(override);
    const fromConfig = await pnpmCandidate(candidate, "config");
    if (fromConfig) return fromConfig;
    return {
      found: false,
      ok: false,
      source: "config",
      reason: `设置 dshVsc.pnpmPath 指向的 pnpm 不存在或不可执行：${candidate}（清空该设置可恢复自动探测）`,
    };
  }

  /** First suitable resolution wins; an outdated one is remembered as fallback. */
  let outdated: PnpmResolution | null = null;
  const accept = (candidate: PnpmResolution | null): PnpmResolution | null => {
    if (!candidate) return null;
    if (candidate.ok) return candidate;
    outdated = outdated ?? candidate;
    return null;
  };

  // 1) PATH (`where pnpm.cmd` / `where pnpm` on Windows, `which pnpm` on POSIX).
  const pathHits = pathLookup(pnpmExecutableNames());
  const whereHits = pathHits.length > 0 ? [] : await whichLookup(pnpmExecutableNames());
  const fromPath = accept(await firstPnpm([...pathHits, ...whereHits], "path", options.nodePath));
  if (fromPath) return fromPath;

  // 2) PNPM_HOME (standalone/pnpm installer and some corepack setups).
  const pnpmHome = process.env.PNPM_HOME?.trim();
  if (pnpmHome) {
    const fromHome = accept(
      await firstPnpm(
        pnpmExecutableNames().map((name) => join(pnpmHome, name)),
        "pnpm-home",
        options.nodePath
      )
    );
    if (fromHome) return fromHome;
  }

  // 3) corepack shims: `corepack enable` writes pnpm next to node/npm.
  const shimDirs = new Set<string>();
  if (options.nodePath) shimDirs.add(dirname(options.nodePath));
  for (const nodeFile of commonNodePaths()) shimDirs.add(dirname(nodeFile));
  for (const directory of shimDirs) {
    const fromShim = accept(
      await firstPnpm(
        pnpmExecutableNames().map((name) => join(directory, name)),
        "corepack",
        options.nodePath
      )
    );
    if (fromShim) return fromShim;
  }

  // 4) npm global bin (`npm i -g pnpm` / `corepack enable`): on Windows the
  //    npm prefix IS the bin dir; on POSIX it is <prefix>/bin.
  const prefix = await npmGlobalPrefix();
  if (prefix) {
    const fromPrefix = accept(
      await firstPnpm(
        pnpmExecutableNames().map((name) =>
          process.platform === "win32" ? join(prefix, name) : join(prefix, "bin", name)
        ),
        "npm-prefix",
        options.nodePath
      )
    );
    if (fromPrefix) return fromPrefix;
  }

  if (outdated) return outdated;
  return {
    found: false,
    ok: false,
    source: "none",
    reason:
      "未找到 pnpm（DSH 插件管理与伴生插件安装需要 pnpm 11+）：请自行执行 npm i -g pnpm@11，" +
      "或用 dshVsc.pnpmPath 指定已有的可执行文件",
  };
}
/* ------------------------------------------------------------------ *
 * Spawn environment + diagnostics
 * ------------------------------------------------------------------ */

/**
 * Environment for the spawned harness: PATH gets the pnpm bin dir and the node
 * dir first (the plugin manager resolves `pnpm` from PATH), everything else is
 * inherited untouched. GITHUB_TOKEN is NOT required or synthesized — it is only
 * interesting when the user's own environment already exports it.
 *
 * `dsh` is accepted for symmetry with the other resolvers (future env needs);
 * the harness itself only requires node + pnpm on PATH today.
 */
export function buildHarnessEnv(
  baseEnv: NodeJS.ProcessEnv,
  node: NodeResolution,
  dsh: DshResolution | null,
  pnpm: PnpmResolution | null
): NodeJS.ProcessEnv {
  void dsh;
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  // Windows env names are case-insensitive but object keys are not: reuse the
  // existing PATH key instead of adding a second, differently-cased one.
  const pathKey =
    Object.keys(env).find((key) => key.toUpperCase() === "PATH") ??
    (process.platform === "win32" ? "Path" : "PATH");
  const parts: string[] = [];
  if (pnpm?.found && pnpm.binDir) parts.push(pnpm.binDir);
  if (node.found && node.path) parts.push(dirname(node.path));
  const current = env[pathKey];
  if (current) parts.push(current);
  env[pathKey] = parts.join(delimiter);
  if (node.source === "vscode") env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

/** Resolve all three dependencies (node first: pnpm's corepack lookup uses it). */
export async function resolveDeps(config: DepsConfig = {}): Promise<DepsResolutions> {
  const node = await resolveNode(config);
  const [dsh, pnpm] = await Promise.all([
    resolveDsh(config),
    resolvePnpm({ config, ...(node.path ? { nodePath: node.path } : {}) }),
  ]);
  return { node, dsh, pnpm };
}

/** Can a harness be spawned with these dependencies at all? */
export function missingHarnessDeps(deps: DepsResolutions): boolean {
  return !deps.node.ok || !deps.dsh.ok;
}

/** One line per dependency for the OutputChannel. */
export function depsSummaryLines(deps: DepsResolutions): string[] {
  return [describeNode(deps.node), describeDsh(deps.dsh), describePnpm(deps.pnpm)];
}

export function describeNode(node: NodeResolution): string {
  if (node.found && node.ok) return `Node.js v${node.version ?? "?"}（${node.path}）`;
  if (node.found) return `Node.js ${node.version ?? "?"}（${node.path}）— 不满足 dsh 要求（>= ${MIN_NODE_VERSION}）`;
  return `Node.js 未找到 — ${node.reason}`;
}

export function describeDsh(dsh: DshResolution): string {
  if (dsh.found) return `${DSH_PACKAGE_NAME} ${dsh.version ? `v${dsh.version}` : ""}（${dsh.path}）`.replace("  ", " ");
  return `${DSH_PACKAGE_NAME} 未找到 — ${dsh.reason}`;
}

export function describePnpm(pnpm: PnpmResolution): string {
  if (pnpm.found && pnpm.ok) {
    return `pnpm${pnpm.version ? ` v${pnpm.version}` : ""}（${pnpm.command}）`;
  }
  if (pnpm.found) {
    return `pnpm${pnpm.version ? ` v${pnpm.version}` : ""}（${pnpm.command}）— 版本过旧：DSH 插件管理需要 pnpm ${MIN_PNPM_VERSION} 及以上`;
  }
  return `pnpm 未找到（插件安装需要）— ${pnpm.reason}`;
}

/**
 * Actionable Chinese guidance for a machine that cannot auto-start DSH. Kept
 * here (not in extension.ts) so the launcher and the extension surface exactly
 * the same text.
 */
export function depsActionableMessage(deps: DepsResolutions): string {
  const lines = ["DSH Bridge 无法自动启动 DSH 服务：缺少可用的运行依赖。"];
  for (const line of depsSummaryLines(deps)) lines.push(`  · ${line}`);
  if (!deps.node.ok) {
    lines.push(
      `  → 安装 Node.js >= ${MIN_NODE_VERSION}：https://nodejs.org/ （或使用 nvm/fnm 安装），` +
        "也可在 VS Code 设置 dshVsc.nodePath 指向已有的 node 可执行文件"
    );
  }
  if (!deps.dsh.ok) {
    lines.push(
      `  → 安装 DSH 命令行：npm i -g ${DSH_PACKAGE_NAME}（Node.js 就绪后执行），` +
        "或设置 dshVsc.dshScriptPath 指向 <npm 全局前缀>/node_modules/@deepseek-ai/dsh/lib/bin.js"
    );
  }
  if ((!deps.pnpm.found || !deps.pnpm.ok) && deps.node.ok && deps.dsh.ok) {
    lines.push(
      `  → pnpm ${deps.pnpm.found ? "版本过旧（需要 11+）" : "未找到"}：插件与伴生插件的安装需要它，请自行执行 npm i -g pnpm@11（或设置 dshVsc.pnpmPath）；` +
        "没有 pnpm 时 DSH 服务仍可启动，只是插件安装不可用"
    );
  }
  lines.push("安装完成后执行命令 “DSH: Start Web Harness”（dsh.start）重试；也可以手动运行 dsh web，扩展会自动复用。");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Flat dependency status for UI consumers (settings-page doctor card)
 * ------------------------------------------------------------------ */

let depStatusCache: { status: DepStatus; at: number } | null = null;
/** diagnoseDeps() caches for a few seconds so a settings render loop does not
 *  re-spawn `npm prefix -g`; config changes invalidate it. */
const DIAGNOSE_CACHE_MS = 5_000;

/** Drop the cached DepStatus (call after changing config). */
export function invalidateDepsCache(): void {
  depStatusCache = null;
}

const PNPM_STATUS_SOURCE: Record<PnpmSource, NonNullable<DepStatus["pnpm"]["source"]>> = {
  config: "config",
  path: "path",
  "pnpm-home": "pnpm-home",
  corepack: "corepack",
  "npm-prefix": "npm-global",
  none: "unknown",
};

/** Map the rich resolutions onto the flat, serializable UI shape. */
export function toDepStatus(deps: DepsResolutions): DepStatus {
  return {
    ok: !missingHarnessDeps(deps),
    node: {
      found: deps.node.found,
      ok: deps.node.ok,
      ...(deps.node.path ? { path: deps.node.path } : {}),
      ...(deps.node.version ? { version: deps.node.version } : {}),
      reason: deps.node.reason,
    },
    dsh: {
      found: deps.dsh.found,
      ok: deps.dsh.ok,
      ...(deps.dsh.path ? { path: deps.dsh.path } : {}),
      ...(deps.dsh.version ? { version: deps.dsh.version } : {}),
      reason: deps.dsh.reason,
    },
    pnpm: {
      found: deps.pnpm.found,
      ok: deps.pnpm.found && deps.pnpm.ok,
      ...(deps.pnpm.command ? { path: deps.pnpm.command } : {}),
      ...(deps.pnpm.binDir ? { binDir: deps.pnpm.binDir } : {}),
      source: PNPM_STATUS_SOURCE[deps.pnpm.source],
      reason: deps.pnpm.reason,
    },
  };
}

/**
 * Stable, never-throws dependency status for the settings page "运行环境"
 * doctor card: runs resolveNode/resolveDsh/resolvePnpm (cached ~5s), honours
 * the dshVsc.* overrides (read from VS Code when `config` is omitted) and the
 * DSH_VSC_TOOLS_DIR test override. Call invalidateDepsCache() (or pass
 * force=true) after ensuring pnpm so the card reflects the new state.
 */
export async function diagnoseDeps(config?: DepsConfig, force = false): Promise<DepStatus> {
  const now = Date.now();
  if (!force && depStatusCache && now - depStatusCache.at < DIAGNOSE_CACHE_MS) {
    return depStatusCache.status;
  }
  try {
    const deps = await resolveDeps(config ?? readDepsConfigFromHost());
    const status = toDepStatus(deps);
    depStatusCache = { status, at: Date.now() };
    return status;
  } catch (error) {
    // The resolvers are defensive already; this is the contract's "never throws".
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      node: { found: false, ok: false, reason: `依赖探测失败：${message}` },
      dsh: { found: false, ok: false, reason: "依赖探测失败" },
      pnpm: { found: false, ok: false, source: "unknown", reason: "依赖探测失败" },
    };
  }
}
