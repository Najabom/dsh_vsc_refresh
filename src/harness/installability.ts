/**
 * Upstream installability preflight (pure: no vscode import, unit-testable).
 *
 * DSH ships ~85 `@deepseek-ai/dsh-*` packages in tandem. Upstream publishes
 * them sequentially, so a dist-tag can point at a version whose siblings are
 * not on npm yet (0.2.1-rc.3 shipped without dsh-client-ui-cordis). npm then
 * dies with ETARGET after minutes of resolver noise. Probe the tandem
 * versions first and let the caller skip a broken release instead of offering
 * an update that cannot succeed.
 */

export const DSH_PACKAGE_NAME = "@deepseek-ai/dsh";

const DEP_PROBE_TIMEOUT_MS = 8000;
/** Exact specs only (`0.2.1-rc.3`), never ranges. */
const EXACT_SPEC = /^\d+\.\d+\.\d+/;

function registryVersionUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

/** true/false, or undefined when the probe itself failed (treat as unknown). */
async function packageVersionExists(name: string, version: string): Promise<boolean | undefined> {
  try {
    const res = await fetch(registryVersionUrl(name, version), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DEP_PROBE_TIMEOUT_MS),
    });
    if (res.status === 404) return false;
    return res.ok ? true : undefined;
  } catch {
    return undefined;
  }
}

/** version -> missing dependency description (null = all probes passed). */
const installableCache = new Map<string, string | null>();

/** Name the first missing tandem dependency of a release, or undefined when
 *  the release looks installable (or the registry could not be asked). */
export async function uninstallableReason(version: string): Promise<string | undefined> {
  if (installableCache.has(version)) return installableCache.get(version) ?? undefined;
  let doc: { dependencies?: Record<string, string> };
  try {
    const res = await fetch(registryVersionUrl(DSH_PACKAGE_NAME, version), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DEP_PROBE_TIMEOUT_MS),
    });
    if (res.status === 404) {
      const reason = `版本 ${version} 在 npm 上不存在`;
      installableCache.set(version, reason);
      return reason;
    }
    if (!res.ok) return undefined;
    doc = (await res.json()) as { dependencies?: Record<string, string> };
  } catch {
    return undefined;
  }
  const deps = Object.entries(doc.dependencies ?? {}).filter(([, spec]) => EXACT_SPEC.test(spec));
  let uncertain = false;
  const missing = (
    await Promise.all(
      deps.map(async ([name, spec]) => {
        const exists = await packageVersionExists(name, spec);
        if (exists === undefined) uncertain = true;
        return exists === false ? `${name}@${spec}` : undefined;
      })
    )
  ).find((entry) => entry !== undefined);
  if (missing) {
    installableCache.set(version, missing);
    return missing;
  }
  if (!uncertain) installableCache.set(version, null);
  return undefined;
}
