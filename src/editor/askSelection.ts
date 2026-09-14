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

/**
 * M2 — the native context bridge.
 * Right-click a selection → "DSH: Ask about selection" → a structured
 * context block (file / lines / excerpt) is queued into the latest session.
 * The agent reads the rest of the file itself with its fs tools.
 *
 * Fallback path (no sidebar panel available): the same flow via the legacy
 * VS Code quick-pick UI. The preferred path posts an in-panel ask card; see
 * NativePanelProvider.showAskCard.
 */
export async function askSelection(getClient: () => HarnessClient | null): Promise<void> {
  const block = await buildSelectionContext();
  if (block === null) {
    void vscode.window.showWarningMessage("DSH: 请先在编辑器里选中要询问的代码。");
    return;
  }

  const client = getClient();
  if (!client) {
    const choice = await vscode.window.showWarningMessage("DSH: harness 未连接。", "启动 harness");
    if (choice === "启动 harness") {
      void vscode.commands.executeCommand("dsh.start");
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(
    INTENT_CHOICES.map(({ id, label, detail }) => ({ label, detail, id })),
    { placeHolder: "要 agent 对这个选区做什么？" }
  );
  if (!picked) return;

  let instruction: string;
  if (picked.id === "custom") {
    const input = await vscode.window.showInputBox({
      prompt: "指令",
      placeHolder: "例如：这段代码有什么 bug？怎么修？",
    });
    if (input === undefined) return;
    instruction = input.trim();
    if (!instruction) return;
  } else {
    instruction = picked.label;
  }

  await sendAsk(client, block, instruction);
}

/** Assemble the prompt text and queue it into the most recent non-blank
 *  session (creating one if needed). Shared by the panel card path and the
 *  legacy quick-pick path. */
export async function sendAsk(client: HarnessClient, contextBlock: string, instruction: string): Promise<void> {
  const message = `${contextBlock}\n\n----\n指令：${instruction}`;
  const sessionId = await targetSession(client);
  await client.prompt(sessionId, [{ type: "text", text: message }], "queue");
  const short = sessionId.replace(/^session-/, "").slice(0, 8);
  void vscode.window.showInformationMessage(`DSH: 已排队发送到会话 ${short}（${instruction}）。`);
  void vscode.commands.executeCommand("dsh.sidebar.right.focus");
}

/** Pick the most recently updated non-blank session; create one if none exists. */
export async function targetSession(client: HarnessClient): Promise<string> {
  const { items } = await client.listSessions();
  // Only top-level user sessions are queue targets: subagent children
  // (origin: "subagent") belong to their parent conversation (official
  // sessionVisible contract) and must not swallow queued messages.
  const usable = items.filter((item) => !item.blank && item.origin !== "subagent");
  if (usable.length > 0) {
    usable.sort((a, b) => b.updatedAt - a.updatedAt);
    return usable[0].sessionId;
  }
  const created = await client.call<{ sessionId: string }>("session.create", {});
  return created.sessionId;
}
