/**
 * DSH compatibility ledger.
 *
 * The extension speaks a hand-written wire contract: every optional surface
 * (plugins, jobs, schedules, …) is a group of RPC endpoints. When DSH ships a
 * breaking change, calls fail with a gateway error. Instead of crashing — or
 * silently hiding the surface — we record the failure per feature and tell the
 * user the truth: "this DSH version is too old/new for that feature".
 *
 * Two signals:
 *  - version band: the extension is verified against [TESTED_MIN, TESTED_MAX);
 *    anything outside is reported as UNVERIFIED (not broken, just untested);
 *  - runtime classification: gateway/not-found (endpoint gone) or
 *    gateway/arguments-invalid (payload drifted) mark the owning feature as
 *    incompatible, with the server's own reason.
 */

export const TESTED_DSH_MIN = "0.1.7-rc.2";
/**
 * Exclusive: newer versions are reported as "untested" until the loop below
 * has been re-verified. 0.2.2-alpha.2 passed `scripts/contract-check.mjs`
 * (all 79 interface identifiers present) on 2026-10-29, covering the whole
 * 0.2.2 line; bump only after that check is green again.
 */
export const TESTED_DSH_MAX = "0.2.3";

export interface CapabilityFeature {
  id: string;
  label: string;
  /** RPC method names; `prefix/*` matches a whole namespace. */
  methods: string[];
}

export const CAPABILITY_FEATURES: CapabilityFeature[] = [
  { id: "plugins", label: "插件管理", methods: ["pluginManager/*"] },
  { id: "jobs", label: "后台命令", methods: ["job/*"] },
  { id: "schedules", label: "定时任务", methods: ["schedule/*"] },
  { id: "goals", label: "目标", methods: ["goals/*"] },
  { id: "changes", label: "每轮变更", methods: ["workspace/follow"] },
  { id: "search", label: "会话搜索", methods: ["session/search"] },
  { id: "fork", label: "会话分叉", methods: ["session/fork"] },
  { id: "references", label: "文件/会话引用", methods: ["fileReferences/*", "sessionReferenceResolver/*"] },
  { id: "skills", label: "技能菜单", methods: ["skills/*"] },
  { id: "workspace", label: "工作区管理", methods: ["workspace/create", "workspace/rename", "workspace/delete", "workspace/insertBefore", "workspace/pinSession", "workspace/unpinSession"] },
  { id: "account", label: "账户与余额", methods: ["account/*"] },
  { id: "settings", label: "高级设置", methods: ["settings/*"] },
  { id: "permissions", label: "权限预设", methods: ["permissionPresets/*"] },
  { id: "attachments", label: "附件", methods: ["fileUploads/*", "session/attachment"] },
  { id: "subagents", label: "子代理", methods: ["subagents/prompt", "subagents/interruptByParent", "session/follow"] },
];

export type FeatureStatus = "ok" | "incompatible" | "unsupported";

export interface FeatureProblem {
  id: string;
  label: string;
  status: FeatureStatus;
  reason: string;
}

export interface CompatibilityReport {
  version: string;
  testedMin: string;
  testedMax: string;
  /** "older"/"newer" = outside the verified band (too high/low), "tested" = in band. */
  versionBand: "tested" | "older" | "newer";
  /** Only features with a recorded problem (empty = every probed surface works). */
  problems: FeatureProblem[];
}

interface Version {
  nums: [number, number, number];
  pre: string[];
}

function parseVersion(raw: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(raw || "").trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver ordering incl. prerelease identifiers (numeric identifiers compare
 *  numerically; a release outranks any prerelease). Unparseable input sorts
 *  as 0.0.0 so a missing version never trips the band check. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? { nums: [0, 0, 0], pre: [] };
  const pb = parseVersion(b) ?? { nums: [0, 0, 0], pre: [] };
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Feature id owning an RPC method, or undefined for core traffic. */
export function featureForMethod(method: string): CapabilityFeature | undefined {
  for (const feature of CAPABILITY_FEATURES) {
    for (const pattern of feature.methods) {
      if (pattern.endsWith("/*")) {
        const head = pattern.slice(0, -1);
        if (method.startsWith(head)) return feature;
      } else if (pattern === method) {
        return feature;
      }
    }
  }
  return undefined;
}

const RANK: Record<FeatureStatus, number> = { ok: 0, incompatible: 1, unsupported: 2 };

/** Stateful ledger for one harness connection. */
export class CapabilityLedger {
  private version = "";
  private problems = new Map<string, FeatureProblem>();

  setVersion(version: string): void {
    const next = String(version || "");
    if (next === this.version) return;
    this.version = next;
    this.problems.clear();
  }

  /** Classify one RPC failure. Returns true when the report changed. */
  recordError(method: string, code: string, message: string): boolean {
    const feature = featureForMethod(method);
    if (!feature) return false;
    let status: FeatureStatus | null = null;
    if (/not[-_ ]?found|unknown (method|endpoint)|no such (method|endpoint)/i.test(code)) {
      status = "unsupported";
    } else if (/arguments-invalid|invalid (args|arguments)|descriptor/i.test(code)) {
      status = "incompatible";
    } else if (/disabled/i.test(code) || /disabled/i.test(message)) {
      status = "unsupported";
    }
    if (!status) return false;
    const reason = this.reasonText(status, code, message);
    const previous = this.problems.get(feature.id);
    if (previous && RANK[previous.status] >= RANK[status]) return false;
    this.problems.set(feature.id, { id: feature.id, label: feature.label, status, reason });
    return true;
  }

  report(): CompatibilityReport {
    const version = this.version;
    const parsed = parseVersion(version) !== null;
    let band: CompatibilityReport["versionBand"] = "tested";
    if (parsed) {
      if (compareVersions(version, TESTED_DSH_MIN) < 0) band = "older";
      else if (compareVersions(version, TESTED_DSH_MAX) >= 0) band = "newer";
    }
    return {
      version,
      testedMin: TESTED_DSH_MIN,
      testedMax: TESTED_DSH_MAX,
      versionBand: band,
      problems: [...this.problems.values()],
    };
  }

  private reasonText(status: FeatureStatus, code: string, message: string): string {
    const detail = message ? `：${message}` : "";
    const version = this.version ? `DSH ${this.version}` : "当前 DSH 版本";
    if (status === "incompatible") return `${version} 的接口参数与扩展不匹配（${code}）${detail}`;
    if (/disabled/i.test(code) || /disabled/i.test(message)) return `当前部署禁用了该能力（${code}）${detail}`;
    return `${version} 没有该接口（${code}）${detail}`;
  }
}
