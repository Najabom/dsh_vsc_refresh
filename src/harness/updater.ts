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

const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${DSH_PACKAGE}/latest`;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

export interface UpdateInfo {
  installed: string;
  latest: string;
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

interface ParsedVersion {
  nums: [number, number, number];
  pre: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver-ish compare: negative when a < b, 0 when equal, positive when a > b.
 *  Prereleases sort below their release; numeric prerelease fields sort below
 *  alphanumeric ones (so rc.10 > rc.2, the part npm-style tags get right). */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1; // release > prerelease
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1; // numeric identifiers sort lower than alphanumeric
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Ask the npm registry for the latest published version. Returns null when the
 * install cannot be located, the registry is unreachable, or nothing newer
 * exists — a failed check must never bother the user.
 */
export async function checkForUpdate(log: (message: string) => void): Promise<UpdateInfo | null> {
  const installed = await installedDshVersion();
  if (!installed) {
    log("update check skipped: global dsh install not found");
    return null;
  }
  let latest: string | undefined;
  try {
    const res = await fetch(REGISTRY_LATEST_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      log(`update check skipped: registry answered HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { version?: string };
    if (typeof body.version === "string") latest = body.version;
  } catch (error) {
    log(`update check skipped: ${(error as Error).message}`);
    return null;
  }
  if (!latest) {
    log("update check skipped: registry response had no version");
    return null;
  }
  if (compareVersions(latest, installed) <= 0) {
    log(`dsh is up to date (installed ${installed}, registry latest ${latest})`);
    return null;
  }
  log(`dsh update available: ${installed} -> ${latest}`);
  return { installed, latest };
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

/** `npm install -g @deepseek-ai/dsh@latest`. */
export function runDshUpdate(log: (message: string) => void): Promise<InstallResult> {
  return installDsh(`${DSH_PACKAGE}@latest`, log);
}
