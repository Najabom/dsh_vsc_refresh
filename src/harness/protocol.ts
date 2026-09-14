/**
 * Wire protocol for the DSH host API.
 * Verified against @deepseek-ai/dsh-host-apiproxy (types/api/rpc.d.ts, rpc-map.d.ts, sessions.d.ts).
 *
 * Request:   POST /api/<method>             body {type:'client-request', rpcId, method, payload}
 * Response:  HTTP 200 body                  {type:'server-response', rpcId, result}
 * Events:    WS /api/events.mux (sessions)  WS /api/events.host (host-level)
 * Trust:     Host header fence; loopback default. No token exchange.
 */

/** Wire request envelope. */
export interface ClientRequest {
  type: "client-request";
  rpcId: string;
  method: string;
  payload: unknown;
}

/** Wire response envelope. */
export interface ServerResponse {
  type: "server-response";
  rpcId: string;
  result: RpcResult<unknown>;
}

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RpcError };

export interface RpcError {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** host.describe value. */
export interface HostDescription {
  version: string;
  cwd: string;
  provider: string;
  model: string;
  attachedSessions: number;
  home: string;
  canOpenPath: boolean;
  /**
   * Live consumers of /api/events.mux (each browser tab and each extension
   * client counts as one; the caller's own stream is included). Added by the
   * runtime overlay (src/harness/overlay — in-memory patch at harness load
   * time; official dsh files stay pristine) — absent when the overlay is
   * missing or its canary failed (e.g. dsh updated). `undefined` = unknown.
   */
  clientCount?: number;
}

/** session.list item. */
export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
  agentPreset?: string;
  /** Projection block; `values.title` carries the session title when known. */
  projections?: {
    values?: {
      title?: string | null;
      tokenUsage?: {
        uncachedInputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        outputTokens?: number;
      } | null;
      sessionStats?: {
        turns?: number;
        steps?: number;
        llmMs?: number;
        toolMs?: number;
        ttftMs?: number;
        ttftSteps?: number;
        decodeMs?: number;
        decodeTokens?: number;
      } | null;
      contextPressure?: {
        projectedTokens?: number;
        pressureTokens?: number;
        contextWindow?: number;
      } | null;
    };
  };
}

/** session.prompt content part: text and raster images both ride the same
 *  typed content array (images carry inline base64 on the wire; the harness
 *  admits them into its durable attachment store and the log keeps a ref). */
export type PromptContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string; name?: string };

/** Durable image reference as it appears in a logged content block. */
export interface ImageAttachmentRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

/** session.attachment value: the ref plus the decoded base64 payload. */
export interface SessionAttachmentValue {
  attachment: ImageAttachmentRef;
  data: string;
}

/** Canonical endpoint names (wire paths use dot notation). */
export const METHODS = {
  hostDescribe: "host.describe",
  sessionList: "session.list",
  sessionHistory: "session.history",
  sessionCreate: "session.create",
  sessionPrompt: "session.prompt",
  sessionCancel: "session.cancel",
  sessionModels: "session.models",
  sessionSelectModel: "session.selectModel",
  sessionUpdateQueue: "session.updateQueue",
  sessionAttachment: "session.attachment",
  workspaceList: "workspace.list",
  workspaceCreate: "workspace.create",
  workspaceArchiveSession: "workspace.archiveSession",
  commandsList: "commands/list",
  commandsExecute: "commands/execute",
  agentPresetList: "agentPreset.list",
  settingsDescribe: "settings.describe",
  settingsMutate: "settings.mutate",
} as const;

/** workspace.list / workspace.create row (DSH workspace domain view). */
export interface WorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** session.updateQueue action (edit/remove/steer a queued message). */
export type QueueAction =
  | { kind: "remove" }
  | { kind: "steer" }
  | { kind: "edit"; content: { type: string; text?: string }[] };

/** session.models response value (provider groups + current selection). */
export interface ModelCatalog {
  current?: { provider: string; model: string; reasoningEffort?: string };
  routable: boolean;
  groups: { id: string; name: string; models: { id: string; name: string; description?: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[] }[];
  failures: { id: string; name: string; message: string }[];
}

/* ---------- session.history (wire schema, single source) ---------- */
/** A raw session event frame as the harness emits it (wire passthrough).
 *  The panel's own view (src/panel/protocol.ts PanelEvent) extends this with
 *  host-supplied fields (time, envelope rpcId) — the wire shape lives here. */
export interface SessionEventLike {
  type: string;
  seq?: number;
  data?: Record<string, unknown>;
  surfaceOp?: string;
}

/** The `todos` projection unit (per-turn task list; null after turn/start). */
export type TodoProjection = { content: string; status: "pending" | "in_progress" | "completed" }[] | null;

/** The `permissions` projection (header 权限 select; same source as web). */
export interface PermissionProjection {
  options?: { value: string; name?: string }[];
  currentValue?: string;
}

/** One history page. Tail page (beforeSeq absent) carries the projections
 *  block — the same source the web GUI's task bar / permission select render
 *  from. */
export interface HistoryPage {
  events: { event: SessionEventLike }[];
  hasMore: boolean;
  projections?: {
    asOfSeq?: number;
    values?: {
      todos?: TodoProjection;
      permissions?: PermissionProjection;
    };
  };
}

/* ---------- settings domain (settings.describe / settings.mutate) ---------- */

/** One schema-declared secret slot inside a redacted namespace value. */
export interface SettingsSecretView {
  path: string[];
  set: boolean;
}

/** Wire view of one registered settings namespace (settings domain). */
export interface SettingsNamespaceView {
  ns: string;
  schema: unknown;
  value: unknown;
  base?: unknown;
  user?: unknown;
  applies: "live" | "restart";
  secrets: SettingsSecretView[];
  revision: number;
}

/** One path-addressed edit carried by settings.mutate. */
export type SettingsPathOp =
  | { op: "set"; path: string[]; value: unknown }
  | { op: "unset"; path: string[] };

/** settings.describe response value. */
export interface SettingsDescribeView {
  writable: boolean;
  hasDocument: boolean;
  namespaces: SettingsNamespaceView[];
}
