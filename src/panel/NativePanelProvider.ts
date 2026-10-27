import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { HarnessClient, RpcErrorResult } from "../harness/client";
import type { AgentTeamProjection, ChangedFileView, ChangesDiffView, ChangesSummaryView, GoalView, JobView, LlmConfigurableProvider, LlmProviderInfo, ModelSelection, ModelSelectionProjection, PresentedFileView, PromptContentPart, QueueAction, SessionAddress, SessionSummary, SettingsDescribeView } from "../harness/protocol";
import type { FollowTarget, WaterfallFrame, WorkspaceState } from "../events/eventStream";
import type { AccountBalanceView, HostMessage, PanelEvent, PanelSession, TodoItem, ToolLineDiff, UpdateCenterHooks, WebviewMessage } from "./protocol";
import { countMetaDiff, countToolArgsDiff } from "../editor/diffCount";
import { INTENT_CHOICES, askPromptText, sendAsk } from "../editor/askSelection";
import { askSessionIdSet } from "../editor/askSessions";
import { deleteSessionStorage } from "../harness/storage";
import { ensureWorkspaceAcl } from "../harness/workspaceAcl";
import type { CompanionStatus } from "../harness/companion";
import type { DshUpdateHooks } from "./protocol";

/** Normalize the settings-page channel picker value (free-form string on the
 *  wire) to a channel the updater understands; unknown → auto. */
function normalizeUpdateChannel(value: unknown): string {
  return value === "stable" || value === "next" || value === "alpha" ? value : "auto";
}

/** Composer file attachments ride the prompt as one upload each; cap matches
 *  the panel-side check so the two ends agree. */
const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024;

/** Image media type for an attachment file name (only the raster images the
 *  harness admits); everything else becomes a generic durable file. */
function attachmentMediaTypeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

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

  private view?: vscode.WebviewView | vscode.WebviewPanel;
  /** True once the webview's own "ready" arrived — posts before that are lost
   *  (a freshly created panel loads asynchronously), so state re-sends on it. */
  private viewReady = false;
  /** True once the one-per-instance registrations (mux bridge + file-index
   *  watchers) were made. */
  private wired = false;
  /** The webview the host-message router is bound to. A closed-and-reopened
   *  panel (or a revived sidebar view) is a NEW webview object — it must get
   *  its own onDidReceiveMessage or it comes back deaf. */
  private wiredWebview?: vscode.Webview;
  /** Last self-reported CSS width (px) of a hosted webview. The sidebar
   *  reports on load/resize; the ask window uses it to size its column. */
  private lastPanelWidth?: number;
  /** Ask surface only: fired when the ask webview reports its width. */
  onAskWidth?: (px: number) => void;
  /** Debounce timer for the list-only session refresh pump. */
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private client: HarnessClient | null = null;
  private activeSessionId: string | null = null;
  /** Manual workspace override picked from the panel header (folder dialog);
   *  wins over the VS Code folder for NEW sessions (persisted across reloads
   *  so the current workspace survives a window restart). */
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
  /** Our plan-mode variant per session + the preset a hard switch locked down
   *  (restored when plan mode ends — only while still read-only). */
  private planVariants = new Map<string, { variant: "soft" | "hard"; restorePermission?: string }>();
  /** Latest account-balance snapshot (account/getBalance) for the panel chip. */
  private lastBalance: AccountBalanceView | null = null;
  /** Last balance fetch time — turn/end refreshes are throttled. */
  private lastBalanceAt = 0;
  /** mux clientId of the $events stream — required by $events/result. */
  private eventClientId = "";
  /** Pending waterfall requests: eventId → sessionId. */
  private pendingWaterfalls = new Map<string, { sessionId: string; message: HostMessage }>();
  /** Unfiltered session/list rows (subagents included) — team member rows,
   *  running flags and per-child model lookups read from here. */
  private rawSessions = new Map<string, SessionSummary>();
  /** Subagent view: the panel is showing a child conversation of the active
   *  team lead (address {kind:'subagent'}) instead of the lead transcript. */
  private teamView: { parentSessionId: string; childSessionId: string } | null = null;
  /** Opens/closes the per-session follow stream (handed in by extension.ts). */
  private setFollowSession: (target: FollowTarget | null) => void = () => {};

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly getClient: () => HarnessClient | null,
    private readonly onSessionEvent: (cb: (sessionId: string, event: PanelEvent) => void) => void,
    /** Ask surface: the whole pipeline with a pinned session and a slimmer
     *  chrome (panel.html ask mode). */
    private readonly askMode = false,
    /** Extension-owned update center (plugin self-update + DSH package hooks;
     *  omit in tests). */
    private readonly options: { updateCenter?: UpdateCenterHooks; dshUpdates?: DshUpdateHooks } = {}
  ) {
    this.manualWorkspace = context.workspaceState.get<string>("dsh.manualWorkspace");
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.viewReady = false;
    const html = this.renderHtml();
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "media")],
    };
    webviewView.webview.html = html;
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) return;
      // Re-showing the sidebar refreshes the balance instead of leaving
      // whatever the chip displayed when it was last hidden.
      this.post({ type: "balance", value: this.lastBalance });
      void this.refreshBalance(true);
    });
    this.wireWebview(webviewView.webview);
  }

  /** Attach a standalone editor-area panel (the ask window). Same webview
   *  contract as the sidebar view. */
  attachPanel(panel: vscode.WebviewPanel): void {
    this.view = panel;
    this.viewReady = false;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "media")],
    };
    panel.webview.html = this.renderHtml();
    panel.onDidDispose(() => {
      if (this.view === panel) this.view = undefined;
    });
    this.wireWebview(panel.webview);
    if (this.askMode) this.log("ask window: attached");
  }

  /** Bind the host-message router to THIS webview (per webview object), and
   *  the mux/file-index registrations once per instance (wiring them twice
   *  would double-post every event). */
  private wireWebview(webview: vscode.Webview): void {
    if (this.wiredWebview !== webview) {
      this.wiredWebview = webview;
      webview.onDidReceiveMessage((message) => {
        void this.onMessage(message as WebviewMessage);
      });
    }
    if (this.wired) return;
    this.wired = true;
    // Route mux events into this surface (filtered by active session host-side).
    this.onSessionEvent((sessionId, event) => {
      this.trackRunning(sessionId, event);
      // Live job/goal/artifact refreshes run for the viewed session only (the
      // cards live in this surface); the raw events still ride through below.
      if (sessionId === this.viewSessionId()) {
        if (event.type === "job/registered" || event.type === "job/settled") this.updateJobEvent(sessionId, event);
        else if (event.type === "goal/change") void this.postGoal(sessionId);
        else if (event.type === "workspace/changes") {
          const turn = Number((event.data as { turn?: unknown } | undefined)?.turn ?? 0);
          if (typeof event.seq === "number") void this.postChanges(sessionId, event.seq, turn);
        } else if (event.type === "deliverables/presented") {
          const data = event.data as { turn?: unknown; files?: unknown } | undefined;
          const files = Array.isArray(data?.files) ? (data.files as PresentedFileView[]) : [];
          this.deliveriesLatest.set(sessionId, { turn: Number(data?.turn ?? 0), files });
          this.post({
            type: "deliveries",
            sessionId,
            turn: Number(data?.turn ?? 0),
            files: files.map((f, index) => ({ index, path: f.path, description: f.description })),
          });
        }
      }
      if (sessionId !== this.viewSessionId()) return;
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
    if (client) {
      // The panel may have loaded before the harness came up (its "ready" ran
      // with no client): seed the chip and fetch so the balance is fresh the
      // moment the panel works, not at some later turn end.
      this.post({ type: "balance", value: this.lastBalance });
      void this.refreshBalance(true);
    }
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
    if (this.view && this.viewReady) {
      this.post({ type: "ask", context: contextBlock, choices: INTENT_CHOICES });
    } else {
      // Webview not loaded yet (or never opened): keep the card until it
      // reports ready.
      this.pendingAsk = { context: contextBlock, choices: INTENT_CHOICES };
    }
  }

  /** extension.ts hands in the follow-stream control after creating the mux. */
  attachStream(controls: { setFollowSession: (target: FollowTarget | null) => void }): void {
    this.setFollowSession = controls.setFollowSession;
  }

  /** The session whose transcript is on screen (subagent view wins). */
  private viewSessionId(): string | null {
    return this.teamView ? this.teamView.childSessionId : this.activeSessionId;
  }

  /** Follow target for the current view (top-level session or subagent child). */
  private followTarget(): FollowTarget | null {
    if (this.teamView) {
      return {
        kind: "subagent",
        parentSessionId: this.teamView.parentSessionId,
        childSessionId: this.teamView.childSessionId,
        mode: "continuable",
      };
    }
    return this.activeSessionId ? { kind: "session", sessionId: this.activeSessionId } : null;
  }

  /** Wire address for paging whatever view is on screen. */
  private addressFor(sessionId: string): SessionAddress {
    if (this.teamView && this.teamView.childSessionId === sessionId) {
      return {
        kind: "subagent",
        parentSessionId: this.teamView.parentSessionId,
        childSessionId: sessionId,
        mode: "continuable",
      };
    }
    return { kind: "session", sessionId };
  }

  /** Follow the active view on the mux (idempotent). */
  private followActive(): void {
    this.setFollowSession(this.followTarget());
  }

  /** Switch this surface to a session: identity first (the renderer drops
   *  history frames for any other session), then history + per-session chrome. */
  private async activateSession(sessionId: string): Promise<void> {
    this.teamView = null;
    this.activeSessionId = sessionId;
    this.postState();
    this.followActive();
    await this.loadHistory(sessionId, undefined);
    await this.postModels();
    await this.postCommands();
    this.postPermissions();
    this.postPlanMode();
    this.postTeam();
    this.postJobsFor(sessionId);
    void this.postGoal(sessionId);
    // An unanswered approval/question can outlive a session switch: the panel
    // clears cards on switch, so re-post this session's pending waterfall or
    // the agent stays blocked with no visible card.
    for (const entry of this.pendingWaterfalls.values()) {
      if (entry.sessionId === sessionId && entry.message.type === "interaction") {
        this.post(entry.message);
      }
    }
  }

  /** Ask surface: pin the dedicated question conversation and load it. */
  openAskSession(sessionId: string): void {
    void this.activateSession(sessionId);
  }

  /** Team card data: the lead's `agentTeam` projection plus live member
   *  statuses (official composition: phase !== active keeps its phase;
   *  active members read the child session's running flag). */
  private postTeam(): void {
    if (this.askMode) return;
    const leadId = this.teamView?.parentSessionId ?? this.activeSessionId;
    const projection = leadId
      ? (this.projections.get(leadId)?.get("agentTeam") as AgentTeamProjection | null | undefined)
      : undefined;
    const members = Array.isArray(projection?.members) ? projection.members : [];
    const tasks = Array.isArray(projection?.tasks) ? projection.tasks : [];
    const view = members.map((m) => {
      const raw = this.rawSessions.get(m.id);
      const status = m.phase === "active" ? (raw?.running ? "running" : "inactive") : m.phase;
      const sel = this.projections.get(m.id)?.get("modelSelection") as ModelSelectionProjection | null | undefined;
      return {
        id: m.id,
        name: m.name,
        role: m.role,
        status,
        model: sel?.next?.model ?? sel?.lastUsed?.model,
        error: m.error,
      };
    });
    this.post({
      type: "team",
      sessionId: leadId ?? "",
      viewSessionId: this.viewSessionId() ?? "",
      members: view,
      tasks,
      failure: typeof projection?.failure === "string" ? projection.failure : undefined,
    });
  }

  /* ---------- background jobs / goals / artifacts ---------- */

  /** Job roster per session, folded from the durable job/registered|settled
   *  session events (the event stream is the only roster source the bridge
   *  uses: job/list is a never-ending stream that a plain RPC call cannot
   *  consume). */
  private jobsBySession = new Map<string, JobView[]>();

  /** Fold one job event into the session roster and repaint the bar. */
  private updateJobEvent(sessionId: string, event: PanelEvent): void {
    const data = event.data as
      | { jobId?: unknown; kind?: unknown; label?: unknown; status?: unknown; finishedAt?: unknown }
      | undefined;
    const id = typeof data?.jobId === "string" ? data.jobId : "";
    if (!id) return;
    const list = this.jobsBySession.get(sessionId) ?? [];
    const index = list.findIndex((job) => job.id === id);
    if (event.type === "job/registered") {
      const job: JobView = {
        id,
        kind: typeof data?.kind === "string" ? data.kind : "",
        label: typeof data?.label === "string" ? data.label : id,
        status: "running",
        startedAt: typeof event.time === "number" ? event.time : Date.now(),
      };
      if (index >= 0) list[index] = { ...list[index], ...job };
      else list.push(job);
    } else if (index >= 0) {
      const settled = typeof data?.status === "string" ? data.status : "completed";
      list[index] = {
        ...list[index],
        status: settled === "completed" || settled === "killed" || settled === "failed" ? settled : "completed",
        finishedAt: typeof data?.finishedAt === "number" ? data.finishedAt : Date.now(),
      };
    }
    while (list.length > 20) {
      const done = list.findIndex((job) => job.status !== "running" && job.status !== "stopping");
      list.splice(done >= 0 ? done : 0, 1);
    }
    this.jobsBySession.set(sessionId, list);
    this.postJobsFor(sessionId);
  }

  /** Push the roster of the viewed session (no-op for other sessions). */
  private postJobsFor(sessionId: string): void {
    if (sessionId !== this.viewSessionId()) return;
    const jobs = this.jobsBySession.get(sessionId) ?? [];
    this.post({
      type: "jobs",
      sessionId,
      jobs: jobs.map((job) => ({
        id: job.id,
        kind: job.kind,
        label: job.label,
        status: job.status,
        detail: job.detail,
        progress: job.progress,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        outputTotal: job.output?.total,
      })),
    });
  }

  private goalToken = 0;

  /** Push the viewed session's goal (goals/get). */
  private async postGoal(sessionId: string): Promise<void> {
    if (!this.client || !sessionId) return;
    const token = ++this.goalToken;
    try {
      const goal = await this.client.goalsGet(sessionId);
      if (token !== this.goalToken || sessionId !== this.viewSessionId()) return;
      this.post({
        type: "goal",
        sessionId,
        goal: goal
          ? {
              id: goal.id,
              revision: goal.revision,
              roundsStarted: goal.roundsStarted,
              maxGoalRounds: goal.maxGoalRounds,
              objective: goal.objective,
              phase: goal.phase,
              activation: goal.activation,
              blockedReason: goal.blockedReason?.message,
            }
          : null,
      });
    } catch {
      // Older harnesses without the goal plugin: no chip.
    }
  }

  /** Latest workspace/changes summary per session (diff coordinates). */
  private changesLatest = new Map<string, { seq: number; turn: number; files: ChangedFileView[] }>();
  /** Latest deliverables/presented files per session (open coordinates). */
  private deliveriesLatest = new Map<string, { turn: number; files: PresentedFileView[] }>();

  /** Fetch one turn's changed-file summary and push it to the panel. */
  private async postChanges(sessionId: string, seq: number, turn: number): Promise<void> {
    if (!this.client) return;
    try {
      const summary: ChangesSummaryView = await this.client.changesSummary(sessionId, seq);
      if (sessionId !== this.viewSessionId()) return;
      this.changesLatest.set(sessionId, { seq, turn, files: summary.files ?? [] });
      this.post({
        type: "changes",
        sessionId,
        turn: typeof summary.turn === "number" ? summary.turn : turn,
        files: (summary.files ?? []).map((f, index) => ({
          index,
          display: f.display,
          added: f.added,
          deleted: f.deleted,
          binary: f.binary,
          oversized: f.oversized,
        })),
        total: summary.total,
        added: summary.added,
        deleted: summary.deleted,
      });
    } catch (error) {
      this.log(`changes summary: ${(error as Error).message}`);
    }
  }

  /** Turn a stored comparison into a unified diff and open it in VS Code. */
  private async openChangeDiff(index: number): Promise<void> {
    const sessionId = this.viewSessionId();
    const latest = sessionId ? this.changesLatest.get(sessionId) : undefined;
    if (!this.client || !sessionId || !latest) return;
    try {
      const diff: ChangesDiffView = await this.client.changesDiff(sessionId, latest.seq, index);
      if (diff.kind !== "text") {
        void vscode.window.showInformationMessage(
          diff.kind === "binary" ? `${diff.display}：二进制文件，无法显示差异` : `${diff.display}：文件过大，未生成差异`
        );
        return;
      }
      const header = `--- a/${diff.display}\n+++ b/${diff.display}\n`;
      const body = (diff.hunks ?? [])
        .map(
          (h) =>
            `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n` + (h.lines ?? []).join("\n") + "\n"
        )
        .join("");
      const doc = await vscode.workspace.openTextDocument({ content: header + body, language: "diff" });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (error) {
      void vscode.window.showErrorMessage(`打开差异失败：${(error as Error).message}`);
    }
  }

  /** Open one presented deliverable file in the editor. */
  private async openDelivered(index: number): Promise<void> {
    const sessionId = this.viewSessionId();
    const latest = sessionId ? this.deliveriesLatest.get(sessionId) : undefined;
    const file = latest?.files[index];
    if (!file) return;
    const raw = file.path;
    const sessionCwd = sessionId ? this.rawSessions.get(sessionId)?.cwd : undefined;
    const target = path.isAbsolute(raw)
      ? raw
      : path.join(sessionCwd ?? this.workspaceCwd() ?? "", raw);
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true });
    } catch {
      void vscode.workspace.openTextDocument(vscode.Uri.file(target)).then(
        (doc) => vscode.window.showTextDocument(doc, { preview: true }),
        () => vscode.window.showWarningMessage(`无法打开 ${file.path}`)
      );
    }
  }

  /** Show one teammate's child conversation (the official continuable
   *  addressing). The lead stays activeSessionId; only the view flips. */
  private async openTeamMember(childSessionId: string): Promise<void> {
    const lead = this.teamView?.parentSessionId ?? this.activeSessionId;
    if (!lead || !this.client) return;
    if (childSessionId === lead) {
      this.teamBack();
      return;
    }
    const child = this.rawSessions.get(childSessionId);
    if (child && child.parentSessionId && child.parentSessionId !== lead) return;
    this.teamView = { parentSessionId: lead, childSessionId };
    this.postState();
    this.followActive();
    await this.loadHistory(childSessionId, undefined);
    this.postTeam();
  }

  /** Return from a teammate transcript to the lead conversation. */
  private teamBack(): void {
    const tv = this.teamView;
    if (!tv) return;
    this.teamView = null;
    this.postState();
    if (tv.parentSessionId === this.activeSessionId) {
      this.followActive();
      void this.loadHistory(tv.parentSessionId, undefined).then(() => {
        this.postModels();
        this.postPermissions();
        this.postPlanMode();
        this.postTeam();
      });
    } else {
      void this.activateSession(tv.parentSessionId);
    }
    this.postTeam();
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
    if (key === "plan") {
      // Runs BEFORE the active-session guard: the hard-variant permission
      // restore must fire even when the panel is showing another session.
      this.handlePlanProjection(sessionId, value);
      return;
    }
    if (key === "agentTeam") {
      // Team state belongs to the lead conversation; refresh the card even
      // while a teammate's transcript is on screen.
      if (sessionId === (this.teamView?.parentSessionId ?? this.activeSessionId)) this.postTeam();
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
    // Any api-session delta also schedules a debounced list refresh so the
    // picker reflects new/updated conversations (ask windows included)
    // without waiting for a reload.
    if (event.startsWith("api-session/")) this.scheduleRefresh();
    if (event === "api-session/added") {
      const item = args[0] as SessionSummary | undefined;
      if (!item || typeof item.sessionId !== "string") return;
      this.rawSessions.set(item.sessionId, item);
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
      const raw = this.rawSessions.get(sessionId);
      if (raw) this.rawSessions.set(sessionId, { ...raw, running });
      const row = this.sessions.find((s) => s.sessionId === sessionId);
      if (row) row.running = running;
      if (sessionId) this.post({ type: "running", sessionId, running });
      if (sessionId === this.activeSessionId) this.postState();
      this.postTeam();
      return;
    }
    if (event === "api-session/removed") {
      const sessionId = String(args[0] ?? "");
      if (!sessionId) return;
      this.rawSessions.delete(sessionId);
      this.sessions = this.sessions.filter((s) => s.sessionId !== sessionId);
      if (this.teamView?.childSessionId === sessionId) this.teamBack();
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
        this.followActive();
      }
      this.postState();
      this.postTeam();
      return;
    }
    if (event === "commands/change") {
      void this.postCommands();
      return;
    }
    // Live invalidation (settings documents, LLM adapters/credentials, the
    // permission-preset catalog, agent presets): the open settings page and
    // the panel chrome follow the host's own change events instead of
    // requiring a reload.
    if (
      event === "settings/document-updated" ||
      event === "llm/adapters-updated" ||
      event === "credentials/record-updated" ||
      event === "credentials/reference-updated"
    ) {
      if (this.settingsPanel) void this.postSettingsData();
      return;
    }
    if (event === "permission-presets/catalog-changed") {
      void this.postPermissions();
      if (this.settingsPanel) void this.postSettingsData();
      return;
    }
    if (event === "agent-preset/selected") {
      void this.postModels();
      if (this.settingsPanel) void this.postSettingsData();
      return;
    }
    if (event === "goal/activation-changed") {
      const viewId = this.viewSessionId();
      if (viewId) void this.postGoal(viewId);
      return;
    }
    if (event === "plugin-market/changed") {
      if (this.settingsPanel) void this.postPlugins();
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
   *  re-show it); post it only while its session is the one on screen —
   *  sibling surfaces (the ask window) run their own instance. */
  private rememberWaterfall(eventId: string, sessionId: string, message: HostMessage): void {
    this.pendingWaterfalls.set(eventId, { sessionId, message });
    if (this.pendingWaterfalls.size > 200) {
      const oldest = this.pendingWaterfalls.keys().next().value;
      if (oldest !== undefined) this.pendingWaterfalls.delete(oldest);
    }
    if (sessionId === this.activeSessionId) this.post(message);
  }

  /** $events cancel: the waterfall was withdrawn (e.g. the run ended). */
  onWaterfallCancel(eventId: string): void {
    const sessionId = this.pendingWaterfalls.get(eventId)?.sessionId ?? this.activeSessionId ?? "";
    this.pendingWaterfalls.delete(eventId);
    this.post({ type: "interactionSettled", sessionId, rpcId: eventId });
  }

  /** Render the inbox projection as the pending-send rows above the input. */
  private postQueue(sessionId: string, inbox: unknown): void {
    type InboxRow = {
      id?: string;
      content?: { type?: string; text?: string }[];
      source?: { kind?: string; summary?: string };
    };
    const v = (inbox ?? {}) as { "next-turn"?: InboxRow[]; "next-step"?: InboxRow[] };
    // The inbox carries the ORIGINAL message objects, including `source`
    // (e.g. {kind:"tool-jobs"} completion notices). Pass the kind through so
    // the panel can label harness notices instead of calling them user input.
    const mapRow = (row: InboxRow, placement: "queued" | "steering") => ({
      id: String(row.id ?? ""),
      placement,
      text: textOf(row.content),
      ...(typeof row.source?.kind === "string" ? { source: row.source.kind } : {}),
      ...(typeof row.source?.summary === "string" ? { summary: row.source.summary } : {}),
    });
    this.post({
      type: "queue",
      sessionId,
      items: [...(v["next-turn"] ?? []).map((row) => mapRow(row, "queued")), ...(v["next-step"] ?? []).map((row) => mapRow(row, "steering"))],
    });
  }

  async refresh(): Promise<void> {
    if (!this.client) {
      this.post({ type: "state", connected: false, sessions: [], activeSessionId: null, mode: this.askMode ? "ask" : "main" });
      return;
    }
    if (this.askMode) {
      // Ask surface: no session list, no auto-open — just the pinned
      // question conversation (once one has been resolved).
      this.postState();
      if (this.activeSessionId) await this.loadHistory(this.activeSessionId, undefined);
      return;
    }
    await this.refreshSessions();
    try {
      if (this.activeSessionId) {
        await this.loadHistory(this.activeSessionId, undefined);
        await this.postModels();
        await this.postCommands();
        this.postPermissions();
        this.postPlanMode();
      }
    } catch (error) {
      this.post({ type: "error", message: describeHarnessFailure("会话加载失败", error) });
    }
  }

  /** Debounced, list-only refresh. Public: the extension asks for a quick
   *  picker update right after creating the ask conversation. */
  scheduleRefresh(delay = 600): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.askMode) {
        this.postState();
        return;
      }
      void this.refreshSessions();
    }, delay);
  }

  /** Session-list freshness only (picker rows: titles/times/running dots) —
   *  shared by refresh() and the api-session event pump, so live turns do not
   *  re-fetch the transcript mid-scroll. */
  private async refreshSessions(): Promise<void> {
    if (!this.client) return;
    try {
      const { items } = await this.client.listSessions();
      // Keep the unfiltered view (subagent children included): the team card
      // derives member running flags and models from these rows.
      this.rawSessions = new Map(items.map((item) => [item.sessionId, item]));
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
        const plan = item.projections?.values?.plan;
        if (perms === undefined && plan === undefined) continue;
        let values = this.projections.get(item.sessionId);
        if (!values) {
          values = new Map<string, unknown>();
          this.projections.set(item.sessionId, values);
        }
        if (perms !== undefined && !values.has("permissions")) values.set("permissions", perms);
        if (plan !== undefined && !values.has("plan")) values.set("plan", plan);
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
        // The dedicated ask conversation of this workspace is never
        // auto-opened as the coding chat — it lives in its own window.
        const askIds = askSessionIdSet(this.context);
        const match = cwd
          ? this.sessions.find((s) => s.cwd && normalizePath(s.cwd) === normalizePath(cwd) && !askIds.has(s.sessionId))
          : undefined;
        if (match) this.activeSessionId = match.sessionId;
      }
      this.postState();
      this.followActive();
      this.postTeam();
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

  /** The workspace the panel currently follows (button-picked folder first):
   *  used for the ask conversation key so asks land in the workspace shown in
   *  the header, not the folder of whichever editor file is active. */
  currentWorkspaceCwd(): string | undefined {
    return this.workspaceCwd();
  }

  /** Last self-reported width (px) of a hosted webview — used to size the
   *  ask window column to the sidebar width. */
  panelWidthPx(): number | undefined {
    return this.lastPanelWidth;
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "panelWidth") {
      // Webview self-measurement (load/resize): stored for the ask-window
      // width match; informational, so it works even before a client lands.
      const px = Math.round(message.px);
      if (Number.isFinite(px) && px > 80) {
        this.lastPanelWidth = px;
        if (this.askMode) this.onAskWidth?.(px);
      }
      return;
    }
    if (!this.client) {
      this.post({ type: "error", message: "harness 未连接" });
      return;
    }
    switch (message.type) {
      case "ready":
        this.viewReady = true;
        if (this.askMode) this.log(`ask window: ready (${this.activeSessionId ?? "no session"})`);
        this.postState();
        if (this.pendingAsk) {
          const pending = this.pendingAsk;
          this.pendingAsk = null;
          this.post({ type: "ask", context: pending.context, choices: pending.choices });
        }
        try {
          if (this.activeSessionId) {
            await this.loadHistory(this.activeSessionId, undefined);
            if (this.askMode) {
              // The session was pinned before this webview finished loading;
              // re-send the per-session chrome its activateSession posts lost.
              await this.postModels();
              await this.postCommands();
              this.postPermissions();
              this.postPlanMode();
            }
          }
          await this.buildFileIndex();
          // Seed the ＋ mode dropdown with the agent-preset roster.
          await this.postAgentPresets();
          // Account balance chip: show the last snapshot instantly, then refresh.
          this.post({ type: "balance", value: this.lastBalance });
          void this.refreshBalance(true);
        } catch (error) {
          // One failed fetch must not kill the rest of the boot sequence (the
          // state + ask card above already went out).
          this.log(`ready handling failed: ${(error as Error).message}`);
        }
        break;
      case "selectSession":
        await this.activateSession(message.sessionId);
        break;
      case "teamOpen":
        await this.openTeamMember(message.childSessionId);
        break;
      case "teamBack":
        this.teamBack();
        break;
      case "jobKill": {
        const sessionId = this.viewSessionId();
        if (!this.client || !sessionId) break;
        try {
          await this.client.jobKill(sessionId, message.jobId);
          const list = this.jobsBySession.get(sessionId) ?? [];
          const job = list.find((j) => j.id === message.jobId);
          if (job && job.status === "running") job.status = "stopping";
          this.postJobsFor(sessionId);
        } catch (error) {
          this.post({ type: "error", message: `停止任务失败：${(error as Error).message}` });
        }
        break;
      }
      case "goalCreate": {
        const sessionId = this.viewSessionId();
        const objective = message.objective.trim();
        if (!this.client || !sessionId || !objective) break;
        try {
          await this.client.goalsCreate(sessionId, objective);
          await this.postGoal(sessionId);
        } catch (error) {
          this.post({ type: "error", message: `创建目标失败：${(error as Error).message}` });
        }
        break;
      }
      case "goalPause":
      case "goalResume":
      case "goalComplete":
      case "goalClear": {
        const sessionId = this.viewSessionId();
        if (!this.client || !sessionId) break;
        try {
          if (message.type === "goalClear") {
            const goal = await this.client.goalsGet(sessionId);
            if (goal) await this.client.goalsClear(sessionId, { id: goal.id, revision: goal.revision });
          } else {
            const goal = await this.client.goalsGet(sessionId);
            if (goal) {
              const ref = { id: goal.id, revision: goal.revision };
              if (message.type === "goalPause") await this.client.goalsPause(sessionId, ref);
              else if (message.type === "goalResume") await this.client.goalsResume(sessionId, ref);
              else await this.client.goalsComplete(sessionId, ref);
            }
          }
          await this.postGoal(sessionId);
        } catch (error) {
          this.post({ type: "error", message: `更新目标失败：${(error as Error).message}` });
        }
        break;
      }
      case "openChangeDiff":
        void this.openChangeDiff(message.index);
        break;
      case "openDelivered":
        void this.openDelivered(message.index);
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
      case "readAttachmentFile": {
        // Explorer drag-and-drop: the webview only has the dropped file's
        // path — read it here (25MB cap) and answer with base64 for the
        // composer's attachment rail.
        const name = path.basename(message.path);
        try {
          const stat = await fs.promises.stat(message.path);
          if (!stat.isFile()) {
            this.post({ type: "attachmentFileRead", requestId: message.requestId, name, error: "不是常规文件" });
            break;
          }
          if (stat.size > MAX_ATTACHMENT_FILE_BYTES) {
            this.post({
              type: "attachmentFileRead",
              requestId: message.requestId,
              name,
              error: `文件超过 ${Math.floor(MAX_ATTACHMENT_FILE_BYTES / (1024 * 1024))}MB`,
            });
            break;
          }
          const data = await fs.promises.readFile(message.path);
          this.post({
            type: "attachmentFileRead",
            requestId: message.requestId,
            name,
            size: stat.size,
            mediaType: attachmentMediaTypeFor(name),
            data: data.toString("base64"),
          });
        } catch (error) {
          this.post({ type: "attachmentFileRead", requestId: message.requestId, name, error: (error as Error).message });
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
        void this.context.workspaceState.update("dsh.manualWorkspace", cwd);
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
          if (this.askMode && this.activeSessionId) {
            // Dedicated ask conversation: straight into the pinned session
            // (no most-recent-session heuristic).
            await this.client.prompt(this.activeSessionId, [{ type: "text", text: askPromptText(context, instruction) }], "queue");
          } else {
            await sendAsk(this.client, context, instruction, this.archivedSessionIds);
          }
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
            value: { answers: message.answers ?? [] },
          });
          // Plan review answered with the approve label: mirror the plan
          // menu's optimistic flip so the button shows the queued "pending"
          // state until the projection lands (otherwise it snaps straight
          // from active to off with no transition).
          const entry = this.pendingWaterfalls.get(message.rpcId);
          if (entry && entry.message.type === "interaction" && entry.message.kind === "question") {
            const review = entry.message.questions.find((q) => q.intent && q.intent.kind === "plan-review");
            const approveLabel = review?.intent?.approve;
            if (review && approveLabel && (message.answers ?? []).some((a) => a.id === review.id && a.selected.includes(approveLabel))) {
              this.rememberPlan(message.sessionId, false, true, null);
              this.postPlanMode();
            }
          }
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
            // Manual permission change while plan+read-only is engaged means
            // the user is taking the wheel: silently downgrade the plan
            // variant to soft so exiting plan mode will not restore a stale
            // preset over the user's own pick.
            const plan = this.planVariants.get(this.activeSessionId);
            if (plan && plan.variant === "hard" && message.permission !== "read-only") {
              this.planVariants.set(this.activeSessionId, { variant: "soft" });
              this.log(`plan variant downgraded to soft (manual permission switch) on ${this.activeSessionId}`);
              this.postPlanMode();
            }
          }
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("切换权限失败", error) });
        }
        break;
      }
      case "planMode": {
        if (!this.activeSessionId || !this.client) break;
        const sessionId = this.activeSessionId;
        try {
          if (message.action === "off") {
            const outcome = await this.client.commandExecute(sessionId, "/plan off");
            if (!outcome || !outcome.result || outcome.result.kind === "error") {
              const detail = outcome?.result?.text ? `：${outcome.result.text}` : "";
              this.post({ type: "error", message: `退出计划模式失败${detail}` });
            } else {
              this.log(`plan switch: off on ${sessionId}`);
              this.rememberPlan(sessionId, false, true, null); // queued: flips next step
            }
          } else {
            // Both variants run the official /plan command; HARD additionally
            // locks the preset to read-only until plan mode ends (restored in
            // handlePlanProjection when the plan projection reports off).
            const outcome = await this.client.commandExecute(sessionId, "/plan");
            if (!outcome || !outcome.result || outcome.result.kind === "error") {
              const detail = outcome?.result?.text ? `：${outcome.result.text}` : "";
              this.post({ type: "error", message: `切换计划模式失败${detail}` });
            } else {
              this.log(`plan switch: ${message.action} on ${sessionId}`);
              this.rememberPlan(sessionId, true, true, message.action === "hard" ? "hard" : "soft");
              if (message.action === "hard") {
                const lock = await this.client.commandExecute(sessionId, "/permission read-only");
                if (lock && lock.result && lock.result.kind !== "error") this.rememberPermission(sessionId, "read-only");
              }
            }
          }
          this.postPlanMode();
          this.postPermissions();
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("切换计划模式失败", error) });
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
        const atts = message.attachments ?? [];
        if (!text && atts.length === 0) return;
        const mode = message.mode ?? "queue";
        // Subagent view: the child conversation is addressed through its lead.
        // Only text + images are admissible (the official addressing refuses
        // durable files for subagent prompts).
        if (this.teamView) {
          const tv = this.teamView;
          const content: PromptContentPart[] = [];
          for (const a of atts) {
            if (a.kind === "file") {
              this.post({ type: "error", message: "给团队成员发消息只能附带图片，不能附带文件（DSH 本体限制）。" });
              return;
            }
            content.push({ type: "image", mediaType: a.mediaType ?? "image/png", data: a.data, name: a.name });
          }
          if (text) content.push({ type: "text", text });
          if (!content.length) return;
          try {
            await this.client.subagentsPrompt(tv.parentSessionId, tv.childSessionId, content, mode === "steer" ? "steer" : "queue");
            this.post({ type: "running", sessionId: tv.childSessionId, running: true });
          } catch (error) {
            this.post({ type: "error", message: describeHarnessFailure("发送失败", error) });
          }
          return;
        }
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
        // A leading-slash line with no attachments is a real slash command —
        // dispatch it through the commands domain instead of sending it to the
        // agent as plain text.
        if (mode === "queue" && text && text.startsWith("/") && atts.length === 0) {
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
        const content: PromptContentPart[] = [];
        try {
          for (const a of atts) {
            if (a.kind === "file") {
              // Durable file: upload once (content-addressed), then reference
              // the one-shot receipt the host resolves during admission.
              const up = await this.client.uploadFile(sessionId, a.data, a.name);
              content.push({ type: "file", receiptId: up.receiptId });
            } else {
              content.push({ type: "image", mediaType: a.mediaType ?? "image/png", data: a.data, name: a.name });
            }
          }
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure("附件上传失败", error) });
          return;
        }
        if (text) content.push({ type: "text", text });
        if (content.length === 0) return;
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
        await this.loadHistory(this.viewSessionId() ?? "", message.beforeSeq);
        break;
      case "cancel":
        if (this.teamView) {
          const tv = this.teamView;
          try {
            await this.client.subagentInterrupt(tv.childSessionId, tv.parentSessionId);
            this.post({ type: "running", sessionId: tv.childSessionId, running: false });
          } catch (error) {
            this.post({ type: "error", message: describeHarnessFailure("停止失败", error) });
          }
          break;
        }
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
      const { records, hasMore } = await this.client.pageAddress(this.addressFor(sessionId), cursor, beforeSeq, 30);
      const mapped = records.map((entry) => entry.event as PanelEvent);
      // Per-call "+N-M" diffs for this page, shipped inside the history frame
      // so the panel has them in hand while folding the page in.
      const toolDiffs = this.diffEntriesForPage(mapped);
      // Tail page: seed the task bar / permission select / queue rows from the
      // control-plane projection cache (the session/control stream source —
      // the same values the web GUI renders). Subagent views keep the lead's
      // chrome untouched — a child has no composer preset row of its own.
      if (beforeSeq === undefined && !this.teamView) this.applyCachedProjections(sessionId);
      this.post({
        type: "history",
        sessionId,
        events: mapped,
        hasMore: hasMore === true,
        isOlder: beforeSeq !== undefined,
        toolDiffs: Object.keys(toolDiffs).length > 0 ? toolDiffs : undefined,
      });
      // Recover the tail turn's artifact coordinates from the page itself:
      // workspace/changes carries its own seq (the summary route key) and
      // deliverables/presented carries the declared files.
      if (beforeSeq === undefined) {
        const roster: JobView[] = [];
        for (const event of mapped) {
          if (event.type !== "job/registered" && event.type !== "job/settled") continue;
          const d = event.data as { jobId?: unknown; kind?: unknown; label?: unknown; status?: unknown; finishedAt?: unknown } | undefined;
          const id = typeof d?.jobId === "string" ? d.jobId : "";
          if (!id) continue;
          const idx = roster.findIndex((job) => job.id === id);
          if (event.type === "job/registered") {
            const row: JobView = {
              id,
              kind: typeof d?.kind === "string" ? d.kind : "",
              label: typeof d?.label === "string" ? d.label : id,
              status: "running",
              startedAt: typeof event.time === "number" ? event.time : Date.now(),
            };
            if (idx >= 0) roster[idx] = { ...roster[idx], ...row };
            else roster.push(row);
          } else if (idx >= 0) {
            const settled = typeof d?.status === "string" ? d.status : "completed";
            roster[idx] = {
              ...roster[idx],
              status: settled === "completed" || settled === "killed" || settled === "failed" ? settled : "completed",
              finishedAt: typeof d?.finishedAt === "number" ? d.finishedAt : Date.now(),
            };
          }
        }
        this.jobsBySession.set(sessionId, roster);
        this.postJobsFor(sessionId);
        for (let i = mapped.length - 1; i >= 0; i -= 1) {
          const event = mapped[i];
          if (event.type === "workspace/changes" && typeof event.seq === "number") {
            void this.postChanges(sessionId, event.seq, Number((event.data as { turn?: unknown } | undefined)?.turn ?? 0));
            break;
          }
        }
        for (let i = mapped.length - 1; i >= 0; i -= 1) {
          const event = mapped[i];
          if (event.type === "deliverables/presented") {
            const data = event.data as { turn?: unknown; files?: unknown } | undefined;
            const files = Array.isArray(data?.files) ? (data.files as PresentedFileView[]) : [];
            this.deliveriesLatest.set(sessionId, { turn: Number(data?.turn ?? 0), files });
            this.post({
              type: "deliveries",
              sessionId,
              turn: Number(data?.turn ?? 0),
              files: files.map((f, index) => ({ index, path: f.path, description: f.description })),
            });
            break;
          }
        }
      }
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

  /** `plan` projection push (~stateVersion 3 view {active, pending}): reflect
   *  the toggle and run the hard-variant permission restore on the
   *  active→false edge (approve / exit — every path funnels through here). */
  private handlePlanProjection(sessionId: string, value: unknown): void {
    const view = (value ?? undefined) as { active?: boolean; pending?: boolean } | null | undefined;
    const active = view?.active === true;
    const pending = view?.pending === true;
    const meta = this.planVariants.get(sessionId);
    if (meta && !active && !pending) {
      const restore = meta.restorePermission;
      if (meta.variant === "hard" && restore && this.currentPermission === "read-only") {
        // Never clobber a preset the user changed meanwhile: restore only
        // while the session is still under the lock we applied.
        void this.client
          ?.commandExecute(sessionId, `/permission ${restore}`)
          .then(() => {
            this.rememberPermission(sessionId, restore);
            if (sessionId === this.activeSessionId) void this.postPermissions();
          })
          .catch((error) => this.log(`plan restore permission: ${(error as Error).message}`));
      }
      this.planVariants.delete(sessionId);
    }
    if (sessionId !== this.activeSessionId) return;
    this.log(`plan projection: ${sessionId.slice(0, 18)} -> ${active ? "on" : "off"}${pending ? " (pending)" : ""}`);
    this.postPlanMode();
  }

  /** Optimistic echo of a confirmed /plan switch: writes the cached view and
   *  records which variant owns the session (hard also pins its restore). */
  private rememberPlan(sessionId: string, active: boolean, pending: boolean, variant: "soft" | "hard" | null): void {
    let values = this.projections.get(sessionId);
    if (!values) {
      values = new Map<string, unknown>();
      this.projections.set(sessionId, values);
    }
    values.set("plan", { active, pending });
    if (variant === "hard") {
      this.planVariants.set(sessionId, { variant: "hard", restorePermission: this.currentPermission });
    } else if (variant === "soft") {
      const prev = this.planVariants.get(sessionId);
      this.planVariants.set(sessionId, { variant: "soft", restorePermission: prev?.restorePermission });
    }
  }

  /** Push the active session's plan view (button state: off/on + pending). */
  private postPlanMode(): void {
    const cached = (this.activeSessionId
      ? this.projections.get(this.activeSessionId)?.get("plan")
      : undefined) as { active?: boolean; pending?: boolean } | null | undefined;
    const active = cached?.active === true;
    const pending = cached?.pending === true;
    const meta = this.activeSessionId ? this.planVariants.get(this.activeSessionId) : undefined;
    const variant = active || pending ? meta?.variant ?? "soft" : null;
    this.post({ type: "planMode", active, pending, variant });
  }

  /**
   * Pull the account balance (account/getBalance) and push it to the panel
   * chip. Throttled unless forced: turn ends are frequent and the balance
   * moves slowly. Failures only log — the chip keeps its last snapshot.
   */
  private async refreshBalance(force = false): Promise<void> {
    if (!this.client) return;
    const now = Date.now();
    if (!force && now - this.lastBalanceAt < 10000) return;
    this.lastBalanceAt = now;
    try {
      const raw = await this.client.getAccountBalance(this.context.extension.packageJSON.version as string, "zh-CN");
      const view: AccountBalanceView | null =
        raw && Array.isArray(raw.value)
          ? { status: raw.status, wallets: raw.value, bonusWallets: raw.bonusWallets ?? [] }
          : null;
      this.lastBalance = view;
      this.post({ type: "balance", value: view });
    } catch (error) {
      this.log(`balance: ${(error as Error).message}`);
    }
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
    this.postPlanMode();
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
      // A finished turn is the moment tokens were billed: refresh the balance
      // chip (throttled inside; covers background sessions too).
      void this.refreshBalance();
      this.noteTurnFailure(sessionId, event);
    } else if (event.type === "session/title") {
      const title = (event.data as { title?: string } | undefined)?.title;
      if (typeof title === "string") {
        this.titles.set(sessionId, title);
        if (sessionId === this.activeSessionId) this.postState();
      }
    }
  }

  /** One toast per failed turn (turn/end.reason.kind === "error").
   *  The panel paints the failure in the transcript; this singleton toast is
   *  for the background-tab case where the user is not looking at the panel.
   *  QUOTA gets a direct top-up action — that class of failure is fixed by a
   *  top-up, not by retrying. Disable with dshVsc.notifyTurnFailures. */
  private notedTurnFailures = new Set<string>();
  private noteTurnFailure(sessionId: string, event: PanelEvent): void {
    const data = event.data as
      | { turn?: number; reason?: { kind?: string; error?: { message?: string; code?: string; status?: number } } }
      | undefined;
    const reason = data?.reason;
    if (!reason || reason.kind !== "error") return;
    const enabled = vscode.workspace.getConfiguration("dshVsc").get<boolean>("notifyTurnFailures", true);
    if (!enabled) return;
    const key = sessionId + ":" + String(data?.turn ?? "");
    if (this.notedTurnFailures.has(key)) return;
    this.notedTurnFailures.add(key);
    if (this.notedTurnFailures.size > 50) this.notedTurnFailures.clear();
    const err = reason.error ?? {};
    const code = typeof err.code === "string" ? err.code : "";
    const quota = code === "QUOTA" || code === "ACCOUNT_QUOTA";
    const msg = typeof err.message === "string" && err.message !== "" ? err.message : "未知错误";
    const full = (quota ? "DSH 运行失败：账户余额不足" : "DSH 运行失败") + " — " + msg;
    if (quota) {
      void vscode.window.showErrorMessage(full, "打开充值页").then((pick) => {
        if (pick === "打开充值页") void vscode.env.openExternal(vscode.Uri.parse("https://platform.deepseek.com/top_up"));
      });
    } else {
      void vscode.window.showErrorMessage(full);
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
      mode: this.askMode ? "ask" : "main",
      viewSessionId: this.viewSessionId(),
      subview: this.teamView ? { ...this.teamView } : null,
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
  /** VSIX-shipped companion bundle status (owned by extension.ts). */
  private companionStatus: CompanionStatus | null = null;

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
    // Update-center messages work without a harness connection (the plugin
    // check talks to GitHub); everything else below needs the harness.
    const updateType = String(msg.type ?? "");
    if (
      updateType === "pluginUpdateCheck" ||
      updateType === "pluginUpdateInstall" ||
      updateType === "pluginUpdateRestart" ||
      updateType === "dshUpdateCheck" ||
      updateType === "dshUpdateInstall"
    ) {
      await this.handleUpdateCenterMessage(updateType, msg);
      return;
    }
    if (updateType === "settingsReady") {
      // Installed versions come from the extension host, not the harness —
      // answer before the client check below can bail out.
      const dshVersion = this.options.dshUpdates ? await this.options.dshUpdates.installedVersion() : "";
      this.postSettingsMessage({
        type: "updateVersions",
        plugin: this.options.updateCenter?.installedVersion() ?? "",
        dsh: dshVersion,
      });
    }
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
      case "pluginWaitInstall": {
        // Recovery for a lost install response: ask the harness to settle the
        // original requestId instead of re-running a possibly-finished install.
        const requestId = String(msg.requestId ?? this.pluginInstallRequestId ?? "");
        if (!requestId) {
          this.postSettingsError("没有可核对的安装请求");
          break;
        }
        try {
          const value = await this.client.waitForInstall(requestId);
          if (value) {
            this.postSettingsMessage({ type: "pluginInstallResult", spec: this.lastInstallSpec, value, recovered: true });
            await this.postPlugins();
          } else {
            this.postSettingsError("该安装请求仍在进行或已被 harness 遗忘（可稍后重试）");
          }
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("核对安装状态失败", error));
        }
        break;
      }
      case "pluginMarketIndexes": {
        try {
          const value = await this.client.marketIndexes();
          this.postSettingsMessage({ type: "pluginMarketIndexes", value });
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("读取插件市场索引失败", error));
        }
        break;
      }
      case "pluginMarketSearch": {
        const url = String(msg.url ?? "").trim();
        const rawQuery = (msg.query && typeof msg.query === "object" ? msg.query : {}) as Record<string, unknown>;
        const text = typeof rawQuery.text === "string" ? rawQuery.text.trim() : undefined;
        const offset = typeof rawQuery.offset === "number" && rawQuery.offset >= 0 ? Math.floor(rawQuery.offset) : 0;
        const limitRaw = typeof rawQuery.limit === "number" ? Math.floor(rawQuery.limit) : 30;
        const limit = Math.min(100, Math.max(1, limitRaw));
        if (!url) {
          this.postSettingsError("请选择一个市场索引");
          break;
        }
        try {
          const value = await this.client.marketSearch(url, {
            ...(text ? { text } : {}),
            sort: { kind: text ? "relevance" : "index" },
            offset,
            limit,
          });
          this.postSettingsMessage({ type: "pluginMarketSearch", url, value });
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("插件市场检索失败", error));
        }
        break;
      }
      case "pluginMarketSetIndexes": {
        const urls = Array.isArray(msg.urls) ? (msg.urls as unknown[]).map((u) => String(u).trim()).filter(Boolean) : [];
        try {
          await this.client.marketSetIndexes(urls);
          const value = await this.client.marketIndexes();
          this.postSettingsMessage({ type: "pluginMarketIndexes", value });
          this.postSettingsSaved(`已保存 ${urls.length} 个市场索引`);
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("保存市场索引失败", error));
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
      case "providerKeys":
        await this.postProviderKeys();
        break;
      case "setProviderKey": {
        const provider = String(msg.provider ?? "").trim();
        const value = typeof msg.value === "string" ? msg.value.trim() : "";
        if (!provider) break;
        if (!value) {
          this.postSettingsError("请输入 API Key");
          break;
        }
        if (provider === ACCOUNT_PROVIDER_ID) {
          this.postSettingsError("该供应商由 DSH 账户登录管理，无需 API Key");
          break;
        }
        try {
          const keyRef = await this.resolveProviderKeyRef(provider, true);
          await this.client.setCredential(keyRef, value);
          this.postSettingsSaved(`API Key 已保存：${provider}`);
          await this.postProviderKeys();
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("保存 API Key 失败", error));
        }
        break;
      }
      case "clearProviderKey": {
        const provider = String(msg.provider ?? "").trim();
        if (!provider) break;
        try {
          const keyRef = await this.resolveProviderKeyRef(provider, false);
          await this.client.unsetCredential(keyRef);
          this.postSettingsSaved(`已清除 API Key：${provider}`);
          await this.postProviderKeys();
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("清除 API Key 失败", error));
        }
        break;
      }
      case "createProvider": {
        // The official models page's custom-provider card, same rules: route id
        // pattern, http(s) endpoint, a protocol, at least one model; the profile
        // lands in llm-pi-ai providers.<route> and the key (when given) in the
        // credentials service under the derived <ROUTE>_API_KEY ref.
        const route = String(msg.route ?? "").trim();
        const displayName = String(msg.displayName ?? "").trim();
        const baseURL = String(msg.baseURL ?? "").trim();
        const api = String(msg.api ?? "").trim();
        const apiKey = typeof msg.apiKey === "string" ? msg.apiKey.trim() : "";
        const models = Array.isArray(msg.models)
          ? (msg.models as Record<string, unknown>[])
              .map((m) => ({
                id: String(m.id ?? "").trim(),
                ...(typeof m.name === "string" && m.name.trim() ? { name: m.name.trim() } : {}),
                ...(typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow)
                  ? { contextWindow: m.contextWindow }
                  : {}),
              }))
              .filter((m) => m.id)
          : [];
        if (!ROUTE_ID_PATTERN.test(route)) {
          this.postSettingsError("路由 id 需为小写字母开头、仅含小写字母/数字/连字符（如 my-provider）");
          break;
        }
        if (!/^https?:\/\//i.test(baseURL)) {
          this.postSettingsError("端点 URL 需以 http(s):// 开头");
          break;
        }
        if (!api) {
          this.postSettingsError("请选择协议");
          break;
        }
        if (!models.length) {
          this.postSettingsError("至少需要一个模型条目");
          break;
        }
        try {
          const settings = await this.client.settingsDescribe();
          const piNs = settings.namespaces.find((n) => n.ns === "llm-pi-ai");
          if (!piNs) {
            this.postSettingsError("harness 未提供 llm-pi-ai 设置域，无法创建自定义供应商");
            break;
          }
          const providersDict =
            piNs.value && typeof piNs.value === "object" && !Array.isArray(piNs.value)
              ? ((piNs.value as Record<string, unknown>).providers as Record<string, unknown> | undefined)
              : undefined;
          if (providersDict && Object.prototype.hasOwnProperty.call(providersDict, route)) {
            this.postSettingsError(`路由 "${route}" 已存在，请换一个 id`);
            break;
          }
          const derived = deriveKeyRef(route);
          const profile: Record<string, unknown> = {
            ...(displayName ? { displayName } : {}),
            ...(apiKey ? { apiKeyEnv: derived } : {}),
            api,
            baseURL,
            models,
          };
          await this.client.settingsMutate(
            "llm-pi-ai",
            [{ op: "set", path: ["providers", route], value: profile }],
            piNs.revision
          );
          if (apiKey) await this.client.setCredential(derived, apiKey);
          this.postSettingsSaved(`已创建供应商「${displayName || route}」${apiKey ? "，并保存 API Key" : ""}`);
          this.postSettingsMessage({ type: "providerCreated", route });
          await this.postSettingsData();
          await this.postProviderKeys();
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("创建供应商失败", error));
        }
        break;
      }
      case "discoverProviderModels": {
        const baseURL = String(msg.baseURL ?? "").trim();
        const api = String(msg.api ?? "").trim();
        const apiKey = typeof msg.apiKey === "string" && msg.apiKey.trim() ? msg.apiKey.trim() : undefined;
        if (!baseURL || !api) {
          this.postSettingsError("填写端点 URL 并选择协议后才能发现模型");
          break;
        }
        try {
          const models = await this.client.discoverModels("llm-pi-ai", {
            baseURL,
            api,
            ...(apiKey ? { apiKey } : {}),
          });
          this.postSettingsMessage({
            type: "providerModels",
            models: models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
          });
        } catch (error) {
          this.postSettingsError(describeHarnessFailure("发现模型失败", error));
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

  /** Full plugin-manager snapshot for the 插件 tab (bundles + entries + registries + exemptions + inventory). */
  private async postPlugins(): Promise<void> {
    if (!this.client) return;
    try {
      const [bundles, plugins, registries, exemptions, inventory] = await Promise.all([
        this.client.listBundles(),
        this.client.listPluginEntries(),
        this.client.pluginRegistries(),
        this.client.listVersionExemptions(),
        // inventory is newer than the rest of the plugin domain: an older
        // harness answers unknown-method, which must not blank the whole tab.
        this.client.pluginInventory().catch(() => null),
      ]);
      this.postSettingsMessage({
        type: "settingsPlugins",
        bundles,
        plugins,
        registries,
        exemptions: exemptions.exemptions,
        exemptionWarnings: exemptions.warnings,
        inventory,
        companion: this.companionStatus,
      });
    } catch (error) {
      this.postSettingsError(describeHarnessFailure("读取插件列表失败", error));
    }
  }

  /** Companion bundle status shown in the settings 插件 tab (extension-owned). */
  setCompanionStatus(status: CompanionStatus): void {
    this.companionStatus = status;
    if (this.settingsPanel) void this.postPlugins();
  }

  private postSettingsMessage(message: unknown): void {
    try {
      void this.settingsPanel?.webview.postMessage(message);
    } catch {
      /* panel disposed */
    }
  }

  /** Update-center flow (settings page): plugin self-update on GitHub and the
   *  DSH npm package. Runs without a harness connection where possible. */
  private async handleUpdateCenterMessage(type: string, msg: Record<string, unknown>): Promise<void> {
    const hooks = this.options.updateCenter;
    const status = (
      target: "plugin" | "dsh",
      phase: "checking" | "uptodate" | "available" | "installing" | "done" | "error",
      extra: { installed?: string; latest?: string; message?: string } = {}
    ): void => {
      this.postSettingsMessage({ type: "updateStatus", target, phase, ...extra });
    };
    if (type === "pluginUpdateRestart") {
      await hooks?.restart();
      return;
    }
    if (type === "pluginUpdateCheck" || type === "pluginUpdateInstall") {
      if (!hooks) {
        status("plugin", "error", { message: "更新中心不可用" });
        return;
      }
      if (type === "pluginUpdateCheck") {
        status("plugin", "checking", { installed: hooks.installedVersion(), message: "正在检查 GitHub 发布…" });
        try {
          const result = await hooks.check();
          status("plugin", result.update ? "available" : "uptodate", {
            installed: result.installed,
            latest: result.latest,
            message: result.update ? "发现新版本" : "已是最新版本",
          });
        } catch (error) {
          status("plugin", "error", { installed: hooks.installedVersion(), message: (error as Error).message });
        }
        return;
      }
      status("plugin", "installing", { installed: hooks.installedVersion(), message: "正在下载并安装…" });
      try {
        const result = await hooks.install();
        if (result.ok) {
          status("plugin", "done", {
            installed: hooks.installedVersion(),
            message: "已安装新版本，重启窗口后生效。",
          });
        } else {
          status("plugin", "error", { message: result.error ?? "安装失败" });
        }
      } catch (error) {
        status("plugin", "error", { message: (error as Error).message });
      }
      return;
    }
    const channel = normalizeUpdateChannel(msg.channel);
    const dshHooks = this.options.dshUpdates;
    if (!dshHooks) {
      status("dsh", "error", { message: "更新中心不可用" });
      return;
    }
    if (type === "dshUpdateCheck") {
      status("dsh", "checking", { message: `通道 ${channel}` });
      const info = await dshHooks.check(channel);
      if (info.kind === "error") {
        status("dsh", "error", { installed: info.installed, message: info.detail ?? "检查失败" });
      } else {
        status("dsh", info.kind === "update" ? "available" : "uptodate", {
          installed: info.installed,
          latest: info.latest,
          message: info.detail ?? `通道 ${info.channel ?? channel}`,
        });
      }
      return;
    }
    // dshUpdateInstall: extension.ts owns the stop → npm → restart → verify
    // flow (and its dialogs); the card just follows along.
    status("dsh", "installing", { installed: await dshHooks.installedVersion(), message: "正在更新 DSH（会重启 harness）…" });
    try {
      await dshHooks.update();
      status("dsh", "done", {
        installed: await dshHooks.installedVersion(),
        message: "已完成更新（若提示重启窗口请照做）。",
      });
    } catch (error) {
      status("dsh", "error", { message: (error as Error).message });
    }
  }

  private postSettingsError(message: string): void {
    try {
      void this.settingsPanel?.webview.postMessage({ type: "settingsError", message });
    } catch {
      /* panel disposed */
    }
  }

  /* ---------- provider keys + custom providers (API tab) ---------- */

  /** Full snapshot for the API tab: every provider row with its credential
   *  state, mirroring the official settings-models directory rules. */
  private async postProviderKeys(): Promise<void> {
    if (!this.client) return;
    try {
      const [providers, configurable, settings] = await Promise.all([
        this.client.listLlmProviders(),
        this.client.listConfigurableProviders(),
        this.client.settingsDescribe(),
      ]);
      const rows = buildProviderKeyRows(providers, configurable, settings);
      const refs = Array.from(
        new Set(rows.flatMap((r) => [r.ref, r.derivedRef]).filter((x): x is string => typeof x === "string" && x.length > 0))
      );
      const credentials = refs.length ? await this.client.describeCredentials(refs) : {};
      for (const row of rows) {
        const ref = row.ref ?? row.derivedRef;
        const info = ref ? credentials[ref] : undefined;
        row.configured = info?.configured === true;
        row.source = info?.source;
        row.writable = info === undefined || info.writable !== false;
      }
      this.settingsPanel?.webview.postMessage({ type: "providerKeys", rows, writable: settings.writable !== false });
    } catch (error) {
      this.postSettingsError(describeHarnessFailure("读取供应商列表失败", error));
    }
  }

  /** The credential ref a provider's key lives under: the recorded apiKeyEnv,
   *  else the derived <ROUTE>_API_KEY. `recordDerived` persists the derived ref
   *  back into the profile first — the bootstrap the official page performs so
   *  the harness resolves the key the same way on its next request. */
  private async resolveProviderKeyRef(provider: string, recordDerived: boolean): Promise<string> {
    const client = this.client!;
    const [settings, configurable] = await Promise.all([client.settingsDescribe(), client.listConfigurableProviders()]);
    const entry = configurable.find((c) => c.provider === provider);
    let env: string | undefined;
    if (entry) {
      const profile = profileAtView(settings, entry);
      if (profile && typeof profile.apiKeyEnv === "string" && profile.apiKeyEnv) env = profile.apiKeyEnv;
    }
    if (env) return env;
    const derived = deriveKeyRef(provider);
    if (recordDerived && entry) {
      const nsView = settings.namespaces.find((n) => n.ns === entry.settingsNs);
      await client.settingsMutate(
        entry.settingsNs,
        [{ op: "set", path: [...entry.settingsPath, "apiKeyEnv"], value: derived }],
        nsView?.revision
      );
    }
    return derived;
  }
}

/* ---------- API tab helpers (pure) ---------- */

/** The harness account provider id: signed in through DSH, never here. */
const ACCOUNT_PROVIDER_ID = "deepseek-account";

/** Official route-id rule for a custom pi-ai provider (also a valid POSIX-ish
 *  credential-ref stem; a digit-leading id would fail the credential service). */
const ROUTE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** One provider row of the API tab (credential state filled after the batch
 *  credentials/describe call). */
interface ProviderKeyRow {
  provider: string;
  displayName: string;
  declared?: boolean;
  account?: boolean;
  /** Recorded credential ref (profile apiKeyEnv); absent when none recorded. */
  ref?: string;
  /** Derived <ROUTE>_API_KEY ref (the fallback every provider gets). */
  derivedRef?: string;
  configured?: boolean;
  source?: string;
  writable?: boolean;
  error?: string;
}

/** The derived credential ref for a provider without a recorded apiKeyEnv. */
function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** Display rank: account first, the built-in official route second. */
function rankProvider(id: string): number {
  if (id === ACCOUNT_PROVIDER_ID) return 0;
  if (id === "deepseek-official") return 1;
  return 2;
}

/** Walk a configurable entry's settingsPath inside the namespace value. */
function profileAtView(settings: SettingsDescribeView, entry: LlmConfigurableProvider): Record<string, unknown> | null {
  const nsView = settings.namespaces.find((n) => n.ns === entry.settingsNs);
  let cur: unknown = nsView?.value;
  for (const key of entry.settingsPath) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur && typeof cur === "object" && !Array.isArray(cur) ? (cur as Record<string, unknown>) : null;
}

/** Build the API tab rows from the three directory RPCs (the official page's
 *  rows are exactly this union: registered providers sorted account → official
 *  → rest, plus declared-but-unregistered routes). */
function buildProviderKeyRows(
  providers: LlmProviderInfo[],
  configurable: LlmConfigurableProvider[],
  settings: SettingsDescribeView
): ProviderKeyRow[] {
  const byId = new Map(configurable.map((c) => [c.provider, c]));
  const rows: ProviderKeyRow[] = [];
  const seen = new Set<string>();
  const ordered = [...providers].sort((a, b) => rankProvider(a.id) - rankProvider(b.id));
  for (const p of ordered) {
    seen.add(p.id);
    const entry = byId.get(p.id);
    const row: ProviderKeyRow = {
      provider: p.id,
      displayName: entry?.displayName || p.name || p.id,
      declared: entry?.declared === true,
      error: entry?.error,
    };
    if (p.id === ACCOUNT_PROVIDER_ID) {
      row.account = true;
      rows.push(row);
      continue;
    }
    if (entry) {
      const profile = profileAtView(settings, entry);
      if (profile && typeof profile.apiKeyEnv === "string" && profile.apiKeyEnv) row.ref = profile.apiKeyEnv;
    }
    row.derivedRef = deriveKeyRef(p.id);
    rows.push(row);
  }
  for (const entry of configurable) {
    // Only user-declared providers get a key row: llm-pi-ai ships a large
    // catalog of routing profiles (declared:false) that would drown the list.
    if (entry.declared !== true) continue;
    if (seen.has(entry.provider)) continue;
    const row: ProviderKeyRow = {
      provider: entry.provider,
      displayName: entry.displayName || entry.provider,
      declared: entry.declared === true,
      error: entry.error,
      derivedRef: deriveKeyRef(entry.provider),
    };
    const profile = profileAtView(settings, entry);
    if (profile && typeof profile.apiKeyEnv === "string" && profile.apiKeyEnv) row.ref = profile.apiKeyEnv;
    rows.push(row);
  }
  return rows;
}
