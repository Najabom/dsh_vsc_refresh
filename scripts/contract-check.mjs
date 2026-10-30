#!/usr/bin/env node
/**
 * Contract check against a pinned DSH release (CI + local).
 *
 * Every interface this extension consumes must still exist in the release the
 * check runs against — the same static-identifier scan the in-app update
 * preflight uses, so a red run here means "the next DSH would break us".
 *
 * Usage: node scripts/contract-check.mjs <dsh-version>
 *        (default: the pinned baseline 0.1.7-rc.2)
 *
 * Exit codes: 0 = contract holds, 1 = contract broken, 2 = could not verify
 * (network/registry), 3 = usage error.
 */
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const BASELINE = "0.1.7-rc.2";
const version = process.argv[2] || process.env.CONTRACT_DSH_VERSION || BASELINE;

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`usage: node scripts/contract-check.mjs <dsh-version> (got "${version}")`);
  process.exit(3);
}

const dir = await mkdtemp(join(tmpdir(), "dsh-vsc-contract-"));
const bundle = join(dir, "preflight.cjs");
// The update preflight imports the launcher (for the installed dsh path), which
// references the `vscode` extension-host module. The check only calls the
// exported pure functions, so satisfy the import with an empty stub instead of
// failing to bundle outside an Extension Host (CI never runs one).
const vscodeStub = {
  name: "vscode-stub",
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "vscode-stub" }));
    build.onLoad({ filter: /.*/, namespace: "vscode-stub" }, () => ({
      contents: "module.exports = {};",
      loader: "js",
    }));
  },
};
const buildOptions = {
  bundle: true,
  format: "cjs",
  platform: "node",
  plugins: [vscodeStub],
  logLevel: "silent",
};
await build({
  entryPoints: ["src/harness/updatePreflight.ts"],
  ...buildOptions,
  outfile: bundle,
});
const { INTERFACE_IDS, staticInterfaceCheck } = require(bundle);
const capsBundle = join(dir, "capabilities.cjs");
await build({
  entryPoints: ["src/harness/capabilities.ts"],
  ...buildOptions,
  outfile: capsBundle,
});
const { CAPABILITY_FEATURES, TESTED_DSH_MIN, compareVersions } = require(capsBundle);

let failed = false;
const log = (line) => console.log(`[contract ${version}] ${line}`);

console.log(`[contract ${version}] ${INTERFACE_IDS.length} interface identifiers in scope`);

const result = await staticInterfaceCheck(version, log);
if (!result.verified) {
  console.error(`[contract ${version}] cannot verify: ${result.error}`);
  await rm(dir, { recursive: true, force: true });
  process.exit(2);
}
if (!result.ok) {
  // The plugin market arrived in 0.2.0; older pinned releases legitimately
  // lack those endpoints (the compatibility ledger reports them as
  // unsupported at runtime instead of hiding the page).
  const marketOnly = result.missing.every((id) => id.startsWith("pluginMarket/"));
  if (marketOnly && compareVersions(version, "0.2.0-rc.1") < 0) {
    log(`expected: plugin market endpoints arrived after ${version} (${result.missing.length} ids)`);
  } else {
    console.error(`[contract ${version}] MISSING: ${result.missing.join(", ")}`);
    failed = true;
  }
}

if (result.optionalMissing.length > 0) {
  // Capability-gated endpoints (e.g. session/state on 0.2.2+) may not exist on
  // older lines; the runtime ledger reports the feature as unsupported instead
  // of the bridge breaking, so this is a degradation, not a contract failure.
  log(`capability-gated identifiers absent (feature degrades, not a break): ${result.optionalMissing.join(", ")}`);
}

const known = new Set(INTERFACE_IDS);
const covered = (pattern) => {
  if (known.has(pattern)) return true;
  if (!pattern.endsWith("/*")) return false;
  const prefix = pattern.slice(0, -1);
  return [...known].some((id) => id.startsWith(prefix));
};
for (const feature of CAPABILITY_FEATURES) {
  for (const method of feature.methods) {
    if (!covered(method)) {
      console.error(`[contract ${version}] capability "${feature.id}" uses unknown method: ${method}`);
      failed = true;
    }
  }
}

if (compareVersions(version, TESTED_DSH_MIN) < 0) {
  console.error(`[contract ${version}] below the tested minimum ${TESTED_DSH_MIN}`);
  failed = true;
}

await rm(dir, { recursive: true, force: true });
if (failed) process.exit(1);
log(
  result.optionalMissing.length > 0
    ? "OK — every required identifier exists in this release (capability-gated ones degrade gracefully)"
    : "OK — every identifier this extension uses exists in this release"
);
