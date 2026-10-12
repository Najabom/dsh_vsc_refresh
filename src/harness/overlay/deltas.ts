/**
 * Runtime overlay patch table — the SINGLE source of truth for the dsh-vsc
 * bridge's in-memory deltas.
 *
 * The bridge philosophy is "pure bridge": the official DSH body must stay
 * byte-identical to the npm release (see scripts/restore-dsh-pristine.ps1 +
 * the recorded SHA256 in ./pristine.ts). The loader (./loader.ts) applies
 * these deltas to the module SOURCE IN MEMORY as the harness process loads
 * each module — the official files on disk are never touched.
 *
 * Current delta (verified byte-exact against the npm release v0.1.7-rc.2):
 *   1. dsh-client-connection/lib/index.js — browser-session auth bypass.
 *      DSH >= 0.1.7 mints a per-process launch token and gates the whole
 *      /api surface (HTTP RPC and the /api/remote.mux WebSocket upgrade)
 *      behind a signed browser cookie that a programmatic client can never
 *      obtain. The bridge keeps the Host/Origin fence (loopback-only in
 *      practice) and replaces ONLY the cookie check on the API path; the
 *      browser index token exchange is untouched.
 *
 * Retired deltas (now upstreamed — do NOT re-add; see AGENTS.md §overlay):
 *   - dsh-host-apiproxy clientCount: the package no longer ships in v0.1.7.
 *   - dsh-subprocess-local spawn windowsHide: upstream ships it natively
 *     (`windowsHide: true` in the win32 job spawn options).
 *   - dsh-sandbox-windows-acl hidden console: the STARTUPINFO patch site is
 *     gone from the package.
 *
 * Delta contract:
 *   - url    : regex matched against the module's file URL (end-anchored)
 *   - marker : regex proving the patch is ALREADY in effect (idempotency)
 *   - re     : upstream anchor; group 1 = the line prefix, group 2 = its EOL
 *   - build  : (pre, eol) => replacement text
 *
 * Safety: if `marker` hits -> already overlaid (skip). If `re` misses ->
 * upstream changed shape; the loader MUST NOT patch (canary failure, logged,
 * degraded mode — the extension then cannot reach an auth-gated harness and
 * surfaces "harness offline" instead of silently hanging).
 */

export interface Delta {
  label: string;
  url: RegExp;
  marker: RegExp;
  re: RegExp;
  build: (pre: string, eol: string, tail?: string) => string;
}

export const PATCHES: Delta[] = [
  {
    label: "client-connection browser-auth bypass (loopback bridge client)",
    url: /dsh-client-connection[\\/]lib[\\/]index\.js$/,
    marker: /dsh-vsc-local-bridge: auth bypass/,
    re: /(\t\treturn this\.browserAuth\.isAuthenticated\(request\) \? void 0 : 401;)(\r?\n)/,
    build: (_pre, eol) => "\t\treturn void 0; // dsh-vsc-local-bridge: auth bypass" + eol,
  },
];

export type OverlayStatus = "no-match" | "already" | "patched" | "anchor-missing";

export interface OverlayResult {
  status: OverlayStatus;
  source?: string;
  label?: string;
}

/**
 * Apply every delta whose url matches `fileUrl` to `source`.
 * Returns the overlaid source (or the original unchanged).
 */
export function applyPatches(fileUrl: string, source: string): OverlayResult {
  const url = fileUrl.replace(/\\/g, "/");
  let out = source;
  let any = false;
  for (const p of PATCHES) {
    if (!p.url.test(url)) continue;
    any = true;
    if (p.marker.test(out)) continue; // already overlaid (idempotent)
    if (!p.re.test(out)) return { status: "anchor-missing", label: p.label };
    out = out.replace(p.re, (_m, pre: string, eol: string, tail?: string) => p.build(pre, eol, tail));
  }
  if (!any) return { status: "no-match" };
  return { status: out === source ? "already" : "patched", source: out };
}
