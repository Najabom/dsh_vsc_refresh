/**
 * Runtime overlay loader — installed into the harness process via
 * `node --import <dist>/overlay-register.mjs` (see register.ts), which calls
 * module.register() on THIS file. EXPORTED-hooks style is required: Node's
 * newer registerHooks() API did not fire in the Node 24 spike (see
 * internal/runtime-overlay.md §mechanism), while exported { load, resolve } hooks
 * registered through module.register() work on Node >= 20.6.
 *
 * What it does: when the harness loads one of the patched dsh modules,
 * the load hook swaps in the overlaid SOURCE (official + deltas) in memory.
 * The official files on disk are never touched.
 *
 * Logging: %TEMP%\dsh-vsc-overlay.log, APPEND-only (bounded: only boot /
 * overlay / canary lines). Never truncate: the harness's own node children
 * (e.g. npx-spawned mcp servers) inherit NODE_OPTIONS and re-run this loader,
 * which would clobber the parent's boot record if we rewrote the file.
 */
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATCHES, applyPatches, type OverlayResult } from "./deltas";

const LOG_FILE = join(tmpdir(), "dsh-vsc-overlay.log");

function log(line: string): void {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break the harness */
  }
}

function targetOf(url: string): { label: string } | null {
  const u = url.replace(/\\/g, "/");
  for (const p of PATCHES) if (p.url.test(u)) return p;
  return null;
}

export async function load(
  url: string,
  context: unknown,
  nextLoad: (u: string, c: unknown) => Promise<{ format?: string; source?: string | Uint8Array; shortCircuit?: boolean }>
): Promise<{ format?: string; source?: string | Uint8Array; shortCircuit?: boolean }> {
  const target = url.startsWith("file:") ? targetOf(url) : null;
  if (!target) return nextLoad(url, context);
  const orig = await nextLoad(url, context);
  // Node >= 22 hands source back as a Buffer; normalize before patching.
  const src =
    typeof orig.source === "string" ? orig.source : Buffer.from(orig.source ?? new Uint8Array(0)).toString("utf8");
  const res: OverlayResult = applyPatches(url, src);
  if (res.status === "anchor-missing") {
    log(`CANARY-FAIL ${url} (${res.label}): upstream anchor changed, overlay SKIPPED — degraded mode`);
    return orig;
  }
  log(`OVERLAY ${url} -> ${res.status} (${target.label})`);
  return { ...orig, source: res.source ?? src, shortCircuit: true };
}

export async function resolve(
  specifier: string,
  context: unknown,
  nextResolve: (s: string, c: unknown) => Promise<{ url: string }>
): Promise<{ url: string }> {
  return nextResolve(specifier, context);
}

// Boot summary — append. Children that inherit NODE_OPTIONS add their own
// pid line; every entry is small and boots are rare, so the log stays small.
try {
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] overlay loader active (pid ${process.pid}, ${PATCHES.length} deltas)\n`);
} catch {
  /* noop */
}
