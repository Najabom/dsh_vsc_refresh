import * as vscode from "vscode";
// Explicit dependency (bundled by esbuild): the global WebSocket only exists in
// Node ≥ 22 extension hosts, while engines still allow VS Code ^1.90 (Node 20).
import { WebSocket } from "ws";
import { nativeAuthHeaders } from "../harness/nativeAuth";

/** A session event from the follow stream, in the vocabulary the panel renders
 *  (durable journal events pass through; assistant-stream chunks are folded
 *  into the historical `assistant/chunk` shape the renderer already knows). */
export interface SessionEvent {
  type: string;
  seq?: number;
  /** Unix epoch ms stamped by the harness on every durable log entry. */
  time?: number;
  data?: Record<string, unknown>;
  surfaceOp?: string;
}

/** One host-level $events waterfall frame (approval/request, user-questions/request). */
export interface WaterfallFrame {
  event: string;
  eventId: string;
  /** Root-agent id, which equals the session id for top-level sessions. */
  agentId: string;
  request: Record<string, unknown>;
  /** mux clientId of this connection — required when answering via $events/result. */
  clientId: string;
}

/** workspace/follow state relevant to the panel: the ordered workspace
 *  registry plus the archived and pinned session sets. */
export interface WorkspaceState {
  items: WorkspaceView[];
  archivedSessionIds: string[];
  pinnedSessionIds: string[];
}

/** One workspace registry row (workspace/follow WorkspaceView). */
export interface WorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt?: number;
  updatedAt?: number;
}

/** A mux follow target: a top-level session, or a child conversation
 *  addressed through its parent (the official subagent addressing). */
export type FollowTarget =
  | { kind: "session"; sessionId: string }
  | {
      kind: "subagent";
      parentSessionId: string;
      childSessionId: string;
      mode: "one-shot" | "continuable" | "unknown";
    };

/** Stable mux stream key for one follow target. */
function targetKey(target: FollowTarget): string {
  return target.kind === "session"
    ? target.sessionId
    : `sub:${target.parentSessionId}:${target.childSessionId}:${target.mode}`;
}

/** The session id whose events a target carries. */
function targetSessionId(target: FollowTarget): string {
  return target.kind === "session" ? target.sessionId : target.childSessionId;
}

const MUX_PATH = "/api/remote.mux";
const EVENTS_STREAM = "events";
const CONTROL_STREAM = "control";
const WORKSPACE_STREAM = "workspace";

/**
 * M3 — WS client for the harness mux (0.1.7 /api/remote.mux). One socket
 * carries every stream: $events (host emits + waterfalls), session/control
 * (projection baseline + increments), workspace/follow (archived set), and a
 * session/follow per followed session — the mux multiplexes streams, so the
 * sidebar and the ask window can follow two different sessions at once.
 * Auto-reconnects with backoff and re-opens every stream on (re)connect.
 */
export class HarnessEventStream implements vscode.Disposable {
  private ws: WebSocket | null = null;
  private disposed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  /** Followed session per owner ("panel", "ask", …). */
  private readonly follows = new Map<string, FollowTarget>();
  /** Follow targets with an open follow stream right now (dedupes owners). */
  private readonly openFollows = new Map<string, FollowTarget>();

  constructor(private readonly base: string) {}

  onSessionEvent: (sessionId: string, event: SessionEvent) => void = () => {};
  /** session/control frame: baseline values and later increments per session. */
  onProjection: (sessionId: string, key: string, value: unknown) => void = () => {};
  /** workspace/follow: baseline and archived-set increments. */
  onWorkspace: (state: WorkspaceState) => void = () => {};
  /** $events emit frame (api-session/added|status|removed|…, commands/change). */
  onApiSession: (event: string, args: unknown[]) => void = () => {};
  /** $events waterfall frame (approval/request, user-questions/request). */
  onWaterfall: (frame: WaterfallFrame) => void = () => {};
  /** $events cancel frame — the pending waterfall is gone. */
  onWaterfallCancel: (eventId: string) => void = () => {};
  onError: (message: string) => void = () => {};
  /** Fired when a (re)connection succeeds — status bar can flip back online. */
  onOpen: () => void = () => {};
  /** Fired when the connection drops — the harness may be down; host decides. */
  onDisconnect: () => void = () => {};

  start(): void {
    this.connect();
  }

  /** Follow a conversation on behalf of one surface (null = stop). Safe
   *  before connect: streams open on (re)connect from the owners map.
   *  A bare string is the common top-level session case. */
  setFollow(owner: string, target: FollowTarget | string | null): void {
    const next: FollowTarget | null =
      typeof target === "string" ? { kind: "session", sessionId: target } : target;
    const previous = this.follows.get(owner);
    const previousKey = previous ? targetKey(previous) : "";
    const nextKey = next ? targetKey(next) : "";
    if (previousKey === nextKey && (previous !== undefined || next === null)) return;
    if (next) this.follows.set(owner, next);
    else this.follows.delete(owner);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (previous && previousKey !== nextKey && !this.wanted(previousKey)) {
      this.openFollows.delete(previousKey);
      this.send({ type: "cancel", streamId: `follow:${previousKey}` });
    }
    if (next && !this.openFollows.has(nextKey)) this.openFollow(next);
  }

  /** True when some owner still wants this follow target. */
  private wanted(key: string): boolean {
    for (const target of this.follows.values()) {
      if (targetKey(target) === key) return true;
    }
    return false;
  }

  private connect(): void {
    if (this.disposed) return;
    try {
      const url = `${this.base.replace(/^http/, "ws")}${MUX_PATH}`;
      const auth = nativeAuthHeaders(this.base);
      const ws = new WebSocket(url, auth ? { headers: auth } : undefined);
      this.ws = ws;
      ws.onopen = () => {
        this.retries = 0;
        this.openBaseStreams();
        this.onOpen();
      };
      ws.onmessage = (msg) => this.handleFrame(msg.data);
      ws.onclose = () => {
        if (this.disposed) return;
        this.onDisconnect();
        this.scheduleReconnect();
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    } catch (error) {
      this.onError(String(error));
      this.onDisconnect();
      this.scheduleReconnect();
    }
  }

  private openBaseStreams(): void {
    this.send({ type: "open", streamId: EVENTS_STREAM, endpoint: "$events", payload: { args: {} } });
    this.send({ type: "open", streamId: CONTROL_STREAM, endpoint: "session/control", payload: { args: {} } });
    this.send({ type: "open", streamId: WORKSPACE_STREAM, endpoint: "workspace/follow", payload: { args: {} } });
    const seen = new Set<string>();
    for (const target of this.follows.values()) {
      const key = targetKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      this.openFollow(target);
    }
  }

  private openFollow(target: FollowTarget): void {
    const key = targetKey(target);
    this.openFollows.set(key, target);
    this.send({
      type: "open",
      streamId: `follow:${key}`,
      endpoint: "session/follow",
      payload: {
        args: {
          request: {
            address:
              target.kind === "session"
                ? { kind: "session", sessionId: target.sessionId }
                : {
                    kind: "subagent",
                    parentSessionId: target.parentSessionId,
                    childSessionId: target.childSessionId,
                    mode: target.mode,
                  },
            assistantStream: true,
          },
        },
      },
    });
  }

  private send(frame: unknown): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch {
      /* socket died — reconnect will re-open everything */
    }
  }

  private handleFrame(raw: unknown): void {
    let frame: { type?: unknown; streamId?: unknown; value?: unknown; error?: unknown } | null = null;
    try {
      frame = JSON.parse(String(raw)) as { type?: unknown; streamId?: unknown; value?: unknown; error?: unknown };
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string") return;
    const streamId = typeof frame.streamId === "string" ? frame.streamId : "";
    if (frame.type === "item") {
      this.dispatch(streamId, frame.value);
      return;
    }
    if (frame.type === "error") {
      this.onError(`stream ${streamId}: ${JSON.stringify(frame.error)}`);
      return;
    }
    if (frame.type === "end") {
      // The endpoint closed server-side. A follow stream can come back (the
      // session may be reopened); a base stream ending means the harness is
      // restarting — drop the socket so the reconnect loop rebuilds a fresh one.
      if (streamId.startsWith("follow:")) {
        const key = streamId.slice("follow:".length);
        const target = this.openFollows.get(key);
        this.openFollows.delete(key);
        setTimeout(() => {
          if (!this.disposed && target && this.wanted(key) && this.ws?.readyState === WebSocket.OPEN) {
            this.openFollow(target);
          }
        }, 500);
      } else if (streamId) {
        this.onError(`stream ${streamId} ended; reconnecting`);
        try {
          this.ws?.close();
        } catch {
          /* the reconnect loop takes over either way */
        }
      }
      return;
    }
  }

  private dispatch(streamId: string, value: unknown): void {
    if (streamId === EVENTS_STREAM) {
      this.handleEventsValue(value);
      return;
    }
    if (streamId === CONTROL_STREAM) {
      this.handleControlValue(value);
      return;
    }
    if (streamId === WORKSPACE_STREAM) {
      this.handleWorkspaceValue(value);
      return;
    }
    if (streamId.startsWith("follow:")) {
      const key = streamId.slice("follow:".length);
      const target = this.openFollows.get(key);
      // Streams opened before this build (or a re-open race) still carry the
      // target; fall back to interpreting the key as a plain session id.
      this.handleFollowValue(
        target ? targetSessionId(target) : key,
        value
      );
    }
  }

  private handleEventsValue(value: unknown): void {
    const v = value as { type?: unknown; clientId?: unknown; event?: unknown; args?: unknown; eventId?: unknown; agentId?: unknown; request?: unknown } | null;
    if (!v || typeof v.type !== "string") return;
    if (v.type === "ready") {
      // $events channel established. The ready frame carries this
      // connection's clientId — the answer key $events/result demands.
      if (typeof v.clientId === "string" && v.clientId) this.clientId = v.clientId;
      return;
    }
    if (v.type === "emit") {
      this.onApiSession(String(v.event ?? ""), Array.isArray(v.args) ? v.args : []);
      return;
    }
    if (v.type === "waterfall") {
      this.onWaterfall({
        event: String(v.event ?? ""),
        eventId: String(v.eventId ?? ""),
        agentId: String(v.agentId ?? ""),
        request: (v.request && typeof v.request === "object" ? v.request : {}) as Record<string, unknown>,
        clientId: this.clientId,
      });
      return;
    }
    if (v.type === "cancel") {
      this.onWaterfallCancel(String(v.eventId ?? ""));
    }
  }

  /** mux clientId captured from the $events ready frame (needed to answer). */
  private clientId = "";
  private workspaceState: WorkspaceState = { items: [], archivedSessionIds: [], pinnedSessionIds: [] };

  private handleControlValue(value: unknown): void {
    const v = value as { type?: unknown; value?: unknown; sessionId?: unknown; key?: unknown } | null;
    if (!v || typeof v.type !== "string") return;
    if (v.type === "baseline") {
      const projections = (v.value as { projections?: Record<string, { values?: Record<string, unknown> }> } | null)?.projections;
      if (!projections) return;
      for (const [sessionId, block] of Object.entries(projections)) {
        const values = block?.values;
        if (!values) continue;
        for (const [key, projection] of Object.entries(values)) {
          this.onProjection(sessionId, key, projection);
        }
      }
      return;
    }
    if (v.type === "projection") {
      this.onProjection(String(v.sessionId ?? ""), String(v.key ?? ""), v.value);
      return;
    }
    this.handleEventsValue(value);
  }

  private handleWorkspaceValue(value: unknown): void {
    const v = value as Record<string, unknown> | null;
    if (!v || typeof v.type !== "string") return;
    const takeBaseline = (raw: unknown): void => {
      const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      this.workspaceState = {
        items: toWorkspaceItems(b.items),
        archivedSessionIds: toIdList(b.archivedSessionIds) ?? [],
        pinnedSessionIds: toIdList(b.pinnedSessionIds) ?? [],
      };
    };
    switch (v.type) {
      case "baseline":
      case "replace":
        takeBaseline(v.value);
        break;
      case "upsert": {
        const item = toWorkspaceItem(v.workspace);
        if (!item) return;
        const items = this.workspaceState.items.filter((w) => w.workspaceId !== item.workspaceId);
        items.push(item);
        this.workspaceState = { ...this.workspaceState, items };
        break;
      }
      case "remove": {
        const id = String(v.workspaceId ?? "");
        this.workspaceState = {
          ...this.workspaceState,
          items: this.workspaceState.items.filter((w) => w.workspaceId !== id),
        };
        break;
      }
      case "order": {
        const ids = toIdList(v.workspaceIds) ?? [];
        const byId = new Map(this.workspaceState.items.map((w) => [w.workspaceId, w] as const));
        const items = ids.map((id) => byId.get(id)).filter((w): w is WorkspaceView => Boolean(w));
        for (const w of this.workspaceState.items) if (!ids.includes(w.workspaceId)) items.push(w);
        this.workspaceState = { ...this.workspaceState, items };
        break;
      }
      case "archived":
        this.workspaceState = {
          ...this.workspaceState,
          archivedSessionIds: toIdList(v.archivedSessionIds) ?? [],
        };
        break;
      case "pinned":
        this.workspaceState = {
          ...this.workspaceState,
          pinnedSessionIds: toIdList(v.pinnedSessionIds) ?? [],
        };
        break;
      default:
        return;
    }
    this.onWorkspace({ ...this.workspaceState, items: [...this.workspaceState.items] });
  }

  private handleFollowValue(sessionId: string, value: unknown): void {
    const v = value as { type?: unknown; event?: { type?: unknown; seq?: unknown; time?: unknown; data?: unknown; surfaceOp?: unknown }; frame?: { type?: unknown; time?: unknown; chunk?: unknown } } | null;
    if (!v || typeof v.type !== "string") return;
    if (v.type === "event") {
      const event = v.event;
      if (event && typeof event.type === "string") {
        this.onSessionEvent(sessionId, {
          type: event.type,
          seq: typeof event.seq === "number" ? event.seq : undefined,
          time: typeof event.time === "number" ? event.time : undefined,
          data: (event.data && typeof event.data === "object" ? event.data : undefined) as Record<string, unknown> | undefined,
          surfaceOp: typeof event.surfaceOp === "string" ? event.surfaceOp : undefined,
        });
      }
      return;
    }
    if (v.type === "assistant-stream") {
      // Live model stream: fold chunks into the historical `assistant/chunk`
      // shape (block-start / text-delta / reasoning-delta / usage) the panel
      // renderer was built on. start/end/block-end/finish carry no content.
      const frame = v.frame;
      if (frame && frame.type === "chunk") {
        this.onSessionEvent(sessionId, {
          type: "assistant/chunk",
          time: typeof frame.time === "number" ? frame.time : undefined,
          data: { chunk: frame.chunk },
        });
      }
      return;
    }
    // snapshot: history is loaded through session/page; projections through
    // session/control — nothing to forward.
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.retries++;
    const delay = Math.min(500 * 2 ** Math.min(this.retries, 5), 15000);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }
}

function toIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => String(v));
}

function toWorkspaceItem(value: unknown): WorkspaceView | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.workspaceId !== "string" || typeof v.path !== "string") return null;
  return {
    workspaceId: v.workspaceId,
    path: v.path,
    title: typeof v.title === "string" ? v.title : v.path,
    sessionIds: toIdList(v.sessionIds) ?? [],
    createdAt: typeof v.createdAt === "number" ? v.createdAt : undefined,
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : undefined,
  };
}

function toWorkspaceItems(value: unknown): WorkspaceView[] {
  if (!Array.isArray(value)) return [];
  return value.map(toWorkspaceItem).filter((w): w is WorkspaceView => Boolean(w));
}
