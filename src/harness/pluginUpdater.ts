/**
 * dsh-vsc plugin self-update: check GitHub releases and install the packaged
 * VSIX through the VS Code CLI (`code --install-extension --force`). The
 * download goes to a per-run temp dir; the running extension keeps working
 * until the user reloads (the CLI writes a NEW versioned extension folder, so
 * a failed install leaves the current one untouched).
 *
 * Distribution assumptions are deliberately publisher-agnostic:
 *  - the running extension is located by its `name` ("dsh-vsc"), so a fork or
 *    a re-published id keeps working without a code change;
 *  - the `code` CLI is searched in the platform-specific locations VS Code
 *    actually installs it to (Windows / macOS / Linux), plus PATH;
 *  - HTTP failures from the GitHub API are classified (rate limit, missing
 *    release, auth) and reported with an actionable message instead of being
 *    folded into "up to date".
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import * as vscode from "vscode";
import { compareVersions } from "./updateChannel";

const RELEASES_URL = "https://api.github.com/repos/Najabom/dsh_vsc_refresh/releases/latest";
const UPDATE_DIR = join(tmpdir(), ".dsh-vsc-update");
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;
const CHECK_TIMEOUT_MS = 15 * 1000;

/** Marketplace-friendly id of this extension (publisher = package.json publisher). */
export const EXTENSION_ID = "najabom.dsh-vsc";
/** `name` field in package.json — stable across publisher/id changes. */
const EXTENSION_NAME = "dsh-vsc";

export interface PluginUpdateCheck {
  installed: string;
  latest?: string;
  update: boolean;
  /** Direct download URL of the release's .vsix asset. */
  vsixUrl?: string;
}

export interface PluginUpdateResult {
  ok: boolean;
  error?: string;
}

let busy = false;

export function isPluginUpdateBusy(): boolean {
  return busy;
}

/** The running extension, found by its package name first (fork/id agnostic). */
function findRunningExtension(): vscode.Extension<unknown> | undefined {
  const all: readonly vscode.Extension<unknown>[] = vscode.extensions.all;
  const byName = all.find((ext) => {
    const pkg = ext.packageJSON as { name?: unknown } | undefined;
    return pkg?.name === EXTENSION_NAME;
  });
  return byName ?? vscode.extensions.getExtension(EXTENSION_ID) ?? vscode.extensions.getExtension("local.dsh-vsc");
}

/** Id of the running extension ("publisher.name"; empty when running from sources). */
export function runningExtensionId(): string {
  return findRunningExtension()?.id ?? "";
}

/** Version of the running extension (undefined when running from sources). */
export function installedPluginVersion(): string {
  const ext = findRunningExtension();
  const version = (ext?.packageJSON as { version?: string } | undefined)?.version;
  return typeof version === "string" ? version : "";
}

/** Turn a non-OK GitHub API response into an actionable error. */
function explainGithubFailure(status: number, headers: Headers): string {
  if (status === 403 || status === 429) {
    if (headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(headers.get("x-ratelimit-reset") ?? "");
      const when = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toLocaleString() : "稍后";
      return `GitHub API 频率限制（未授权请求每小时 60 次），请在 ${when} 后重试，或设置 GITHUB_TOKEN 环境变量后重载窗口`;
    }
    return "GitHub API 拒绝访问（HTTP 403）——可能是网络代理/防火墙拦截，或仓库权限变更";
  }
  if (status === 404) {
    return "GitHub 仓库或 Release 不存在（HTTP 404）——仓库可能已改名/迁移，或尚未发布任何 Release";
  }
  if (status === 401) {
    return "GitHub API 鉴权失败（HTTP 401）——GITHUB_TOKEN 可能已失效";
  }
  return `GitHub 发布检查失败：HTTP ${status}`;
}

/** Ask the GitHub releases API for the newest tag; compare with the running
 *  extension. Throws with an actionable message on HTTP/network failure so the
 *  settings page can distinguish "up to date" from "check failed". */
export async function checkPluginUpdate(log: (message: string) => void): Promise<PluginUpdateCheck> {
  const installed = installedPluginVersion();
  let res: Response;
  try {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "dsh-vsc",
      "x-github-api-version": "2022-11-28",
    };
    // Optional: only used to lift the anonymous rate limit; never required.
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) headers.authorization = `Bearer ${token}`;
    res = await fetch(RELEASES_URL, { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  } catch (error) {
    const reason = (error as Error).name === "TimeoutError" ? "请求超时" : (error as Error).message;
    log(`plugin update check failed: ${reason}`);
    throw new Error(`无法访问 GitHub 发布页（${reason}）——请检查网络/代理后重试`);
  }
  if (!res.ok) {
    const message = explainGithubFailure(res.status, res.headers);
    log(`plugin update check: ${message}`);
    throw new Error(message);
  }
  const body = (await res.json()) as {
    tag_name?: string;
    assets?: { name?: string; browser_download_url?: string }[];
  };
  const latest = String(body.tag_name ?? "").replace(/^v/, "");
  const assets = (body.assets ?? []).filter(
    (a): a is { name: string; browser_download_url: string } =>
      typeof a.name === "string" && a.name.length > 0 && typeof a.browser_download_url === "string" && a.browser_download_url.length > 0
  );
  // Prefer the canonical artifact name; fall back to whatever VSIX the release
  // carries (older releases / renamed assets).
  const preferred = assets.find((a) => a.name === `dsh-vsc-${latest}.vsix`);
  const vsix = preferred ?? assets.find((a) => a.name.toLowerCase().endsWith(".vsix"));
  const update = !!latest && !!installed && compareVersions(latest, installed) > 0;
  log(
    `plugin update check: installed ${installed || "?"}, latest ${latest || "?"}` +
      `${update ? " (update available)" : ""}${vsix ? "" : " — release has no .vsix asset"}`
  );
  return { installed, latest, update, vsixUrl: vsix?.browser_download_url };
}

/** Download the release VSIX and install it with the VS Code CLI. */
export async function installPluginUpdate(log: (message: string) => void): Promise<PluginUpdateResult> {
  if (busy) return { ok: false, error: "另一个更新正在进行中" };
  busy = true;
  try {
    const check = await checkPluginUpdate(log);
    if (!check.update) return { ok: false, error: "没有可安装的新版本" };
    if (!check.latest || !check.vsixUrl) return { ok: false, error: "发布版本缺少 VSIX 附件" };
    const dir = join(UPDATE_DIR, check.latest);
    mkdirSync(dir, { recursive: true });
    const vsixPath = join(dir, `dsh-vsc-${check.latest}.vsix`);
    log(`plugin update: downloading ${check.vsixUrl}`);
    const res = await fetch(check.vsixUrl, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    writeFileSync(vsixPath, Buffer.from(await res.arrayBuffer()));
    const cli = findCodeCli();
    if (!cli) {
      throw new Error(
        `找不到 VS Code 命令行（${process.platform === "win32" ? "code.cmd" : "code"}）：` +
          "请手动从 Releases 下载 VSIX 并“从 VSIX 安装”，或把 code 命令加入 PATH 后重试"
      );
    }
    log(`plugin update: installing via ${cli}`);
    await runCli(cli, ["--install-extension", vsixPath, "--force"], log);
    return { ok: true };
  } catch (error) {
    const message = (error as Error).message;
    log(`plugin update failed: ${message}`);
    return { ok: false, error: message };
  } finally {
    busy = false;
  }
}

/** Remove downloaded VSIX files (old versions accumulate otherwise). */
export function cleanupUpdateTemp(): void {
  if (busy) return;
  try {
    if (existsSync(UPDATE_DIR)) rmSync(UPDATE_DIR, { recursive: true, force: true });
  } catch {
    /* temp cleanup must never throw */
  }
}

export async function restartHost(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

/** Candidate `code` CLI paths for the current platform (without PATH scan). */
function codeCliCandidates(): string[] {
  const win = process.platform === "win32";
  const darwin = process.platform === "darwin";
  const exe = win ? "code.cmd" : "code";
  const candidates: string[] = [];
  const push = (candidate: string | undefined): void => {
    if (candidate) candidates.push(candidate);
  };
  // appRoot layouts differ per platform, so probe the plausible CLI locations
  // relative to it (existsSync filters the wrong ones):
  //   macOS app bundle : <app>/Contents/Resources/app/bin/code
  //   Linux deb/rpm    : /usr/share/code/bin/code
  //   Windows/tarball  : <install>/resources/app -> <install>/bin/code[.cmd]
  const root = vscode.env.appRoot;
  if (root) {
    push(join(root, "bin", exe));
    push(join(dirname(root), "bin", exe));
    push(join(dirname(dirname(root)), "bin", exe));
  }
  if (win) {
    if (process.env.LOCALAPPDATA) {
      push(join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "bin", exe));
    }
    if (process.env.ProgramFiles) push(join(process.env.ProgramFiles, "Microsoft VS Code", "bin", exe));
    if (process.env["ProgramFiles(x86)"]) {
      push(join(process.env["ProgramFiles(x86)"] as string, "Microsoft VS Code", "bin", exe));
    }
  } else if (darwin) {
    push("/usr/local/bin/code");
    push("/opt/homebrew/bin/code");
    push("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
    push(join(process.env.HOME ?? "", "Applications", "Visual Studio Code.app", "Contents", "Resources", "app", "bin", "code"));
  } else {
    // deb/rpm, snap, tarball, distro packages — covers the common Linux layouts.
    push("/usr/bin/code");
    push("/usr/share/code/bin/code");
    push("/snap/bin/code");
    push("/usr/local/bin/code");
  }
  return [...new Set(candidates)];
}

/** Find the VS Code command-line launcher for this platform, or null. */
function findCodeCli(): string | null {
  for (const candidate of codeCliCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  // Last resort: scan PATH (Homebrew / nvm-style installs, remote CLI, asdf...).
  const exe = process.platform === "win32" ? "code.cmd" : "code";
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = join(entry, exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function runCli(cli: string, args: string[], log: (message: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const onExit = (error: Error | null, stdout: string, stderr: string): void => {
      const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
      for (const line of output.split(/\r?\n/).slice(-8)) log(`code: ${line}`);
      if (error) {
        reject(new Error((error as { killed?: boolean }).killed ? "安装命令超时" : error.message));
        return;
      }
      resolve();
    };
    const options = { windowsHide: true, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 };
    if (process.platform === "win32") {
      // .cmd shims need cmd.exe; quoting keeps paths with spaces intact.
      const comspec = process.env.ComSpec || "cmd.exe";
      const commandLine = `"${cli}" ${args.map((a) => `"${a}"`).join(" ")}`;
      execFile(comspec, ["/c", commandLine], options, onExit);
    } else {
      execFile(cli, args, options, onExit);
    }
  });
}
