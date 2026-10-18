/**
 * dsh-vsc plugin self-update: check GitHub releases and install the packaged
 * VSIX through the VS Code CLI (`code --install-extension --force`). The
 * download goes to a per-run temp dir; the running extension keeps working
 * until the user reloads (the CLI writes a NEW versioned extension folder, so
 * a failed install leaves the current one untouched).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { compareVersions } from "./updateChannel";

const RELEASES_URL = "https://api.github.com/repos/Najabom/dsh_vsc_refresh/releases/latest";
const UPDATE_DIR = join(tmpdir(), ".dsh-vsc-update");
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;

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

/** Version of the running extension (undefined when running from sources). */
export function installedPluginVersion(): string {
  const ext =
    vscode.extensions.getExtension("local.dsh-vsc") ?? vscode.extensions.getExtension("Najabom.dsh-vsc");
  const version = (ext?.packageJSON as { version?: string } | undefined)?.version;
  return typeof version === "string" ? version : "";
}

/** Ask the GitHub releases API for the newest tag; compare with the running
 *  extension. Never throws — a failed check reports update:false. */
export async function checkPluginUpdate(log: (message: string) => void): Promise<PluginUpdateCheck> {
  const installed = installedPluginVersion();
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": "dsh-vsc" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      log(`plugin update check: GitHub HTTP ${res.status}`);
      return { installed, update: false };
    }
    const body = (await res.json()) as {
      tag_name?: string;
      assets?: { name?: string; browser_download_url?: string }[];
    };
    const latest = String(body.tag_name ?? "").replace(/^v/, "");
    const vsix = (body.assets ?? []).find((a) => typeof a.name === "string" && a.name.endsWith(".vsix"));
    const update = !!latest && !!installed && compareVersions(latest, installed) > 0;
    log(`plugin update check: installed ${installed || "?"}, latest ${latest || "?"}${update ? " (update available)" : ""}`);
    return { installed, latest, update, vsixUrl: vsix?.browser_download_url };
  } catch (error) {
    log(`plugin update check failed: ${(error as Error).message}`);
    return { installed, update: false };
  }
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
    if (!cli) throw new Error("找不到 VS Code 命令行（code.cmd），请手动安装 VSIX");
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
    if (existsSync(UPDATE_DIR)) {
      // fs.rmSync is imported lazily to keep the happy path dependency-free.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:fs").rmSync(UPDATE_DIR, { recursive: true, force: true });
    }
  } catch {
    /* temp cleanup must never throw */
  }
}

export async function restartHost(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

/** The VS Code CLI lives next to the running app (appRoot = ...\resources\app). */
function findCodeCli(): string | null {
  const exe = process.platform === "win32" ? "code.cmd" : "code";
  const root = vscode.env.appRoot;
  const candidates = [
    root ? join(dirname(root), "bin", exe) : "",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "bin", exe) : "",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Microsoft VS Code", "bin", exe) : "",
  ].filter((p) => p.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function runCli(cli: string, args: string[], log: (message: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const comspec = process.env.ComSpec || "cmd.exe";
    // .cmd shims need cmd.exe; quoting keeps paths with spaces intact.
    const commandLine = `"${cli}" ${args.map((a) => `"${a}"`).join(" ")}`;
    execFile(
      comspec,
      ["/c", commandLine],
      { windowsHide: true, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        for (const line of output.split(/\r?\n/).slice(-6)) log(`code: ${line}`);
        if (error) {
          reject(new Error(error.killed ? "安装命令超时" : error.message));
          return;
        }
        resolve();
      }
    );
  });
}
