import { execFile } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { featureForMethod } from "./capabilities";
import { METHODS } from "./protocol";
import { compareVersions } from "./updater";
import { FEATURE_BASELINE_VERSION, KNOWN_FEATURE_PACKAGES } from "./featureBaseline";

/**
 * Update preflight: before offering (or recommending) a DSH update, measure
 * whether the bridge's wire contract survives it, using two independent
 * signals:
 *
 * 1. Official release notes — the DSH repo publishes per-version notes on
 *    GitHub Releases (中文+English, with breaking-change markers). We pull the
 *    notes for every version in (installed, latest] and scan them for the
 *    exact interface identifiers this extension uses.
 * 2. Static interface check — fetch the new version's key packages from the
 *    npm registry as tarballs, gunzip in memory (tarballs are plain .tar.gz),
 *    and verify every RPC endpoint / event / stream name still exists.
 *
 * Either signal alone is fallible (prose can be vague; strings can survive a
 * semantically changed endpoint), so they are combined and the runtime
 * post-update verification (API probe + RPC + WS stream, with rollback) stays
 * the final gate.
 */

const RELEASES_API = "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=40";
const RELEASES_ATOM = "https://github.com/deepseek-ai/deepseek-harness/releases.atom";
const RELEASES_TIMEOUT_MS = 15000;
const TARBALL_TIMEOUT_MS = 30000;
const UA = "dsh-vsc-update-preflight";

/**
 * Text fetch with a curl.exe fallback. Some Windows networks run TLS
 * interception whose root CA is in the system store: curl (Schannel) verifies
 * the chain while Node's bundled roots reject it
 * (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). The registry fetch used by the static
 * check has never shown the problem, but GitHub has — so every GitHub request
 * goes through this helper.
 */
async function fetchTextWithFallback(url: string, accept: string, log: (message: string) => void): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { accept, "user-agent": UA },
      signal: AbortSignal.timeout(RELEASES_TIMEOUT_MS),
    });
    if (!res.ok) {
      log(`release notes unavailable: ${url} answered HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (error) {
    log(`github fetch failed (${(error as Error).message}) — trying curl.exe fallback`);
  }
  return new Promise((resolve) => {
    execFile(
      "curl.exe",
      ["-sS", "-f", "-m", "20", "-H", `accept: ${accept}`, "-H", `user-agent: ${UA}`, url],
      { windowsHide: true, timeout: RELEASES_TIMEOUT_MS + 10000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          log(`curl fallback failed: ${error.message}`);
          resolve(null);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

interface ReleaseEntry {
  version: string;
  text: string;
}

function filterInterval(entries: ReleaseEntry[], installed: string, latest: string): ReleaseNotesInfo {
  const notes = entries.filter(
    (n) => compareVersions(n.version, installed) > 0 && compareVersions(n.version, latest) <= 0
  );
  notes.sort((a, b) => compareVersions(a.version, b.version));
  return { versions: notes.map((n) => n.version), notes };
}

/** Parse the releases.atom feed (github.com web, reachable where api.github.com
 *  is blocked). Version comes from the tag link/id; the raw (HTML-escaped)
 *  entry body is the scan text — every INTERFACE_ID is HTML-safe, so a literal
 *  substring search stays exact. */
function parseAtomReleases(xml: string): ReleaseEntry[] | null {
  const entries: ReleaseEntry[] = [];
  for (const chunk of xml.split("<entry>").slice(1)) {
    const body = chunk.split("</entry>")[0] ?? chunk;
    const m = /releases\/tag\/dsh-v([\w.+-]+)/.exec(body) ?? /dsh-v([\w.+-]+)/.exec(body);
    if (!m) continue;
    entries.push({ version: m[1], text: body });
  }
  return entries.length > 0 ? entries : null;
}

/** Fetch the official release notes for versions in (installed, latest].
 *  Tries the structured GitHub API first, then the atom feed. Null when both
 *  are unavailable — the caller treats that as "preflight unavailable", never
 *  as a failure. */
export async function fetchReleaseNotes(
  installed: string,
  latest: string,
  log: (message: string) => void
): Promise<ReleaseNotesInfo | null> {
  const apiText = await fetchTextWithFallback(RELEASES_API, "application/vnd.github+json", log);
  if (apiText !== null) {
    try {
      const body = JSON.parse(apiText) as unknown;
      if (Array.isArray(body)) {
        const entries: ReleaseEntry[] = [];
        for (const item of body as { tag_name?: unknown; body?: unknown }[]) {
          const tag = typeof item.tag_name === "string" ? item.tag_name : "";
          const m = /^dsh-v(.+)$/.exec(tag);
          if (!m) continue;
          entries.push({ version: m[1], text: typeof item.body === "string" ? item.body : "" });
        }
        return filterInterval(entries, installed, latest);
      }
      log("release notes: unexpected GitHub API response shape");
    } catch (error) {
      log(`release notes: GitHub API JSON parse failed (${(error as Error).message})`);
    }
  }
  log("release notes: falling back to the releases.atom feed");
  const atomText = await fetchTextWithFallback(RELEASES_ATOM, "application/atom+xml,text/xml;q=0.9,*/*;q=0.8", log);
  if (atomText === null) return null;
  const atomEntries = parseAtomReleases(atomText);
  if (atomEntries === null) {
    log("release notes: atom feed had no parsable entries");
    return null;
  }
  return filterInterval(atomEntries, installed, latest);
}

/** Every wire identifier the bridge depends on: all RPC endpoints it calls,
 *  the waterfall events it answers, the mux path, and the client envelope. */
export const INTERFACE_IDS: string[] = [
  ...Object.values(METHODS),
  "remote.mux",
  // Stream endpoints opened over the mux (not typert RPC methods).
  "$events",
  "session/control",
  "session/follow",
  "workspace/follow",
  "approval/request",
  "user-questions/request",
  "client-request",
];

/** Packages whose tarballs carry the identifiers above (aggregated remote
 *  client + event list, gateway stream protocol, connection envelope). */
const CHECK_PACKAGES = [
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-gateway",
  "@deepseek-ai/dsh-client-connection",
];

export interface ReleaseNotesInfo {
  versions: string[];
  notes: { version: string; text: string }[];
}

export interface InterfaceAlert {
  id: string;
  versions: string[];
}

export interface InterfaceAlerts {
  hits: InterfaceAlert[];
}

/** Exact-identifier scan of the release notes: a hit means the official notes
 *  named an interface this extension actually uses. Prose vagueness is fine —
 *  we only report identifiers, not vibes. */
export function scanInterfaceAlerts(notes: { version: string; text: string }[]): InterfaceAlerts {
  const hits = new Map<string, Set<string>>();
  for (const note of notes) {
    for (const id of INTERFACE_IDS) {
      if (!note.text.includes(id)) continue;
      let versions = hits.get(id);
      if (!versions) {
        versions = new Set<string>();
        hits.set(id, versions);
      }
      versions.add(note.version);
    }
  }
  return { hits: [...hits].map(([id, versions]) => ({ id, versions: [...versions] })) };
}

export type StaticCheckResult =
  | { verified: true; ok: boolean; missing: string[]; optionalMissing: string[] }
  | { verified: false; error: string };

function tarballUrl(pkg: string, version: string): string {
  const name = pkg.slice(pkg.indexOf("/") + 1);
  return `https://registry.npmjs.org/${pkg}/-/${name}-${version}.tgz`;
}

async function fetchTarballText(pkg: string, version: string): Promise<Buffer> {
  const res = await fetch(tarballUrl(pkg, version), {
    headers: { accept: "application/octet-stream", "user-agent": "dsh-vsc-update-preflight" },
    signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${pkg}@${version}: HTTP ${res.status}`);
  return gunzipSync(Buffer.from(await res.arrayBuffer()));
}

/** Verify every INTERFACE_ID exists verbatim inside the new version's key
 *  packages. All identifiers are plain ASCII, so a byte search over the
 *  concatenated uncompressed tar payload is exact. */
export async function staticInterfaceCheck(latest: string, log: (message: string) => void): Promise<StaticCheckResult> {
  try {
    const blobs: Buffer[] = [];
    for (const pkg of CHECK_PACKAGES) blobs.push(await fetchTarballText(pkg, latest));
    const haystack = Buffer.concat(blobs);
    const absent = INTERFACE_IDS.filter((id) => !haystack.includes(id));
    // Capability-gated surfaces may legitimately predate a release line (e.g.
    // `session/state` only exists on 0.2.2+): their absence degrades one
    // feature (recorded by the runtime compatibility ledger) instead of
    // breaking the bridge, so only the rest is a hard contract failure.
    const optionalMissing = absent.filter((id) => featureForMethod(id) !== undefined);
    const missing = absent.filter((id) => featureForMethod(id) === undefined);
    if (missing.length > 0) {
      log(`static interface check: ${missing.length} required identifier(s) missing in ${latest}: ${missing.join(", ")}`);
      if (optionalMissing.length > 0) {
        log(`static interface check: ${optionalMissing.length} capability-gated identifier(s) absent in ${latest}: ${optionalMissing.join(", ")}`);
      }
      return { verified: true, ok: false, missing, optionalMissing };
    }
    if (optionalMissing.length > 0) {
      log(`static interface check: ${optionalMissing.length} capability-gated identifier(s) absent in ${latest}: ${optionalMissing.join(", ")}`);
    }
    log(
      `static interface check: all ${INTERFACE_IDS.length - optionalMissing.length} required identifiers present in ${latest} (${CHECK_PACKAGES.length} packages)`
    );
    return { verified: true, ok: true, missing: [], optionalMissing };
  } catch (error) {
    const message = (error as Error).message;
    log(`static interface check unavailable: ${message}`);
    return { verified: false, error: message };
  }
}

/** Read one text entry out of an npm tarball (uncompressed .tar bytes).
 *  npm tarballs are plain USTAR headers + 512-byte padding; we only need
 *  the main package manifest, so no external tar dependency is required. */
function tarEntryText(tar: Buffer, wanted: string): string | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return null;
    const rawName = header.subarray(0, 100).toString("utf8");
    const nul = rawName.indexOf("\0");
    const name = nul >= 0 ? rawName.slice(0, nul) : rawName;
    const sizeField = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeField, 8);
    const dataStart = offset + 512;
    if (!Number.isFinite(size) || size < 0) return null;
    if (name === wanted) {
      if (dataStart + size > tar.length) return null;
      return tar.subarray(dataStart, dataStart + size).toString("utf8");
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

export type FeatureProbeResult =
  | { verified: true; unknown: string[] }
  | { verified: false; error: string };

const KNOWN_FEATURE_SET = new Set(KNOWN_FEATURE_PACKAGES);

/** Compare the candidate DSH release's runtime bundle list with the
 *  feature packages this extension was built and verified against
 *  (harness/featureBaseline.ts). Packages added after the baseline are
 *  features the bridge has never seen: their entry points cannot be
 *  surfaced in the VS Code panel until the extension adapts, so the update
 *  prompt warns instead of pretending the release is fully compatible. */
export async function probeNewFeaturePackages(
  latest: string,
  log: (message: string) => void
): Promise<FeatureProbeResult> {
  try {
    const tar = await fetchTarballText("@deepseek-ai/dsh", latest);
    const manifestText = tarEntryText(tar, "package/package.json");
    if (manifestText === null) throw new Error("main package tarball has no package/package.json");
    const manifest = JSON.parse(manifestText) as { dependencies?: Record<string, unknown> };
    const packages = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@deepseek-ai/dsh-"));
    const unknown = packages.filter((name) => !KNOWN_FEATURE_SET.has(name));
    if (unknown.length > 0) {
      log(
        `new-feature probe: ${latest} adds ${unknown.length} package(s) outside the ${FEATURE_BASELINE_VERSION} baseline: ${unknown.join(", ")}`
      );
    } else {
      log(`new-feature probe: ${latest} feature package set matches the ${FEATURE_BASELINE_VERSION} baseline (${packages.length} packages)`);
    }
    return { verified: true, unknown };
  } catch (error) {
    const message = (error as Error).message;
    log(`new-feature probe unavailable: ${message}`);
    return { verified: false, error: message };
  }
}
