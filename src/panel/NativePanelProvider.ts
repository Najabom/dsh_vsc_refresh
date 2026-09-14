import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { HarnessClient, RpcErrorResult } from "../harness/client";
import type { PromptContentPart, QueueAction } from "../harness/protocol";
import type { HostMessage, PanelEvent, PanelSession, TodoItem, ToolLineDiff, WebviewMessage } from "./protocol";
import { countMetaDiff, countToolArgsDiff } from "../editor/diffCount";
import { INTENT_CHOICES, sendAsk } from "../editor/askSelection";

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

/**
 * Phase 1 — native sidebar chat panel.
 * Renders the conversation natively (VS Code themed), driven by the mux event
 * stream + session.history, with prompt via session.prompt. This replaces the
 * embedded DSH webview as the main surface (embed moves to dsh.openWebView).
 */
export class NativePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dsh.sidebar.right";

  private view?: vscode.WebviewView;
  private client: HarnessClient | null = null;
  private activeSessionId: string | null = null;
  private sessions: PanelSession[] = [];
  private titles = new Map<string, string>();
  private connected = false;
  private version?: string;
  private phase: "searching" | "starting" | "online" | "offline" = "searching";
  /** Live todo list of the active session (todos projection, realtime mux push). */
  private todos: TodoItem[] = [];
  /** Current permission presets of the active session (permissions projection,
   *  seeded from history tail + refreshed by session/projection pushes).
   *  Wire values: read-only / workspace-write / danger-full-access. */
  private permissions: { options: { value: string; name?: string }[]; currentValue?: string } | null = null;
  /**
   * Pending file-mutation calls (callId → name+args), kept so the tool/result
   * can refine the bridge-computed diff with the tool's own meta.diffs hunks.
   */
  private pendingArgs = new Map<string, { name: string; args: Record<string, unknown>; path?: string }>();
  private readonly maxPendingArgs = 400;
  /** Context block of a pending in-panel ask card (set by showAskCard). */
  private askContext: string | null = null;

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
    webviewView.webview.onDidReceiveMessage((message) => {
      void this.onMessage(message as WebviewMessage);
    });
    // Route mux events into this panel (filtered by active session host-side).
    this.onSessionEvent((sessionId, event) => {
      this.trackRunning(sessionId, event);
      if (sessionId !== this.activeSessionId) return;
      if (event.type === "session/queue") {
        // Queue state snapshot — render the pending-send rows above the input.
        const data = (event.data ?? {}) as { items?: { id?: unknown; placement?: unknown; message?: { content?: { type?: string; text?: string }[] } }[] };
        this.post({
          type: "queue",
          sessionId,
          items: (data.items ?? []).map((it) => ({
            id: String(it.id ?? ""),
            placement: String(it.placement ?? "queued"),
            text: (it.message?.content ?? [])
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text as string)
              .join(""),
          })),
        });
        return;
      }
      if (event.type === "session/projection") {
        // Realtime projection push — the `todos` unit carries the current
        // turn's whole task list, reset to null on every turn/start (mirrors
        // the web GUI's task bar exactly). The `permissions` unit carries the
        // session's permission presets (header 权限 select). Other projection
        // frames fall through to the generic event path below.
        const data = (event.data ?? {}) as { key?: unknown; value?: unknown };
        if (data.key === "todos") {
          this.todos = Array.isArray(data.value) ? (data.value as TodoItem[]) : [];
          this.post({ type: "todos", sessionId, items: this.todos });
          return;
        }
        if (data.key === "permissions") {
          const value = data.value as { options?: { value: string; name?: string }[]; currentValue?: string } | undefined;
          if (value && Array.isArray(value.options)) {
            this.permissions = { options: value.options, currentValue: value.currentValue };
            this.postPermissions();
          }
          return;
        }
      }
      // Bridge-computed per-call line diffs ride alongside the raw event so
      // the panel can show "+N-M" on the tool card immediately (and refine it
      // once the tool's own result-time hunks land).
      if (event.type === "tool/call") {
        this.handleToolCallDiff(sessionId, event);
      } else if (event.type === "tool/result") {
        this.handleToolResultDiff(sessionId, event);
      }
      // Answerable interaction frames (approval/requested, question/requested)
      // carry their envelope rpcId — forward them as a dedicated interaction
      // message so the panel can render a decision card and answer via
      // /api/respond (the raw event is ALSO posted below; the panel ignores
      // it for interaction kinds). Settled frames close the card.
      if (event.type === "approval/requested" || event.type === "question/requested") {
        this.handleInteraction(sessionId, event);
      } else if (event.type === "approval/resolved" || event.type === "question/resolved") {
        const rpcId = event.rpcId ?? "";
        if (rpcId) this.post({ type: "interactionSettled", sessionId, rpcId });
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
    void this.refresh();
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
    this.post({ type: "ask", context: contextBlock, choices: INTENT_CHOICES });
  }

  async refresh(): Promise<void> {
    if (!this.client) {
      this.post({ type: "state", connected: false, sessions: [], activeSessionId: null });
      return;
    }
    try {
      const [list, workspaces] = await Promise.all([
        this.client.listSessions(),
        this.client.workspaceList(),
      ]);
      const archived = new Set(workspaces.archivedSessionIds);
      const { items } = list;
      // Mirror the official client's session visibility contract
      // (dsh-client-ui-workspace `sessionVisible`): subagent children carry
      // `origin: "subagent"` and are surfaced under their parent conversation
      // via subagent.list, never as standalone sidebar rows. Archived and
      // blank rows are excluded the same way.
      let sessions = items
        .filter((item) => !item.blank && item.origin !== "subagent" && !archived.has(item.sessionId))
        .map((item) => ({
          sessionId: item.sessionId,
          running: item.running,
          blank: item.blank,
          updatedAt: item.updatedAt,
          title: item.projections?.values?.title ?? undefined,
          usage: item.projections?.values?.tokenUsage ?? undefined,
          stats: item.projections?.values?.sessionStats ?? undefined,
          context: item.projections?.values?.contextPressure ?? undefined,
          agentPreset: item.agentPreset,
        }))
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
          usage: undefined,
          stats: undefined,
          context: undefined,
          agentPreset: undefined,
        });
      }
      this.sessions = sessions;
      if (this.sessions.length > 0 && !this.sessions.some((s) => s.sessionId === this.activeSessionId)) {
        this.activeSessionId = this.sessions[0].sessionId;
      }
      this.postState();
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
   * Resolve the current VS Code workspace folder to a DSH workspace id
   * (registering the path idempotently). No folder open → undefined, and new
   * sessions then fall back to the host's default workspace.
   */
  private async resolveWorkspaceId(): Promise<string | undefined> {
    try {
      if (!this.client) return undefined;
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) return undefined;
      const { workspace } = await this.client.workspaceCreate(folders[0].uri.fsPath);
      return workspace.workspaceId;
    } catch (error) {
      this.log(`workspace: ${(error as Error).message}`);
      return undefined;
    }
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
        break;
      case "selectSession":
        this.activeSessionId = message.sessionId;
        // State first: the panel drops history frames for any session that is
        // not its current activeSessionId, so switch the panel's identity
        // before shipping history, or the page gets wiped to "no messages".
        this.postState();
        await this.loadHistory(message.sessionId, undefined);
        await this.postModels();
        await this.postCommands();
        this.postPermissions();
        break;
      case "getModels":
        await this.postModels();
        break;
      case "selectModel": {
        if (!this.activeSessionId) break;
        try {
          await this.client.selectModel(this.activeSessionId, message.provider, message.model, message.reasoningEffort);
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
          const workspaceId = await this.resolveWorkspaceId();
          const opts: { workspaceId?: string; agentPreset?: string } = {};
          if (workspaceId) opts.workspaceId = workspaceId;
          // Optional mode pick: the panel sends agentPreset when the user chose
          // one from the ＋ dropdown (标准 / PTC / 极简 / 创造 = agent presets).
          if (message.agentPreset) opts.agentPreset = message.agentPreset;
          const { sessionId } = await this.client.createSession(opts);
          this.activeSessionId = sessionId;
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("新建会话失败", error) });
        }
        break;
      }
      case "deleteSession": {
        if (!this.activeSessionId) break;
        try {
          await this.client.archiveSession(message.sessionId);
          if (this.activeSessionId === message.sessionId) this.activeSessionId = null;
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("删除会话失败", error) });
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
          await sendAsk(this.client, context, instruction);
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
          await this.client.respond(message.rpcId, {
            sessionId: message.sessionId,
            approvalId: message.approvalId,
            outcome: message.outcome,
          });
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
          await this.client.respond(message.rpcId, {
            sessionId: message.sessionId,
            answer: { answers: message.answers },
          });
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
          if (outcome === undefined || (outcome as { matched?: boolean }).matched === false) {
            this.post({ type: "error", message: `切换权限失败: host 未提供 /permission 命令` });
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
            const workspaceId = await this.resolveWorkspaceId();
            const created = await this.client.createSession(workspaceId ? { workspaceId } : {});
            sessionId = created.sessionId;
            this.activeSessionId = sessionId;
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
      const { events, projections, hasMore } = await this.client.history(sessionId, beforeSeq, 30);
      const mapped = events.map((entry) => entry.event as PanelEvent);
      // Per-call "+N-M" diffs for this page, shipped inside the history frame
      // so the panel has them in hand while folding the page in.
      const toolDiffs = this.diffEntriesForPage(mapped);
      // Task bar mirrors the web GUI: it renders the host-computed `todos`
      // projection (current turn's todo list; null after a turn/start reset),
      // NOT the raw log. Seed it from the tail page's projections block so a
      // freshly opened session shows the same state as the web tab.
      if (beforeSeq === undefined) {
        const todos = projections?.values?.todos;
        this.todos = Array.isArray(todos) ? todos : [];
        this.post({ type: "todos", sessionId, items: this.todos });
        // Permission presets ride the same projections block (web GUI's
        // 权限 select): seed the header select from the tail page.
        const perms = projections?.values?.permissions;
        if (perms) {
          this.permissions = { options: perms.options ?? [], currentValue: perms.currentValue };
          this.postPermissions();
        }
      }
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

  /**
   * Forward an answerable interaction frame (approval/requested or
   * question/requested) to the panel as a dedicated `interaction` message.
   * The panel answers by echoing `rpcId` through respondApproval /
   * respondQuestion; the host then calls /api/respond.
   */
  private handleInteraction(sessionId: string, event: PanelEvent): void {
    const rpcId = event.rpcId;
    if (!rpcId) return; // unreachable frame — cannot answer it
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "approval/requested") {
      this.post({
        type: "interaction",
        sessionId,
        rpcId,
        kind: "approval",
        approvalId: String(data.approvalId ?? ""),
        toolName: String(data.toolName ?? ""),
        callId: data.callId !== undefined ? String(data.callId) : undefined,
        reason: data.reason !== undefined ? String(data.reason) : undefined,
      });
      return;
    }
    if (event.type === "question/requested") {
      const raw = Array.isArray(data.questions) ? (data.questions as Record<string, unknown>[]) : [];
      this.post({
        type: "interaction",
        sessionId,
        rpcId,
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
    let callId = String(data.callId ?? "");
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
        let callId = String(data.callId ?? "");
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

  private async postModels(): Promise<void> {
    if (!this.client || !this.activeSessionId) return;
    try {
      const catalog = await this.client.models(this.activeSessionId);
      this.post({
        type: "models",
        current: catalog.current,
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

  private async postPermissions(): Promise<void> {
    // Post the cached permissions projection (seeded from history tail,
    // refreshed by session/projection pushes). Header labels come from the
    // known three presets (web GUI semantics: 仅可查看 / 可写入工作区 / 完全权限).
    if (!this.permissions || this.permissions.options.length === 0) {
      this.post({ type: "permissions", options: [], current: undefined });
      return;
    }
    const LABELS: Record<string, string> = {
      "read-only": "仅可查看",
      "workspace-write": "可写入工作区",
      "danger-full-access": "完全权限",
    };
    this.post({
      type: "permissions",
      options: this.permissions.options.map((o) => ({
        value: o.value,
        label: LABELS[o.value] ?? o.name ?? o.value,
      })),
      current: this.permissions.currentValue,
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
        break;
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
      const value = await this.client.agentPresetList();
      this.settingsPanel?.webview.postMessage({ type: "settingsAgentPresets", value });
    } catch (error) {
      this.postSettingsError(describeHarnessFailure("读取预设失败", error));
    }
  }

  private postSettingsSaved(message: string): void {
    try {
      void this.settingsPanel?.webview.postMessage({ type: "settingsSaved", message });
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
