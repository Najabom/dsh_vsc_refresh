// 唯一主干入口
import * as vscode from "vscode";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativePanelProvider } from "./panel/NativePanelProvider";
import { renderEmbedHtml } from "./panel/embed";
import { DshStatusBar } from "./status";
import { HarnessClient } from "./harness/client";
import { configuredBase, discover, portOf } from "./harness/discover";
import { startHarness, stopHarness, isRunning as harnessRunning, readPidRecord } from "./harness/launcher";
import { ensureWorkspaceAcl, repairWorkspaceAclElevated } from "./harness/workspaceAcl";
import { checkForUpdate, installedDshVersion, installDsh, runDshUpdate, DSH_PACKAGE, type UpdateInfo } from "./harness/updater";
import { fetchReleaseNotes, scanInterfaceAlerts, staticInterfaceCheck } from "./harness/updatePreflight";
import { HarnessEventStream } from "./events/eventStream";
import { ChangeTracker } from "./editor/changeTracker";
import { FollowEdits } from "./editor/followEdits";
import { ExternalChanges } from "./editor/externalChanges";
import { AskSessions } from "./editor/askSessions";
import { buildSelectionContext } from "./editor/askSelection";
import { cleanupTempDirs, reviewFiles } from "./editor/diff";
import type { PanelEvent } from "./panel/protocol";

const POLL_MS = 1000;
const START_TIMEOUT_MS = 30000;
const RIGHT_VIEW = "dsh.sidebar.right";
const MAX_SPAWN_FAILURES = 3; // consecutive auto-spawn failures before giving up this session
const OFFLINE_RECHECK_MS = 15000; // slow poll while down-but-not-our-job (user may start one manually)
const DISCONNECT_RECHECK_MS = 3000; // grace before probing after the event stream drops
// A freshly installed DSH boots cold (npm replaced the whole tree): the 0.2.0
// cold boot took ~45s while warm boots settle in ~15s. The post-update
// restart+verify path therefore waits much longer than the normal startup
// path before it is allowed to call the update a failure.
const RESTART_BOOT_TIMEOUT_MS = 90000;
const VERIFY_RETRY_WINDOW_MS = 45000; // extra retry window for the gateway routes after the port answers

/** Set on deactivate: stops every lifecycle callback from spawning or probing
 *  after the extension is going away (a late timer would otherwise spawn a
 *  detached orphan nobody could ever stop). */
let shuttingDown = false;

export function activate(context: vscode.ExtensionContext): void {
  shuttingDown = false;
  const log = vscode.window.createOutputChannel("DSH Bridge");
  const status = new DshStatusBar();
  const makeLog = (message: string): void => {
    log.appendLine(message);
    console.log("[dsh-vsc]", message); // lands in the exthost log for headless diagnosis
  };
  const tracker = new ChangeTracker();
  const followEdits = new FollowEdits(makeLog);
  const externalChanges = new ExternalChanges(makeLog, (sessionId, turn, files) => {
    const added = tracker.addExternalFiles(sessionId, turn, files);
    for (const file of added) followEdits.revealExternal(file);
  });
  const panelListeners = new Set<(sessionId: string, event: PanelEvent) => void>();
  let client: HarnessClient | null = null;
  let stream: HarnessEventStream | null = null;
  let updatingDsh = false; // an update flow owns the harness lifecycle right now
  let streamOpenWaiter: ((ok: boolean) => void) | null = null; // armed around harness restarts
  // Lifecycle state. `autoStarted` is gone: the watch loop owns auto-start.
  let connecting = false; // a spawn+wait is in flight; prevents double work
  let userStopped = false; // `dsh.stop` asked us not to respawn; cleared by start / reload
  let autoRetryDisabled = false; // too many consecutive spawn failures this session
  let consecutiveSpawnFailures = 0;
  let checkTimer: NodeJS.Timeout | null = null;
  let authNoticeShown = false;

  // Shutdown guard: dispose clears the pending probe so no timer fires after
  // deactivation (deactivate() also flips shuttingDown for the async paths).
  context.subscriptions.push({
    dispose: () => {
      shuttingDown = true;
      if (checkTimer) {
        clearTimeout(checkTimer);
        checkTimer = null;
      }
    },
  });

  const panel = new NativePanelProvider(context, makeLog, () => client, (cb) => panelListeners.add(cb));

  // Dedicated per-workspace ask conversation, shown in its own editor-area
  // split to the side, hugging the existing DSH sidebar (not a bottom panel).
  const askSessions = new AskSessions(context);
  const askProvider = new NativePanelProvider(context, makeLog, () => client, (cb) => panelListeners.add(cb), true);
  let askPanel: vscode.WebviewPanel | null = null;
  const openAskPanel = async (): Promise<boolean> => {
    if (askPanel) {
      askPanel.reveal(undefined, true);
      return true;
    }
    try {
      // Split to the right of the active editor group and drop the ask window
      // into the new side column (adjacent to the DSH sidebar). If the command
      // is unavailable, fall back to a plain side split.
      let column = vscode.ViewColumn.Active;
      try {
        await vscode.commands.executeCommand("workbench.action.newGroupRight");
      } catch {
        column = vscode.ViewColumn.Beside;
      }
      const created = vscode.window.createWebviewPanel(
        "dsh.ask",
        "问题对话",
        { viewColumn: column, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true }
      );
      askPanel = created;
      created.onDidDispose(() => {
        if (askPanel === created) askPanel = null;
        askProvider.onAskWidth = undefined;
      });
      askProvider.attachPanel(created);
      // Match the ask column to the sidebar width: the first self-measured
      // width from the ask webview drives a one-shot split adjustment (a
      // freshly created side column starts at ~50% of the editor area).
      let widthAdjusted = false;
      askProvider.onAskWidth = (px) => {
        if (widthAdjusted) return;
        const side = panel.panelWidthPx();
        if (!side || px <= 0) return;
        widthAdjusted = true;
        if (vscode.window.tabGroups.all.length > 2) {
          log.appendLine("ask window: width match skipped (multi-column layout)");
          return;
        }
        const ratio = side / px;
        if (Math.abs(ratio - 1) <= 0.12) return;
        const frac = Math.min(0.6, Math.max(0.06, 0.5 * ratio));
        void vscode.commands
          .executeCommand("vscode.setEditorLayout", {
            orientation: 0,
            groups: [{ size: 1 - frac }, { size: frac }],
          })
          .then(
            () => log.appendLine(`ask window: width matched sidebar (${px}px → ${Math.round(frac * 100)}%)`),
            (error: unknown) => log.appendLine(`ask window: width adjust failed: ${(error as Error).message}`),
          );
      };
      log.appendLine("ask window: opened");
      return true;
    } catch (error) {
      log.appendLine(`ask window: ${(error as Error).message}`);
      return false;
    }
  };

  log.appendLine("dsh-vsc activated");

  tracker.onBatch((batch) => {
    status.setChanges(tracker.latestFiles().length);
    log.appendLine(`agent turn ${batch.turn} changed ${batch.files.length} file(s): ${batch.files.join(", ")}`);
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RIGHT_VIEW, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    status,
    tracker,
    followEdits,
    externalChanges,
    vscode.commands.registerCommand("dsh.openSidebar", () => {
      void vscode.commands.executeCommand(`${RIGHT_VIEW}.focus`);
    }),
    vscode.commands.registerCommand("dsh.start", () => {
      // Explicit start: clear every "don't respawn" latch and retry for real.
      userStopped = false;
      autoRetryDisabled = false;
      consecutiveSpawnFailures = 0;
      void ensureRunning();
    }),
    vscode.commands.registerCommand("dsh.stop", () => {
      if (harnessRunning()) {
        stopHarness();
        userStopped = true;
        status.setOffline();
        log.appendLine("dsh web stopped (auto-started instance); not respawning until dsh:start or window reload");
      } else {
        void vscode.window.showInformationMessage(
          "DSH Bridge：当前服务不是本扩展启动的（可能是你手动运行的 dsh web）。扩展无权停止它；要彻底停掉请关掉对应的终端。"
        );
      }
    }),
    vscode.commands.registerCommand("dsh.refreshStatus", () => {
  void refresh();

  // Workspace ACL guard: the DSH workspace-write sandbox needs WRITE_OWNER on
  // the workspace root (it stamps a Low integrity label into the SACL) — see
  // harness/workspaceAcl.ts. Repair silently when we can; when the folder is
  // owned by another identity offer the one-time elevated repair. Without
  // this, every sandboxed tool call in such a workspace dies instantly with
  // `grantWrite … Win32 5` and even plain code execution is blocked.
  const guardWorkspaceAcl = (folders: readonly vscode.WorkspaceFolder[] | undefined): void => {
    for (const folder of folders ?? []) {
      void ensureWorkspaceAcl(folder.uri.fsPath, makeLog).then(async (result) => {
        if (result !== "needs-elevation") return;
        const choice = await vscode.window.showWarningMessage(
          `DSH Bridge：工作区「${folder.name}」的目录权限无法自动修复（未授予当前账号完全控制，DSH 沙箱无法在其中运行代码/写文件）。`,
          "以管理员身份修复",
          "忽略"
        );
        if (choice !== "以管理员身份修复") return;
        const fixed = await repairWorkspaceAclElevated(folder.uri.fsPath, makeLog);
        void vscode.window.showInformationMessage(
          fixed
            ? `已修复工作区权限：${folder.name}`
            : `工作区权限修复失败：${folder.name}（详见 “DSH Bridge” 输出日志）`
        );
      });
    }
  };
  guardWorkspaceAcl(vscode.workspace.workspaceFolders);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => guardWorkspaceAcl(e.added))
  );
    }),
    vscode.commands.registerCommand("dsh.openWebView", () => openWebView(context, log)),
    vscode.commands.registerCommand("dsh.askSelection", () => {
      // Dedicated ask flow: the selection context rides a per-workspace
      // question conversation, brought up in its own side split; the intent
      // card lives there. Degrades to the sidebar card if the harness is
      // unreachable mid-resolve.
      void (async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
          void vscode.window.showWarningMessage("DSH: 请先在编辑器里选中要询问的代码。");
          return;
        }
        const harness = client;
        if (!harness) {
          const choice = await vscode.window.showWarningMessage("DSH: harness 未连接。", "启动 harness");
          if (choice === "启动 harness") void vscode.commands.executeCommand("dsh.start");
          return;
        }
        const block = await buildSelectionContext();
        if (block === null) return;
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        // The ask conversation follows the workspace the panel is on (the
        // button-picked folder wins), not the folder of the active file:
        // asks in one project must not land in another project's thread.
        const askCwd = panel.currentWorkspaceCwd() ?? folder?.uri.fsPath;
        try {
          const askSessionId = await askSessions.resolve(harness, askCwd);
          const opened = await openAskPanel();
          if (!opened) throw new Error("问题对话窗口创建失败");
          askProvider.openAskSession(askSessionId);
          askProvider.showAskCard(block);
          panel.scheduleRefresh(200);
        } catch (error) {
          log.appendLine(`ask conversation: ${(error as Error).message}`);
          void vscode.commands.executeCommand(`${RIGHT_VIEW}.focus`).then(() => {
            panel.showAskCard(block);
          });
        }
      })();
    }),
    vscode.commands.registerCommand("dsh.reviewChanges", () => {
      reviewFiles(tracker.latestFiles());
      // The review is open — drop the badge back to the online indicator.
      status.setChanges(0);
    })
  );

  void refresh();

  // Update check: once per window start, delayed so the dialog does not race
  // the harness startup sequence.
  setTimeout(() => void offerDshUpdate(), 5000);

  // Dev-host autotest hook (only when launched with DSH_VSC_AUTOTEST=1): open the
  // right sidebar a few seconds after startup so resolveWebviewView runs and its
  // diagnostics land in the exthost log.
  if (process.env.DSH_VSC_AUTOTEST === "1") {
    setTimeout(() => {
      log.appendLine("[autotest] opening sidebar");
      void vscode.commands.executeCommand(`${RIGHT_VIEW}.focus`);
    }, 4000);
  }

  async function ensureRunning(): Promise<boolean> {
    if (shuttingDown || connecting || updatingDsh) return false;
    // Idempotent start: if something already answers, just (re)connect.
    const before = await discover();
    if (before.alive) {
      await refresh();
      return true;
    }
    if (before.unauthorized) {
      // A stock harness owns the port: our spawn would only hit EADDRINUSE.
      reportUnauthorized(before.base);
      status.setOffline();
      return false;
    }
    connecting = true;
    try {
      const base = configuredBase();
      const port = portOf(base);
      status.setStarting(port);
      panel.setPhase("starting");
      // Same data root as the web GUI (~/.dsh): "one runs, the other watches"
      // means ONE history. Port ownership is the natural exclusivity — the
      // extension's own instance takes the same port the web GUI would use,
      // so the two can never co-write the same log.
      const started = await startHarness(port, log, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
      if (started) await waitUntilAlive(base, START_TIMEOUT_MS);
    } finally {
      connecting = false;
    }
    const d = await discover();
    if (d.alive) {
      consecutiveSpawnFailures = 0;
      await refresh(); // connects, updates the panel, opens the stream
      return true;
    }
    consecutiveSpawnFailures++;
    if (consecutiveSpawnFailures >= MAX_SPAWN_FAILURES) {
      autoRetryDisabled = true;
      status.setOffline();
      log.appendLine(
        `DSH 服务连续 ${MAX_SPAWN_FAILURES} 次启动失败，本次会话不再自动重试（可执行命令 dsh: Start Web Harness 手动重试）`
      );
      // Keep watching (probe-only) so a harness the user starts manually is
      // still discovered — without it the whole chain would go dark.
      scheduleHarnessCheck(OFFLINE_RECHECK_MS);
    } else {
      scheduleHarnessCheck(Math.min(2000 * 2 ** (consecutiveSpawnFailures - 1), 30000));
    }
    return false;
  }

  /** Debounced harness probe: reconnect if it came back, respawn if it died. */
  function scheduleHarnessCheck(delayMs: number): void {
    if (shuttingDown) return;
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      checkTimer = null;
      void checkHarness();
    }, delayMs);
  }

  async function checkHarness(): Promise<void> {
    if (shuttingDown || connecting || updatingDsh) return;
    const d = await discover();
    if (d.alive) {
      await refresh();
      return;
    }
    if (d.unauthorized) {
      reportUnauthorized(d.base);
      status.setOffline();
      log.appendLine(`harness at ${d.base} demands browser-session auth (stock dsh web) — cannot be driven from the extension`);
      scheduleHarnessCheck(OFFLINE_RECHECK_MS);
      return;
    }
    status.setOffline();
    log.appendLine(`no harness at ${d.base}`);
    const autoStart = vscode.workspace.getConfiguration("dshVsc").get<boolean>("autoStart", true);
    if (autoStart && !userStopped && !autoRetryDisabled) {
      void ensureRunning();
    } else {
      // Not our job to respawn right now — keep watching in case the user
      // starts one manually (then the panel recovers on its own).
      scheduleHarnessCheck(OFFLINE_RECHECK_MS);
    }
  }

  /** One clear warning when a stock (non-overlay) harness occupies the port:
   *  we cannot drive it, and we must NOT spawn onto the same port. */
  function reportUnauthorized(base: string): void {
    if (authNoticeShown || shuttingDown) return;
    authNoticeShown = true;
    void vscode.window.showWarningMessage(
      `DSH Bridge：${base} 已有原生 dsh web 在运行（需要浏览器鉴权，扩展无法连接）。` +
        `请关闭它，扩展会自动启动并接管一个受管实例；或改用命令 “dsh: Start Web Harness”。`
    );
  }

  async function refresh(): Promise<void> {
    const d = await discover();
    if (d.alive) {
      client = new HarnessClient(d.base);
      status.setOnline(d.version ?? "?");
      log.appendLine(`harness connected at ${d.base} (version ${d.version})`);
      panel.setClient(client, d.version);
      askProvider.setClient(client, d.version);
      ensureStream(d.base);
      return;
    }
    client = null;
    panel.setClient(null);
    askProvider.setClient(null);
    await checkHarness();
  }

  let streamBase = "";
  function ensureStream(base: string): void {
    if (stream && streamBase === base) return;
    if (stream) {
      // Base changed (config edit / another port): the socket is bound to the
      // old URL — rebuild it against the new harness.
      stream.dispose();
      stream = null;
    }
    streamBase = base;
    stream = new HarnessEventStream(base);
    stream.onSessionEvent = (sessionId, event) => {
      tracker.handleEvent(sessionId, event);
      followEdits.handleEvent(sessionId, event);
      externalChanges.handleEvent(sessionId, event);
      panelListeners.forEach((cb) => cb(sessionId, event as PanelEvent));
    };
    // Control-plane channels (0.1.7): projections, workspace archived set,
    // host emits and answerable waterfalls all ride the same mux socket.
    // Both surfaces run a full provider instance over the same stream (each
    // filters by its own active session host-side).
    stream.onProjection = (sessionId, key, value) => {
      panel.onProjection(sessionId, key, value);
      askProvider.onProjection(sessionId, key, value);
    };
    stream.onWorkspace = (state) => {
      panel.onWorkspace(state);
      askProvider.onWorkspace(state);
    };
    stream.onApiSession = (event, args) => {
      panel.onApiSession(event, args);
      askProvider.onApiSession(event, args);
    };
    stream.onWaterfall = (frame) => {
      panel.onWaterfall(frame);
      askProvider.onWaterfall(frame);
    };
    stream.onWaterfallCancel = (eventId) => {
      panel.onWaterfallCancel(eventId);
      askProvider.onWaterfallCancel(eventId);
    };
    // Each surface decides which session to follow (the mux carries parallel
    // follow streams, so the sidebar and the ask window coexist).
    panel.attachStream({ setFollowSession: (sessionId) => stream?.setFollow("panel", sessionId) });
    askProvider.attachStream({ setFollowSession: (sessionId) => stream?.setFollow("ask", sessionId) });
    stream.onError = (message) => log.appendLine(`event stream: ${message}`);
    stream.onOpen = () => {
      // A restart watchdog (update flow) may be waiting for the WS mux to
      // come back: resolve before anything else can race it.
      if (streamOpenWaiter) {
        const waiter = streamOpenWaiter;
        streamOpenWaiter = null;
        waiter(true);
      }
      // Reconnected (possibly to a fresh harness we respawned): flip status online.
      void discover().then((d) => {
        if (d.alive) status.setOnline(d.version ?? "?");
      });
    };
    stream.onDisconnect = () => {
      // Stream dropped. The stream itself keeps retrying; give it a grace
      // period, then check whether the harness is actually gone and respawn.
      // Only bother while we were connected: once refresh() found the harness
      // down (client === null) the slow OFFLINE_RECHECK poll owns recovery.
      if (client) scheduleHarnessCheck(DISCONNECT_RECHECK_MS);
    };
    stream.start();
    context.subscriptions.push({
      dispose: () => {
        stream?.dispose();
        stream = null;
      },
    });
  }

  /** Restart watchdog: resolves true when the WS mux reconnects within the
   *  window. Armed BEFORE a harness restart so the open event cannot race it. */
  function waitForStreamOpen(timeoutMs: number): Promise<boolean> {
    if (shuttingDown) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        streamOpenWaiter = null;
        resolve(false);
      }, timeoutMs);
      streamOpenWaiter = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
    });
  }

  /** HTTP half of the post-update health check: browser-auth bypass alive and
   *  one real RPC (session/list) through the typert wire contract. */
  async function verifyApiCommunication(): Promise<{ ok: boolean; detail: string }> {
    const base = configuredBase();
    const probe = new HarnessClient(base);
    const state = await probe.probe(3000);
    if (state === "unauthorized") {
      return { ok: false, detail: "API 拒绝访问（浏览器鉴权未被兼容层绕过——overlay 补丁与新版本不匹配）" };
    }
    if (state !== "alive") return { ok: false, detail: "API 探活失败（服务未就绪）" };
    try {
      await probe.listSessions();
    } catch (error) {
      return { ok: false, detail: `RPC 调用失败：${(error as Error).message}` };
    }
    return { ok: true, detail: "" };
  }

  /** The harness may accept connections slightly before its gateway routes are
   *  ready, so a failed check is retried inside a short window instead of
   *  failing the update right away (observed on the 0.2.0 cold boot). An
   *  overlay/auth mismatch is definitive and stops the retry loop. */
  async function verifyWithRetry(windowMs: number): Promise<{ ok: boolean; detail: string }> {
    const deadline = Date.now() + windowMs;
    let last = await verifyApiCommunication();
    while (!last.ok && Date.now() < deadline && !last.detail.startsWith("API 拒绝访问")) {
      log.appendLine(`communication check pending: ${last.detail} — retrying…`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      last = await verifyApiCommunication();
    }
    return last;
  }

  /** Start the harness and prove the extension can still talk to it: HTTP
   *  probe + one RPC + the WS event stream coming back up. A freshly installed
   *  version boots cold (npm replaced the whole tree), so this waits far
   *  longer than the normal startup path before declaring failure. */
  async function restartAndVerify(): Promise<{ ok: boolean; detail: string }> {
    const base = configuredBase();
    const port = portOf(base);
    const eventsWaiter = waitForStreamOpen(RESTART_BOOT_TIMEOUT_MS); // arm before the spawn
    status.setStarting(port);
    panel.setPhase("starting");
    log.appendLine(`restarting harness (${base})…`);
    const started = await startHarness(port, log, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    if (started) await waitUntilAlive(base, RESTART_BOOT_TIMEOUT_MS);
    await refresh();
    const api = await verifyWithRetry(VERIFY_RETRY_WINDOW_MS);
    if (!api.ok) return api;
    const events = await eventsWaiter;
    if (!events) return { ok: false, detail: "事件流（WebSocket mux）未能重新建立" };
    return { ok: true, detail: "" };
  }

  /** Once per window: check the npm registry for a newer DSH; when one exists
   *  ask 立即更新/暂不更新 (a skip is remembered per version). Choosing update
   *  runs the full update → restart → communication-verification flow with an
   *  automatic rollback offer when the new version cannot be driven. */
  async function offerDshUpdate(): Promise<void> {
    if (shuttingDown) return;
    const info = await checkForUpdate(makeLog);
    if (!info || shuttingDown) return;
    const skipped = context.globalState.get<string>("dshVsc.skippedDshVersion");
    if (skipped === info.latest) {
      log.appendLine(`dsh v${info.latest} is available but was skipped before — not asking again`);
      return;
    }

    // Interface preflight: official release notes for (installed, latest] plus
    // a static identifier check of the new version's packages (see
    // harness/updatePreflight.ts). A missing signal only downgrades the dialog
    // copy — the runtime verification after an actual update stays the gate.
    const [notesInfo, staticResult] = await Promise.all([
      fetchReleaseNotes(info.installed, info.latest, makeLog),
      staticInterfaceCheck(info.latest, makeLog),
    ]);
    if (shuttingDown) return;
    const alerts = notesInfo ? scanInterfaceAlerts(notesInfo.notes) : null;
    if (notesInfo) {
      log.appendLine(
        `release notes: interval (${info.installed}, ${info.latest}] = [${notesInfo.versions.join(", ") || "no entries"}]`
      );
      for (const hit of alerts?.hits ?? []) {
        log.appendLine(`release note mention: ${hit.id} (v${hit.versions.join(", ")})`);
      }
    }
    const staticFailed = staticResult.verified && !staticResult.ok;
    const noteHits = alerts?.hits ?? [];
    if (staticFailed || noteHits.length > 0) {
      const parts: string[] = [];
      if (staticFailed) parts.push(`新版本包中缺少接口：${staticResult.missing.join("、")}`);
      if (noteHits.length > 0) {
        parts.push(`官方通告提及：${noteHits.map((h) => `${h.id}（v${h.versions.join(", ")}）`).join("、")}`);
      }
      const choice = await vscode.window.showWarningMessage(
        `DSH 新版本 v${info.latest}（当前 v${info.installed}）接口预检未通过：${parts.join("；")}。` +
          `建议先更新 dsh-vsc 插件适配该版本后再升级 DSH。`,
        "暂不更新（等待插件适配）",
        "仍要更新（自检失败自动回滚）"
      );
      if (choice === "仍要更新（自检失败自动回滚）") {
        await performDshUpdate(info);
      } else {
        // Deliberately NOT remembered: a future plugin update is exactly the
        // thing that changes this verdict, and the user must be asked again.
        log.appendLine(`user deferred dsh ${info.latest} (interface preflight risk)`);
      }
      return;
    }

    const preflightNote =
      staticResult.verified && alerts !== null
        ? "接口预检通过（官方通告未提及本扩展所用接口，新版本包内接口核验存在）。"
        : `接口预检未能完成（${staticResult.verified ? "未能获取官方通告" : "未能下载新版本包核验"}）。`;
    const choice = await vscode.window.showInformationMessage(
      `DSH 有新版本 v${info.latest}（当前 v${info.installed}）。${preflightNote}更新后会自动验证通信兼容性，失败可一键回滚。`,
      "立即更新",
      "暂不更新"
    );
    if (choice === "暂不更新") {
      await context.globalState.update("dshVsc.skippedDshVersion", info.latest);
      log.appendLine(`user chose to skip dsh ${info.latest}`);
      return;
    }
    if (choice !== "立即更新" || shuttingDown) return;
    await performDshUpdate(info);
  }

  async function performDshUpdate(info: UpdateInfo): Promise<void> {
    if (updatingDsh || shuttingDown) return;
    updatingDsh = true;
    try {
      const owned = harnessRunning();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `DSH：正在更新到 v${info.latest}…` },
        async (progress) => {
          if (owned) {
            // Never replace files under a live harness tree.
            log.appendLine("update: stopping the owned harness before npm install");
            await stopHarness();
          }
          progress.report({ message: "npm install -g @deepseek-ai/dsh@latest" });
          const result = await runDshUpdate(makeLog);
          if (!result.ok) {
            void vscode.window.showErrorMessage(
              `DSH 更新失败：${result.error ?? "未知错误"}（详见 “DSH Bridge” 输出日志）`
            );
            if (owned && !shuttingDown) {
              // Put the previous version back in service.
              const back = await restartAndVerify();
              if (!back.ok) log.appendLine(`harness restart after failed update: ${back.detail}`);
            }
            return;
          }
          const newVersion = (await installedDshVersion()) ?? info.latest;
          log.appendLine(`update: npm install finished, installed version is now ${newVersion}`);
          if (!owned) {
            void vscode.window.showInformationMessage(
              `DSH 已更新到 v${newVersion}。当前运行中的实例不是本扩展启动的，需其自行重启后新版本才会生效。`
            );
            return;
          }
          progress.report({ message: "重启 harness 并验证通信…" });
          const verdict = await restartAndVerify();
          if (verdict.ok) {
            log.appendLine(`update: communication verified on v${newVersion}`);
            void vscode.window.showInformationMessage(
              `DSH 已更新到 v${newVersion}，通信验证通过（API 与事件流均正常）。`
            );
            return;
          }
          const rollbackLabel = `回滚到 v${info.installed}`;
          const choice = await vscode.window.showWarningMessage(
            `DSH 已更新到 v${newVersion}，但通信验证失败：${verdict.detail}。` +
              `新版本可能变更了协议或鉴权行为（扩展的兼容层尚未适配）。`,
            rollbackLabel,
            "保持新版本"
          );
          if (choice !== rollbackLabel) return;
          log.appendLine(`update: rolling back to v${info.installed}`);
          progress.report({ message: `回滚到 v${info.installed}…` });
          await stopHarness();
          const back = await installDsh(`${DSH_PACKAGE}@${info.installed}`, makeLog);
          if (!back.ok) {
            void vscode.window.showErrorMessage(
              `回滚失败：${back.error ?? "未知错误"}（详见 “DSH Bridge” 输出日志）`
            );
            return;
          }
          const verdict2 = await restartAndVerify();
          void vscode.window.showInformationMessage(
            verdict2.ok
              ? `已回滚到 v${info.installed}，通信恢复正常。`
              : `已回滚到 v${info.installed}，但通信仍异常：${verdict2.detail}（详见 “DSH Bridge” 输出日志）`
          );
        }
      );
    } finally {
      updatingDsh = false;
      // Hand the lifecycle back to the normal watch loop (respawn/reconnect
      // decisions if anything above left the harness down).
      scheduleHarnessCheck(DISCONNECT_RECHECK_MS);
    }
  }

  async function waitUntilAlive(base: string, timeoutMs: number): Promise<void> {
    const probe = new HarnessClient(base);
    const started = Date.now();
    const deadline = started + timeoutMs;
    let lastNote = started;
    while (Date.now() < deadline) {
      if (await probe.isAlive(800)) return;
      if (Date.now() - lastNote >= 10000) {
        lastNote = Date.now();
        log.appendLine(
          `harness at ${base} is still booting (${Math.round((Date.now() - started) / 1000)}s elapsed)…`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    log.appendLine(`harness at ${base} did not answer within ${timeoutMs / 1000}s (the watch loop will keep trying)`);
  }
}

/** Optional full DSH web GUI as an editor tab (the embed, demoted from main surface). */
function openWebView(context: vscode.ExtensionContext, log: vscode.OutputChannel): void {
  const panel = vscode.window.createWebviewPanel("dsh.webview", "DSH (Web)", vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "media")],
  });
  try {
    panel.webview.html = renderEmbedHtml(panel.webview, configuredBase(), context);
  } catch (error) {
    log.appendLine(`openWebView render failed: ${(error as Error).message}`);
  }
}

const DEACTIVATE_LOG = join(tmpdir(), "dsh-vsc-deactivate.log");

function logDeactivate(line: string): void {
  try {
    fs.appendFileSync(DEACTIVATE_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break shutdown */
  }
}

/**
 * Shutdown of the harness THIS extension spawned (live handle, or the pid
 * record left by a previous session after an extension reload). A
 * pre-existing/shared harness is never killed.
 *
 * dsh 0.1.7 removed host.describe — and with it the clientCount reference
 * count that used to tell us "a browser tab is still attached, leave it
 * running". With no way to ask, the owned instance (windowless, detached, no
 * UI of its own) is stopped deterministically: an orphan would outlive its
 * owner with nothing left to shut it down.
 */
export function deactivate(): Promise<void> {
  shuttingDown = true;
  // Older temp diff dirs would otherwise accumulate one per reviewed file.
  cleanupTempDirs();
  logDeactivate("deactivate called");
  const owned = harnessRunning();
  const record = readPidRecord();
  logDeactivate(`owned=${owned} pidRecord=${JSON.stringify(record)}`);
  if (!owned) {
    logDeactivate("shared or no harness — nothing to stop");
    return Promise.resolve();
  }
  logDeactivate("stopping owned instance");
  return stopHarness().then((result) => {
    logDeactivate(`stopHarness -> ${JSON.stringify(result)}`);
  });
}
