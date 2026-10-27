/**
 * Wire protocol for the DSH host API (dsh 0.1.7 "typert" remote gateway).
 *
 * Request:   POST /api/<slash/endpoint>   body {type:'client-request', rpcId, method, payload:{args}}
 * Response:  HTTP 200                     {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}
 * Streams:   WS /api/remote.mux           open/item/end/cancel frames. Endpoints used here:
 *   - session/follow     live session events (durable journal + assistant-stream frames)
 *   - session/control    host-wide projection baseline + increments (todos/permissions/inbox/…)
 *   - workspace/follow   workspace baseline + archived-session increments
 *   - $events            host-level emits (api-session/*, commands/change) and the
 *                        approval/request + user-questions/request waterfalls
 *
 * Auth: a stock `dsh web` 0.1.7 answers 401 on /api and / without its launch-token
 * cookie. This bridge talks to the instance it spawns through the in-memory
 * overlay bypass (src/harness/overlay) — official dsh files on disk stay pristine.
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

/** Canonical endpoints (slash names, as the 0.1.7 gateway registers them). */
export const METHODS = {
  sessionList: "session/list",
  sessionPage: "session/page",
  sessionCreate: "session/create",
  sessionRename: "session/rename",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionModelCatalog: "session/modelCatalog",
  sessionSelectModel: "session/selectModel",
  sessionUpdateQueue: "session/updateQueue",
  sessionAttachment: "session/attachment",
  workspaceArchiveSession: "workspace/archiveSession",
  commandsList: "commands/list",
  commandsExecute: "commands/execute",
  agentPresetsList: "agentPresets/list",
  settingsDescribe: "settings/describe",
  settingsMutate: "settings/mutate",
  settingsUpdate: "settings/update",
  permissionCatalog: "permissionPresets/catalog",
  pluginList: "pluginManager/listPlugins",
  pluginBundles: "pluginManager/listBundles",
  pluginRegistries: "pluginManager/registries",
  pluginInspect: "pluginManager/inspect",
  pluginInstall: "pluginManager/installBundle",
  pluginCancelInstall: "pluginManager/cancelInstall",
  pluginSetEnabled: "pluginManager/setPluginEnabled",
  pluginBundleSetEnabled: "pluginManager/setBundleEnabled",
  pluginRemoveBundle: "pluginManager/removeBundle",
  pluginListExemptions: "pluginManager/listVersionExemptions",
  pluginSetExemption: "pluginManager/setVersionExemption",
  pluginWaitInstall: "pluginManager/waitForInstall",
  pluginInventory: "pluginInventory/list",
  pluginMarketIndexes: "pluginMarket/listIndexes",
  pluginMarketSearch: "pluginMarket/search",
  pluginMarketSetIndexes: "pluginMarket/setIndexes",
  subagentsPrompt: "subagents/prompt",
  subagentsInterrupt: "subagents/interruptByParent",
  accountGetBalance: "account/getBalance",
  llmListProviders: "llm/listProviders",
  llmListConfigurableProviders: "llm/listConfigurableProviders",
  llmDiscoverModels: "llm/discoverModels",
  credentialsDescribe: "credentials/describe",
  credentialsSet: "credentials/set",
  credentialsUnset: "credentials/unset",
  fileUpload: "fileUploads/upload",
  eventsResult: "$events/result",
} as const;

/** session.prompt content part: text and raster images both ride the same
 *  typed content array (images carry inline base64 on the wire; the harness
 *  admits them into its durable attachment store and the log keeps a ref).
 *  Durable files ride a receipt: upload once via fileUploads/upload, then
 *  reference the receiptId the host resolves during prompt admission. */
export type PromptContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string; name?: string }
  | { type: "file"; receiptId: string };

/** Durable image reference as it appears in a logged content block. */
export interface ImageAttachmentRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

/** Durable (non-image) file reference as it appears in a logged content block. */
export interface FileAttachmentRef {
  attachmentId: string;
  name: string;
  bytes: number;
}

/** fileUploads/upload value: the one-shot receiptId (referenced from prompt
 *  content) plus the durable file ref the harness stored. */
export interface FileUploadValue {
  receiptId: string;
  file: FileAttachmentRef;
}

/** session/attachment value: the ref plus the decoded base64 payload. */
export interface SessionAttachmentValue {
  attachment: ImageAttachmentRef;
  data: string;
}

/** session/updateQueue action (edit/remove/steer a queued message). */
export type QueueAction =
  | { kind: "remove" }
  | { kind: "steer" }
  | { kind: "edit"; content: { type: string; text?: string }[] };

/* ---------- account ---------- */

/** One wallet row of account/getBalance (decimal-string amount). */
export interface AccountWalletWire {
  currency: string;
  balance: string;
}

/** account/getBalance value: the signed-in account's wallet snapshot
 *  ({status:'ready'}); the wire union also allows null / {status:'failed'},
 *  which callers surface as "no balance". */
export interface AccountBalanceWire {
  status: string;
  value?: AccountWalletWire[];
  bonusWallets?: AccountWalletWire[];
}

/* ---------- session/list + projection values ---------- */

/** tokenUsage projection unit. */
export interface TokenUsage {
  uncachedInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** sessionStats projection unit (the web composer's status line source). */
export interface SessionStats {
  turns?: number;
  steps?: number;
  llmMs?: number;
  toolMs?: number;
  ttftMs?: number;
  ttftSteps?: number;
  decodeMs?: number;
  decodeTokens?: number;
}

/** contextPressure projection unit (context occupancy ring source). */
export interface ContextPressure {
  projectedTokens?: number;
  pressureTokens?: number;
  contextWindow?: number;
}

/** The `todos` projection unit (per-turn task list; null after a turn reset). */
export type TodoProjection = { content: string; status: "pending" | "in_progress" | "completed" }[] | null;

/** The `permissions` projection — 0.1.7 carries only the current value; the
 *  option list comes from permissionPresets/catalog. */
export interface PermissionProjection {
  currentValue?: string;
}

/** One pending row of the inbox projection (next-turn queued / next-step steer). */
export interface InboxRow {
  id?: string;
  content?: { type?: string; text?: string }[];
}

/** The `inbox` projection — pending queue rows for the active session. */
export interface InboxProjection {
  "next-turn"?: InboxRow[];
  "next-step"?: InboxRow[];
}

/** Projection values block (shape varies by key; unknown keys pass through). */
export interface SessionProjectionValues {
  title?: string | null;
  tokenUsage?: TokenUsage | null;
  sessionStats?: SessionStats | null;
  contextPressure?: ContextPressure | null;
  todos?: TodoProjection;
  permissions?: PermissionProjection | null;
  inbox?: InboxProjection | null;
  modelSelection?: ModelSelectionProjection | null;
  [key: string]: unknown;
}

/** session/list item. */
export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  agentAvailable?: boolean;
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
  agentPreset?: string;
  /** Projection block; `asOfSeq` is the session journal cursor (the throughSeq
   *  a session/page request must not exceed). */
  projections?: {
    kind?: string;
    asOfSeq?: number;
    values?: SessionProjectionValues;
  };
}

/* ---------- session/page ---------- */

/** A raw session event frame as the harness emits it (wire passthrough).
 *  The panel's own view (src/panel/protocol.ts PanelEvent) extends this with
 *  host-supplied fields — the wire shape lives here. */
export interface SessionEventLike {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
  surfaceOp?: string;
}

/** One history page (records end at the requested throughSeq). */
export interface SessionPageValue {
  records: { type: string; event: SessionEventLike }[];
  hasMore: boolean;
}

/* ---------- model catalog (session/modelCatalog) ---------- */

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** Durable model-selection fold (the `modelSelection` projection). `next` is
 *  the pending pick the next request will use; `lastUsed` is what the latest
 *  recorded model request consumed. */
export interface ModelSelectionProjection {
  lastUsed?: ModelSelection | null;
  next?: ModelSelection | null;
}

export interface ModelCatalog {
  default?: ModelSelection;
  routableProviders?: string[];
  groups: { id: string; name: string; models: { id: string; name: string; description?: string; reasoning?: { efforts: { id: string; name: string; description?: string }[]; defaultEffort?: string } }[] }[];
  failures?: { id: string; name: string; message: string }[];
}

/* ---------- permission presets (permissionPresets/catalog) ---------- */

export interface PermissionPresetOption {
  value: string;
  name?: string;
  label?: string;
  description?: string;
}

export interface PermissionCatalog {
  options: PermissionPresetOption[];
  defaultOptions?: PermissionPresetOption[];
  defaultPreset?: string;
}

/* ---------- agent presets (agentPresets/list) ---------- */

export interface AgentPresetRoster {
  presets: {
    id: string;
    order?: number;
    isDefault?: boolean;
    name?: string;
    description?: string;
    trust?: string;
    broken?: string;
  }[];
}

/* ---------- settings domain (settings/describe / settings/mutate) ---------- */

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

/** One path-addressed edit carried by settings/mutate. */
export type SettingsPathOp =
  | { op: "set"; path: string[]; value: unknown }
  | { op: "unset"; path: string[] };

/** settings/describe response value. */
export interface SettingsDescribeView {
  writable: boolean;
  hasDocument: boolean;
  namespaces: SettingsNamespaceView[];
}

/* ---------- llm providers + credentials (llm/*, credentials/*) ---------- */

/** llm/listProviders row: one registered provider route. */
export interface LlmProviderInfo {
  id: string;
  name: string;
}

/** llm/listConfigurableProviders row: where a provider's profile is stored. */
export interface LlmConfigurableProvider {
  provider: string;
  displayName: string;
  settingsNs: string;
  settingsPath: string[];
  declared?: boolean;
  error?: string;
}

/** One candidate model from llm/discoverModels. */
export interface LlmDiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: string[];
}

/** credentials/describe row state (credential values are never read back). */
export interface CredentialInfo {
  configured: boolean;
  source?: string;
  writable: boolean;
}

/* ---------- plugin manager (pluginManager/*) ---------- */

/** Local package display metadata (title/description, locale-resolved). */
export interface PluginLocalizedMetaView {
  title?: LocalizedText;
  description?: LocalizedText;
  [key: string]: unknown;
}

/** Lifecycle state of one plugin entry's root fiber. */
export type PluginFiberPhase = "pending" | "loading" | "active" | "failed" | "unloading" | null;

/** pluginManager/listPlugins row (Loader entry with control handle or reason). */
export interface PluginEntryView {
  entryId: string;
  moduleName: string;
  meta?: PluginLocalizedMetaView;
  enabled: boolean;
  fiberPhase: PluginFiberPhase;
  patchId?: string;
  readOnlyReason?: string;
}

/** One row inside a bundle's composition. */
export interface BundleRowView {
  rowId: string;
  moduleName: string;
  meta?: PluginLocalizedMetaView;
  entryId?: string;
}

/** pluginManager/listBundles row (one profile bundle). Official optional
 *  bundles are listed even when not installed yet (availability tells where
 *  the package lives; installTarget is set only for on-demand packages). */
export interface BundleView {
  name: string;
  version?: string;
  meta?: PluginLocalizedMetaView;
  description?: string;
  enabled: boolean;
  installed: boolean;
  optional: boolean;
  official?: boolean;
  availability?: "installation" | "profile" | "missing";
  installTarget?: { spec: string; version: string };
  source?: string;
  removable: boolean;
  readOnlyReason?: string;
  error?: { code: string; diagnostic?: string; incompatible?: PluginIncompatible[] };
  rows: BundleRowView[];
  overrides: string[];
}

/** pluginManager/registries value. */
export interface PluginRegistriesView {
  registry: string | null;
  fallbackRegistries: string[];
  resolved: string | null;
}

/** One package an `incompatible-version` rejection names (plugin@version vs runtime). */
export interface PluginIncompatible {
  name: string;
  version: string;
  runtimeVersion: string;
  peers: Record<string, string>;
}

/** pluginManager/listVersionExemptions value: "name@version" → accepted runtime versions. */
export interface PluginExemptionsView {
  exemptions: Record<string, string[]>;
  warnings: string[];
}

/** pluginManager/inspect value: accepted spec probe or refused with reason. */
export type PluginInspection =
  | {
      status: "accepted";
      kind: "registry" | "path" | "git" | "tarball";
      name?: string;
      version?: string;
      description?: string;
      bundle: boolean | null;
      registry: string | null;
      host?: string;
    }
  | {
      status: "refused";
      problem:
        | "invalid-spec"
        | "already-installed"
        | "not-found"
        | "not-a-package"
        | "not-a-bundle"
        | "network"
        | "unknown";
      reason: string;
      registries?: (string | null)[];
    };

/** Outcome of one bundle operation (install/enable/remove). */
export interface PluginChangeResult {
  changed: boolean;
  application: "applied" | "restart-required" | "overridden" | "failed" | "cancelled";
  stage: "install" | "enable" | "remove";
  target: string;
  enabled?: boolean;
  version?: string;
  restartReason?: string;
  error?: { code: string; diagnostic?: string; incompatible?: PluginIncompatible[] };
  warnings?: string[];
  pendingBuilds?: string[];
  approvedBuilds?: string[];
  bundle?: string;
  packageResult?: {
    exitCode?: number;
    output?: string;
    truncated?: boolean;
    logPath?: string;
    kind?: string;
    timedOut?: boolean;
    incompatible?: PluginIncompatible[];
  };
  registries?: (string | null)[];
  failedAt?: "registry" | "spec-host";
}

/** plugin-manager/install-state emit payload. */
export interface PluginInstallProgressView {
  requestId: string;
  phase: "installing" | "cancelling" | "applying";
  attempt?: { registry: string | null; index: number; total: number };
}

/** plugin-manager/install-log emit payload (one pnpm log chunk). */
export interface PluginInstallLogView {
  requestId?: string;
  jobId?: string;
  argv?: string[];
  cwd?: string;
  stream: "stdout" | "stderr";
  text: string;
  exitCode?: number | null;
}

/* ---------- plugin inventory (read-only; grouped by agent preset) ---------- */

/** One Loader entry as the official built-in-plugins view lists it. */
export interface PluginInventoryEntry {
  entryId: string;
  moduleName: string;
  meta?: PluginLocalizedMetaView;
  enabled: boolean;
  fiberPhase: PluginFiberPhase;
}

/** One entry row inside an agent preset composition. */
export interface PluginInventoryRow extends PluginInventoryEntry {
  condition?: unknown;
}

/** One agent preset and the entries it composes. */
export interface PluginInventoryPreset {
  id: string;
  name?: string;
  isDefault?: boolean;
  broken?: string;
  rows: PluginInventoryRow[];
}

/** pluginInventory/list value (the official Settings → 内置插件 source). */
export interface PluginInventoryView {
  managementAvailable?: boolean;
  entries: PluginInventoryEntry[];
  agentPresets: PluginInventoryPreset[];
}

/* ---------- plugin market (Discover; pluginMarket/*) ---------- */

/** LocalizedText as DSH stores display copy (string or locale map). */
export type LocalizedText = string | { [locale: string]: string };

/** One configured market index source and the last read's outcome. */
export interface MarketIndexSummary {
  url: string;
  title?: LocalizedText;
  description?: LocalizedText;
  error?: string;
}

/** Result ordering for a market query. */
export type MarketSort =
  | { kind: "index" }
  | { kind: "relevance" }
  | { kind: "published"; direction: "asc" | "desc" }
  | { kind: "key"; id: string; direction: "asc" | "desc" };

/** One page request over one configured index. */
export interface MarketQuery {
  text?: string;
  category?: string;
  labels?: string[];
  sort: MarketSort;
  offset: number;
  limit: number;
  refresh?: boolean;
  fetchedAt?: number;
}

/** How a market plugin relates to this profile. */
export interface MarketInstallation {
  status: string;
  installedVersion?: string;
}

/** One listed version with its compatibility verdict and install target. */
export interface MarketVersionView {
  version: string;
  install?: { spec?: string } & Record<string, unknown>;
  compatibility?: {
    compatible?: boolean;
    runtimeVersion?: string;
    requirements?: Record<string, string>;
    exempted?: boolean;
  };
}

/** One market plugin row. */
export interface MarketEntryView {
  name: string;
  title?: LocalizedText;
  description?: LocalizedText;
  versions: MarketVersionView[];
  defaultVersion?: string;
  installation: MarketInstallation;
  [key: string]: unknown;
}

/** pluginMarket/search value: one page plus the index header. */
export interface MarketSearchResult {
  url: string;
  title?: LocalizedText;
  description?: LocalizedText;
  metadata?: unknown;
  fetchedAt: number;
  entries: MarketEntryView[];
  total: number;
  nextOffset: number | null;
}

/* ---------- agent team (projection `agentTeam` + subagent addressing) ---------- */

/** One team member row (the lead is synthesized by the host). */
export interface AgentTeamMemberView {
  id: string;
  name: string;
  role: "lead" | "teammate";
  phase: "provisioning" | "active" | "failed";
  error?: string;
}

/** One shared task (the projection drops deleted rows and passwords the list). */
export interface AgentTeamTaskView {
  id: string;
  revision?: number;
  subject: string;
  description?: string;
  status: string;
  ownerName?: string;
  blockedBy?: string[];
  writeScopes?: string[];
  ready?: boolean;
  writeScopeWarnings?: string[];
}

/** The `agentTeam` projection unit. */
export interface AgentTeamProjection {
  members: AgentTeamMemberView[];
  tasks: AgentTeamTaskView[];
  failure?: string;
}

/** A session address: a top-level conversation, or a child conversation
 *  addressed through its parent (the official subagent addressing). */
export type SessionAddress =
  | { kind: "session"; sessionId: string }
  | {
      kind: "subagent";
      parentSessionId: string;
      childSessionId: string;
      mode: "one-shot" | "continuable" | "unknown";
    };

/** subagents/prompt value. */
export interface SubagentPromptValue {
  messageId: string;
}
