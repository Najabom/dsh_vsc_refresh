import { randomUUID } from "node:crypto";
import { nativeAuthHeaders } from "./nativeAuth";
import { METHODS, type AccountBalanceWire, type AccountClientMetadataWire, type AccountProfileWire, type AccountStateWire, type ClientRequest, type ServerResponse, type RpcError, type AgentPresetRoster, type BundleView, type CredentialInfo, type FileReferenceWire, type FileUploadValue, type ImageAttachmentRef, type LlmConfigurableProvider, type LlmDiscoveredModel, type LlmProviderInfo, type MarketIndexSummary, type MarketQuery, type MarketSearchResult, type ModelCatalog, type ModelSelection, type PermissionCatalog, type PluginChangeResult, type PluginEntryView, type PluginExemptionsView, type PluginInspection, type PluginInventoryView, type PluginRegistriesView, type PromptContentPart, type QueueAction, type ScheduleCatalogEntryWire, type ScheduleTimingChangeWire, type SessionAddress, type SessionAttachmentValue, type SessionPageValue, type SessionReferenceCandidateWire, type SessionSearchView, type SessionSummary, type SettingsDescribeView, type SettingsNamespaceView, type SettingsPathOp, type SkillWire, type SubagentPromptValue, type GoalView, type GoalRef, type ChangesSummaryView, type ChangesDiffView, type WorkspaceViewWire } from "./protocol";

/** A business-level RPC failure (result.ok === false). */
export class RpcErrorResult extends Error {
  constructor(public readonly rpcError: RpcError) {
    super(`${rpcError.code}: ${rpcError.message}`);
    this.name = "RpcErrorResult";
  }
}

/** Request identity for account RPCs — same shape and derivation as the
 *  official web client (offset in seconds, positive east of Greenwich). */
function accountClientMetadata(version: string, locale: string): AccountClientMetadataWire {
  return { version, locale, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 };
}

/**
 * Thin RPC client for a running DSH web harness (0.1.7 typert gateway).
 * Implements the same wire contract the browser frontend uses — no DSH-internal
 * packages, works from any Node ≥ 18 host (fetch is global). Every call wraps
 * its descriptor-named arguments in `payload.args`.
 */
export class HarnessClient {
  constructor(public readonly base: string) {}

  /** Optional sink for RPC-level failures: the extension classifies which
   *  surface a gateway error belongs to and reports version incompatibility
   *  honestly (see harness/capabilities.ts). Never throws into the call path. */
  onProtocolError?: (method: string, code: string, message: string) => void;

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
        // A native `dsh web` demands a browser-session cookie even for local
        // protocol clients; mint one from this home's stored signing secret
        // (loopback only). Managed instances ignore it — their overlay bypass
        // already admits us.
        headers: { "content-type": "application/json", ...(nativeAuthHeaders(this.base) ?? {}) },
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
    if (!body.result.ok) {
      const failure = new RpcErrorResult(body.result.error);
      try {
        this.onProtocolError?.(method, failure.rpcError.code, failure.rpcError.message);
      } catch {
        /* diagnostics must never break the call */
      }
      throw failure;
    }
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
        headers: { "content-type": "application/json", ...(nativeAuthHeaders(this.base) ?? {}) },
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
    return this.pageAddress({ kind: "session", sessionId }, throughSeq, beforeSeq, maxMessages, signal);
  }

  /** One history page for an explicit address (top-level session or a
   *  subagent child addressed through its parent — same paging rules). */
  pageAddress(
    address: SessionAddress,
    throughSeq: number,
    beforeSeq?: number,
    maxMessages = 30,
    signal?: AbortSignal
  ): Promise<SessionPageValue> {
    return this.call<SessionPageValue>(
      METHODS.sessionPage,
      {
        request: {
          address,
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

  /** Pin a session title (official rename: appends a user-owned
   *  `session/title` event; later user messages schedule no auto-title). */
  renameSession(sessionId: string, title: string): Promise<{ title: string; seq?: number }> {
    return this.call<{ title: string; seq?: number }>(METHODS.sessionRename, {
      request: { sessionId, title },
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
   * another session's image. The harness verifies the COMPLETE ref (id, media
   * type, byte length, dimensions), so callers must pass the ref as logged.
   */
  sessionAttachment(sessionId: string, attachmentId: string): Promise<SessionAttachmentValue> {
    return this.call<SessionAttachmentValue>(METHODS.sessionAttachment, {
      request: { sessionId, attachmentId },
    });
  }

  /** Resolve a full durable image ref into bytes (queue/file refs carry all fields). */
  readAttachment(sessionId: string, attachment: ImageAttachmentRef): Promise<SessionAttachmentValue> {
    return this.call<SessionAttachmentValue>(METHODS.sessionAttachment, {
      request: { sessionId, attachment },
    });
  }

  /**
   * Upload one durable (non-image) file for a session's prompt. The harness
   * stores it content-addressed and returns a one-shot receiptId; reference
   * it from prompt content as `{type:'file', receiptId}` — admission resolves
   * the receipt into the durable attachment ref.
   */
  uploadFile(sessionId: string, data: string, name?: string): Promise<FileUploadValue> {
    return this.call<FileUploadValue>(METHODS.fileUpload, {
      agentId: sessionId,
      request: { data, ...(name ? { name } : {}) },
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
      client: accountClientMetadata(version, locale),
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

  /* ---------- llm providers + credentials (API keys) ---------- */

  /** Registered provider routes (id + display name). */
  listLlmProviders(signal?: AbortSignal): Promise<LlmProviderInfo[]> {
    return this.call<LlmProviderInfo[]>(METHODS.llmListProviders, {}, signal);
  }

  /** Providers whose profile is stored in a settings namespace. */
  listConfigurableProviders(signal?: AbortSignal): Promise<LlmConfigurableProvider[]> {
    return this.call<LlmConfigurableProvider[]>(METHODS.llmListConfigurableProviders, {}, signal);
  }

  /** Ask one adapter namespace for the models an endpoint serves. */
  discoverModels(
    settingsNs: string,
    request: { provider?: string; baseURL?: string; api?: string; apiKey?: string },
    signal?: AbortSignal
  ): Promise<LlmDiscoveredModel[]> {
    return this.call<LlmDiscoveredModel[]>(METHODS.llmDiscoverModels, { settingsNs, request }, signal);
  }

  /** Credential state for a batch of refs (values are never read back). */
  describeCredentials(refs: string[], signal?: AbortSignal): Promise<Record<string, CredentialInfo>> {
    return this.call<Record<string, CredentialInfo>>(METHODS.credentialsDescribe, { refs }, signal);
  }

  /** Store (or replace) one credential value. */
  setCredential(ref: string, value: string, signal?: AbortSignal): Promise<void> {
    return this.call<void>(METHODS.credentialsSet, { ref, value }, signal);
  }

  /** Remove a stored credential. */
  unsetCredential(ref: string, signal?: AbortSignal): Promise<void> {
    return this.call<void>(METHODS.credentialsUnset, { ref }, signal);
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

  /** Settle a lost install request by its requestId (null when the harness
   *  never saw it or it is still running). */
  waitForInstall(requestId: string): Promise<PluginChangeResult | null> {
    return this.call<PluginChangeResult | null>(METHODS.pluginWaitInstall, { requestId });
  }

  /** Read-only built-in plugins inventory, grouped by agent preset. */
  pluginInventory(signal?: AbortSignal): Promise<PluginInventoryView> {
    return this.call<PluginInventoryView>(METHODS.pluginInventory, {}, signal);
  }

  /** Configured market index sources (title/description/error per source). */
  marketIndexes(signal?: AbortSignal): Promise<MarketIndexSummary[]> {
    return this.call<MarketIndexSummary[]>(METHODS.pluginMarketIndexes, {}, signal);
  }

  /** One market search page from a configured index. */
  marketSearch(url: string, query: MarketQuery, signal?: AbortSignal): Promise<MarketSearchResult> {
    return this.call<MarketSearchResult>(METHODS.pluginMarketSearch, { url, query }, signal);
  }

  /** Replace the configured market index sources. */
  marketSetIndexes(urls: string[], signal?: AbortSignal): Promise<void> {
    return this.call<void>(METHODS.pluginMarketSetIndexes, { urls }, signal);
  }

  /** Continue (or steer) a child conversation through its parent — the
   *  official addressing for a live subagent session. */
  subagentsPrompt(
    parentSessionId: string,
    childSessionId: string,
    content: PromptContentPart[],
    delivery: "queue" | "steer" = "queue"
  ): Promise<SubagentPromptValue> {
    return this.call<SubagentPromptValue>(METHODS.subagentsPrompt, {
      requestId: randomUUID(),
      parentSessionId,
      childSessionId,
      mode: "continuable",
      delivery,
      content,
    });
  }

  /** Interrupt a child conversation (works even when the parent is not live). */
  subagentInterrupt(childSessionId: string, parentSessionId: string): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>(METHODS.subagentsInterrupt, {
      childSessionId,
      parentSessionId,
      mode: "continuable",
    });
  }

  /* ---------- background jobs ---------- */

  /** Ask a running job to stop (jobController/kill takes one request struct). */
  jobKill(sessionId: string, jobId: string): Promise<{ outcome: "requested" | "already-finished" }> {
    return this.call<{ outcome: "requested" | "already-finished" }>(METHODS.jobKill, { request: { sessionId, jobId } });
  }

  /* ---------- goals ---------- */

  /** The session's goal (undefined when none is set). */
  goalsGet(agentId: string): Promise<GoalView | undefined> {
    return this.call<GoalView | undefined>(METHODS.goalsGet, { agentId });
  }

  goalsCreate(agentId: string, objective: string, maxGoalRounds?: number): Promise<{ ref: GoalRef }> {
    return this.call<{ ref: GoalRef }>(METHODS.goalsCreate, { agentId, request: { objective, maxGoalRounds } });
  }

  goalsPause(agentId: string, ref: GoalRef): Promise<GoalView> {
    return this.call<GoalView>(METHODS.goalsPause, { agentId, ref });
  }

  goalsResume(agentId: string, ref: GoalRef): Promise<GoalView> {
    return this.call<GoalView>(METHODS.goalsResume, { agentId, ref });
  }

  goalsComplete(agentId: string, ref: GoalRef): Promise<GoalView> {
    return this.call<GoalView>(METHODS.goalsComplete, { agentId, ref });
  }

  goalsClear(agentId: string, ref: GoalRef): Promise<void> {
    return this.call<void>(METHODS.goalsClear, { agentId, ref });
  }

  /* ---------- workspace management / search / fork / skills / references ---------- */

  workspaceCreate(path: string): Promise<{ workspace: WorkspaceViewWire; created: boolean }> {
    return this.call<{ workspace: WorkspaceViewWire; created: boolean }>(METHODS.workspaceCreate, { path });
  }

  workspaceRename(workspaceId: string, title: string): Promise<{ workspace: WorkspaceViewWire }> {
    return this.call<{ workspace: WorkspaceViewWire }>(METHODS.workspaceRename, { workspaceId, title });
  }

  workspaceDelete(workspaceId: string): Promise<{ deleted: true }> {
    return this.call<{ deleted: true }>(METHODS.workspaceDelete, { workspaceId });
  }

  /** Move a workspace before another one (order is the list order). */
  workspaceInsertBefore(workspaceId: string, beforeWorkspaceId?: string): Promise<{ workspaceIds: string[] }> {
    return this.call<{ workspaceIds: string[] }>(METHODS.workspaceInsertBefore, {
      workspaceId,
      ...(beforeWorkspaceId ? { beforeWorkspaceId } : {}),
    });
  }

  workspacePinSession(sessionId: string, pinned: boolean): Promise<{ pinnedSessionIds: string[] }> {
    return this.call<{ pinnedSessionIds: string[] }>(
      pinned ? METHODS.workspacePinSession : METHODS.workspaceUnpinSession,
      { sessionId }
    );
  }

  /** Full-text history search (session/search). Disabled deployments answer
   *  with a gateway/internal error explaining the query index is off. */
  sessionSearch(query: string): Promise<SessionSearchView> {
    return this.call<SessionSearchView>(METHODS.sessionSearch, { request: { query } });
  }

  /** Fork a conversation; atSeq is an inclusive source seq (the turn prefix
   *  before that seq is forked when callers pass turnStartSeq - 1). */
  sessionFork(sessionId: string, atSeq?: number): Promise<{ sessionId: string }> {
    return this.call<{ sessionId: string }>(METHODS.sessionFork, {
      sessionId,
      ...(atSeq !== undefined ? { atSeq } : {}),
    });
  }

  skillsList(sessionId: string): Promise<{ skills: SkillWire[] }> {
    return this.call<{ skills: SkillWire[] }>(METHODS.skillsList, { sessionId });
  }

  /** Workspace-relative file/directory suggestions for the @ menu. */
  fileReferences(agentId: string, query: string): Promise<FileReferenceWire[]> {
    return this.call<FileReferenceWire[]>(METHODS.fileReferences, { agentId, query });
  }

  /** Conversation candidates for the @ menu; insert `mention` verbatim. */
  sessionReferenceCandidates(agentId: string, query?: string): Promise<SessionReferenceCandidateWire[]> {
    return this.call<SessionReferenceCandidateWire[]>(
      METHODS.sessionReferenceCandidates,
      query === undefined ? { agentId } : { agentId, query }
    );
  }

  /* ---------- account ---------- */

  getAccountState(): Promise<AccountStateWire> {
    return this.call<AccountStateWire>(METHODS.accountGetState, {});
  }

  getAccountProfile(version: string, locale: string): Promise<AccountProfileWire> {
    return this.call<AccountProfileWire>(METHODS.accountGetProfile, {
      client: accountClientMetadata(version, locale),
    });
  }

  /**
   * Begin the DeepSeek-account browser sign-in (account/startSignIn).
   * `callbackOrigin` must be the browser-reachable loopback origin of the
   * harness itself (`http://127.0.0.1:<port>`): DSH registers
   * `${callbackOrigin}/oauth/callback` on its own web server and rejects
   * non-loopback / default-port / path-ful origins with a protocol error.
   * The result's `attempt.authorizeUrl` is the platform URL to open externally;
   * poll getAccountState until `attempt.phase` settles.
   *
   * `loginSource: "web"` is deliberate: the extension finishes the flow in a
   * normal external browser, exactly like the official web client (DSH then
   * renders its browser-facing failure page and the platform shows browser
   * copy; "desktop" belongs to DSH's own desktop shell).
   */
  startAccountSignIn(version: string, locale: string, callbackOrigin: string): Promise<AccountStateWire> {
    return this.call<AccountStateWire>(METHODS.accountStartSignIn, {
      client: accountClientMetadata(version, locale),
      callbackOrigin,
      loginSource: "web",
    });
  }

  /** Cancel one in-flight sign-in attempt (account/cancelSignIn). */
  cancelAccountSignIn(attemptId: string): Promise<AccountStateWire> {
    return this.call<AccountStateWire>(METHODS.accountCancelSignIn, { attemptId });
  }

  /** Remove the stored local grant (account/signOut); Platform revocation is
   *  asynchronous on the harness side and API-key credentials are untouched. */
  signOutAccount(version: string, locale: string): Promise<AccountStateWire> {
    return this.call<AccountStateWire>(METHODS.accountSignOut, {
      client: accountClientMetadata(version, locale),
    });
  }

  /** Whether running agent work uses the account route
   *  (account/hasRunningAccountTasks; no arguments). */
  hasRunningAccountTasks(): Promise<boolean> {
    return this.call<boolean>(METHODS.accountHasRunningAccountTasks, {});
  }

  /* ---------- schedules ---------- */

  scheduleCatalog(): Promise<ScheduleCatalogEntryWire[]> {
    return this.call<ScheduleCatalogEntryWire[]>(METHODS.scheduleCatalog, {});
  }

  /** Update one task (title/prompt/timing). `expected` is the full record read from the catalog. */
  scheduleUpdate(
    record: ScheduleCatalogEntryWire,
    change?: ScheduleTimingChangeWire,
    title?: string,
    prompt?: string
  ): Promise<ScheduleCatalogEntryWire> {
    return this.call<ScheduleCatalogEntryWire>(METHODS.scheduleUpdate, {
      id: record.id,
      sessionId: record.sessionId,
      expected: record,
      ...(change ? { change } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    });
  }

  scheduleDelete(id: string, sessionId: string): Promise<{ id: string; deleted: boolean; code?: string }> {
    return this.call<{ id: string; deleted: boolean; code?: string }>(METHODS.scheduleDelete, { id, sessionId });
  }

  /* ---------- document routes (workspace changes / deliverables) ---------- */

  /** Authenticated GET on the harness document routes (JSON responses).
   *  The same browser-session cookie the RPC call attaches is used here. */
  async getJson<T>(pathAndQuery: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}${pathAndQuery}`, {
      headers: { ...(nativeAuthHeaders(this.base) ?? {}) },
      signal,
    });
    if (!res.ok) throw new Error(`dsh api GET ${pathAndQuery}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** One turn's changed-file summary (workspace/changes). */
  changesSummary(sessionId: string, seq: number, signal?: AbortSignal): Promise<ChangesSummaryView> {
    return this.getJson<ChangesSummaryView>(
      `/api/changes.summary?sessionId=${encodeURIComponent(sessionId)}&seq=${seq}`,
      signal
    );
  }

  /** One listed file's turn-start/turn-end comparison. */
  changesDiff(sessionId: string, seq: number, index: number, signal?: AbortSignal): Promise<ChangesDiffView> {
    return this.getJson<ChangesDiffView>(
      `/api/changes.diff?sessionId=${encodeURIComponent(sessionId)}&seq=${seq}&index=${index}`,
      signal
    );
  }
}
