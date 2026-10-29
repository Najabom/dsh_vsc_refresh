/**
 * Official-install integrity reference for the runtime overlay.
 *
 * The installed @deepseek-ai/dsh tree must stay byte-identical to the npm
 * release (v0.2.2-alpha.2). These SHA256
 * values were computed from the files of the npm release and are what
 * scripts/restore-dsh-pristine.ps1 verifies against. When upstream ships a new
 * version, update this table + the script + internal/runtime-overlay.md
 * together (`npm run record-pristine` regenerates the values).
 *
 * A dsh version outside the recorded one is reported as "unverified" (info),
 * never as "modified": a stale table must not look like a tampered install.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** dsh version the table below was recorded from. */
export const PRISTINE_HOST_VERSION = "0.2.2-alpha.2";

/** relative path under the dsh package's node_modules/@deepseek-ai -> pristine SHA256 */
export const PRISTINE_SHA256: Record<string, string> = {
  "dsh-client-connection/lib/index.js": "0EBCCA7583E082716F79B0B55BC1749D48269CC8DB2989B043B321B57ABD3684",
};

export interface PristineReport {
  ok: boolean;
  /** installed dsh version matches the recorded reference */
  versionMatch: boolean;
  /** installed dsh version (undefined when it cannot be read) */
  dshVersion?: string;
  /** version mismatch: hashes were NOT evaluated (reference table is stale) */
  unverified: boolean;
  /** rel paths that are missing on disk */
  missing: string[];
  /** rel paths whose sha256 does not match the npm release */
  modified: string[];
  /** rel paths verified byte-identical to the npm release */
  pristine: string[];
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

/** Version of the installed dsh package (subRoot/../../package.json). */
function installedVersion(subRoot: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(subRoot, "..", "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check the dsh install under `subRoot` (e.g. `<npm-global>\node_modules\
 * @deepseek-ai\dsh\node_modules\@deepseek-ai`). Read-only; never writes.
 * A non-pristine tree means the runtime overlay can still patch, but the
 * "official body integrity" guarantee is broken (someone re-patched, or the
 * dsh version changed) — surface it.
 */
export function checkDshPristine(subRoot: string): PristineReport {
  const report: PristineReport = {
    ok: true,
    versionMatch: false,
    unverified: false,
    missing: [],
    modified: [],
    pristine: [],
  };
  const base = subRoot.replace(/[\\/]+$/, "");
  report.dshVersion = installedVersion(base);
  report.versionMatch = report.dshVersion === PRISTINE_HOST_VERSION;
  if (!report.versionMatch) {
    // A stale reference table is expected right after a dsh upgrade. Skip the
    // hash comparison entirely: reporting these files as "modified" would look
    // like tampering when it is only version drift.
    report.unverified = true;
    report.ok = false;
    return report;
  }
  for (const rel of Object.keys(PRISTINE_SHA256)) {
    try {
      const hash = sha256(`${base}/${rel}`);
      if (hash === PRISTINE_SHA256[rel]) report.pristine.push(rel);
      else report.modified.push(rel);
    } catch {
      report.missing.push(rel);
    }
  }
  report.ok = report.missing.length === 0 && report.modified.length === 0;
  return report;
}
