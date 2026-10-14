import { randomUUID } from "node:crypto";
import { METHODS, type AccountBalanceWire, type ClientRequest, type ServerResponse, type RpcError, type AgentPresetRoster, type BundleView, type ModelCatalog, type ModelSelection, type PermissionCatalog, type PluginChangeResult, type PluginEntryView, type PluginExemptionsView, type PluginInspection, type PluginRegistriesView, type PromptContentPart, type QueueAction, type SessionAttachmentValue, type SessionPageValue, type SessionSummary, type SettingsDescribeView, type SettingsNamespaceView, type SettingsPathOp } from "./protocol";

/** A business-level RPC failure (result.ok === false). */
export class RpcErrorResult extends Error {
  constructor(public readonly rpcError: RpcError) {
    super(`${rpcError.code}: ${rpcError.message}`);
    this.name = "RpcErrorResult";
  }
}

/**
 * Thin RPC client for a running DSH web harness (0.1.7 typert gateway).
 * Implements the same wire contract the browser frontend uses — no DSH-internal
 * packages, works from any Node ≥ 18 host (fetch is global). Every call wraps
 * its descriptor-named arguments in `payload.args`.
 */
export class HarnessClient {
  constructor(public readonly base: string) {}

  async call<T>(method: string, args: unknown, signal?: AbortSignal): Promise<T> {
    const request: ClientRequest = {
      type: "client-request",
      rpcId: randomUUID(),
      method,
      payload: { args },
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
    let body: ServerResponse;
    try {
      body = (await res.json()) as ServerResponse;
    } catch {
      throw new Error(`dsh api ${method}: response was not JSON (harness restarting or wrong service?)`);
    }
    if (!body || body.type !== "server-response" || !body.result) {
      throw new Error(`dsh api ${method}: malformed server response`);
    }
    if (!body.result.ok) throw new RpcErrorResult(body.result.error);
    return body.result.value as T;
  }

  /** Cheap liveness probe: a session/list read within a timeout. (0.1.7 has no
   *  host.describe; session/list is the registry read the web GUI opens with.)
   *  Tri-state so callers can tell a STOCK instance we cannot drive (401: it
   *  wants browser-session auth that only our overlay-bypassed spawn skips)
   *  apart from "nothing is listening". */
  async probe(timeoutMs = 1500): Promise<"alive" | "unauthorized" | "down"> {
    try {
      const res = await fetch(`${this.base}/api/${METHODS.sessionList}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: METHODS.sessionList, payload: { args: { _request: {} } } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 || res.status === 403) return "unauthorized";
      if (!res.ok) return "down";
      const body = (await res.json().catch(() => null)) as { result?: { ok?: boolean } } | null;
      return body?.result?.ok ? "alive" : "down";
    } catch {
      return "down";
    }
  }

  async isAlive(timeoutMs = 1500): Promise<boolean> {
    return (await this.probe(timeoutMs)) === "alive";
  }

  listSessions(signal?: AbortSignal): Promise<{ items: SessionSummary[] }> {
    return this.call<{ items: SessionSummary[] }>(METHODS.sessionList, { _request: {} }, signal);
  }

  /** One history page: records with beforeSeq < seq <= throughSeq. The tail
   *  page omits beforeSeq; throughSeq never exceeds the session cursor
   *  (session/list projections.asOfSeq). */
  page(
    sessionId: string,
    throughSeq: number,
    beforeSeq?: number,
    maxMessages = 30,
    signal?: AbortSignal
  ): Promise<SessionPageValue> {
    return this.call<SessionPageValue>(
      METHODS.sessionPage,
      {
        request: {
          address: { kind: "session", sessionId },
          throughSeq,
          ...(beforeSeq !== undefined ? { beforeSeq } : {}),
          maxMessages,
        },
      },
      signal
    );
  }

  createSession(opts?: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }> {
    return this.call<{ sessionId: string; agentPreset?: string }>(METHODS.sessionCreate, {
      request: {
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        ...(opts?.agentPreset ? { agentPreset: opts.agentPreset } : {}),
      },
    });
  }

  prompt(sessionId: string, content: PromptContentPart[], mode: "queue" | "steer" = "queue"): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>(METHODS.sessionPrompt, {
      request: { requestId: randomUUID(), sessionId, mode, content },
    });
  }

  cancel(sessionId: string): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>(METHODS.sessionCancel, { request: { sessionId } });
  }

  /**
   * Resolve one logged image ref into its bytes (base64). The harness only
   * serves attachments the named session's log actually references, so a
   * foreign or stale id fails with `attachment-error` instead of leaking
   * another session's image.
   */
  sessionAttachment(sessionId: string, attachmentId: string): Promise<SessionAttachmentValue> {
    return this.call<SessionAttachmentValue>(METHODS.sessionAttachment, {
      request: { sessionId, attachmentId },
    });
  }

  /** Model catalog (session/modelCatalog, no session argument). */
  models(): Promise<ModelCatalog> {
    return this.call<ModelCatalog>(METHODS.sessionModelCatalog, {});
  }

  selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<{ selected: ModelSelection }> {
    return this.call<{ selected: ModelSelection }>(METHODS.sessionSelectModel, {
      request: { sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
    });
  }

  /** Archive a session (DSH's delete: hides it from session/workspace lists).
   *  The value is the complete archived set after the write. Running work is
   *  stopped first (stopActivity) — the harness otherwise refuses an active
   *  session with `workspace/session-active` instead of archiving it. */
  archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
    return this.call<{ archivedSessionIds: string[] }>(METHODS.workspaceArchiveSession, {
      request: { sessionId, stopActivity: true },
    });
  }

  updateQueue(sessionId: string, itemId: string, action: QueueAction): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>(METHODS.sessionUpdateQueue, {
      request: { sessionId, itemId, action },
    });
  }

  /** Slash-command catalog for a session (wire: commands/list, args by name). */
  commandList(
    sessionId: string
  ): Promise<{ name: string; description?: string; input?: { hint?: string; images?: boolean } }[]> {
    return this.call<{ name: string; description?: string; input?: { hint?: string; images?: boolean } }[]>(
      METHODS.commandsList,
      { agentId: sessionId }
    );
  }

  /** Execute one slash-command line against a session. */
  commandExecute(
    sessionId: string,
    line: string
  ): Promise<{ commandId?: string; result?: { kind: string; text?: string } } | undefined> {
    return this.call<{ commandId?: string; result?: { kind: string; text?: string } } | undefined>(
      METHODS.commandsExecute,
      { agentId: sessionId, line, submittedAttachments: [] }
    );
  }

  /** Available agent presets (agentPresets/list) — feeds the panel's ＋
   *  new-session mode picker (标准 / PTC / 极简 / 创造 + user presets). */
  agentPresetList(signal?: AbortSignal): Promise<AgentPresetRoster> {
    return this.call<AgentPresetRoster>(METHODS.agentPresetsList, {}, signal);
  }

  /** Permission preset roster (permissionPresets/catalog) — the header 权限
   *  select's option list (0.1.7 no longer carries options in the projection). */
  permissionCatalog(signal?: AbortSignal): Promise<PermissionCatalog> {
    return this.call<PermissionCatalog>(METHODS.permissionCatalog, {}, signal);
  }

  /**
   * Answer a $events waterfall (approval/request, user-questions/request).
   * Wire: POST /api/$events/result with the mux connection's clientId and the
   * waterfall eventId; the outcome carries the waterfall value
   * ({kind:'result', value} | {kind:'next'} | {kind:'rejected', error}).
   */
  answerEvent(clientId: string, eventId: string, outcome: unknown): Promise<void> {
    return this.call<void>(METHODS.eventsResult, { clientId, eventId, outcome });
  }

  /**
   * Account balance of the signed-in DeepSeek-account channel
   * (account/getBalance). `client` is the request identity the official
   * account UI sends — {version, locale, timezoneOffsetSeconds} — carried as
   * a descriptor-named argument (NOT the `_request` wrapper). A null result
   * means the account channel is not signed in; {status:'failed'} means the
   * platform call itself failed (offline etc.).
   */
  getAccountBalance(version: string, locale: string): Promise<AccountBalanceWire | null> {
    return this.call<AccountBalanceWire | null>(METHODS.accountGetBalance, {
      client: { version, locale, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 },
    });
  }

  /** Patch one namespace's user layer with a partial value (settings/update).
   *  This is the path the official client uses to switch the default agent
   *  preset (agent-preset-registry → {selectedDefault}). */
  settingsUpdate(
    ns: string,
    patch: Record<string, unknown>,
    expectedRevision?: number,
    signal?: AbortSignal
  ): Promise<SettingsNamespaceView> {
    return this.call<SettingsNamespaceView>(
      METHODS.settingsUpdate,
      { ns, patch, ...(expectedRevision !== undefined ? { expectedRevision } : {}) },
      signal
    );
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

  /* ---------- plugin manager ---------- */

  /** Loader entries with their enablement, fiber phase and control handle. */
  listPluginEntries(signal?: AbortSignal): Promise<PluginEntryView[]> {
    return this.call<PluginEntryView[]>(METHODS.pluginList, {}, signal);
  }

  /** Profile bundles (the management unit: enable/remove/install). */
  listBundles(signal?: AbortSignal): Promise<BundleView[]> {
    return this.call<BundleView[]>(METHODS.pluginBundles, {}, signal);
  }

  /** Configured registry plus the resolved effective one. */
  pluginRegistries(signal?: AbortSignal): Promise<PluginRegistriesView> {
    return this.call<PluginRegistriesView>(METHODS.pluginRegistries, {}, signal);
  }

  /** Probe a spec (registry name / path / git / tarball) before installing. */
  inspectPlugin(
    spec: string,
    registry?: string | null,
    signal?: AbortSignal
  ): Promise<PluginInspection> {
    return this.call<PluginInspection>(
      METHODS.pluginInspect,
      { spec, ...(registry !== undefined ? { options: { registry } } : {}) },
      signal
    );
  }

  /** Install a bundle. Resolves when the operation settles; progress arrives
   *  on the harness event stream (plugin-manager/install-state + install-log).
   *  `enabled` installs and enables in one operation. */
  installBundle(
    spec: string,
    options: { enabled?: boolean; requestId?: string; registry?: string | null; approvedBuilds?: string[] } = {}
  ): Promise<PluginChangeResult> {
    return this.call<PluginChangeResult>(METHODS.pluginInstall, { spec, options });
  }

  /** Cancel an in-flight install by requestId. */
  cancelInstall(requestId: string): Promise<{ status: string }> {
    return this.call<{ status: string }>(METHODS.pluginCancelInstall, { requestId });
  }

  /** Toggle one Loader entry by its control handle (patchId). */
  setPluginEnabled(entryId: string, enabled: boolean, signal?: AbortSignal): Promise<PluginChangeResult> {
    return this.call<PluginChangeResult>(METHODS.pluginSetEnabled, { id: entryId, enabled }, signal);
  }

  /** Toggle a whole bundle. */
  setBundleEnabled(name: string, enabled: boolean, signal?: AbortSignal): Promise<PluginChangeResult> {
    return this.call<PluginChangeResult>(METHODS.pluginBundleSetEnabled, { name, enabled }, signal);
  }

  /** Remove an installed bundle from the profile. */
  removeBundle(name: string, signal?: AbortSignal): Promise<PluginChangeResult> {
    return this.call<PluginChangeResult>(METHODS.pluginRemoveBundle, { name }, signal);
  }

  /** Exact plugin-version exemptions saved in this profile ("name@version" → runtimes). */
  listVersionExemptions(signal?: AbortSignal): Promise<PluginExemptionsView> {
    return this.call<PluginExemptionsView>(METHODS.pluginListExemptions, {}, signal);
  }

  /** Grant or revoke one exact plugin/runtime exemption (acceptRisk required for grants). */
  setVersionExemption(
    packageVersion: string,
    runtimeVersion: string,
    enabled: boolean,
    acceptRisk?: boolean
  ): Promise<PluginChangeResult> {
    return this.call<PluginChangeResult>(METHODS.pluginSetExemption, {
      packageVersion,
      runtimeVersion,
      enabled,
      ...(acceptRisk === undefined ? {} : { acceptRisk }),
    });
  }
}
