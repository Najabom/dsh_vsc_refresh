// Multi-window guard: spawned by the extension IN FRONT of `dsh web` so the
// harness can never outlive EVERY dsh-vsc client (e.g. all VS Code windows
// killed at once — no deactivate runs, nothing stops the detached harness).
//
// The guard is plain node with builtins only; esbuild bundles it to
// dist/harness-guard.mjs exactly like overlay-register.mjs. It spawns the real
// harness as its child and supervises the liveness contract written by
// src/harness/clientRegistry.ts:
//
//   <tmpdir>/dsh-vsc-clients/<pid>.json  { pid, heartbeatAt, url, startedAt }
//
// - While any OTHER process keeps a FRESH heartbeat for this port's base, the
//   harness stays up (covers "close one of several windows").
// - When the last heartbeat goes stale for GRACE_MS after the initial window,
//   the guard kills the whole harness tree and exits (covers "all windows
//   crashed/force-killed").
// - A normal extension-driven stop kills the guard's PROCESS GROUP (POSIX) or
//   the guard pid tree (Windows taskkill /T) — guard + harness die together;
//   the guard does not survive it.
//
// Args: exactly `node harness-guard.mjs <dshScript> web --no-open --port <N>`.
// argv is passed through to the harness unchanged, so the guard's own command
// line also contains `--port <N>` — the PID-reuse guard in launcher.ts keeps
// working on the recorded pid.
//
// Cross-platform process tree:
// - Windows: kill the harness tree with `taskkill /PID <pid> /T /F`.
// - POSIX: launcher.ts spawns the guard detached, so the guard IS the
//   process-group leader; the harness (spawned without `detached`) inherits
//   that group, and a signal to `-guardPid` reaches guard + harness +
//   descendants. When only the guard is signalled, it terminates the harness
//   child itself before exiting.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);

const IS_WINDOWS = process.platform === "win32";
const INTERVAL_MS = Number(process.env.DSH_VSC_GUARD_INTERVAL_MS ?? 20_000);
const GRACE_MS = Number(process.env.DSH_VSC_GUARD_GRACE_MS ?? 60_000);
const INITIAL_MS = Number(process.env.DSH_VSC_GUARD_INITIAL_MS ?? 180_000);
const CLIENTS_DIR = process.env.DSH_VSC_CLIENTS_DIR ?? join(tmpdir(), "dsh-vsc-clients");
// Must mirror clientRegistry.ts: the extension writes every 30s (focused) or
// 120s (background), so 150s is "no live window". Env-overridable for tests.
const FRESH_MS = Number(process.env.DSH_VSC_FRESH_MS ?? 150_000);

function parsePort(args: string[]): number | null {
  const i = args.indexOf("--port");
  if (i < 0 || !args[i + 1]) return null;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const port = parsePort(argv);
if (argv.length === 0 || port === null) {
  // Misconfigured — refuse to wrap blindly (the harness would be unkillable).
  process.exit(64);
}

// The harness is a direct child (no `detached`): on POSIX it stays inside the
// guard's process group so the extension's group kill reaches the whole tree.
const child = spawn(process.execPath, argv, {
  windowsHide: IS_WINDOWS,
  stdio: "ignore",
  detached: false,
});
const startedAt = Date.now();
let noClientSince: number | null = null;
let stopping = false;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Live (fresh + process alive) client heartbeats for this port's base. */
function liveClients(): number {
  let names: string[] = [];
  try {
    names = readdirSync(CLIENTS_DIR);
  } catch {
    return 0; // no registry yet — a pre-heartbeat window is covered by INITIAL_MS
  }
  const now = Date.now();
  const portRe = new RegExp(`:${port}(/|$)`);
  let live = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const hb = JSON.parse(readFileSync(join(CLIENTS_DIR, name), "utf8")) as {
        pid?: unknown;
        heartbeatAt?: unknown;
        url?: unknown;
      };
      if (typeof hb?.pid !== "number" || typeof hb?.heartbeatAt !== "number" || typeof hb?.url !== "string") continue;
      if (now - hb.heartbeatAt > FRESH_MS) continue;
      if (!portRe.test(hb.url.toLowerCase())) continue;
      if (!pidAlive(hb.pid)) continue;
      live++;
    } catch {
      /* half-written file from a dying process — skip */
    }
  }
  return live;
}

/**
 * Kill a Windows process tree with `taskkill /T /F`. Spawned with ignored
 * stdio (no pipes: restricted hosts may deny pipe creation) and tolerant of a
 * failed/blocked taskkill spawn — the guard must always exit, never crash with
 * an uncaught spawn error.
 */
function taskkillTree(pid: number, done: () => void): void {
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    done();
  };
  try {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", finish);
    killer.on("exit", finish);
  } catch {
    finish();
  }
}

/** Kill the harness tree, then exit. Guarded so the signal handler and the
 *  stale-heartbeat path cannot race. */
function killTree(): void {
  if (stopping) return;
  stopping = true;
  const pid = child.pid;
  if (pid === undefined) {
    process.exit(0);
    return;
  }
  if (IS_WINDOWS) {
    // taskkill /T kills the harness and every child it spawned (MCP servers…).
    taskkillTree(pid, () => process.exit(0));
    // Belt and braces: if taskkill never calls back, still go away (and try
    // terminating the direct child ourselves — TerminateProcess usually works
    // even where an external taskkill is blocked).
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* noop */
      }
      process.exit(0);
    }, 8000);
    return;
  }
  // POSIX: terminate the harness child, then exit. Its descendants are in the
  // same process group, so they already received the group signal on the
  // normal stop path; this covers guard-only termination.
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    process.exit(0);
  }, 3000);
}

const timer = setInterval(() => {
  if (stopping) return;
  const now = Date.now();
  if (now - startedAt < INITIAL_MS) return; // cold boot / connect window
  if (liveClients() > 0) {
    noClientSince = null;
    return;
  }
  if (noClientSince === null) {
    noClientSince = now;
    return;
  }
  if (now - noClientSince >= GRACE_MS) {
    clearInterval(timer);
    killTree();
  }
}, INTERVAL_MS);

// The extension's normal stop either group-kills (POSIX) or taskkill /T
// (Windows); handle a guard-only SIGTERM/SIGINT by taking the harness down
// with us instead of leaving an orphan behind.
process.on("SIGTERM", () => {
  clearInterval(timer);
  killTree();
});
process.on("SIGINT", () => {
  clearInterval(timer);
  killTree();
});

child.on("exit", (code) => {
  clearInterval(timer);
  // The guard exits with the child; `stopping` guards the reverse direction.
  process.exit(code ?? 0);
});
child.on("error", () => {
  clearInterval(timer);
  process.exit(1);
});
