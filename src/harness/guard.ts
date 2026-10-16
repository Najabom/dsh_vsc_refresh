// Multi-window guard: spawned by the extension IN FRONT of `dsh web` so the
// harness can never outlive EVERY dsh-vsc client (e.g. all VS Code windows
// killed at once — no deactivate runs, nothing stops the detached harness).
//
// The guard is plain node with builtins only; esbuild bundles it to
// dist/harness-guard.mjs exactly like overlay-register.mjs. It spawns the real
// harness as its child and supervises the liveness contract written by
// src/harness/clientRegistry.ts:
//
//   %TEMP%\dsh-vsc-clients\<pid>.json  { pid, heartbeatAt, url, startedAt }
//
// - While any OTHER process keeps a FRESH heartbeat for this port's base, the
//   harness stays up (covers "close one of several windows").
// - When the last heartbeat goes stale for GRACE_MS after the initial window,
//   the guard kills the whole harness tree and exits (covers "all windows
//   crashed/force-killed").
// - A normal extension-driven stop taskkills the guard pid with /T — the
//   whole tree (guard + harness) dies together; the guard does not survive it.
//
// Args: exactly `node harness-guard.mjs <dshScript> web --no-open --port <N>`.
// argv is passed through to the harness unchanged, so the guard's own command
// line also contains `--port <N>` — the PID-reuse guard in launcher.ts keeps
// working on the recorded pid.
import { spawn, execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);

const INTERVAL_MS = Number(process.env.DSH_VSC_GUARD_INTERVAL_MS ?? 5000);
const GRACE_MS = Number(process.env.DSH_VSC_GUARD_GRACE_MS ?? 45_000);
const INITIAL_MS = Number(process.env.DSH_VSC_GUARD_INITIAL_MS ?? 180_000);
const CLIENTS_DIR = process.env.DSH_VSC_CLIENTS_DIR ?? join(tmpdir(), "dsh-vsc-clients");
const FRESH_MS = 15_000;

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

const child = spawn(process.execPath, argv, { windowsHide: true, stdio: "ignore" });
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

function shutdown(): void {
  stopping = true;
  const pid = child.pid;
  if (pid === undefined) process.exit(0);
  // taskkill the harness TREE (the extension's own stop does the same to us).
  execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => process.exit(0));
  // Belt and braces: if taskkill somehow never calls back, still go away.
  setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* noop */
    }
    process.exit(0);
  }, 8000);
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
    shutdown();
  }
}, INTERVAL_MS);

child.on("exit", (code) => {
  clearInterval(timer);
  process.exit(code ?? 0);
});
child.on("error", () => {
  clearInterval(timer);
  process.exit(1);
});
