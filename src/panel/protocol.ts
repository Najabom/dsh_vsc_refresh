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
    }
  | { type: "event"; sessionId: string; event: PanelEvent }
  | { type: "history"; sessionId: string; events: PanelEvent[]; hasMore: boolean; isOlder?: boolean; toolDiffs?: Record<string, ToolLineDiff> }
  | { type: "running"; sessionId: string; running: boolean }
  | { type: "index"; files: string[]; dirs: string[] }
  | {
      type: "models";
      current?: { provider: string; model: string; reasoningEffort?: string };
      groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[] }[];
    }
  | { type: "queue"; sessionId: string; items: { id: string; placement: string; text: string }[] }
  | { type: "commands"; items: { name: string; description?: string; input?: { hint?: string; images?: boolean } }[] }
  | { type: "cmdResult"; text: string; ok: boolean }
  | { type: "todos"; sessionId: string; items: TodoItem[] }
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
      /** rpcId to echo when answering via /api/respond. */
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
      type: "agentPresets";
      /** Agent-preset roster for the new-session mode picker (id → display copy). */
      presets: { id: string; name?: string; description?: string; isDefault?: boolean; trust?: string; broken?: string }[];
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
    };

/** Webview → host messages. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "selectSession"; sessionId: string }
  | { type: "newSession"; agentPreset?: string }
  | { type: "getAgentPresets" }
  | { type: "deleteSession"; sessionId: string }
  | { type: "deletePermanently"; sessionId: string }
  | { type: "pickWorkspace" }
  | { type: "send"; text: string; mode?: "queue" | "steer"; attachments?: { mediaType: string; data: string; name?: string }[] }
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
      answers: { id: string; selected: string[]; custom?: string }[];
    }
  | { type: "getPermissions" }
  | { type: "selectPermission"; permission: string }
  | { type: "openExternal"; url: string }
  | {
      /** Lazy fetch of one logged image's bytes (harness session.attachment). */
      type: "getAttachment";
      requestId: number;
      sessionId: string;
      attachmentId: string;
    }
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
