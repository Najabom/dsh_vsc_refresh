/**
 * Native sidebar panel — webview ↔ extension-host message protocol.
 * The panel is plain JS (inline in panel.html); these types drive the host side.
 */

/** A raw session event forwarded to the panel (wire passthrough). */
export interface PanelEvent {
  type: string;
  seq?: number;
  /** Unix epoch ms stamped by the harness on every durable log entry. */
  time?: number;
  data?: Record<string, unknown>;
  surfaceOp?: string;
  /** Envelope rpcId of a server-request frame (approval/question answerable frames). */
  rpcId?: string;
}

/** One bridge-computed line diff for a tool call ("+N-M"). */
export interface ToolLineDiff {
  added: number;
  deleted: number;
  /** Resolved absolute path (when resolvable) or the raw tool argument. */
  path?: string;
}

/** One todo item — the `todos` projection unit (dsh-tool-todo / dsh-session types). */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** One account wallet (currency + decimal-string amount). */
export interface AccountWallet {
  currency: string;
  balance: string;
}

/** Account balance view for the panel (provider-normalized account/getBalance;
 *  null when the account channel is signed out or the call failed). */
export interface AccountBalanceView {
  status: string;
  wallets: AccountWallet[];
  bonusWallets: AccountWallet[];
}

/** Host → webview messages. */
export type HostMessage =
  | {
      type: "state";
      connected: boolean;
      version?: string;
      phase?: "searching" | "starting" | "online" | "offline";
      sessions: PanelSession[];
      activeSessionId: string | null;
      /** Effective workspace folder (manual picker override or the open folder). */
      workspace?: string;
      /** Session id whose transcript is on screen (subagent view differs from
       *  the active session while a teammate's conversation is open). */
      viewSessionId?: string | null;
      /** Set while a teammate's child conversation is on screen. */
      subview?: { parentSessionId: string; childSessionId: string } | null;
      /** Surface mode: "ask" renders the dedicated question conversation
       *  (session picker / workspace strip / utility buttons hidden). */
      mode?: "main" | "ask";
    }
  | { type: "event"; sessionId: string; event: PanelEvent }
  | { type: "history"; sessionId: string; events: PanelEvent[]; hasMore: boolean; isOlder?: boolean; toolDiffs?: Record<string, ToolLineDiff> }
  | { type: "running"; sessionId: string; running: boolean }
  | {
      /** Agent-team card (the lead's `agentTeam` projection + live statuses). */
      type: "team";
      sessionId: string;
      viewSessionId?: string;
      members: {
        id: string;
        name: string;
        role: string;
        /** running | inactive | provisioning | failed */
        status: string;
        model?: string;
        error?: string;
      }[];
      tasks: {
        id: string;
        subject: string;
        description?: string;
        status: string;
        ownerName?: string;
        blockedBy?: string[];
        writeScopes?: string[];
        ready?: boolean;
        writeScopeWarnings?: string[];
      }[];
      failure?: string;
    }
  | { type: "index"; files: string[]; dirs: string[] }
  | {
      type: "models";
      current?: { provider: string; model: string; reasoningEffort?: string };
      groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[] }[];
    }
  | { type: "queue"; sessionId: string; items: { id: string; placement: string; text: string; source?: string; summary?: string }[] }
  | { type: "commands"; items: { name: string; description?: string; input?: { hint?: string; images?: boolean } }[] }
  | { type: "cmdResult"; text: string; ok: boolean }
  | { type: "todos"; sessionId: string; items: TodoItem[] }
  | {
      /** Background jobs of the viewed session (job/list). */
      type: "jobs";
      sessionId: string;
      jobs: {
        id: string;
        kind: string;
        label: string;
        /** running | stopping | completed | killed | failed */
        status: string;
        detail?: string;
        progress?: { completed?: number; total?: number; text?: string };
        startedAt: number;
        finishedAt?: number;
        outputTotal?: number;
      }[];
    }
  | {
      /** The viewed session's goal (goals/get). null = no goal. */
      type: "goal";
      sessionId: string;
      goal: {
        id: string;
        revision: number;
        roundsStarted: number;
        maxGoalRounds: number;
        objective: string;
        /** active | paused | blocked | complete */
        phase: string;
        /** armed | disarmed */
        activation: string;
        blockedReason?: string;
      } | null;
    }
  | {
      /** Latest turn's changed-file summary (workspace/changes). */
      type: "changes";
      sessionId: string;
      turn: number;
      files: { index: number; display: string; added: number; deleted: number; binary?: boolean; oversized?: boolean }[];
      total: number;
      added: number;
      deleted: number;
    }
  | {
      /** Files an assistant turn declared as deliverables (deliverables/presented). */
      type: "deliveries";
      sessionId: string;
      turn: number;
      files: { index: number; path: string; description?: string }[];
    }
  | { type: "balance"; value: AccountBalanceView | null }
  | { type: "toolDiff"; sessionId: string; callId: string; added: number; deleted: number; path?: string }
  | {
      type: "ask";
      /** Structured editor-context block (file / selection / workspace). */
      context: string;
      /** Choice buttons rendered inside the panel (id === "custom" gets an input box). */
      choices: { id: string; label: string; detail?: string }[];
    }
  | {
      type: "interaction";
      sessionId: string;
      /** Waterfall event id; echoed back (with the stream's clientId) when answering via $events/result. */
      rpcId: string;
      kind: "approval";
      approvalId: string;
      toolName: string;
      callId?: string;
      reason?: string;
      /** Sandbox escalation target parsed from the request reason; when set,
       *  the card offers "永久允许" (answer once + raise the session preset). */
      escalationMode?: string;
    }
  | {
      type: "interaction";
      sessionId: string;
      rpcId: string;
      kind: "question";
      questions: {
        id: string;
        question: string;
        detail?: string;
        header?: string;
        multiSelect?: boolean;
        options?: { label: string; description?: string }[];
        intent?: { kind: "plan-review"; approve: string } | { kind: string; approve: string };
      }[];
    }
  | { type: "interactionSettled"; sessionId: string; rpcId: string }
  | {
      type: "permissions";
      options: { value: string; label: string }[];
      current?: string;
    }
  | {
      /** Plan mode for the active session (harness `plan` projection). */
      type: "planMode";
      active: boolean;
      /** A queued switch (flips on the next step). */
      pending: boolean;
      /** Our soft variant vs the hard read-only variant; null = plain off. */
      variant?: "soft" | "hard" | null;
    }
  | {
      type: "agentPresets";
      /** Agent-preset roster for the new-session mode picker (id → display copy). */
      presets: { id: string; name?: string; description?: string; isDefault?: boolean; trust?: string; broken?: string }[];
    }
  | {
      /** Update-center status for the settings page (plugin or DSH target). */
      type: "updateStatus";
      target: "plugin" | "dsh";
      phase: "checking" | "uptodate" | "available" | "installing" | "done" | "error";
      installed?: string;
      latest?: string;
      /** Extra line for surfaces that show details (channel, errors, notes). */
      message?: string;
    }
  | {
      /** Installed versions shown at the top of the settings update cards. */
      type: "updateVersions";
      plugin: string;
      dsh: string;
    }
  | { type: "error"; message: string }
  | {
      /** One resolved transcript image (session.attachment round-trip). */
      type: "attachment";
      requestId: number;
      attachmentId: string;
      mediaType?: string;
      /** base64 payload; absent when `error` is set. */
      data?: string;
      width?: number;
      height?: number;
      bytes?: number;
      name?: string;
      error?: string;
    }
  | {
      /** Host-read payload for one dropped Explorer file (readAttachmentFile). */
      type: "attachmentFileRead";
      requestId: number;
      name?: string;
      size?: number;
      mediaType?: string;
      /** base64 payload; absent when `error` is set. */
      data?: string;
      error?: string;
    };

/** Webview → host messages. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "selectSession"; sessionId: string }
  | { type: "teamOpen"; childSessionId: string }
  | { type: "teamBack" }
  | { type: "newSession"; agentPreset?: string }
  | { type: "getAgentPresets" }
  | { type: "deleteSession"; sessionId: string }
  | { type: "deletePermanently"; sessionId: string }
  | { type: "pickWorkspace" }
  | { type: "send"; text: string; mode?: "queue" | "steer"; attachments?: { kind?: "image" | "file"; mediaType?: string; data: string; name?: string }[] }
  | { type: "loadOlder"; beforeSeq: number }
  | { type: "cancel" }
  | { type: "refresh" }
  | { type: "refreshFiles" }
  | { type: "getModels" }
  | { type: "selectModel"; provider: string; model: string; reasoningEffort?: string }
  | { type: "copyText"; text: string }
  | { type: "openFile"; path: string }
  | { type: "queueSteer"; itemId: string }
  | { type: "queueRemove"; itemId: string }
  | { type: "askPick"; choiceId: string; customText?: string }
  | { type: "askCancel" }
  | {
      type: "respondApproval";
      rpcId: string;
      sessionId: string;
      approvalId: string;
      outcome: "allowed-once" | "rejected";
      /** "永久允许": answer allowed-once, then persist the escalated mode (see
       *  escalationMode) as the session permission preset. */
      remember?: string;
      mode?: string;
    }
  | {
      type: "respondQuestion";
      rpcId: string;
      sessionId: string;
      /** One item per question. A dismissed card rides here too: dismissing
       *  submits a completed batch of SKIPPED answers (empty selected), the
       *  official skip semantics — a waterfall rejection would surface to the
       *  model as a failed tool call and it would ask the question again. */
      answers?: { id: string; selected: string[]; custom?: string }[];
    }
  | { type: "getPermissions" }
  | { type: "selectPermission"; permission: string }
  | { type: "planMode"; action: "soft" | "hard" | "off" }
  | { type: "openExternal"; url: string }
  | { type: "panelWidth"; px: number }
  | {
      /** Lazy fetch of one logged image's bytes (harness session.attachment). */
      type: "getAttachment";
      requestId: number;
      sessionId: string;
      attachmentId: string;
    }
  | {
      /** Explorer drag-and-drop: the webview only knows the dropped file://
       *  path — the host reads it and answers attachmentFileRead. */
      type: "readAttachmentFile";
      requestId: number;
      path: string;
    }
  | { type: "pluginUpdateCheck" }
  | { type: "pluginUpdateInstall" }
  | { type: "pluginUpdateRestart" }
  /** DSH (harness npm package) update check/install from the settings page. */
  | { type: "dshUpdateCheck"; channel?: string }
  | { type: "dshUpdateInstall"; channel?: string }
  | { type: "jobKill"; jobId: string }
  | { type: "goalCreate"; objective: string }
  | { type: "goalPause" }
  | { type: "goalResume" }
  | { type: "goalComplete" }
  | { type: "goalClear" }
  | { type: "openChangeDiff"; index: number }
  | { type: "openDelivered"; index: number }
  | { type: "openSettings" };

export interface PanelSession {
  sessionId: string;
  running: boolean;
  blank: boolean;
  updatedAt: number;
  title?: string;
  /** Session working directory — the picker groups rows by this. */
  cwd?: string;
  /** Current agent preset of the session (agentPresets/list domain). */
  agentPreset?: string;
  /** tokenUsage projection (aggregate over the durable log). */
  usage?: {
    uncachedInputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
  };
  /** sessionStats projection — the web composer's status line source. */
  stats?: {
    turns?: number;
    steps?: number;
    llmMs?: number;
    toolMs?: number;
    ttftMs?: number;
    ttftSteps?: number;
    decodeMs?: number;
    decodeTokens?: number;
  };
  /** contextPressure projection — context occupancy ring source. */
  context?: {
    projectedTokens?: number;
    pressureTokens?: number;
    contextWindow?: number;
  };
}

/** Extension-owned update center hooks (plugin self-update; extension.ts owns
 *  the GitHub/CLI implementation so the provider stays testable). */
export interface UpdateCenterHooks {
  installedVersion(): string;
  check(): Promise<{ installed: string; latest?: string; update: boolean }>;
  install(): Promise<{ ok: boolean; error?: string }>;
  restart(): Promise<void>;
}

/** DSH package update hooks (extension.ts owns the lifecycle-aware flow). */
export interface DshUpdateHooks {
  installedVersion(): Promise<string>;
  check(channel: string): Promise<{
    installed?: string;
    latest?: string;
    kind?: "update" | "uptodate" | "error";
    detail?: string;
    channel?: string;
  }>;
  update(): Promise<void>;
}
