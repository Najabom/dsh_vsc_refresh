import * as vscode from "vscode";
import * as fs from "node:fs";
import { join } from "node:path";
import { HarnessClient } from "./client";
import { localDshPackageJson } from "./launcher";

export interface DiscoveryResult {
  base: string;
  alive: boolean;
  /** The port answers but demands browser-session auth (a stock `dsh web`
   *  that was NOT started through this extension's overlay). */
  unauthorized: boolean;
  version?: string;
  port: number;
}

/**
 * Resolve the harness base URL: user config → DSH_WEB_URL → default.
 * The default is 3080 — the web GUI's harness port. The extension drives an
 * instance it spawned itself (its overlay bypasses the browser-session auth);
 * a stock instance answering 401 is reported as `unauthorized` instead of
 * being silently treated as offline, so the lifecycle loop does not try to
 * spawn a second server onto an occupied port. If nothing answers at the
 * configured URL, the lifecycle loop auto-starts the extension's own instance
 * on that same port (see extension.ts ensureRunning), records it in
 * %TEMP%\dsh-vsc-harness.pid, and stops it on exit.
 */
export function configuredBase(): string {
  const fromConfig = vscode.workspace.getConfiguration("dshVsc").get<string>("url");
  const fromEnv = process.env.DSH_WEB_URL;
  // The browser-session cookie is authority-bound; `localhost` and
  // `127.0.0.1` are DIFFERENT authorities, so normalize the loopback alias to
  // the address native instances actually bind (the default).
  return (fromConfig?.trim() || fromEnv?.trim() || "http://127.0.0.1:3080")
    .replace(/\/+$/, "")
    .replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, "$1127.0.0.1");
}

/** Port implied by a base URL (default 3080). */
export function portOf(base: string): number {
  try {
    const parsed = new URL(base);
    return parsed.port ? Number(parsed.port) : 3080;
  } catch {
    return 3080;
  }
}

/** Probe the configured harness. */
export async function discover(): Promise<DiscoveryResult> {
  const base = configuredBase();
  const port = portOf(base);
  const probe = await new HarnessClient(base).probe();
  const alive = probe === "alive";
  return {
    base,
    alive,
    unauthorized: probe === "unauthorized",
    version: alive ? await localDshVersion() : undefined,
    port,
  };
}

/**
 * Best-effort version of the dsh package the launcher resolves (the same
 * install, wherever the npm prefix actually lives). A running harness has no
 * version-reporting RPC in 0.1.7; this is display copy only.
 */
async function localDshVersion(): Promise<string | undefined> {
  try {
    const pkg =
      (await localDshPackageJson()) ??
      (process.env.APPDATA
        ? join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "package.json")
        : undefined);
    if (!pkg) return undefined;
    const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}
