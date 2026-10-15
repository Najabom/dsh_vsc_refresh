/**
 * Companion-bundle lifecycle for the VSIX-shipped DSH plugin.
 *
 * `companion/dsh-vsc-companion` travels inside the extension package; this
 * module copies it into stable extension storage and installs it into the DSH
 * profile through the OFFICIAL plugin manager (`installBundle` with a `file:`
 * spec) — no manual configuration and no writes outside official entry
 * points. The bundle adds two things the bridge cannot deliver by protocol
 * alone:
 *
 *  - task-checklist stewardship (a dynamic runtime-context section that keeps
 *    the model updating todo lists step by step, and rebuilds them after a
 *    turn reset);
 *  - host-side `page_screenshot` / `page_eval` tools that drive a headless
 *    Edge/Chromium in the harness process, outside the command sandbox.
 *
 * Versions move in lockstep with the extension: a newer bundled copy is
 * re-copied and reinstalled, and the caller restarts the owned harness while
 * it is idle so the new bundle actually loads.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessClient } from "./client";

export const COMPANION_NAME = "dsh-vsc-companion";

export type CompanionState =
  | "unknown"
  | "current"
  | "installed"
  | "updated"
  | "disabled"
  | "missing"
  | "error";

export interface CompanionStatus {
  state: CompanionState;
  bundledVersion?: string;
  installedVersion?: string;
  message?: string;
}

export interface CompanionSyncOptions {
  /** VS Code extension root (the VSIX layout: <extensionPath>/companion/...). */
  extensionPath: string;
  /** Stable per-extension storage (context.globalStorageUri.fsPath). */
  storageDir: string;
  client: HarnessClient;
}

/** Version declared by the bundled copy, or null when the VSIX lacks it. */
export async function bundledCompanionVersion(extensionPath: string): Promise<string | null> {
  try {
    const raw = await readFile(join(extensionPath, "companion", COMPANION_NAME, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Ensure the storage copy matches the VSIX and the profile has it installed at
 * that version. Idempotent: a current install costs one `listBundles` round
 * trip. Throws only when the RPC itself fails (the caller reports that).
 */
export async function syncCompanion(options: CompanionSyncOptions): Promise<CompanionStatus> {
  const bundledVersion = await bundledCompanionVersion(options.extensionPath);
  if (bundledVersion === null) {
    return { state: "missing", message: "VSIX 中未找到 companion/dsh-vsc-companion" };
  }
  const source = join(options.extensionPath, "companion", COMPANION_NAME);
  const target = join(options.storageDir, COMPANION_NAME);
  const marker = join(options.storageDir, "companion-synced.json");
  let syncedVersion: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(marker, "utf8")) as { version?: unknown };
    syncedVersion = typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    syncedVersion = null;
  }
  if (syncedVersion !== bundledVersion || !existsSync(join(target, "package.json"))) {
    await mkdir(options.storageDir, { recursive: true });
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
    await writeFile(marker, JSON.stringify({ version: bundledVersion }), "utf8");
  }

  const before = await options.client.listBundles();
  const existing = before.find((bundle) => bundle.name === COMPANION_NAME);
  if (existing && existing.enabled && existing.installed && existing.version === bundledVersion) {
    return { state: "current", bundledVersion, installedVersion: existing.version };
  }
  if (existing && existing.enabled === false && existing.version === bundledVersion && existing.installed) {
    // User switched the bundle off through the official plugin UI — respect it.
    return { state: "disabled", bundledVersion, installedVersion: existing.version };
  }

  const spec = `file:${target.replace(/\\/g, "/")}`;
  await options.client.installBundle(spec, { enabled: true });
  const after = await options.client.listBundles();
  const installed = after.find((bundle) => bundle.name === COMPANION_NAME);
  if (!installed || !installed.installed) {
    return {
      state: "error",
      bundledVersion,
      message: "installBundle 完成但 bundle 列表中找不到伴生插件",
    };
  }
  if (installed.error) {
    return {
      state: "error",
      bundledVersion,
      installedVersion: installed.version,
      message: installed.error.diagnostic ?? installed.error.code,
    };
  }
  return {
    state: existing ? "updated" : "installed",
    bundledVersion,
    installedVersion: installed.version,
  };
}
