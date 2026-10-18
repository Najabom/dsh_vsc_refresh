/**
 * Pure version/channel logic for the DSH update check — no imports, no network
 * (unit-testable by bundling this file alone).
 */

/** Which release line the update check follows. */
export type DshUpdateChannel = "auto" | "stable" | "next" | "alpha";

interface ParsedVersion {
  nums: [number, number, number];
  pre: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver-ish compare: negative when a < b, 0 when equal, positive when a > b.
 *  Prereleases sort below their release; numeric prerelease fields sort below
 *  alphanumeric ones (so rc.10 > rc.2, the part npm-style tags get right). */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1; // release > prerelease
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1; // numeric identifiers sort lower than alphanumeric
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Pick the version an update check should compare against. Pure (no network)
 * so the channel logic is unit-testable. `versions` is the registry's full
 * version list, `tags` its dist-tags.
 */
export function pickLatestVersion(
  tags: Record<string, string | undefined>,
  versions: string[],
  installed: string,
  channel: DshUpdateChannel
): { latest?: string; channelLabel: string } {
  const isPre = (value: string): boolean => value.includes("-");
  const maxOf = (list: string[]): string | undefined =>
    list.reduce<string | undefined>(
      (acc, value) => (acc === undefined || compareVersions(value, acc) > 0 ? value : acc),
      undefined
    );
  const tagged = (tag: string, fallback: "stable" | "any"): string | undefined => {
    const value = tags[tag];
    if (typeof value === "string" && value) return value;
    return fallback === "stable" ? maxOf(versions.filter((v) => !isPre(v))) : maxOf(versions);
  };
  if (channel === "stable") return { latest: tagged("latest", "stable"), channelLabel: "stable" };
  if (channel === "next") return { latest: tagged("next", "any"), channelLabel: "next" };
  if (channel === "alpha") return { latest: tagged("alpha", "any"), channelLabel: "alpha" };
  // auto: follow the installed line (an rc install tracks prereleases — that
  // is exactly how the user got onto that line in the first place).
  if (isPre(installed)) return { latest: maxOf(versions), channelLabel: "auto (prerelease)" };
  return { latest: tagged("latest", "stable"), channelLabel: "auto (stable)" };
}
