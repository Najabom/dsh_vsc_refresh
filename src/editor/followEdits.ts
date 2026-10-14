import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { mutationTargetOf } from "./changeTracker";
import type { SessionEvent } from "../events/eventStream";

/**
 * Follow the agent's edits: when a file-mutating tool finishes without an
 * error, reveal the touched file in the editor — preview tab, no focus steal,
 * cursor parked on the first changed line — and let VS Code live-reload it as
 * the agent keeps writing.
 *
 * Two wire shapes are traced:
 *  - direct tools: `tool/call` (arguments as JSON string) + success `tool/result`;
 *  - PTC nesting: `tool/ptc-dispatch-start` fires the moment a nested call
 *    begins (pre-edit content is captured then), `tool/ptc-dispatch` on
 *    completion. Nested `tools.write`/`tools.edit` etc. arrive this way.
 *
 * The change line comes from a real disk read: content at start vs content at
 * completion, common-prefix line diff. Shell commands that write files
 * internally (e.g. `pwsh Set-Content`) carry no structured path — not traced.
 */
export class FollowEdits implements vscode.Disposable {
  /** scope id (callId / subCallId) -> target file + content before the mutation. */
  private pending = new Map<string, { path: string; oldText: string | null }>();
  private followEnabled: boolean;
  private readonly configListener: vscode.Disposable;

  constructor(private readonly log: (message: string) => void) {
    this.followEnabled = vscode.workspace.getConfiguration("dshVsc").get<boolean>("followAgentEdits", true);
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("dshVsc.followAgentEdits")) return;
      this.followEnabled = vscode.workspace.getConfiguration("dshVsc").get<boolean>("followAgentEdits", true);
      if (!this.followEnabled) this.pending.clear();
    });
  }

  handleEvent(_sessionId: string, event: SessionEvent): void {
    if (!this.followEnabled) return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "tool/call": {
        const args = parseArgs(data.arguments);
        if (args) this.noteStart(String(data.callId ?? ""), String(data.name ?? ""), args);
        return;
      }
      case "tool/ptc-dispatch-start": {
        const args = parseArgs(data.arguments);
        if (args) this.noteStart(String(data.subCallId ?? ""), String(data.name ?? ""), args);
        return;
      }
      case "tool/result": {
        const message = (data.message ?? {}) as Record<string, unknown>;
        // v4 wire: the tool-result MESSAGE itself carries toolCallId / isError.
        // The retired v3 wrapper (a content[type='tool-result'] block) stays as
        // a fallback so migrated old logs still resolve.
        const scopeId = String(data.callId ?? message.toolCallId ?? toolResultField(data, "toolCallId") ?? "");
        const failed = message.isError === true || toolResultField(data, "isError") === true;
        this.complete(scopeId, failed);
        return;
      }
      case "tool/ptc-dispatch": {
        this.complete(String(data.subCallId ?? ""), data.isError === true);
        return;
      }
      default:
        return;
    }
  }

  /** Remember the pre-edit content of the file a mutation is about to touch. */
  private noteStart(scopeId: string, name: string, args: Record<string, unknown>): void {
    if (!scopeId) return;
    const target = mutationTargetOf(name, args);
    if (!target) return;
    this.pending.set(scopeId, { path: target, oldText: readTextIfExists(target) });
    if (this.pending.size > 400) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
  }

  /** Mutation finished: diff disk before/after and reveal the first change. */
  private complete(scopeId: string, failed: boolean): void {
    const entry = this.pending.get(scopeId);
    if (!entry) return;
    this.pending.delete(scopeId);
    if (failed) return;
    const newText = readTextIfExists(entry.path);
    const line = entry.oldText === null || newText === null ? 0 : firstChangedLine(entry.oldText, newText);
    this.reveal(entry.path, line);
  }

  /** Reveal an externally changed file (shell write / untracked tool). No
   *  line information is available — the file opens at the top. */
  revealExternal(target: string): void {
    if (!this.followEnabled) return;
    this.reveal(target, 0);
  }

  private reveal(target: string, line: number): void {
    // Only reveal files inside an open workspace folder — never pop unrelated
    // system paths into the editor.
    if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target))) return;
    void vscode.workspace.openTextDocument(vscode.Uri.file(target)).then(
      (doc) => {
        const lastLine = Math.max(0, doc.lineCount - 1);
        const ln = Math.min(Math.max(0, line), lastLine);
        this.log(`follow edits: reveal ${target}:${ln + 1}`);
        const selection = new vscode.Range(ln, 0, ln, 0);
        return vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, selection });
      },
      (error) => this.log(`follow edits: cannot open ${target}: ${(error as Error).message}`),
    );
  }

  dispose(): void {
    this.pending.clear();
    this.configListener.dispose();
  }
}

/** File content, or null when the file does not exist / cannot be read. */
function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * First line that differs between the two snapshots (0-based). Content that
 * shrank/ended early anchors at its last line; unchanged content anchors at 0.
 */
function firstChangedLine(oldText: string, newText: string): number {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let i = 0;
  while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) i++;
  if (i >= oldLines.length && i >= newLines.length) return 0;
  return Math.max(0, Math.min(i, newLines.length - 1));
}

/** Legacy fallback: a field on the retired v3 tool-result content block. */
function toolResultField(data: Record<string, unknown>, field: string): unknown {
  const message = data.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];
  for (const block of blocks) {
    if (block && block.type === "tool-result") return block[field];
  }
  return undefined;
}

/** Tool arguments as a record; tolerates both the object and JSON-string wire shapes. */
function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return null;
}
