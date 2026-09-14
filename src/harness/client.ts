import { randomUUID } from "node:crypto";
import { METHODS, type ClientRequest, type ServerResponse, type RpcError, type HostDescription, type HistoryPage, type ModelCatalog, type PromptContentPart, type QueueAction, type SessionAttachmentValue, type SessionSummary, type SettingsDescribeView, type SettingsNamespaceView, type SettingsPathOp, type WorkspaceView } from "./protocol";

/** A business-level RPC failure (result.ok === false). */
export class RpcErrorResult extends Error {
  constructor(public readonly rpcError: RpcError) {
    super(`${rpcError.code}: ${rpcError.message}`);
    this.name = "RpcErrorResult";
  }
}

/**
 * Thin RPC client for a running DSH web harness.
 * Implements the same protocol the browser frontend uses — no DSH-internal
 * packages, ~80 lines, works from any Node ≥ 18 host (fetch is global).
 */
export class HarnessClient {
  constructor(public readonly base: string) {}

  async call<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const request: ClientRequest = {
      type: "client-request",
      rpcId: randomUUID(),
      method,
      payload,
    };
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      throw new Error(`dsh api ${method}: transport failed (${(error as Error).message})`);
    }
    if (!res.ok) throw new Error(`dsh api ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as ServerResponse;
    if (!body.result.ok) throw new RpcErrorResult(body.result.error);
    return body.result.value as T;
  }

  describe(signal?: AbortSignal): Promise<HostDescription> {
    return this.call<HostDescription>(METHODS.hostDescribe, {}, signal);
  }

  listSessions(signal?: AbortSignal): Promise<{ items: SessionSummary[] }> {
    return this.call<{ items: SessionSummary[] }>(METHODS.sessionList, {}, signal);
  }

  prompt(sessionId: string, content: PromptContentPart[], mode: "queue" | "steer" = "queue"): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>(METHODS.sessionPrompt, { sessionId, mode, content });
  }

  /** One history page: raw events + hasMore. Tail page (beforeSeq absent)
   *  additionally carries the projections block (values.todos = current todo
   *  list or null after a turn/start reset — the same source the web GUI's
   *  task bar renders from). */
  history(
    sessionId: string,
    beforeSeq?: number,
    maxMessages = 30,
    signal?: AbortSignal
  ): Promise<HistoryPage> {
    return this.call(
      METHODS.sessionHistory,
      { sessionId, beforeSeq, maxMessages },
      signal
    );
  }

  createSession(opts?: { workspaceId?: string; agentPreset?: string }): Promise<{ sessionId: string }> {
    const payload: Record<string, string> = {};
    if (opts?.workspaceId) payload.workspaceId = opts.workspaceId;
    if (opts?.agentPreset) payload.agentPreset = opts.agentPreset;
    return this.call<{ sessionId: string }>(METHODS.sessionCreate, payload);
  }

  /** Register (or idempotently resolve) a directory as a DSH workspace. */
  workspaceCreate(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    return this.call<{ workspace: WorkspaceView; created: boolean }>(METHODS.workspaceCreate, { path });
  }

  /** All registered workspaces, for path→workspaceId lookups. */
  workspaceList(): Promise<{ items: WorkspaceView[]; archivedSessionIds: string[] }> {
    return this.call<{ items: WorkspaceView[]; archivedSessionIds: string[] }>(METHODS.workspaceList, {});
  }

  /** Archive a session (DSH's delete: hides it from session/workspace lists). */
  archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
    return this.call<{ archivedSessionIds: string[] }>(METHODS.workspaceArchiveSession, { sessionId });
  }

  cancel(sessionId: string): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>(METHODS.sessionCancel, { sessionId });
  }

  /**
   * Resolve one logged image ref into its bytes (base64). The harness only
   * serves attachments the named session's log actually references, so a
   * foreign or stale id fails with `attachment-error` instead of leaking
   * another session's image.
   */
  sessionAttachment(sessionId: string, attachmentId: string): Promise<SessionAttachmentValue> {
    return this.call<SessionAttachmentValue>(METHODS.sessionAttachment, { sessionId, attachmentId });
  }

  models(sessionId: string): Promise<ModelCatalog> {
    return this.call<ModelCatalog>(METHODS.sessionModels, { sessionId });
  }

  selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<{ selected: { provider: string; model: string } }> {
    return this.call<{ selected: { provider: string; model: string } }>(
      METHODS.sessionSelectModel,
      { sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
    );
  }

  /**
   * Answer a server-request frame (approval/requested, question/requested).
   * The rpcId MUST be the envelope id echoed from the frame — the harness
   * routes the client-response by it. Wire: POST /api/respond with a
   * client-response body; the HTTP response is an RpcReceipt
   * ({accepted:true} | {accepted:false, reason}).
   */
  respond(rpcId: string, value: unknown, signal?: AbortSignal): Promise<{ accepted: boolean; reason?: string }> {
    const request = {
      type: "client-response" as const,
      rpcId,
      result: { ok: true as const, value },
    };
    return fetch(`${this.base}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    }).then(async (res) => {
      if (!res.ok) throw new Error(`dsh api respond: HTTP ${res.status}`);
      const body = (await res.json()) as { accepted: boolean; reason?: string };
      return body;
    });
  }

  /** Available agent presets (agentPreset.list) — feeds the panel's ＋
   *  new-session mode picker (标准 / PTC / 极简 / 创造 + user presets).
   *  Entry fields mirror the host schema: id/trust/isDefault/name/description/broken. */
  agentPresetList(signal?: AbortSignal): Promise<{
    presets: {
      id: string;
      trust: "system" | "user";
      isDefault: boolean;
      name?: string;
      description?: string;
      broken?: string;
    }[];
    authorable: boolean;
    hasDocument: boolean;
  }> {
    return this.call(METHODS.agentPresetList, {}, signal);
  }

  updateQueue(sessionId: string, itemId: string, action: QueueAction): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>(METHODS.sessionUpdateQueue, { sessionId, itemId, action });
  }

  /** Slash-command catalog for a session (wire: commands/list, endpoint form). */
  commandList(
    sessionId: string
  ): Promise<{ name: string; description?: string; input?: { hint?: string; images?: boolean } }[]> {
    return this.call<{ name: string; description?: string; input?: { hint?: string; images?: boolean } }[]>(
      METHODS.commandsList,
      { args: { agentId: sessionId } }
    );
  }

  /** Execute one slash-command line against a session. */
  commandExecute(
    sessionId: string,
    line: string
  ): Promise<{ commandId?: string; result?: { kind: string; text?: string } } | undefined> {
    return this.call<{ commandId?: string; result?: { kind: string; text?: string } } | undefined>(
      METHODS.commandsExecute,
      { args: { agentId: sessionId, line, images: [] } }
    );
  }

  /** Cheap liveness probe: host.describe within a timeout. */
  async isAlive(timeoutMs = 1500): Promise<HostDescription | null> {
    try {
      return await this.describe(AbortSignal.timeout(timeoutMs));
    } catch {
      return null;
    }
  }

  /** All registered settings namespaces (redacted values + schemas). */
  settingsDescribe(signal?: AbortSignal): Promise<SettingsDescribeView> {
    return this.call<SettingsDescribeView>(METHODS.settingsDescribe, {}, signal);
  }

  /** Path-addressed edits to one namespace's user layer (optimistic revision
   *  guard: a stale expectedRevision is refused rather than overwriting). */
  settingsMutate(
    ns: string,
    ops: SettingsPathOp[],
    expectedRevision?: number,
    signal?: AbortSignal
  ): Promise<SettingsNamespaceView> {
    return this.call<SettingsNamespaceView>(
      METHODS.settingsMutate,
      { ns, ops, ...(expectedRevision !== undefined ? { expectedRevision } : {}) },
      signal
    );
  }
}
