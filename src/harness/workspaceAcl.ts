/**
 * Windows workspace ACL guard.
 *
 * The DSH workspace-write sandbox stamps a Low mandatory label onto the
 * session workspace root; writing that label (it lives in the SACL) needs
 * WRITE_OWNER on the directory, which owner-implicit rights do NOT include.
 * Folders copied from another machine (old-SID owners, no direct ACE for the
 * current user) grant only "Modify", so the sandbox's grantWrite fails with
 * `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)` and every
 * sandboxed tool call dies before it starts.
 *
 * This guard restores the standard Windows folder shape — the current user
 * with Full control — so workspace switching keeps working:
 *   - directory owned by the user: a silent no-elevation icacls grant;
 *   - owned by another identity: report `needs-elevation` (the caller offers
 *     the one-time UAC repair via {@link repairWorkspaceAclElevated}).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

export type WorkspaceAclResult = "ok" | "needs-elevation" | "failed" | "skipped";

function domainUser(): string {
  return `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;
}

function run(
  command: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      const err = error as (Error & { code?: unknown }) | null;
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Ensure the DSH sandbox can operate in `dir`: the current user needs Full
 * control (WRITE_OWNER specifically) on the directory. `icacls /grant` with an
 * already-present identical ACE is a no-op, so the apply doubles as the probe
 * — no separate access check needed. Never throws.
 */
export async function ensureWorkspaceAcl(
  dir: string,
  log: (message: string) => void
): Promise<WorkspaceAclResult> {
  if (process.platform !== "win32") return "skipped";
  const enabled = vscode.workspace
    .getConfiguration("dshVsc")
    .get<boolean>("autoFixWorkspaceAcl", true);
  if (!enabled) return "skipped";
  try {
    if (!fs.statSync(dir).isDirectory()) return "skipped";
  } catch {
    return "failed";
  }
  const result = await run("icacls", [dir, "/grant", `${domainUser()}:(OI)(CI)(F)`]);
  if (result.code === 0) {
    log(`workspace ACL ok: ${dir}`);
    return "ok";
  }
  const firstLine = (result.stderr || result.stdout).trim().split(/\r?\n/)[0] ?? "icacls failed";
  log(`workspace ACL needs elevation: ${dir} — ${firstLine}`);
  return "needs-elevation";
}

/**
 * One-time elevated repair (UAC): the same grant, run as administrator.
 * The elevated helper is launched through a temp script so no quoting layer
 * can corrupt a path. Resolves true when the elevated icacls exits 0.
 */
export async function repairWorkspaceAclElevated(
  dir: string,
  log: (message: string) => void
): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const script = join(tmpdir(), `dsh-vsc-acl-fix-${Date.now()}-${process.pid}.ps1`);
  const body = [
    "$ErrorActionPreference = 'Stop'",
    `$grant = '${domainUser()}:(OI)(CI)(F)'`,
    `$p = Start-Process -FilePath icacls.exe -ArgumentList '"${dir.replace(/'/g, "''")}"','/grant',('"' + $grant + '"') -Verb RunAs -Wait -PassThru`,
    "exit $p.ExitCode",
  ].join("\r\n");
  // UTF-8 BOM: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI, which
  // would corrupt non-ASCII workspace paths baked into the script text.
  fs.writeFileSync(script, `\uFEFF${body}`, "utf8");
  try {
    const result = await run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
    ]);
    if (result.code === 0) {
      log(`workspace ACL repaired (elevated): ${dir}`);
      return true;
    }
    log(`workspace ACL elevated repair failed: ${dir} — ${(result.stderr || result.stdout).trim()}`);
    return false;
  } finally {
    try {
      fs.unlinkSync(script);
    } catch {
      /* best effort */
    }
  }
}
