import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Multi-window liveness registry.
 *
 * Several VS Code windows may share ONE auto-started harness (same port, same
 * ~/.dsh history). Closing one window must not kill the service the others are
 * still using — and closing the LAST window must stop it (a windowless
 * detached spawn must not outlive its owner).
 *
 * Every window periodically writes `<pid>.json` into %TEMP%\dsh-vsc-clients\
 * naming itself and the harness base it is connected to. `deactivate` removes
 * its own file, then asks "is any OTHER live window still on this base?" —
 * yes: leave the harness alone; no: stop the owned instance.
 *
 * The same files are what dist/harness-guard.mjs (the wrapper spawned in
 * front of `dsh web`) polls when every window died abnormally: no fresh
 * heartbeat for the port + grace period → it kills the harness tree.
 *
 * The guard is plain node and spawns without the extension host, so the file
 * format here is a hard contract between the two (pid, heartbeatAt, url).
 */

export const CLIENTS_DIR = process.env.DSH_VSC_CLIENTS_DIR ?? join(tmpdir(), "dsh-vsc-clients");

/** A heartbeat older than this no longer counts as a live window. Must stay
 *  comfortably above the extension's slowest write cadence (120s when the
 *  window is in the background); overridable for the guard tests. */
const FRESH_MS = Number(process.env.DSH_VSC_FRESH_MS ?? 150_000);
/** Files older than this are pruned — crashed windows never clean up. */
const STALE_MS = 60 * 60 * 1000;

export interface ClientHeartbeat {
  pid: number;
  heartbeatAt: number;
  url: string;
  startedAt: number;
}

/** Compare bases the way the harness would: case-insensitive, no trailing
 *  slash, and loopback aliases (localhost / ::1 / 127.0.0.1) collapse to one
 *  canonical host — two windows writing "localhost:3080" and "127.0.0.1:3080"
 *  address the SAME server and must count as the same base. */
export function normalizeBase(url: string): string {
  const raw = url.trim().replace(/\/+$/, "").toLowerCase();
  try {
    const u = new URL(raw);
    if (u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1") u.hostname = "127.0.0.1";
    return u.href.replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

/** True for loopback bases — only those get a heartbeat written. */
export function isLocalBase(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function heartbeatPath(pid: number): string {
  return join(CLIENTS_DIR, `${pid}.json`);
}

/** Write/refresh this window's heartbeat for a harness base. */
export function writeHeartbeat(url: string): void {
  try {
    mkdirSync(CLIENTS_DIR, { recursive: true });
    const heartbeat: ClientHeartbeat = {
      pid: process.pid,
      heartbeatAt: Date.now(),
      url: normalizeBase(url),
      startedAt: Date.now(),
    };
    writeFileSync(heartbeatPath(process.pid), JSON.stringify(heartbeat), "utf8");
  } catch {
    /* liveness bookkeeping must never break the extension */
  }
}

/** Remove this window's heartbeat (called first thing in deactivate). */
export function removeHeartbeat(): void {
  try {
    rmSync(heartbeatPath(process.pid), { force: true });
  } catch {
    /* noop */
  }
}

export function readHeartbeats(): ClientHeartbeat[] {
  let names: string[] = [];
  try {
    names = readdirSync(CLIENTS_DIR);
  } catch {
    return [];
  }
  const out: ClientHeartbeat[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const hb = JSON.parse(readFileSync(join(CLIENTS_DIR, name), "utf8")) as ClientHeartbeat;
      if (typeof hb?.pid === "number" && typeof hb?.heartbeatAt === "number" && typeof hb?.url === "string") {
        out.push(hb);
      }
    } catch {
      /* a half-written file from a dying process — skip */
    }
  }
  return out;
}

/** Drop heartbeats older than STALE_MS (crashed windows leave files behind). */
export function pruneStale(now = Date.now()): void {
  for (const hb of readHeartbeats()) {
    if (now - hb.heartbeatAt > STALE_MS) {
      try {
        rmSync(heartbeatPath(hb.pid), { force: true });
      } catch {
        /* noop */
      }
    }
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
 * PIDs of OTHER windows still alive and freshly connected to `base`.
 * Excludes this window; requires a fresh heartbeat AND a live process (a
 * crash leaves the file, the stale heartbeat and the dead pid are both
 * filtered).
 */
export function liveOtherClients(base: string, now = Date.now()): number[] {
  const target = normalizeBase(base);
  const out: number[] = [];
  for (const hb of readHeartbeats()) {
    if (hb.pid === process.pid) continue;
    if (normalizeBase(hb.url) !== target) continue;
    if (now - hb.heartbeatAt > FRESH_MS) continue;
    if (!pidAlive(hb.pid)) continue;
    out.push(hb.pid);
  }
  return out;
}
