import * as vscode from "vscode";
import * as path from "node:path";
import type { SessionEvent } from "../events/eventStream";

/** One agent turn's file mutations, collected from tool/call events. */
export interface ChangeBatch {
  sessionId: string;
  turn: number;
  files: string[];
  endedAt: number;
}

const MUTATING_TOOLS =
  /^(write|edit|patch|apply_patch|fs[_a-z]*write|fs[_a-z]*edit|fs[_a-z]*create|fs[_a-z]*delete|fs[_a-z]*rename|fs[_a-z]*move|fs[_a-z]*mkdir)$/i;
const STR_COMMANDS = new Set(["create", "str_replace", "insert"]);

/** Absolute path a tool call will mutate, or null when it isn't a file edit.
 *  Shared by ChangeTracker and FollowEdits. */
export function mutationTargetOf(name: string, args: Record<string, unknown>): string | null {
  let pathVal: unknown;
  if (name === "str_replace_editor") {
    if (!STR_COMMANDS.has(String(args.command ?? ""))) return null;
    pathVal = args.path;
  } else if (MUTATING_TOOLS.test(name)) {
    pathVal = args.file_path ?? args.path;
  } else {
    return null;
  }
  if (typeof pathVal !== "string" || pathVal.trim().length === 0) return null;
  if (!path.isAbsolute(pathVal)) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) pathVal = path.join(folder.uri.fsPath, pathVal);
    else return null;
  }
  return typeof pathVal === "string" ? pathVal : null;
}

/**
 * M3 — watch the mux event stream for file mutations (write / edit /
 * str_replace_editor), grouped per agent turn. On turn/end a batch fires.
 */
export class ChangeTracker implements vscode.Disposable {
  private batches: ChangeBatch[] = [];
  private files = new Set<string>();
  private turn = 0;
  private onBatchCb: (batch: ChangeBatch) => void = () => {};
  private readonly maxBatches = 20;

  onBatch(cb: (batch: ChangeBatch) => void): void {
    this.onBatchCb = cb;
  }

  handleEvent(sessionId: string, event: SessionEvent): void {
    switch (event.type) {
      case "turn/start": {
        this.turn = Number((event.data as { turn?: unknown } | undefined)?.turn ?? 0);
        this.files = new Set();
        break;
      }
      case "tool/call": {
        const data = (event.data ?? {}) as Record<string, unknown>;
        const name = String(data.name ?? "");
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(String(data.arguments ?? "{}")) as Record<string, unknown>;
        } catch {
          /* keep empty args */
        }
        const file = mutationTargetOf(name, args);
        if (file) this.files.add(file);
        break;
      }
      case "turn/end": {
        if (this.files.size > 0) {
          const batch: ChangeBatch = {
            sessionId,
            turn: this.turn,
            files: [...this.files],
            endedAt: Date.now(),
          };
          this.batches.push(batch);
          if (this.batches.length > this.maxBatches) {
            this.batches.splice(0, this.batches.length - this.maxBatches);
          }
          this.onBatchCb(batch);
          this.files = new Set();
        }
        break;
      }
    }
  }

  /** Deduplicated union of every captured change. */
  latestFiles(): string[] {
    return [...new Set(this.batches.flatMap((b) => b.files))];
  }

  dispose(): void {
    /* nothing to release */
  }
}
