import * as vscode from "vscode";
import type { SessionEvent } from "../events/eventStream";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 100;
/** Path segments never worth following: VCS metadata, dependency trees, and
 *  PlatformIO build output (the workspace we grew up in). */
const SKIPPED_SEGMENTS = new Set([".git", "node_modules", ".pio"]);

/**
 * Catch file changes that tool events cannot see — shell commands that write
 * files (`pwsh Set-Content`, `git checkout`, build steps, …) carry no
 * structured path. While an agent turn is running we listen to the workspace
 * filesystem; at turn/end the changed set is filtered (inside a workspace
 * folder, regular files, size cap) and handed to the ChangeTracker batch and
 * the FollowEdits revealer, so statistics and follow-edits cover them too.
 */
export class ExternalChanges implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly watcherDisposables: vscode.Disposable[] = [];
  /** Running turns per session (the ask window and the sidebar can overlap). */
  private readonly pending = new Map<string, { turn: number; files: Set<string> }>();

  constructor(
    private readonly log: (message: string) => void,
    private readonly onExternal: (sessionId: string, turn: number, files: string[]) => void,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const note = (uri: vscode.Uri): void => this.note(uri);
    this.watcherDisposables.push(
      this.watcher.onDidChange(note),
      this.watcher.onDidCreate(note),
      this.watcher.onDidDelete(note),
    );
  }

  handleEvent(sessionId: string, event: SessionEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "turn/start": {
        this.pending.set(sessionId, { turn: Number(data.turn ?? 0), files: new Set() });
        return;
      }
      case "turn/end": {
        const slot = this.pending.get(sessionId);
        this.pending.delete(sessionId);
        if (!slot) return;
        const candidates = [...slot.files];
        if (candidates.length === 0) return;
        void this.finalize(sessionId, slot.turn, candidates);
        return;
      }
      default:
        return;
    }
  }

  private note(uri: vscode.Uri): void {
    if (this.pending.size === 0 || uri.scheme !== "file") return;
    const fsPath = uri.fsPath;
    if (isExcluded(fsPath)) return;
    if (!vscode.workspace.getWorkspaceFolder(uri)) return;
    // Attribute to every active turn (a concurrent ask turn + coding turn
    // cannot be told apart from the event alone; batches dedupe downstream).
    for (const slot of this.pending.values()) {
      if (slot.files.size >= MAX_FILES) continue;
      slot.files.add(fsPath);
    }
  }

  /** Directories and oversized files are dropped once the turn is over. */
  private async finalize(sessionId: string, turn: number, candidates: string[]): Promise<void> {
    const kept: string[] = [];
    for (const fsPath of candidates) {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
        if (stat.type !== vscode.FileType.File) continue;
        if (stat.size > MAX_FILE_BYTES) continue;
        kept.push(fsPath);
      } catch {
        // Deleted (or moved) again before the turn ended — that is a change.
        kept.push(fsPath);
      }
    }
    if (kept.length === 0) return;
    this.log(`external file changes: ${kept.length} file(s) this turn (shell / untracked tools)`);
    this.onExternal(sessionId, turn, kept);
  }

  dispose(): void {
    this.pending.clear();
    this.watcher.dispose();
    for (const disposable of this.watcherDisposables) disposable.dispose();
  }
}

function isExcluded(fsPath: string): boolean {
  for (const segment of fsPath.split(/[\\/]+/)) {
    if (SKIPPED_SEGMENTS.has(segment)) return true;
  }
  return false;
}
