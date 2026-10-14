import * as vscode from "vscode";
import type { HarnessClient } from "../harness/client";
import { currentEditorContext, formatEditorContext } from "./context";

export const INTENT_CHOICES = [
  { id: "explain", label: "解释", detail: "解释这段代码在做什么、为什么这么写" },
  { id: "review", label: "代码审查", detail: "审查这段代码的问题与改进点" },
  { id: "fix", label: "修复/改进", detail: "让 agent 直接修改这段代码" },
  { id: "custom", label: "自定义…", detail: "自己输入指令" },
];

const SELECTION_CAP = 4000;

/**
 * Build the structured editor-context block for the current selection.
 * Returns null when there is no usable selection (caller decides the message).
 */
export async function buildSelectionContext(): Promise<string | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return null;
  const ctx = await currentEditorContext();
  return formatEditorContext(ctx, SELECTION_CAP);
}

/*
 * M2 — the native context bridge.
 * Right-click a selection → "DSH: Ask about selection" → the command builds a
 * structured context block (file / lines / excerpt) and posts it to the
 * sidebar as an in-panel ask card (NativePanelProvider.showAskCard); the
 * picked intent is shipped by sendAsk(). The agent reads the rest of the file
 * itself with its fs tools.
 */

/** Message text shipped to the harness for an ask (context + instruction). */
export function askPromptText(contextBlock: string, instruction: string): string {
  return `${contextBlock}\n\n----\n指令：${instruction}`;
}

/** Assemble the prompt text and queue it into the most recent non-blank
 *  session (creating one if needed). Shared by the panel card path and the
 *  legacy quick-pick path. */
export async function sendAsk(
  client: HarnessClient,
  contextBlock: string,
  instruction: string,
  excludeSessionIds?: ReadonlySet<string>,
): Promise<void> {
  const message = askPromptText(contextBlock, instruction);
  const sessionId = await targetSession(client, excludeSessionIds);
  await client.prompt(sessionId, [{ type: "text", text: message }], "queue");
  const short = sessionId.replace(/^session-/, "").slice(0, 8);
  void vscode.window.showInformationMessage(`DSH: 已排队发送到会话 ${short}（${instruction}）。`);
  void vscode.commands.executeCommand("dsh.sidebar.right.focus");
}

/** Pick the most recently updated non-blank session; create one if none exists. */
export async function targetSession(client: HarnessClient, excludeSessionIds?: ReadonlySet<string>): Promise<string> {
  const { items } = await client.listSessions();
  // Only top-level user sessions are queue targets: subagent children
  // (origin: "subagent") belong to their parent conversation (official
  // sessionVisible contract) and must not swallow queued messages.
  const usable = items.filter(
    (item) => !item.blank && item.origin !== "subagent" && !excludeSessionIds?.has(item.sessionId),
  );
  if (usable.length > 0) {
    usable.sort((a, b) => b.updatedAt - a.updatedAt);
    return usable[0].sessionId;
  }
  const created = await client.call<{ sessionId: string }>("session/create", { request: {} });
  return created.sessionId;
}
