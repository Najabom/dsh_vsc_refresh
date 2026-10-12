/**
 * Official-install integrity reference for the runtime overlay.
 *
 * The installed @deepseek-ai/dsh tree must stay byte-identical to the npm
 * release (v0.1.7-rc.2). These SHA256 values were computed from the files of
 * the npm release and are what scripts/restore-dsh-pristine.ps1 verifies
 * against. When upstream ships a new version, update this table + the script
 * + internal/runtime-overlay.md together (see "upgrade checkpoints" there).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** relative path under the dsh package's node_modules/@deepseek-ai -> pristine SHA256 */
export const PRISTINE_SHA256: Record<string, string> = {
  "dsh-client-connection/lib/index.js": "3950F524AED44E28240140A254CD928EA40EBA8E2D04CC8FD04F92A687F5C91D",
};

export interface PristineReport {
  ok: boolean;
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

/**
 * Check the dsh install under `subRoot` (e.g. `<npm-global>\node_modules\
 * @deepseek-ai\dsh\node_modules\@deepseek-ai`). Read-only; never writes.
 * A non-pristine tree means the runtime overlay can still patch, but the
 * "official body integrity" guarantee is broken (someone re-patched, or the
 * dsh version changed) — surface it.
 */
export function checkDshPristine(subRoot: string): PristineReport {
  const report: PristineReport = { ok: true, missing: [], modified: [], pristine: [] };
  const base = subRoot.replace(/[\\/]+$/, "");
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
