import { execFile } from "node:child_process";
import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

/** Temp dirs backing open diff editors; cleaned up on deactivate so a long
 *  session doesn't leak one directory per reviewed file. */
const tempDirs = new Set<string>();

export function cleanupTempDirs(): void {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort — an open editor may still hold the file */
    }
  }
  tempDirs.clear();
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * M3 — native diff review. For each changed file, diff the working tree
 * against git HEAD via VS Code's built-in diff editor (temp file vs real file).
 */
export async function reviewFiles(files: string[]): Promise<void> {
  const unique = [...new Set(files.filter((f) => typeof f === "string" && f.length > 0))];
  if (unique.length === 0) {
    void vscode.window.showInformationMessage("DSH: 还没有捕获到 agent 的文件改动。在侧边栏让 agent 改几个文件后，再点这里。");
    return;
  }

  const items = [
    { label: "$(check-all) 全部（" + unique.length + " 个文件）", description: "逐个打开原生 diff", file: null as string | null },
    ...unique.map((file) => ({
      label: path.basename(file),
      description: path.dirname(file),
      file: file as string | null,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "选择要审查的文件",
    canPickMany: false,
  });
  if (!picked) return;

  const targets = picked.file === null ? unique : [picked.file];
  let opened = 0;
  const failures: string[] = [];
  for (const file of targets) {
    const ok = await openGitDiff(file);
    if (ok) opened++;
    else failures.push(file);
  }
  if (opened > 0) {
    void vscode.window.showInformationMessage(`DSH: 已打开 ${opened} 个 diff。`);
  }
  if (failures.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `DSH: ${failures.length} 个文件无法做 git diff（未跟踪或不在仓库内）。`,
      "直接打开文件"
    );
    if (choice === "直接打开文件") {
      for (const file of failures) {
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
      }
    }
  }
}

async function openGitDiff(file: string): Promise<boolean> {
  try {
    const dir = path.dirname(file);
    const root = (await execGit(["rev-parse", "--show-toplevel"], dir)).trim();
    const rel = path.relative(root, file).replaceAll("\\", "/");
    let head: string;
    try {
      head = await execGit(["show", `HEAD:${rel}`], root);
    } catch {
      return false; // untracked / new file
    }
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "dsh-diff-"));
    tempDirs.add(tmpDir);
    const tmpFile = path.join(tmpDir, path.basename(file) + ".HEAD");
    writeFileSync(tmpFile, head, "utf8");
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(tmpFile),
      vscode.Uri.file(file),
      `HEAD → 工作区: ${rel}`,
      { preview: true }
    );
    return true;
  } catch {
    return false;
  }
}
