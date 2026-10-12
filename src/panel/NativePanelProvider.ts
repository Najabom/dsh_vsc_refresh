import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { HarnessClient, RpcErrorResult } from "../harness/client";
import type { ModelSelection, ModelSelectionProjection, PromptContentPart, QueueAction, SessionSummary } from "../harness/protocol";
import type { WaterfallFrame, WorkspaceState } from "../events/eventStream";
import type { HostMessage, PanelEvent, PanelSession, TodoItem, ToolLineDiff, WebviewMessage } from "./protocol";
import { countMetaDiff, countToolArgsDiff } from "../editor/diffCount";
import { INTENT_CHOICES, sendAsk } from "../editor/askSelection";
import { deleteSessionStorage } from "../harness/storage";
import { ensureWorkspaceAcl } from "../harness/workspaceAcl";

/**
 * Display copy for the four shipped agent presets — the official zh text from
 * the harness's config agent-presets preset.yml files (name + description),
 * the same strings the DSH web GUI's preset picker shows for system presets.
 * Used as a fallback so the ＋ mode dropdown renders official copy even when
 * the roster entry carries no name/description; live roster wins when present.
 */
const OFFICIAL_PRESET_COPY: Record<string, { name: string; description: string }> = {
  standard: {
    name: "标准模式",
    description: "功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。",
  },
  ptc: {
    name: "PTC 模式",
    description: "具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作。",
  },
  code: {
    name: "PTC 模式",
    description: "具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作。",
  },
  minimal: {
    name: "极简模式",
    description: "仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。",
  },
  cordis: {
    name: "创造模式",
    description: "用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。",
  },
};

/**
 * Chinese copy for the harness's attachment-admission refusals
 * (dsh-attachment `ATTACHMENT_REASONS`). On the wire these arrive as
 * `attachment-error` with `details.reason`; their English text is what reached
 * users as a bare red warning that looked like a defect in this extension.
 */
/**
 * Chinese copy for the harness's attachment-admission refusals
 * (dsh-attachment `ATTACHMENT_REASONS`). On the wire these arrive as
 * `attachment-error` with `details.reason`; their English text is what reached
 * users as a bare red warning that looked like a defect in this extension.
 *
 * WORDS ONLY: the request still travels to the harness and the harness still
 * refuses it, so core keeps behaving — and logging — exactly as before. No
 * limit is duplicated here: quoting this deployment's numbers would be the
 * bridge re-modelling a core fact that the deployment config owns.
 */
const ATTACHMENT_REASON_COPY: Record<string, string> = {
  IMAGE_DIMENSION_TOO_LARGE: "图片单边像素超过本体上限，请先裁剪或缩小后再发。",
  IMAGE_TOO_MANY_PIXELS: "图片总像素超过本体上限，请先缩小后再发。",
  IMAGE_TOO_LARGE: "单张图片体积超过本体上限，请压缩后再发。",
  TOO_MANY_IMAGES: "单条消息的图片数量超过本体上限，请分批发送。",
  IMAGES_TOO_LARGE: "单条消息的图片总体积超过本体上限，请分批发送。",
  UNSUPPORTED_IMAGE_TYPE: "本部署不接受这种图片格式。",
  IMAGE_TYPE_MISMATCH: "图片实际格式与声明的类型不一致，请重新复制粘贴。",
  INVALID_IMAGE: "图片已损坏或格式无法识别，请重新复制粘贴。",
  INVALID_IMAGE_BASE64: "图片数据不完整，请重新复制粘贴。",
  INVALID_ATTACHMENT_REF: "这个图片引用无效（会话记录里查不到）。",
  ATTACHMENT_NOT_FOUND: "这张图片在本体里已不存在（可能已被清理）。",
  ATTACHMENT_NOT_REFERENCED: "这张图片不属于当前会话，本体拒绝读取。",
  ATTACHMENT_CORRUPT: "本体里的这张图片已损坏，无法读取。",
  ATTACHMENT_READ_FAILED: "本体读取这张图片失败。",
  ATTACHMENT_WRITE_FAILED: "本体保存这张图片失败（磁盘或权限问题）。",
};

/**
 * Turn any request failure into Chinese panel copy — presentation only.
 *
 * The harness answers refusals with English code+message pairs
 * (`attachment-error` with a `details.reason`, `model-unavailable`, …). Shown
 * verbatim they read like a defect in this extension, so every harness refusal
 * is translated AND explicitly attributed to DSH core; an unknown refusal keeps
 * its code for support while still naming the source. Local (VS Code / fs)
 * failures just get the Chinese prefix.
 */
function describeHarnessFailure(prefix: string, error: unknown): string {
  if (error instanceof RpcErrorResult) {
    const { code, message, details } = error.rpcError;
    const reason = typeof details.reason === "string" ? details.reason : undefined;
    if (code === "attachment-error" && reason && ATTACHMENT_REASON_COPY[reason]) {
      return `${prefix}：${ATTACHMENT_REASON_COPY[reason]}（DSH 本体限制，不是本扩展的问题）`;
    }
    if (code === "model-unavailable") {
      return `${prefix}：该模型不接受图像输入，而本会话已包含图片（DSH 本体的限制，不是本扩展的问题）。请改选支持图像输入的模型。`;
    }
    return `${prefix}：DSH 本体拒绝了这次请求（${code}）。原文：${message}`;
  }
  return `${prefix}：${(error as Error).message}`;
}

/** Flatten a content-block array into display text (queue rows, inbox). */
function textOf(content: { type?: string; text?: string }[] | undefined): string {
  return (content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/** Case/trailing-separator-insensitive path compare (Windows-shaped paths). */
function normalizePath(p: string): string {
  return p.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * Phase 1 — native sidebar chat panel.
 * Renders the conversation natively (VS Code themed), driven by the mux event
 * stream + session/page history, with prompt via session/prompt. This replaces
 * the embedded DSH webview as the main surface (embed moves to dsh.openWebView).
 */
export class NativePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dsh.sidebar.right";

  private view?: vscode.WebviewView;
  /** True once the webview routers were registered (views can be revived). */
  private wired = false;
  private client: HarnessClient | null = null;
  private activeSessionId: string | null = null;
  /** Manual workspace override picked from the panel header (folder dialog);
   *  wins over the VS Code folder for NEW sessions until the window reloads. */
  private manualWorkspace: string | undefined;
  /** One auto-created session per panel lifetime when the harness has none. */
  private autoCreatedWorkspace = false;
  private sessions: PanelSession[] = [];
  private titles = new Map<string, string>();
  private connected = false;
  private version?: string;
  private phase: "searching" | "starting" | "online" | "offline" = "searching";
  /** Live todo list of the active session (todos projection, realtime push). */
  private todos: TodoItem[] = [];
  /**
   * Pending file-mutation calls (callId → name+args), kept so the tool/result
   * can refine the bridge-computed diff with the tool's own meta.diffs hunks.
   */
  private pendingArgs = new Map<string, { name: string; args: Record<string, unknown>; path?: string }>();
  private readonly maxPendingArgs = 400;
  /** Context block of a pending in-panel ask card (set by showAskCard). */
  private askContext: string | null = null;
  /** Ask card posted before the view was ready; flushed on the webview's ready. */
  private pendingAsk: { context: string; choices: typeof INTENT_CHOICES } | null = null;
  /** Archived session ids (workspace/follow baseline + archived increments). */
  private archivedSessionIds = new Set<string>();
  /** Sessions hard-deleted from disk this window — hidden until the harness forgets them. */
  private hardDeletedSessionIds = new Set<string>();
  /** Durable model selection per session (the `modelSelection` projection:
   *  next ?? lastUsed). The model catalog's `default` is the deployment
   *  fallback, NOT the session's pick — without this map the model button
   *  shows a stale label and an effort-only switch re-sends the wrong model. */
  private modelSelections = new Map<string, ModelSelection>();
  /** Latest session/control projection values per session (key → value). */
  private projections = new Map<string, Map<string, unknown>>();
  /** session/list journal cursor per session (projections.asOfSeq). */
  private cursors = new Map<string, number>();
  /** Permission preset options (permissionPresets/catalog; projection carries
   *  only the current value in 0.1.7). */
  private permissionOptions: { value: string; name?: string }[] = [];
  private currentPermission: string | undefined;
  /** mux clientId of the $events stream — required by $events/result. */
  private eventClientId = "";
  /** Pending waterfall requests: eventId → sessionId. */
  private pendingWaterfalls = new Map<string, { sessionId: string; message: HostMessage }>();
  /** Opens/closes the per-session follow stream (handed in by extension.ts). */
  private setFollowSession: (sessionId: string | null) => void = () => {};

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly getClient: () => HarnessClient | null,
    private readonly onSessionEvent: (cb: (sessionId: string, event: PanelEvent) => void) => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const html = this.renderHtml();
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "media")],
    };
    webviewView.webview.html = html;
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
    if (this.wired) {
      // Webview views can be revived after being hidden: the provider instance
      // survives, so register the routers only once per host session.
      return;
    }
    this.wired = true;
    webviewView.webview.onDidReceiveMessage((message) => {
      void this.onMessage(message as WebviewMessage);
    });
    // Route mux events into this panel (filtered by active session host-side).
    this.onSessionEvent((sessionId, event) => {
      this.trackRunning(sessionId, event);
      if (sessionId !== this.activeSessionId) return;
      // Bridge-computed per-call line diffs ride alongside the raw event so
      // the panel can show "+N-M" on the tool card immediately (and refine it
      // once the tool's own result-time hunks land).
      if (event.type === "tool/call") {
        this.handleToolCallDiff(sessionId, event);
      } else if (event.type === "tool/result") {
        this.handleToolResultDiff(sessionId, event);
      }
      this.post({ type: "event", sessionId, event });
    });
    // Keep the @ file index fresh.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.buildFileIndex()),
      vscode.workspace.onDidCreateFiles(() => void this.buildFileIndex()),
      vscode.workspace.onDidDeleteFiles(() => void this.buildFileIndex())
    );
  }

  /** Called by extension.ts when harness connectivity changes. */
  setClient(client: HarnessClient | null, version?: string): void {
    this.client = client;
    this.connected = client !== null;
    this.version = version;
    this.phase = client ? "online" : "offline";
    if (!client && this.pendingWaterfalls.size) {
      // Harness went away mid-question: settle the cards so the input is not
      // locked forever behind an answer that can no longer be delivered.
      for (const [eventId, entry] of this.pendingWaterfalls) {
        this.post({ type: "interactionSettled", sessionId: entry.sessionId, rpcId: eventId });
      }
      this.pendingWaterfalls.clear();
    }
    void this.refresh();
    void this.loadPermissionCatalog();
  }

  /** Loading-phase hint from the extension (searching / starting). */
  setPhase(phase: "searching" | "starting" | "online" | "offline"): void {
    this.phase = phase;
    this.postState();
  }

  /**
   * Show an in-panel "ask about selection" card (preferred path for
   * dsh.askSelection): the editor context block is rendered inside the
   * sidebar with the intent choices, so the whole flow stays in the panel
   * instead of a VS Code quick-pick. The pick is answered via askPick /
   * askCancel and shipped by sendAsk().
   */
  showAskCard(contextBlock: string): void {
    this.askContext = contextBlock;
    if (this.view) {
      this.post({ type: "ask", context: contextBlock, choices: INTENT_CHOICES });
    } else {
      // Sidebar never opened: keep the card until the webview reports ready.
      this.pendingAsk = { context: contextBlock, choices: INTENT_CHOICES };
    }
  }

  /** extension.ts hands in the follow-stream control after creating the mux. */
  attachStream(controls: { setFollowSession: (sessionId: string | null) => void }): void {
    this.setFollowSession = controls.setFollowSession;
  }

  /** Follow the active session on the mux (idempotent). */
  private followActive(): void {
    this.setFollowSession(this.activeSessionId);
  }

  /** session/control push: projection values are cached per session; the ones
   *  the open panel renders (todos/permissions/inbox/title/usage) are applied
   *  live, the rest ride the cache until the session is selected. */
  onProjection(sessionId: string, key: string, value: unknown): void {
    let values = this.projections.get(sessionId);
    if (!values) {
      values = new Map<string, unknown>();
      this.projections.set(sessionId, values);
    }
    values.set(key, value);
    if (key === "modelSelection") {
      this.noteModelSelection(sessionId, value);
      if (sessionId === this.activeSessionId) void this.postModels();
      return;
    }
    if (sessionId !== this.activeSessionId) return;
    if (key === "todos") {
      // The current turn's whole task list — reset to an empty array on every
      // turn/start (mirrors the web GUI's task bar exactly).
      this.todos = Array.isArray(value) ? (value as TodoItem[]) : [];
      this.post({ type: "todos", sessionId, items: this.todos });
      return;
    }
    if (key === "permissions") {
      const current = (value as { currentValue?: string } | null | undefined)?.currentValue;
      this.currentPermission = typeof current === "string" ? current : undefined;
      this.log(`permission projection: ${sessionId.slice(0, 18)} -> ${this.currentPermission ?? "?"}`);
      this.postPermissions();
      return;
    }
    if (key === "inbox") {
      this.postQueue(sessionId, value);
      return;
    }
    if (key === "title") {
      const title = typeof value === "string" ? value : (value as { title?: string } | null | undefined)?.title;
      if (typeof title === "string") {
        this.titles.set(sessionId, title);
        this.postState();
      }
      return;
    }
    if (key === "tokenUsage" || key === "sessionStats" || key === "contextPressure") {
      const row = this.sessions.find((s) => s.sessionId === sessionId);
      if (row) {
        if (key === "tokenUsage") row.usage = (value ?? undefined) as PanelSession["usage"];
        else if (key === "sessionStats") row.stats = (value ?? undefined) as PanelSession["stats"];
        else row.context = (value ?? undefined) as PanelSession["context"];
        this.postState();
      }
    }
  }

  /** workspace/follow: the archived set changed — re-filter the session list. */
  onWorkspace(state: WorkspaceState): void {
    this.archivedSessionIds = new Set((state.archivedSessionIds ?? []).map(String));
    if (this.connected) void this.refresh();
  }

  /** $events emit: host-level session-list / status / command-catalog deltas. */
  onApiSession(event: string, args: unknown[]): void {
    if (event === "api-session/added") {
      const item = args[0] as SessionSummary | undefined;
      if (!item || typeof item.sessionId !== "string") return;
      const asOf = item.projections?.asOfSeq;
      if (typeof asOf === "number") this.cursors.set(item.sessionId, asOf);
      if (item.blank || item.origin === "subagent" || this.archivedSessionIds.has(item.sessionId) || this.hardDeletedSessionIds.has(item.sessionId)) return;
      const row = this.toPanelSession(item);
      const index = this.sessions.findIndex((s) => s.sessionId === item.sessionId);
      if (index >= 0) this.sessions[index] = { ...this.sessions[index], ...row };
      else this.sessions.unshift(row);
      this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      this.postState();
      return;
    }
    if (event === "api-session/status") {
      const sessionId = String(args[0] ?? "");
      const running = args[1] === true;
      const row = this.sessions.find((s) => s.sessionId === sessionId);
      if (row) row.running = running;
      if (sessionId) this.post({ type: "running", sessionId, running });
      if (sessionId === this.activeSessionId) this.postState();
      return;
    }
    if (event === "api-session/removed") {
      const sessionId = String(args[0] ?? "");
      if (!sessionId) return;
      this.sessions = this.sessions.filter((s) => s.sessionId !== sessionId);
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
        this.followActive();
      }
      this.postState();
      return;
    }
    if (event === "commands/change") {
      void this.postCommands();
      return;
    }
    if (event.startsWith("plugin-manager/")) {
      if (event === "plugin-manager/changed") {
        if (this.settingsPanel) void this.postPlugins();
        return;
      }
      if (event === "plugin-manager/install-state") {
        this.postSettingsMessage({ type: "pluginInstallProgress", value: args[0] ?? null });
        return;
      }
      if (event === "plugin-manager/install-log") {
        this.postSettingsMessage({ type: "pluginInstallLog", value: args[0] ?? null });
      }
    }
  }

  /** $events waterfall: answerable approval / question cards (0.1.7 replaces
   *  the old approval/requested + question/requested mux frames). */
  onWaterfall(frame: WaterfallFrame): void {
    if (frame.clientId) this.eventClientId = frame.clientId;
    const sessionId = frame.agentId || this.activeSessionId || "";
    const request = frame.request ?? {};
    if (frame.event === "approval/request") {
      const display = request.displayReason as { en?: string; zh?: string } | undefined;
      const reason =
        display?.zh ??
        display?.en ??
        (typeof request.reason === "string" ? request.reason : undefined);
      // Sandbox escalation prompts carry "escalate sandbox to <mode>: <why>";
      // the mode lets the card offer "永久允许" (preset switch after answering).
      const escalate =
        typeof request.reason === "string"
          ? /escalate sandbox to (workspace-write|danger-full-access)/i.exec(request.reason)
          : null;
      this.rememberWaterfall(frame.eventId, sessionId, {
        type: "interaction",
        sessionId,
        rpcId: frame.eventId,
        kind: "approval",
        // 0.1.7 carries no approvalId — the callId (or the waterfall eventId)
        // is the stable identity the panel echoes back when answering.
        approvalId: String(request.callId ?? frame.eventId),
        toolName: String(request.toolName ?? ""),
        callId: request.callId !== undefined ? String(request.callId) : undefined,
        reason,
        escalationMode: escalate ? escalate[1] : undefined,
      });
      return;
    }
    if (frame.event === "user-questions/request") {
      const raw = Array.isArray(request.questions) ? (request.questions as Record<string, unknown>[]) : [];
      this.rememberWaterfall(frame.eventId, sessionId, {
        type: "interaction",
        sessionId,
        rpcId: frame.eventId,
        kind: "question",
        questions: raw.map((q) => ({
          id: String(q.id ?? ""),
          question: String(q.question ?? ""),
          detail: q.detail !== undefined ? String(q.detail) : undefined,
          header: q.header !== undefined ? String(q.header) : undefined,
          multiSelect: q.multiSelect === true,
          options: Array.isArray(q.options)
            ? (q.options as Record<string, unknown>[]).map((o) => ({
                label: String(o.label ?? ""),
                description: o.description !== undefined ? String(o.description) : undefined,
              }))
            : undefined,
          intent:
            q.intent && typeof q.intent === "object"
              ? {
                  kind: String((q.intent as Record<string, unknown>).kind ?? ""),
                  approve: String((q.intent as Record<string, unknown>).approve ?? ""),
                }
              : undefined,
        })),
      });
    }
  }

  /** Cache an unanswered waterfall's card (so re-selecting the session can
   *  re-show it) and post it to the panel. */
  private rememberWaterfall(eventId: string, sessionId: string, message: HostMessage): void {
    this.pendingWaterfalls.set(eventId, { sessionId, message });
    if (this.pendingWaterfalls.size > 200) {
      const oldest = this.pendingWaterfalls.keys().next().value;
      if (oldest !== undefined) this.pendingWaterfalls.delete(oldest);
    }
    this.post(message);
  }

  /** $events cancel: the waterfall was withdrawn (e.g. the run ended). */
  onWaterfallCancel(eventId: string): void {
    const sessionId = this.pendingWaterfalls.get(eventId)?.sessionId ?? this.activeSessionId ?? "";
    this.pendingWaterfalls.delete(eventId);
    this.post({ type: "interactionSettled", sessionId, rpcId: eventId });
  }

  /** Render the inbox projection as the pending-send rows above the input. */
  private postQueue(sessionId: string, inbox: unknown): void {
    const v = (inbox ?? {}) as {
      "next-turn"?: { id?: string; content?: { type?: string; text?: string }[] }[];
      "next-step"?: { id?: string; content?: { type?: string; text?: string }[] }[];
    };
    this.post({
      type: "queue",
      sessionId,
      items: [
        ...(v["next-turn"] ?? []).map((row) => ({ id: String(row.id ?? ""), placement: "queued", text: textOf(row.content) })),
        ...(v["next-step"] ?? []).map((row) => ({ id: String(row.id ?? ""), placement: "steering", text: textOf(row.content) })),
      ],
    });
  }

  async refresh(): Promise<void> {
    if (!this.client) {
      this.post({ type: "state", connected: false, sessions: [], activeSessionId: null });
      return;
    }
    try {
      const { items } = await this.client.listSessions();
      // Cache each session's journal cursor (projections.asOfSeq) while the
      // list is in hand — session/page refuses throughSeq past the cursor.
      for (const item of items) {
        const asOf = item.projections?.asOfSeq;
        if (typeof asOf === "number") this.cursors.set(item.sessionId, asOf);
        this.noteModelSelection(item.sessionId, item.projections?.values?.modelSelection);
      }
      // Fresh harness with no sessions at all: adopt the open VS Code folder
      // as the workspace right away instead of making the user create a
      // session (and pick a folder) by hand. Fires once per panel lifetime.
      if (items.length === 0 && !this.autoCreatedWorkspace) {
        const cwd = this.workspaceCwd();
        if (cwd) {
          this.autoCreatedWorkspace = true;
          const created = await this.client.createSession({ cwd });
          this.activeSessionId = created.sessionId;
          await this.refresh();
          return;
        }
      }
      // Cold-start safety net: seed the projection cache from the list
      // snapshot so the permission button (and other projection-driven UI)
      // can render even if the session/control baseline has not landed yet.
      // Seeding only fills keys the live cache is missing — the stream stays
      // authoritative once it has spoken.
      for (const item of items) {
        const perms = item.projections?.values?.permissions;
        if (perms === undefined) continue;
        let values = this.projections.get(item.sessionId);
        if (!values) {
          values = new Map<string, unknown>();
          this.projections.set(item.sessionId, values);
        }
        if (!values.has("permissions")) values.set("permissions", perms);
      }
      // Mirror the official client's session visibility contract
      // (dsh-client-ui-workspace `sessionVisible`): subagent children carry
      // `origin: "subagent"` and are surfaced under their parent conversation
      // via subagent.list, never as standalone sidebar rows. Archived and
      // blank rows are excluded the same way.
      let sessions = items
        .filter((item) => !item.blank && item.origin !== "subagent" && !this.archivedSessionIds.has(item.sessionId) && !this.hardDeletedSessionIds.has(item.sessionId))
        .map((item) => this.toPanelSession(item))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      // A freshly created session is blank until its first prompt; keep it
      // visible as the active session instead of silently reverting.
      if (this.activeSessionId && !sessions.some((s) => s.sessionId === this.activeSessionId)) {
        sessions.unshift({
          sessionId: this.activeSessionId,
          running: false,
          blank: true,
          updatedAt: Date.now(),
          title: "新会话",
          cwd: this.workspaceCwd(),
          usage: undefined,
          stats: undefined,
          context: undefined,
          agentPreset: undefined,
        });
      }
      this.sessions = sessions;
      // Auto-open a conversation only when it belongs to the CURRENT
      // workspace: a session from another folder is reachable from the
      // picker, but must never be silently opened as if it belonged here
      // (a fresh/empty workspace opens BLANK instead of the previous chat).
      if (!this.activeSessionId) {
        const cwd = this.workspaceCwd();
        const match = cwd
          ? this.sessions.find((s) => s.cwd && normalizePath(s.cwd) === normalizePath(cwd))
          : undefined;
        if (match) this.activeSessionId = match.sessionId;
      }
      this.postState();
      this.followActive();
      if (this.activeSessionId) {
        await this.loadHistory(this.activeSessionId, undefined);
        await this.postModels();
        await this.postCommands();
        this.postPermissions();
      }
    } catch (error) {
      this.post({ type: "error", message: describeHarnessFailure("会话列表失败", error) });
    }
  }

  private async postCommands(): Promise<void> {
    if (!this.client || !this.activeSessionId) return;
    try {
      const items = await this.client.commandList(this.activeSessionId);
      this.post({ type: "commands", items });
    } catch (error) {
      this.log(`commands: ${(error as Error).message}`);
    }
  }

  /**
   * First VS Code workspace folder as the session cwd. 0.1.7 session/create
   * takes the directory directly (workspaces are derived from cwd server-side),
   * so there is no workspace registration round-trip any more. No folder open
   * → undefined, and new sessions then fall back to the host's default cwd.
   */
  private workspaceCwd(): string | undefined {
    if (this.manualWorkspace) return this.manualWorkspace;
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    if (!this.client) {
      this.post({ type: "error", message: "harness 未连接" });
      return;
    }
    switch (message.type) {
      case "ready":
        this.postState();
        if (this.activeSessionId) {
          await this.loadHistory(this.activeSessionId, undefined);
        }
        await this.buildFileIndex();
        // Seed the ＋ mode dropdown with the agent-preset roster.
        await this.postAgentPresets();
        if (this.pendingAsk) {
          const pending = this.pendingAsk;
          this.pendingAsk = null;
          this.post({ type: "ask", context: pending.context, choices: pending.choices });
        }
        break;
      case "selectSession":
        this.activeSessionId = message.sessionId;
        // State first: the panel drops history frames for any session that is
        // not its current activeSessionId, so switch the panel's identity
        // before shipping history, or the page gets wiped to "no messages".
        this.postState();
        this.followActive();
        await this.loadHistory(message.sessionId, undefined);
        await this.postModels();
        await this.postCommands();
        this.postPermissions();
        // An unanswered approval/question can outlive a session switch: the
        // panel clears cards on switch, so re-post this session's pending
        // waterfall or the agent stays blocked with no visible card.
        for (const entry of this.pendingWaterfalls.values()) {
          if (entry.sessionId === message.sessionId && entry.message.type === "interaction") {
            this.post(entry.message);
          }
        }
        break;
      case "getModels":
        await this.postModels();
        break;
      case "selectModel": {
        if (!this.activeSessionId) break;
        const sessionId = this.activeSessionId;
        try {
          const { selected } = await this.client.selectModel(sessionId, message.provider, message.model, message.reasoningEffort);
          // Apply the harness's own resolved pick immediately (the projection
          // increment may lag); postModels then echoes it to the panel.
          if (selected) this.noteModelSelection(sessionId, { next: selected });
          await this.postModels();
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("切换模型失败", error) });
        }
        break;
      }
      case "getAttachment": {
        // Transcript images are stored as refs in the log; bytes come back
        // through the harness's own session.attachment RPC (which refuses ids
        // the named session never referenced). Failures degrade to a labeled
        // placeholder rather than an empty box.
        const sessionId = message.sessionId || this.activeSessionId;
        try {
          if (!sessionId) throw new Error("没有活动会话");
          const value = await this.client.sessionAttachment(sessionId, message.attachmentId);
          this.post({
            type: "attachment",
            requestId: message.requestId,
            attachmentId: message.attachmentId,
            mediaType: value.attachment.mediaType,
            data: value.data,
            width: value.attachment.width,
            height: value.attachment.height,
            bytes: value.attachment.bytes,
            name: value.attachment.name,
          });
        } catch (error) {
          this.post({
            type: "attachment",
            requestId: message.requestId,
            attachmentId: message.attachmentId,
            error: describeHarnessFailure("读取图片失败", error),
          });
        }
        break;
      }
      case "newSession": {
        try {
          const cwd = this.workspaceCwd();
          const opts: { cwd?: string; agentPreset?: string } = {};
          if (cwd) opts.cwd = cwd;
          // Optional mode pick: the panel sends agentPreset when the user chose
          // one from the ＋ dropdown (标准 / PTC / 极简 / 创造 = agent presets).
          if (message.agentPreset) opts.agentPreset = message.agentPreset;
          const { sessionId } = await this.client.createSession(opts);
          this.activeSessionId = sessionId;
          this.followActive();
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("新建会话失败", error) });
        }
        break;
      }
      case "deleteSession": {
        if (!message.sessionId) break;
        try {
          const { archivedSessionIds } = await this.client.archiveSession(message.sessionId);
          if (Array.isArray(archivedSessionIds)) {
            this.archivedSessionIds = new Set(archivedSessionIds.map(String));
          }
          if (this.activeSessionId === message.sessionId) {
            this.activeSessionId = null;
            this.followActive();
          }
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("归档会话失败", error) });
        }
        break;
      }
      case "deletePermanently": {
        if (!message.sessionId) break;
        const sessionId = message.sessionId;
        try {
          // Stop any running work and hide it from lists first (archive), then
          // remove the on-disk log. The harness has no session-delete RPC; its
          // session index reconciles the missing file as a delete.
          try {
            const value = await this.client.archiveSession(sessionId);
            if (Array.isArray(value.archivedSessionIds)) {
              this.archivedSessionIds = new Set(value.archivedSessionIds.map(String));
            }
          } catch {
            /* already archived / unknown to the registry — the file part still applies */
          }
          const removed = await deleteSessionStorage(sessionId);
          this.hardDeletedSessionIds.add(sessionId);
          if (this.activeSessionId === sessionId) {
            this.activeSessionId = null;
            this.followActive();
          }
          if (removed.length === 0) {
            this.post({ type: "error", message: `未找到会话 ${sessionId} 的历史文件（可能已删除）——已从列表隐藏` });
          } else {
            void vscode.window.showInformationMessage(`已彻底删除会话历史：${sessionId}`);
          }
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("彻底删除会话失败", error) });
        }
        break;
      }
      case "pickWorkspace": {
        // Header button: browse for a workspace folder and start a fresh
        // session there (the pick then governs later new sessions too).
        const current = this.workspaceCwd();
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "选择工作区文件夹",
          ...(current ? { defaultUri: vscode.Uri.file(current) } : {}),
        });
        if (!picked || picked.length === 0) break;
        const cwd = picked[0].fsPath;
        // The sandbox needs Full control (WRITE_OWNER) on a session cwd — a
        // picked folder (e.g. a project copied from another machine) may not
        // grant it; repair now instead of failing every tool call later.
        void ensureWorkspaceAcl(cwd, this.log);
        this.manualWorkspace = cwd;
        try {
          const { sessionId } = await this.client.createSession({ cwd });
          this.activeSessionId = sessionId;
          this.followActive();
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("新建工作区会话失败", error) });
        }
        break;
      }
      case "copyText":
        void vscode.env.clipboard.writeText(message.text).then(
          () => undefined,
          (error) => this.post({ type: "error", message: describeHarnessFailure("复制失败", error) })
        );
        break;
      case "askPick": {
        const context = this.askContext;
        this.askContext = null;
        if (!context || !this.client) {
          this.post({ type: "error", message: "Ask 卡片已失效，请重新选中代码再试。" });
          break;
        }
        const choice = INTENT_CHOICES.find((c) => c.id === message.choiceId);
        let instruction: string;
        if (choice && choice.id !== "custom") {
          instruction = choice.label;
        } else {
          const custom = (message.customText ?? "").trim();
          if (!custom) {
            this.post({ type: "error", message: "请输入指令。" });
            break;
          }
          instruction = custom;
        }
        try {
          await sendAsk(this.client, context, instruction, this.archivedSessionIds);
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("发送失败", error) });
        }
        break;
      }
      case "askCancel":
        this.askContext = null;
        break;
      case "respondApproval": {
        if (!this.client) {
          this.post({ type: "error", message: "harness 未连接" });
          break;
        }
        try {
          // 0.1.7: waterfall answers ride $events/result keyed by the waterfall
          // eventId (the rpcId the panel echoed back) + this mux clientId.
          await this.client.answerEvent(this.eventClientId, message.rpcId, {
            kind: "result",
            value: message.outcome,
          });
          this.pendingWaterfalls.delete(message.rpcId);
          this.post({ type: "interactionSettled", sessionId: message.sessionId, rpcId: message.rpcId });
          if (message.remember === "session" && message.mode) {
            // "永久允许": the request is answered allowed-once above; then the
            // session permission preset moves up to the escalated mode so the
            // same class of operations stops asking (same path the permission
            // picker uses — no invented protocol).
            try {
              await this.client.commandExecute(message.sessionId, `/permission ${message.mode}`);
              this.postPermissions();
            } catch (error) {
              this.post({ type: "error", message: describeHarnessFailure("提升会话权限失败", error) });
            }
          }
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("审批应答失败", error) });
        }
        break;
      }
      case "respondQuestion": {
        if (!this.client) {
          this.post({ type: "error", message: "harness 未连接" });
          break;
        }
        try {
          await this.client.answerEvent(this.eventClientId, message.rpcId, {
            kind: "result",
            value: { answers: message.answers },
          });
          this.pendingWaterfalls.delete(message.rpcId);
          this.post({ type: "interactionSettled", sessionId: message.sessionId, rpcId: message.rpcId });
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("选择题应答失败", error) });
        }
        break;
      }
      case "getPermissions":
        this.postPermissions();
        break;
      case "getAgentPresets":
        await this.postAgentPresets();
        break;
      case "selectPermission": {
        if (!this.activeSessionId) break;
        try {
          // Same admission path as the web composer's /permission picker:
          // run the slash command against the session's agent.
          const outcome = await this.client?.commandExecute(this.activeSessionId, `/permission ${message.permission}`);
          if (!outcome || !outcome.result || outcome.result.kind === "error") {
            const detail = outcome?.result?.text ? `：${outcome.result.text}` : "";
            this.post({ type: "error", message: `切换权限失败${detail || "：host 未提供 /permission 命令"}` });
          } else {
            // Apply the harness-resolved pick immediately (the projection
            // increment may lag behind or never arrive on this connection);
            // postPermissions re-reads the per-session cache so the button
            // shows the switch right away.
            this.log(`permission switch: ${message.permission} on ${this.activeSessionId}`);
            this.rememberPermission(this.activeSessionId, message.permission);
            this.postPermissions();
          }
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("切换权限失败", error) });
        }
        break;
      }
      case "openFile": {
        let abs = message.path;
        if (!path.isAbsolute(abs)) {
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (folder) abs = path.join(folder.uri.fsPath, abs);
        }
        void vscode.window
          .showTextDocument(vscode.Uri.file(abs), { preview: true })
          .then(
            () => undefined,
            (error) => this.post({ type: "error", message: describeHarnessFailure("打开文件失败", error) })
          );
        break;
      }
      case "openExternal": {
        try {
          const uri = vscode.Uri.parse(message.url);
          void vscode.env.openExternal(uri).then(
            () => undefined,
            (error) => this.post({ type: "error", message: describeHarnessFailure("打开链接失败", error) })
          );
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("打开链接失败", error) });
        }
        break;
      }
      case "openSettings":
        this.openSettingsPanel();
        break;
      case "queueSteer":
      case "queueRemove": {
        if (!this.activeSessionId) break;
        const action: QueueAction = message.type === "queueSteer" ? { kind: "steer" } : { kind: "remove" };
        try {
          await this.client.updateQueue(this.activeSessionId, message.itemId, action);
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("队列操作失败", error) });
        }
        break;
      }
      case "send": {
        const text = message.text.trim();
        const content: PromptContentPart[] = [];
        for (const a of message.attachments ?? []) {
          content.push({ type: "image", mediaType: a.mediaType, data: a.data, name: a.name });
        }
        if (text) content.push({ type: "text", text });
        if (content.length === 0) return;
        const mode = message.mode ?? "queue";
        let sessionId = this.activeSessionId;
        if (!sessionId) {
          try {
            const cwd = this.workspaceCwd();
            const created = await this.client.createSession(cwd ? { cwd } : {});
            sessionId = created.sessionId;
            this.activeSessionId = sessionId;
            this.followActive();
          } catch (error) {
            this.post({ type: "error", message: describeHarnessFailure("新建会话失败", error) });
            return;
          }
        }
        // A leading-slash line is a real slash command — dispatch it through the
        // commands domain instead of sending it to the agent as plain text.
        if (mode === "queue" && text && text.startsWith("/") && content.length === 1) {
          try {
            const outcome = await this.client.commandExecute(sessionId, text);
            this.post({
              type: "cmdResult",
              text: outcome?.result?.text ?? `命令已执行：${text}`,
              ok: outcome?.result?.kind !== "error",
            });
            await this.refresh();
          } catch (error) {
            this.post({ type: "error", message: describeHarnessFailure("命令执行失败", error) });
          }
          return;
        }
        try {
          await this.client.prompt(sessionId, content, mode);
          this.post({ type: "running", sessionId, running: true });
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("发送失败", error) });
        }
        break;
      }
      case "loadOlder":
        await this.loadHistory(this.activeSessionId ?? "", message.beforeSeq);
        break;
      case "cancel":
        if (this.activeSessionId) {
          try {
            await this.client.cancel(this.activeSessionId);
            this.post({ type: "running", sessionId: this.activeSessionId, running: false });
          } catch (error) {
            this.post({ type: "error", message: describeHarnessFailure("停止失败", error) });
          }
        }
        break;
      case "refresh":
        await this.refresh();
        break;
      case "refreshFiles":
        await this.buildFileIndex();
        break;
    }
  }

  /**
   * Build a workspace file index (files + all ancestor dirs) once and push it
   * to the panel for LOCAL, millisecond @ filtering. Folders sort before files.
   */
  private async buildFileIndex(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.post({ type: "index", files: [], dirs: [] });
      return;
    }
    const root = folders[0].uri.fsPath;
    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,dist,.git,out,build,coverage,.vscode-test,.vscode-test-ext}/**",
        500
      );
      uris = uris.filter((uri) => !/\.vsix$/i.test(uri.fsPath));
    } catch {
      /* empty list */
    }
    const files = uris
      .map((uri) => path.relative(root, uri.fsPath).replaceAll("\\", "/"))
      .sort((a, b) => a.localeCompare(b));
    const dirSet = new Set<string>();
    for (const file of files) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) {
        dirSet.add(parts.slice(0, i).join("/"));
      }
    }
    const dirs = [...dirSet].sort((a, b) => a.localeCompare(b));
    this.post({ type: "index", files, dirs });
  }

  /** Load a history page ending before `beforeSeq` (tail when undefined).
   *  Older pages are prepends (isOlder: true) so the webview can append them
   *  above the current messages without rebuilding the list. */
  private async loadHistory(sessionId: string, beforeSeq?: number): Promise<void> {
    if (!this.client || !sessionId) return;
    try {
      const cursor = await this.cursorFor(sessionId);
      const { records, hasMore } = await this.client.page(sessionId, cursor, beforeSeq, 30);
      const mapped = records.map((entry) => entry.event as PanelEvent);
      // Per-call "+N-M" diffs for this page, shipped inside the history frame
      // so the panel has them in hand while folding the page in.
      const toolDiffs = this.diffEntriesForPage(mapped);
      // Tail page: seed the task bar / permission select / queue rows from the
      // control-plane projection cache (the session/control stream source —
      // the same values the web GUI renders).
      if (beforeSeq === undefined) this.applyCachedProjections(sessionId);
      this.post({
        type: "history",
        sessionId,
        events: mapped,
        hasMore: hasMore === true,
        isOlder: beforeSeq !== undefined,
        toolDiffs: Object.keys(toolDiffs).length > 0 ? toolDiffs : undefined,
      });
    } catch (error) {
      this.post({ type: "error", message: describeHarnessFailure("读取历史失败", error) });
    }
  }

  /** The session journal cursor (session/list projections.asOfSeq) — the
   *  throughSeq bound session/page enforces. Cached from the last list. */
  private async cursorFor(sessionId: string): Promise<number> {
    const cached = this.cursors.get(sessionId);
    if (cached !== undefined) return cached;
    if (this.client) {
      try {
        const { items } = await this.client.listSessions();
        for (const item of items) {
          const asOf = item.projections?.asOfSeq;
          if (typeof asOf === "number") this.cursors.set(item.sessionId, asOf);
        }
      } catch {
        /* fall through to the default cursor */
      }
    }
    return this.cursors.get(sessionId) ?? 0;
  }

  /** Write one permission value into the active session's projection cache
   *  (the optimistic echo of a confirmed /permission switch). */
  private rememberPermission(sessionId: string, current: string): void {
    let values = this.projections.get(sessionId);
    if (!values) {
      values = new Map<string, unknown>();
      this.projections.set(sessionId, values);
    }
    values.set("permissions", { currentValue: current });
  }

  /** Seed panel state from the control-plane projection cache of a session. */
  private applyCachedProjections(sessionId: string): void {
    const values = this.projections.get(sessionId);
    const todos = values?.get("todos");
    this.todos = Array.isArray(todos) ? (todos as TodoItem[]) : [];
    const perms = values?.get("permissions") as { currentValue?: string } | null | undefined;
    this.currentPermission = typeof perms?.currentValue === "string" ? perms.currentValue : undefined;
    this.noteModelSelection(sessionId, values?.get("modelSelection"));
    this.post({ type: "todos", sessionId, items: this.todos });
    this.postPermissions();
    this.postQueue(sessionId, values?.get("inbox"));
  }

  /** Map a session/list (or api-session/added) summary into a panel row. */
  private toPanelSession(item: SessionSummary): PanelSession {
    return {
      sessionId: item.sessionId,
      running: item.running,
      blank: item.blank,
      updatedAt: item.updatedAt,
      title: item.projections?.values?.title ?? undefined,
      cwd: item.cwd,
      usage: item.projections?.values?.tokenUsage ?? undefined,
      stats: item.projections?.values?.sessionStats ?? undefined,
      context: item.projections?.values?.contextPressure ?? undefined,
      agentPreset: item.agentPreset,
    };
  }

  /** Derive per-session running state from turn events. */
  private trackRunning(sessionId: string, event: PanelEvent): void {
    if (event.type === "turn/start") {
      this.post({ type: "running", sessionId, running: true });
    } else if (event.type === "turn/end") {
      this.post({ type: "running", sessionId, running: false });
    } else if (event.type === "session/title") {
      const title = (event.data as { title?: string } | undefined)?.title;
      if (typeof title === "string") {
        this.titles.set(sessionId, title);
        if (sessionId === this.activeSessionId) this.postState();
      }
    }
  }

  /* ---------- bridge-computed per-tool line diffs ("+N-M") ---------- */

  /** Resolve a possibly-relative tool path against the first workspace root. */
  private resolveToolPath(raw: string): string | null {
    if (!raw || raw.trim().length === 0) return null;
    if (path.isAbsolute(raw)) return raw;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;
    return path.join(folder.uri.fsPath, raw);
  }

  /** Pre-write content of a file (best effort; the harness usually applies
   *  the mutation after emitting tool/call, so this is the old version). */
  private readOldFile(raw: string): string | null {
    const abs = this.resolveToolPath(raw);
    if (!abs) return null;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return null;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  }

  private parseToolArgs(argumentsText: unknown): Record<string, unknown> {
    try {
      const parsed = JSON.parse(String(argumentsText ?? "{}")) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private rememberPendingArgs(callId: string, name: string, args: Record<string, unknown>, filePath?: string): void {
    this.pendingArgs.set(callId, { name, args, path: filePath });
    if (this.pendingArgs.size > this.maxPendingArgs) {
      const oldest = this.pendingArgs.keys().next().value;
      if (oldest !== undefined) this.pendingArgs.delete(oldest);
    }
  }

  /** tool/call: count from the arguments alone (visible while still running). */
  private handleToolCallDiff(sessionId: string, event: PanelEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const name = String(data.name ?? "");
    const callId = String(data.callId ?? "");
    if (!name || !callId) return;
    const args = this.parseToolArgs(data.arguments);
    const diff = countToolArgsDiff(name, args, (p) => this.readOldFile(p));
    if (diff) {
      const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
      const filePath = this.resolveToolPath(rawPath) ?? (rawPath || undefined);
      this.rememberPendingArgs(`${sessionId}:${callId}`, name, args, filePath);
      this.post({ type: "toolDiff", sessionId, callId, added: diff.added, deleted: diff.deleted, path: filePath });
    }
  }

  /** tool/result: refine with the tool's own result-time hunks (meta.diffs). */
  private handleToolResultDiff(sessionId: string, event: PanelEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const msg = (data.message ?? {}) as Record<string, unknown>;
    // v4 result frame: {message:{...,toolCallId,isError}} — callId rides the
    // message; v3 carried it as data.callId / the tool-result block.
    let callId =
      (typeof data.callId === "string" && data.callId) ||
      (typeof msg.toolCallId === "string" && msg.toolCallId) ||
      "";
    if (!callId && Array.isArray(msg.content)) {
      for (const block of msg.content as Record<string, unknown>[]) {
        if (block && block.type === "tool-result" && block.toolCallId) {
          callId = String(block.toolCallId);
          break;
        }
      }
    }
    if (!callId) return;
    const pending = this.pendingArgs.get(`${sessionId}:${callId}`);
    if (!pending) return;
    this.pendingArgs.delete(`${sessionId}:${callId}`);
    const refined = countMetaDiff(data.meta, pending.name, pending.args);
    if (refined) {
      this.post({ type: "toolDiff", sessionId, callId, added: refined.added, deleted: refined.deleted, path: pending.path });
    }
  }

  /**
   * History path: recompute the per-call diffs for one page and ship them as a
   * map (the panel merges it before applying the page's events). tool/result
   * hunks win over arg-based counts, matching the live path.
   */
  private diffEntriesForPage(events: PanelEvent[]): Record<string, ToolLineDiff> {
    const entries: Record<string, ToolLineDiff> = {};
    const pending = new Map<string, { name: string; args: Record<string, unknown>; path?: string }>();
    for (const ev of events) {
      const data = (ev.data ?? {}) as Record<string, unknown>;
      if (ev.type === "tool/call") {
        const name = String(data.name ?? "");
        const callId = String(data.callId ?? "");
        if (!name || !callId) continue;
        const args = this.parseToolArgs(data.arguments);
        const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
        const filePath = this.resolveToolPath(rawPath) ?? (rawPath || undefined);
        pending.set(callId, { name, args, path: filePath });
        const diff = countToolArgsDiff(name, args, (p) => this.readOldFile(p));
        if (diff) entries[callId] = { ...diff, path: filePath };
      } else if (ev.type === "tool/result") {
        const msg = (data.message ?? {}) as Record<string, unknown>;
        let callId =
          (typeof data.callId === "string" && data.callId) ||
          (typeof msg.toolCallId === "string" && msg.toolCallId) ||
          "";
        if (!callId && Array.isArray(msg.content)) {
          for (const block of msg.content as Record<string, unknown>[]) {
            if (block && block.type === "tool-result" && block.toolCallId) {
              callId = String(block.toolCallId);
              break;
            }
          }
        }
        if (!callId) continue;
        const call = pending.get(callId);
        if (!call) continue;
        const refined = countMetaDiff(data.meta, call.name, call.args);
        if (refined) entries[callId] = { ...refined, path: call.path };
      }
    }
    return entries;
  }

  /** Record a session's durable model pick from a `modelSelection` projection
   *  or a session/selectModel response ({next} wins over {lastUsed}). */
  private noteModelSelection(sessionId: string, value: unknown): void {
    const proj = value as ModelSelectionProjection | null | undefined;
    const eff = proj?.next ?? proj?.lastUsed ?? null;
    if (!eff || typeof eff.provider !== "string" || typeof eff.model !== "string") return;
    this.modelSelections.set(sessionId, {
      provider: eff.provider,
      model: eff.model,
      ...(eff.reasoningEffort ? { reasoningEffort: eff.reasoningEffort } : {}),
    });
  }

  private async postModels(): Promise<void> {
    if (!this.client) return;
    try {
      const catalog = await this.client.models();
      // The session's own pick comes first (modelSelection projection); the
      // catalog `default` is only the cold-start fallback — it never changes
      // after session/selectModel, so using it alone left the menu stale.
      const current = (this.activeSessionId && this.modelSelections.get(this.activeSessionId)) || catalog.default;
      this.post({
        type: "models",
        current,
        groups: catalog.groups.map((g) => ({
          id: g.id,
          name: g.name,
          models: g.models.map((m) => ({
            id: m.id,
            name: m.name,
            // The harness reports each model's real reasoning efforts (off/low/
            // high/max...) — carry them through so the effort selector renders
            // the OFFICIAL set instead of a hardcoded list.
            ...(m.reasoning ? { reasoning: m.reasoning } : {}),
          })),
        })),
      });
    } catch (error) {
      // Model catalog is advisory; fail silently rather than spamming errors.
      this.log(`models: ${(error as Error).message}`);
    }
  }

  /** Fetch the permission preset roster once per connection. */
  private async loadPermissionCatalog(): Promise<void> {
    if (!this.client) return;
    try {
      const catalog = await this.client.permissionCatalog();
      this.permissionOptions = (catalog.options ?? []).map((o) => ({ value: o.value, name: o.name }));
      this.postPermissions();
    } catch (error) {
      this.log(`permissions catalog: ${(error as Error).message}`);
    }
  }

  private async postPermissions(): Promise<void> {
    // Post the cached permission state. 0.1.7's `permissions` projection only
    // carries the current value; the option list comes from the roster
    // (permissionPresets/catalog, same three presets as the web GUI). The
    // value resolves from the ACTIVE session's projection cache so a session
    // switch can never leak the previous session's preset into the button.
    const cached = (this.activeSessionId
      ? this.projections.get(this.activeSessionId)?.get("permissions")
      : undefined) as { currentValue?: string } | null | undefined;
    const current = typeof cached?.currentValue === "string" ? cached.currentValue : undefined;
    this.currentPermission = current;
    if (this.permissionOptions.length === 0) {
      this.post({ type: "permissions", options: [], current });
      return;
    }
    const LABELS: Record<string, string> = {
      "read-only": "仅可查看",
      "workspace-write": "可写入工作区",
      "danger-full-access": "完全权限",
    };
    this.post({
      type: "permissions",
      options: this.permissionOptions.map((o) => ({
        value: o.value,
        label: LABELS[o.value] ?? o.name ?? o.value,
      })),
      current,
    });
  }

  /** Push the agent-preset roster (＋ 新建会话的模式下拉) to the panel. Display
   *  copy: the live roster's own name/description when present, otherwise the
   *  official shipped copy for the four built-in presets. Roster order is the
   *  host's (order field in preset.yml), so 标准/PTC/极简/创造 appear in the
   *  dropdown in the official order. If the roster is empty or unreachable
   *  (e.g. an older harness without the agent-presets domain), fall back to
   *  the four shipped presets so the picker always offers the modes. */
  private async postAgentPresets(): Promise<void> {
    if (!this.client) return;
    const officialRows = (presets: { id: string; name?: string; description?: string; isDefault?: boolean }[]) =>
      presets.map((p) => {
        const official = OFFICIAL_PRESET_COPY[p.id];
        return {
          id: p.id,
          name: p.name ?? official?.name,
          description: p.description ?? official?.description,
          isDefault: p.isDefault === true,
        };
      });
    try {
      const { presets } = await this.client.agentPresetList();
      const rows = presets
        .filter((p) => p.broken === undefined)
        .map((p) => {
          const official = OFFICIAL_PRESET_COPY[p.id];
          return {
            id: p.id,
            name: p.name ?? official?.name,
            description: p.description ?? official?.description,
            isDefault: p.isDefault === true,
          };
        });
      if (rows.length === 0) {
        // Empty roster: deployment composes no presets — fall back to the
        // four shipped modes (the normal dsh deployment ships all four).
        this.post({
          type: "agentPresets",
          presets: officialRows(
            Object.keys(OFFICIAL_PRESET_COPY).map((id) => ({ id, isDefault: id === "standard" }))
          ),
        });
        return;
      }
      this.post({ type: "agentPresets", presets: rows });
    } catch (error) {
      this.log(`agentPresets: ${(error as Error).message}`);
      this.post({
        type: "agentPresets",
        presets: officialRows(
          Object.keys(OFFICIAL_PRESET_COPY).map((id) => ({ id, isDefault: id === "standard" }))
        ),
      });
    }
  }

  private postState(): void {
    this.post({
      type: "state",
      connected: this.connected,
      version: this.version,
      phase: this.phase,
      // live title event wins; otherwise the projection title from session.list
      sessions: this.sessions.map((s) => ({ ...s, title: this.titles.get(s.sessionId) ?? s.title })),
      activeSessionId: this.activeSessionId,
      workspace: this.workspaceCwd(),
    });
  }

  private post(message: HostMessage): void {
    try {
      void this.view?.webview.postMessage(message);
    } catch {
      /* panel disposed */
    }
  }

  private renderHtml(): string {
    const panelPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "media", "native", "panel.html");
    let html = fs.readFileSync(panelPath.fsPath, "utf8");
    try {
      const whaleUri = this.view?.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "media", "dsh-whale.svg")
      );
      html = html.replaceAll("__WHALE_URI__", whaleUri?.toString() ?? "");
    } catch {
      /* keep the placeholder; the loading view degrades to text */
    }
    return html;
  }

  /* ---------- settings panel (editor-area tab, opened by the ⚙ button) ---------- */

  private settingsPanel?: vscode.WebviewPanel;

  /** Active plugin install (requestId) so the cancel button can reach it. */
  private pluginInstallRequestId: string | null = null;
  /** Last install target, so 授予版本豁免 can retry the same spec after granting. */
  private lastInstallSpec: string | null = null;
  private lastInstallRegistry: string | null | undefined;

  /** Open (or reveal) the settings webview in the editor area — it behaves
   *  like a normal file tab, not another sidebar view. Reads/writes ride the
   *  settings domain (settings.describe / settings.mutate). */
  private openSettingsPanel(): void {
    if (this.settingsPanel) {
      this.settingsPanel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "dsh.settings",
      "DSH 设置",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "media")],
      }
    );
    this.settingsPanel = panel;
    panel.onDidDispose(() => {
      this.settingsPanel = undefined;
    });
    const settingsPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "media", "native", "settings.html");
    panel.webview.html = fs.readFileSync(settingsPath.fsPath, "utf8");
    panel.webview.onDidReceiveMessage((msg) => {
      void this.onSettingsMessage(msg as Record<string, unknown>);
    });
  }

  private async onSettingsMessage(msg: Record<string, unknown>): Promise<void> {
    if (!this.client) {
      this.postSettingsError("harness 未连接");
      return;
    }
    switch (msg.type) {
      case "settingsReady":
        await this.postSettingsData();
        await this.postSettingsPresets();
        await this.postSettingsCatalog();
        await this.postPlugins();
        break;
      case "pluginsReady":
        await this.postPlugins();
        break;
      case "pluginInspect": {
        const spec = String(msg.spec ?? "").trim();
        if (!spec) break;
        const registry = msg.registry === null || typeof msg.registry === "string" ? (msg.registry as string | null) : undefined;
        try {
          const value = await this.client.inspectPlugin(spec, registry);
          this.postSettingsMessage({ type: "pluginInspectResult", spec, value });
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("检索插件失败", error));
        }
        break;
      }
      case "pluginInstall": {
        const spec = String(msg.spec ?? "").trim();
        if (!spec) break;
        const registry = msg.registry === null || typeof msg.registry === "string" ? (msg.registry as string | null) : undefined;
        const approvedBuilds = Array.isArray(msg.approvedBuilds) ? (msg.approvedBuilds as unknown[]).map(String) : undefined;
        await this.runPluginInstall(spec, registry, msg.enabled !== false, approvedBuilds);
        break;
      }
      case "pluginAllowVersion": {
        // dsh plugin allow-version flow: grant the exact-version exemption the
        // incompatible-version rejection named, then retry the same install.
        const spec = typeof msg.spec === "string" && msg.spec.trim() ? msg.spec.trim() : this.lastInstallSpec;
        if (!spec) {
          this.postSettingsError("缺少插件 spec，无法重试安装");
          break;
        }
        const registry = msg.registry === null || typeof msg.registry === "string" ? (msg.registry as string | null) : this.lastInstallRegistry;
        const rawPairs = Array.isArray(msg.pairs) ? (msg.pairs as Record<string, unknown>[]) : [];
        const pairs = rawPairs
          .map((p) => ({ packageVersion: String(p.packageVersion ?? ""), runtimeVersion: String(p.runtimeVersion ?? "") }))
          .filter((p) => p.packageVersion && p.runtimeVersion);
        if (!pairs.length) {
          this.postSettingsError("缺少豁免目标（packageVersion/runtimeVersion）");
          break;
        }
        try {
          for (const pair of pairs) {
            await this.client.setVersionExemption(pair.packageVersion, pair.runtimeVersion, true, true);
          }
          this.postSettingsSaved(
            pairs.length === 1
              ? `已授予版本豁免：${pairs[0].packageVersion} 可在 dsh ${pairs[0].runtimeVersion} 上运行`
              : `已授予 ${pairs.length} 项版本豁免`
          );
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("授予版本豁免失败", error));
          break;
        }
        await this.runPluginInstall(spec, registry, true);
        break;
      }
      case "pluginRevokeVersion": {
        const packageVersion = String(msg.packageVersion ?? "");
        const runtimeVersion = String(msg.runtimeVersion ?? "");
        if (!packageVersion || !runtimeVersion) break;
        try {
          const value = await this.client.setVersionExemption(packageVersion, runtimeVersion, false);
          await this.postPlugins();
          this.postSettingsSaved(
            value.application === "applied"
              ? `已撤销版本豁免：${packageVersion}（dsh ${runtimeVersion}）`
              : `撤销 ${packageVersion}：${value.application}`
          );
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("撤销版本豁免失败", error));
        }
        break;
      }
      case "pluginCancelInstall": {
        const requestId = this.pluginInstallRequestId;
        if (!requestId) break;
        try {
          const value = await this.client.cancelInstall(requestId);
          this.postSettingsMessage({ type: "pluginCancelResult", value });
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("取消安装失败", error));
        }
        break;
      }
      case "pluginSetEnabled": {
        const id = String(msg.id ?? "");
        if (!id) break;
        try {
          await this.client.setPluginEnabled(id, msg.enabled === true);
          await this.postPlugins();
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("切换插件开关失败", error));
        }
        break;
      }
      case "pluginSetBundleEnabled": {
        const name = String(msg.name ?? "");
        if (!name) break;
        try {
          await this.client.setBundleEnabled(name, msg.enabled === true);
          await this.postPlugins();
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("切换插件包开关失败", error));
        }
        break;
      }
      case "pluginRemove": {
        const name = String(msg.name ?? "");
        if (!name) break;
        try {
          const value = await this.client.removeBundle(name);
          await this.postPlugins();
          this.postSettingsSaved(
            value.application === "applied" ? `已删除 ${name}` : `删除 ${name}：${value.application}`
          );
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("删除插件包失败", error));
        }
        break;
      }
      case "settingsUpdate": {
        const ns = String(msg.ns ?? "");
        const patch = (msg.patch && typeof msg.patch === "object" ? msg.patch : {}) as Record<string, unknown>;
        const expectedRevision = typeof msg.expectedRevision === "number" ? msg.expectedRevision : undefined;
        try {
          await this.client.settingsUpdate(ns, patch, expectedRevision);
          this.postSettingsSaved("已保存");
          await this.postSettingsData();
          await this.postSettingsPresets();
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("保存失败", error));
        }
        break;
      }
      case "settingsMutate": {
        const ns = String(msg.ns ?? "");
        const ops = Array.isArray(msg.ops) ? (msg.ops as { op: string; path?: string[]; value?: unknown }[]) : [];
        const expectedRevision = typeof msg.expectedRevision === "number" ? msg.expectedRevision : undefined;
        try {
          await this.client.settingsMutate(
            ns,
            ops.map((o) =>
              o.op === "set"
                ? { op: "set" as const, path: o.path ?? [], value: o.value }
                : { op: "unset" as const, path: o.path ?? [] }
            ),
            expectedRevision
          );
          this.postSettingsSaved("已保存");
          await this.postSettingsData();
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("保存失败", error));
        }
        break;
      }
    }
  }

  private async postSettingsData(): Promise<void> {
    if (!this.client) return;
    try {
      const value = await this.client.settingsDescribe();
      this.settingsPanel?.webview.postMessage({ type: "settingsData", value });
    } catch (error) {
      this.postSettingsError(describeHarnessFailure("读取配置失败", error));
    }
  }

  private async postSettingsPresets(): Promise<void> {
    if (!this.client) return;
    try {
      const { presets } = await this.client.agentPresetList();
      this.settingsPanel?.webview.postMessage({
        type: "settingsAgentPresets",
        value: {
          presets: presets.map((p) => {
            const official = OFFICIAL_PRESET_COPY[p.id];
            return {
              id: p.id,
              name: p.name ?? official?.name,
              description: p.description ?? official?.description,
              isDefault: p.isDefault === true,
              trust: p.trust,
              broken: p.broken,
            };
          }),
        },
      });
    } catch (error) {
      this.postSettingsError(describeHarnessFailure("读取预设失败", error));
    }
  }

  /** Server-side option lists for the settings dropdowns: the model catalog
   *  (provider → model → reasoning effort) and the permission presets — the
   *  same rosters the web GUI's pickers render from. */
  private async postSettingsCatalog(): Promise<void> {
    if (!this.client) return;
    try {
      const [models, permissions] = await Promise.all([
        this.client.models(),
        this.client.permissionCatalog(),
      ]);
      this.settingsPanel?.webview.postMessage({
        type: "settingsCatalog",
        models: {
          default: models.default,
          groups: models.groups.map((g) => ({
            id: g.id,
            name: g.name,
            models: g.models.map((m) => ({ id: m.id, name: m.name, reasoning: m.reasoning })),
          })),
        },
        permissions: { options: permissions.options, defaultPreset: permissions.defaultPreset },
      });
    } catch (error) {
      this.postSettingsError(describeHarnessFailure("读取可选列表失败", error));
    }
  }

  private postSettingsSaved(message: string): void {
    try {
      void this.settingsPanel?.webview.postMessage({ type: "settingsSaved", message });
    } catch {
      /* panel disposed */
    }
  }

  /** Run one installBundle with progress events (shared by install and allow-version retry). */
  private async runPluginInstall(spec: string, registry: string | null | undefined, enabled: boolean, approvedBuilds?: string[]): Promise<void> {
    if (!this.client) return;
    const requestId = randomUUID();
    this.pluginInstallRequestId = requestId;
    this.lastInstallSpec = spec;
    this.lastInstallRegistry = registry;
    this.postSettingsMessage({ type: "pluginInstallStarted", requestId, spec });
    try {
      const value = await this.client.installBundle(spec, {
        enabled,
        requestId,
        registry,
        ...(approvedBuilds && approvedBuilds.length ? { approvedBuilds } : {}),
      });
      this.postSettingsMessage({ type: "pluginInstallResult", spec, value });
    } catch (error) {
      this.postSettingsError(describeHarnessFailure("安装插件失败", error));
    } finally {
      this.pluginInstallRequestId = null;
      this.postSettingsMessage({ type: "pluginInstallDone" });
      await this.postPlugins();
    }
  }

  /** Full plugin-manager snapshot for the 插件 tab (bundles + entries + registries + exemptions). */
  private async postPlugins(): Promise<void> {
    if (!this.client) return;
    try {
      const [bundles, plugins, registries, exemptions] = await Promise.all([
        this.client.listBundles(),
        this.client.listPluginEntries(),
        this.client.pluginRegistries(),
        this.client.listVersionExemptions(),
      ]);
      this.postSettingsMessage({
        type: "settingsPlugins",
        bundles,
        plugins,
        registries,
        exemptions: exemptions.exemptions,
        exemptionWarnings: exemptions.warnings,
      });
    } catch (error) {
      this.postSettingsError(describeHarnessFailure("读取插件列表失败", error));
    }
  }

  private postSettingsMessage(message: unknown): void {
    try {
      void this.settingsPanel?.webview.postMessage(message);
    } catch {
      /* panel disposed */
    }
  }

  private postSettingsError(message: string): void {
    try {
      void this.settingsPanel?.webview.postMessage({ type: "settingsError", message });
    } catch {
      /* panel disposed */
    }
  }
}
