import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { localDshPackageJson } from "./launcher";

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
  let tags: Record<string, string | undefined> = {};
  let versions: string[] = [];
  try {
    const res = await fetch(REGISTRY_DOC_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      log(`update check skipped: registry answered HTTP ${res.status}`);
      return { kind: "error", installed, detail: `npm registry HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      "dist-tags"?: Record<string, string>;
      versions?: Record<string, unknown>;
    };
    tags = body["dist-tags"] ?? {};
    versions = Object.keys(body.versions ?? {});
  } catch (error) {
    log(`update check skipped: ${(error as Error).message}`);
    return { kind: "error", installed, detail: (error as Error).message };
  }
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

/**
 * `npm install -g <spec>` for the harness package. `spec` is validated to be
 * exactly the dsh package plus a plain version/latest tag before it reaches
 * the command line. npm is a .cmd shim, so go through cmd.exe (the same route
 * launcher.resolveDshScript already uses for `npm prefix -g`).
 */
export function installDsh(spec: string, log: (message: string) => void): Promise<InstallResult> {
  if (!/^@deepseek-ai\/dsh@(latest|[\w.+-]+)$/.test(spec)) {
    return Promise.resolve({ ok: false, error: `refusing to install unexpected spec: ${spec}` });
  }
  const comspec = process.env.ComSpec || "cmd.exe";
  log(`$ npm install -g ${spec}`);
  return new Promise((resolve) => {
    execFile(
      comspec,
      ["/c", "npm", "install", "-g", spec],
      { windowsHide: true, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        const lines = output.length > 0 ? output.split(/\r?\n/) : [];
        for (const line of lines.slice(-10)) log(`npm: ${line}`);
        if (error) {
          resolve({ ok: false, error: error.killed ? "npm install timed out" : error.message });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}

/** `npm install -g @deepseek-ai/dsh@<version|latest>`. */
export function runDshUpdate(log: (message: string) => void, version?: string): Promise<InstallResult> {
  const spec = version ? `${DSH_PACKAGE}@${version}` : `${DSH_PACKAGE}@latest`;
  return installDsh(spec, log);
}
