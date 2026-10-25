import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localDshPackageJson } from "./launcher";
import { classifyNpmFailure } from "./npmFailure";
import { uninstallableReason } from "./installability";

/**
 * DSH update check + installer. The harness runs from the user's GLOBAL npm
 * install of `@deepseek-ai/dsh` (see launcher.resolveDshScript), so "update
 * DSH" means `npm install -g @deepseek-ai/dsh@latest` — the same thing the
 * user would do by hand. This module only measures and mutates that install;
 * whether the extension can still TALK to the new version is verified
 * afterwards by the caller (extension.ts) and rolled back on failure.
 */

/** The npm package the harness is launched from. */
export const DSH_PACKAGE = "@deepseek-ai/dsh";

const REGISTRY_DOC_URL = `https://registry.npmjs.org/${DSH_PACKAGE}`;
/** Metadata fallback: many China users pin this mirror in .npmrc; our probe
 *  must not fail just because npmjs is unreachable from their network. */
const REGISTRY_MIRROR_DOC_URL = `https://registry.npmmirror.com/${DSH_PACKAGE}`;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

export { compareVersions, pickLatestVersion, type DshUpdateChannel } from "./updateChannel";

import { compareVersions, pickLatestVersion, type DshUpdateChannel } from "./updateChannel";

export interface UpdateInfo {
  installed?: string;
  latest?: string;
  /** Human-readable channel description ("auto (prerelease)" etc.). */
  channel?: string;
  /** "error" checks carry a detail message for surfaces that show it. */
  kind?: "update" | "uptodate" | "error";
  detail?: string;
}

export interface InstallResult {
  ok: boolean;
  error?: string;
}

/** Version of the globally installed dsh (the install the launcher spawns). */
export async function installedDshVersion(): Promise<string | undefined> {
  const pkgPath = await localDshPackageJson();
  if (!pkgPath) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** Newest versions above the installed one, highest first. */
function candidateVersions(versions: string[], installed: string, channel: DshUpdateChannel): string[] {
  const above = versions.filter((v) => compareVersions(v, installed) > 0);
  if (channel === "stable") return above.filter((v) => !v.includes("-")).sort((a, b) => compareVersions(b, a));
  return above.sort((a, b) => compareVersions(b, a));
}


/**
 * Fetch the package document (dist-tags + versions) from npmjs, falling back
 * to the npmmirror mirror. Never throws; the caller turns a failure into a
 * user-visible check result.
 */
async function fetchPackument(
  log: (message: string) => void
): Promise<{ tags: Record<string, string | undefined>; versions: string[] } | { error: string }> {
  const urls = [REGISTRY_DOC_URL, REGISTRY_MIRROR_DOC_URL];
  let last = "registry unreachable";
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await fetch(urls[i], {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        last = `npm registry HTTP ${res.status}`;
        if (i < urls.length - 1) {
          log(`update check: ${urls[i]} answered HTTP ${res.status}; trying the mirror`);
          continue;
        }
        return { error: last };
      }
      const body = (await res.json()) as {
        "dist-tags"?: Record<string, string>;
        versions?: Record<string, unknown>;
      };
      return { tags: body["dist-tags"] ?? {}, versions: Object.keys(body.versions ?? {}) };
    } catch (error) {
      last = (error as Error).message;
      if (i < urls.length - 1) log(`update check: ${urls[i]} failed (${last}); trying the mirror`);
    }
  }
  return { error: last };
}

/**
 * Channel-aware update check. Never throws: every failure path is reported as
 * `kind: "error"` (or "uptodate") with the reason in `detail` so the log AND
 * the settings UI can show something meaningful.
 */
export async function checkForUpdateDetailed(
  log: (message: string) => void,
  channel: DshUpdateChannel = "auto"
): Promise<UpdateInfo> {
  const installed = await installedDshVersion();
  if (!installed) {
    log("update check skipped: global dsh install not found");
    return { kind: "error", detail: "未找到全局安装的 dsh（npm i -g @deepseek-ai/dsh）" };
  }
  const packument = await fetchPackument(log);
  if ("error" in packument) {
    log(`update check skipped: ${packument.error}`);
    return { kind: "error", installed, detail: packument.error };
  }
  const tags = packument.tags;
  const versions = packument.versions;
  if (versions.length === 0) {
    log("update check skipped: registry response had no versions");
    return { kind: "error", installed, detail: "registry response had no versions" };
  }
  const { latest, channelLabel } = pickLatestVersion(tags, versions, installed, channel);
  if (!latest) {
    log(`update check skipped: no version on channel ${channelLabel}`);
    return { kind: "error", installed, detail: `通道 ${channelLabel} 没有可用版本` };
  }
  if (compareVersions(latest, installed) <= 0) {
    log(`dsh is up to date (installed ${installed}, ${channelLabel} latest ${latest})`);
    return { installed, latest, channel: channelLabel, kind: "uptodate" };
  }
  const broken = await uninstallableReason(latest);
  if (broken) {
    log(`upstream release ${latest} is incomplete (missing ${broken}); probing older candidates`);
    if (channel === "auto" || channel === "stable") {
      // The tag points at a half-published release. Walk down the same line
      // instead of offering an update npm is guaranteed to reject.
      for (const candidate of candidateVersions(versions, installed, channel).slice(0, 5)) {
        if (candidate === latest) continue;
        if (compareVersions(candidate, installed) <= 0) break;
        if (await uninstallableReason(candidate)) continue;
        log(`dsh update available: ${installed} -> ${candidate} (${channelLabel}; skipped incomplete ${latest})`);
        return {
          installed,
          latest: candidate,
          channel: channelLabel,
          kind: "update",
          detail: `已跳过不完整版本 ${latest}（缺少 ${broken}）`,
        };
      }
      const detail = `上游最新版本 ${latest} 发布不完整（缺少 ${broken}），当前没有更新的可安装版本；通常上游会在数小时内补齐。`;
      log(`update check: ${detail}`);
      return { installed, latest, channel: channelLabel, kind: "uptodate", detail };
    }
    const detail = `上游 ${channelLabel} 版本 ${latest} 发布不完整（缺少 ${broken}），请稍后重试或切换通道。`;
    log(`update check: ${detail}`);
    return { installed, latest, channel: channelLabel, kind: "error", detail };
  }
  log(`dsh update available: ${installed} -> ${latest} (${channelLabel})`);
  return { installed, latest, channel: channelLabel, kind: "update" };
}

/**
 * Ask the npm registry for the newest version on the tracked channel. Returns
 * null when the install cannot be located, the registry is unreachable, or
 * nothing newer exists — a failed check must never bother the user.
 */
export async function checkForUpdate(
  log: (message: string) => void,
  channel: DshUpdateChannel = "auto"
): Promise<UpdateInfo | null> {
  const result = await checkForUpdateDetailed(log, channel);
  return result.kind === "update" ? result : null;
}

/* ---------- npm install core ---------- */

/** Last few meaningful npm error lines (for unknown failures). */
function npmErrorLines(output: string): string {
  const errorLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^npm (error|ERR!)/i.test(line));
  const chosen = (errorLines.length ? errorLines : output.split(/\r?\n/).filter((line) => line.trim()))
    .slice(0, 4)
    .join(" ");
  return chosen.length > 500 ? `${chosen.slice(0, 500)}…` : chosen;
}

interface NpmRun {
  ok: boolean;
  /** Process-level failure (timeout / spawn error). */
  error?: string;
  output: string;
}

/** npm is a .cmd shim on Windows; prefer the well-known absolute path so a
 *  stripped-down PATH (VS Code launched from a shortcut) still works. */
function resolveNpmCommand(): string {
  const appData = process.env.APPDATA;
  if (appData) {
    const candidate = join(appData, "npm", "npm.cmd");
    if (existsSync(candidate)) return candidate;
  }
  return "npm";
}

/** One `npm install -g <spec> [extra]` attempt. */
function runNpmInstall(spec: string, extraArgs: string[], log: (message: string) => void): Promise<NpmRun> {
  const comspec = process.env.ComSpec || "cmd.exe";
  const npmCmd = resolveNpmCommand();
  if (npmCmd !== "npm") log(`npm: using ${npmCmd}`);
  log(`$ npm install -g ${spec}${extraArgs.length ? ` ${extraArgs.join(" ")}` : ""}`);
  return new Promise((resolve) => {
    execFile(
      comspec,
      ["/c", npmCmd, "install", "-g", spec, ...extraArgs],
      { windowsHide: true, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        for (const line of output.length > 0 ? output.split(/\r?\n/).slice(-10) : []) log(`npm: ${line}`);
        if (error) {
          const missing = /not recognized|not found|不是内部或外部命令|无法将/i.test(output);
          resolve({
            ok: false,
            error: missing
              ? `找不到 npm（已尝试 ${npmCmd}）：请确认 Node.js/npm 已安装并在 PATH 中`
              : error.killed
                ? "npm install timed out"
                : error.message,
            output,
          });
          return;
        }
        resolve({ ok: true, output });
      }
    );
  });
}

/**
 * `npm install -g <spec>` for the harness package. `spec` is validated to be
 * exactly the dsh package plus a plain version/latest tag before it reaches
 * the command line. npm is a .cmd shim, so go through cmd.exe (the same route
 * launcher.resolveDshScript already uses for `npm prefix -g`).
 *
 * Prerelease lines occasionally ship with conflicting peers (the translator
 * bundle pins an unversioned sibling) and China's registry mirror lags behind
 * a fresh publish; the first failure is retried once with the flags that fit
 * that state. Peer conflicts take `--force` (NOT `--legacy-peer-deps`: that
 * one also stops npm from installing peers such as dsh-scope/dsh-attachment,
 * which leaves an unrunnable tree). ETARGET takes the official registry.
 */
export async function installDsh(spec: string, log: (message: string) => void): Promise<InstallResult> {
  if (!/^@deepseek-ai\/dsh@(latest|[\w.+-]+)$/.test(spec)) {
    return { ok: false, error: `refusing to install unexpected spec: ${spec}` };
  }
  const first = await runNpmInstall(spec, [], log);
  if (first.ok) return { ok: true };
  const extraArgs: string[] = [];
  if (/ERESOLVE/.test(first.output)) {
    log("npm: peer dependency conflict — retrying with --force (keeps peers installed)");
    extraArgs.push("--force");
  }
  if (/(No matching version|ETARGET)/.test(first.output)) {
    log("npm: the configured registry has not synced this version — retrying with the official npm registry");
    extraArgs.push("--registry", "https://registry.npmjs.org");
  }
  if (extraArgs.length === 0) {
    return {
      ok: false,
      error: classifyNpmFailure(first.output) ?? npmErrorLines(first.output) ?? first.error ?? "npm install failed",
    };
  }
  const second = await runNpmInstall(spec, extraArgs, log);
  if (second.ok) return { ok: true };
  return {
    ok: false,
    error: classifyNpmFailure(second.output) ?? npmErrorLines(second.output) ?? second.error ?? "npm install failed",
  };
}

/** `npm install -g @deepseek-ai/dsh@<version|latest>`. An exact version is
 *  preflighted first: a half-published upstream release is reported by name
 *  before npm spends minutes resolving a tree that cannot exist. */
export async function runDshUpdate(log: (message: string) => void, version?: string): Promise<InstallResult> {
  if (version) {
    const broken = await uninstallableReason(version);
    if (broken) {
      const message = `上游版本 ${version} 发布不完整（缺少 ${broken}），本次更新已取消。`;
      log(`update aborted: ${message}`);
      return { ok: false, error: message };
    }
  }
  const spec = version ? `${DSH_PACKAGE}@${version}` : `${DSH_PACKAGE}@latest`;
  return installDsh(spec, log);
}
