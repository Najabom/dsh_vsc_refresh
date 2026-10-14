import * as vscode from "vscode";
import type { HarnessClient } from "../harness/client";

/** Persisted ids of every dedicated ask conversation created in this window
 *  group (one per workspace folder). The main sidebar uses the set to keep
 *  ask conversations out of its auto-open pick. */
const IDS_KEY = "dsh.askSessionIds";

export function askSessionIdSet(context: vscode.ExtensionContext): Set<string> {
  return new Set(context.workspaceState.get<string[]>(IDS_KEY, []));
}

/** Every ask conversation carries this pinned title (official rename —
 *  user-owned, so automatic title generation never replaces it). */
export const ASK_TITLE = "问题对话";

/** A saved mapping only serves the workspace folder it was created for:
 *  a conversation recorded against a different cwd (or one without cwd)
 *  is replaced, so each workspace keeps an independent ask thread. */
function belongsTo(cwd: string | undefined, target: string | undefined): boolean {
  if (target === undefined) return true;
  const norm = (p: string): string => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return cwd !== undefined && norm(cwd) === norm(target);
}

/**
 * M4 — per-workspace dedicated "ask" conversation. ("Ask about selection",
 * and every later ask in the same workspace, rides the same conversation so
 * questions never interleave with the coding chat.) The folder → session
 * mapping is persisted; a stale id (session deleted) is replaced on the fly.
 * The conversation title is pinned to {@link ASK_TITLE}.
 */
export class AskSessions {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private mapKey(cwd: string | undefined): string {
    return `dsh.askSession:${cwd ?? "<none>"}`;
  }

  async resolve(client: HarnessClient, cwd: string | undefined): Promise<string> {
    const key = this.mapKey(cwd);
    const saved = this.context.workspaceState.get<string>(key);
    if (saved) {
      const item = await this.itemOf(client, saved);
      if (item && item.origin !== "subagent" && belongsTo(item.cwd, cwd)) {
        if (item.projections?.values?.title !== ASK_TITLE) await this.pinTitle(client, saved);
        return saved;
      }
    }
    const created = await client.createSession(cwd ? { cwd } : {});
    await this.context.workspaceState.update(key, created.sessionId);
    const ids = askSessionIdSet(this.context);
    ids.add(created.sessionId);
    await this.context.workspaceState.update(IDS_KEY, [...ids]);
    await this.pinTitle(client, created.sessionId);
    return created.sessionId;
  }

  /** Best-effort title pin: never blocks the ask flow. */
  private async pinTitle(client: HarnessClient, sessionId: string): Promise<void> {
    try {
      await client.renameSession(sessionId, ASK_TITLE);
    } catch {
      /* title stays auto-generated; resolve() re-pins on the next ask */
    }
  }

  /** The harness list row for a session, or undefined when it is gone. */
  private async itemOf(client: HarnessClient, sessionId: string) {
    try {
      const { items } = await client.listSessions();
      return items.find((i) => i.sessionId === sessionId);
    } catch {
      return undefined;
    }
  }
}
