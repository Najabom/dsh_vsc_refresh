// 唯一主干入口
import * as vscode from "vscode";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { NativePanelProvider } from "./panel/NativePanelProvider";
import { renderEmbedHtml } from "./panel/embed";
import { DshStatusBar } from "./status";
import { HarnessClient } from "./harness/client";
import { syncCompanion, type CompanionStatus } from "./harness/companion";
import { configuredBase, discover, portOf } from "./harness/discover";
import { startHarness, stopHarness, isRunning as harnessRunning, readPidRecord } from "./harness/launcher";
import { isLocalBase, liveOtherClients, pruneStale, removeHeartbeat, writeHeartbeat } from "./harness/clientRegistry";
import { CapabilityLedger } from "./harness/capabilities";
import { setNativeWebAuthEnabled } from "./harness/nativeAuth";
import { ensureWorkspaceAcl, repairWorkspaceAclElevated } from "./harness/workspaceAcl";
import {
  checkForUpdateDetailed,
  installedDshVersion,
  installDsh,
  runDshUpdate,
  DSH_PACKAGE,
  type DshUpdateChannel,
  type UpdateInfo,
} from "./harness/updater";
import {
  checkPluginUpdate,
  cleanupUpdateTemp,
  installedPluginVersion,
  installPluginUpdate,
  restartHost,
} from "./harness/pluginUpdater";
import { fetchReleaseNotes, scanInterfaceAlerts, staticInterfaceCheck } from "./harness/updatePreflight";
import { HarnessEventStream } from "./events/eventStream";
import { ChangeTracker } from "./editor/changeTracker";
import { FollowEdits } from "./editor/followEdits";
import { ExternalChanges } from "./editor/externalChanges";
import { AskSessions } from "./editor/askSessions";
import { buildSelectionContext } from "./editor/askSelection";
import { cleanupTempDirs, reviewFiles } from "./editor/diff";
import { buildDiagnostics } from "./diagnostics";
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
const DSH_UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000; // long-running windows must not miss releases

/** Set on deactivate: stops every lifecycle callback from spawning or probing
 *  after the extension is going away (a late timer would otherwise spawn a
 *  detached orphan nobody could ever stop). */
let shuttingDown = false;
/** Recent log lines for the one-click diagnostics export (never contains secrets). */
const LOG_RING: string[] = [];

/**
 * Multi-window liveness: this window writes an adaptive heartbeat (via
 * clientRegistry) naming the harness base it is connected to — 30s while the
 * window is focused, 120s in the background, plus an immediate write on every
 * focus change and session activity. Shutdown uses it to tell "other windows
 * still need the service" (leave it) apart from "we are the last one" (stop
 * it), and dist/harness-guard.mjs uses the same files to clean up after an
 * all-windows crash.
 */
let heartbeatTimer: NodeJS.Timeout | undefined;
let heartbeatBase: string | undefined;
let lastBeatAt = 0;
const HEARTBEAT_FOCUSED_MS = 30_000;
const HEARTBEAT_IDLE_MS = 120_000;
const HEARTBEAT_MIN_WRITE_MS = 10_000;
/** DSH version/compatibility ledger for the current connection. */
const capabilities = new CapabilityLedger();

export function activate(context: vscode.ExtensionContext): void {
  shuttingDown = false;
  const log = vscode.window.createOutputChannel("DSH Bridge");
  const status = new DshStatusBar();
  // Fallback entry when the activity-bar icon gets hidden (right-click → hide
  // is per-window UI state that the extension cannot detect or undo).
  const statusEntry = vscode.window.createStatusBarItem("dsh.sidebar", vscode.StatusBarAlignment.Right, 100);
  const UPDATE_TIP_BASE = "打开 DSH 面板（活动栏图标被隐藏时的入口）";
  let updateTip = "";
  const setUpdateTip = (note: string): void => {
    updateTip = note;
    statusEntry.tooltip = updateTip ? `${UPDATE_TIP_BASE}\n${updateTip}` : UPDATE_TIP_BASE;
  };
  statusEntry.name = "DSH";
  statusEntry.text = "$(comment-discussion) DSH";
  statusEntry.tooltip = UPDATE_TIP_BASE;
  statusEntry.command = "dsh.openSidebar";
  const syncStatusEntry = (): void => {
    const enabled = vscode.workspace.getConfiguration("dshVsc").get<boolean>("statusBarEntry", true);
    if (enabled) statusEntry.show();
    else statusEntry.hide();
  };
  syncStatusEntry();
  const syncNativeWebAuth = (): void => {
    setNativeWebAuthEnabled(vscode.workspace.getConfiguration("dshVsc").get<boolean>("nativeWebAuth", true));
  };
  syncNativeWebAuth();
  context.subscriptions.push(statusEntry);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dshVsc.statusBarEntry")) syncStatusEntry();
      if (e.affectsConfiguration("dshVsc.nativeWebAuth")) syncNativeWebAuth();
    })
  );
  const makeLog = (message: string): void => {
    log.appendLine(message);
    console.log("[dsh-vsc]", message); // lands in the exthost log for headless diagnosis
    // Ring buffer for the diagnostics export (last 500 lines, no secrets are
    // ever logged by this extension).
    LOG_RING.push(`${new Date().toISOString()} ${message}`);
    if (LOG_RING.length > 500) LOG_RING.splice(0, LOG_RING.length - 500);
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
  let dshUpdateTimer: NodeJS.Timeout | null = null;
  let lastDshUpdateCheckAt = 0;
  // Adaptive liveness heartbeat: focused windows beat every 30s, background
  // windows every 120s; a focus change or real activity writes immediately so
  // the guard never has to infer more than "no window has spoken recently".
  const scheduleHeartbeat = (): void => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    const delay = vscode.window.state.focused ? HEARTBEAT_FOCUSED_MS : HEARTBEAT_IDLE_MS;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      if (!heartbeatBase) return;
      lastBeatAt = Date.now();
      pruneStale();
      writeHeartbeat(heartbeatBase);
      scheduleHeartbeat();
    }, delay);
  };
  /** Write a heartbeat now (real activity/focus), rate-limited unless forced. */
  const beatNow = (force = false): void => {
    if (!heartbeatBase) return;
    const now = Date.now();
    if (!force && now - lastBeatAt < HEARTBEAT_MIN_WRITE_MS) {
      if (!heartbeatTimer) scheduleHeartbeat();
      return;
    }
    lastBeatAt = now;
    pruneStale();
    writeHeartbeat(heartbeatBase);
    scheduleHeartbeat();
  };
  context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) beatNow(true);
    else scheduleHeartbeat();
  }));
  context.subscriptions.push({
    dispose: () => {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    },
  });
  let authNoticeShown = false;
  // Companion bundle (companion/dsh-vsc-companion): synced into profile
  // storage through the official plugin manager whenever the VSIX copy
  // changes. A fresh install/update needs a harness restart to load, which
  // we perform only while every session is idle.
  let companionStatus: CompanionStatus = { state: "unknown" };
  let companionSyncedClient: HarnessClient | null = null;
  let companionSyncRunning = false;
  let pendingCompanionRestart = false;
  let companionRestartInFlight = false;
  const busySessions = new Set<string>();

  // Shutdown guard: dispose clears the pending probe so no timer fires after
  // deactivation (deactivate() also flips shuttingDown for the async paths).
  context.subscriptions.push({
    dispose: () => {
      shuttingDown = true;
      if (checkTimer) {
        clearTimeout(checkTimer);
        checkTimer = null;
      }
      if (dshUpdateTimer) {
        clearInterval(dshUpdateTimer);
        dshUpdateTimer = null;
      }
    },
  });

  const panel = new NativePanelProvider(context, makeLog, () => client, (cb) => panelListeners.add(cb), false, {
    // Settings-page update center: the extension owns the GitHub/CLI side so
    // the provider only drives phases and status lines.
    updateCenter: {
      installedVersion: installedPluginVersion,
      check: () => checkPluginUpdate(makeLog),
      install: () => installPluginUpdate(makeLog),
      restart: restartHost,
    },
    dshUpdates: {
      installedVersion: async () => (await installedDshVersion()) ?? "",
      check: (channel) => checkForUpdateDetailed(makeLog, channel as DshUpdateChannel),
      update: async () => {
        const ok = await vscode.commands.executeCommand<boolean>("dsh.updateDsh");
        if (!ok) throw new Error("DSH 更新未完成（详见 “DSH Bridge” 输出日志）");
      },
    },
  });

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
    vscode.commands.registerCommand("dsh.reloadPanel", () => {
      // Escape hatch for a wedged webview (e.g. after a monitor disconnect the
      // render surface can stay blank even though the harness is healthy).
      panel.reloadWebview("手动重载");
      askProvider.reloadWebview("手动重载");
    }),
    vscode.commands.registerCommand("dsh.exportDiagnostics", async () => {
      // One-click support bundle: versions, connection phase, compatibility
      // report, harness/heartbeat records and the log tail. No credentials
      // (the extension never logs tokens or message bodies).
      const facts = { baseUrl: configuredBase(), ...panel.diagnosticsFacts() };
      const content = buildDiagnostics(context, facts, LOG_RING);
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(folder ?? vscode.Uri.file(homedir()), `dsh-vsc-diagnostics-${stamp}.md`),
        filters: { Markdown: ["md"] },
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
      const open = await vscode.window.showInformationMessage("诊断报告已保存", "打开");
      if (open === "打开") void vscode.commands.executeCommand("vscode.open", target);
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      // Display reconnect usually lands as a focus event; probe both surfaces.
      panel.nudge();
      askProvider.nudge();
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
    }),
    vscode.commands.registerCommand("dsh.checkDshUpdates", () => {
      // Manual check from the settings page / palette: lift the throttle.
      lastDshUpdateCheckAt = 0;
      void offerDshUpdate();
    }),
    vscode.commands.registerCommand("dsh.updateDsh", async (): Promise<boolean> => {
      const channel = dshUpdateChannel();
      const info = await checkForUpdateDetailed(makeLog, channel);
      if (info.kind === "update") {
        return performDshUpdate(info);
      }
      if (info.kind === "uptodate") {
        void vscode.window.showInformationMessage(
          `DSH 已是最新版本（${info.installed ?? "?"}，通道 ${info.channel ?? channel}）。${info.detail ?? ""}`
        );
        return true;
      }
      void vscode.window.showWarningMessage(`检查 DSH 更新失败：${info.detail ?? "未知错误"}`);
      return false;
    })
  );

  void refresh();

  // DSH update check: once per window start (delayed so the dialog does not
  // race the harness startup sequence), then every 6 hours — a window left
  // open for days must not keep reporting the release it booted with. The
  // channel setting decides which release line is compared (see updater.ts).
  setTimeout(() => void offerDshUpdate(), 5000);
  dshUpdateTimer = setInterval(() => void offerDshUpdate(), DSH_UPDATE_RECHECK_MS);

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
      `DSH Bridge：${base} 已有原生 dsh web 在运行，但无法自动鉴别（本机凭据不可用，或 dshVsc.nativeWebAuth 已关闭）。` +
        `请关闭它，扩展会自动启动并接管一个受管实例；或改用命令 “dsh: Start Web Harness”。`
    );
  }

  async function refresh(): Promise<void> {
    const d = await discover();
    if (d.alive) {
      client = new HarnessClient(d.base);
      client.onProtocolError = (method, code, message) => {
        if (!capabilities.recordError(method, code, message)) return;
        const report = capabilities.report();
        log.appendLine(`compat: ${method} failed (${code}) — ${message}`);
        panel.setCapabilities(report);
        askProvider.setCapabilities(report);
      };
      capabilities.setVersion(d.version ?? "");
      status.setOnline(d.version ?? "?");
      log.appendLine(`harness connected at ${d.base} (version ${d.version})`);
      panel.setClient(client, d.version);
      askProvider.setClient(client, d.version);
      panel.setCapabilities(capabilities.report());
      askProvider.setCapabilities(capabilities.report());
      ensureStream(d.base);
      // Liveness: name ourselves for this base now and every 5s (covers the
      // "which window is still using the shared harness" decision in
      // deactivate, and the guard's crash cleanup).
      heartbeatBase = d.base;
      beatNow(true);
      void runCompanionSync();
      return;
    }
    client = null;
    panel.setClient(null);
    askProvider.setClient(null);
    await checkHarness();
  }

  /** Install/upgrade the VSIX-shipped companion bundle through the official
   *  plugin manager; restart the owned harness (when idle) so it loads. */
  async function runCompanionSync(): Promise<void> {
    const harness = client;
    if (!harness || shuttingDown) return;
    if (companionSyncRunning || companionSyncedClient === harness) return;
    companionSyncRunning = true;
    try {
      const enabled = vscode.workspace.getConfiguration("dshVsc").get<boolean>("companion", true);
      if (!enabled) {
        companionStatus = { state: "disabled" };
        panel.setCompanionStatus(companionStatus);
        return;
      }
      const previous = companionStatus;
      const result = await syncCompanion({
        extensionPath: context.extensionPath,
        storageDir: context.globalStorageUri.fsPath,
        client: harness,
      });
      companionStatus = result;
      panel.setCompanionStatus(companionStatus);
      if (
        (result.state === "installed" || result.state === "updated") &&
        (previous.state !== result.state || previous.installedVersion !== result.installedVersion)
      ) {
        log.appendLine(
          `companion ${result.state}: ${result.installedVersion ?? "?"} (bundled ${result.bundledVersion ?? "?"})`
        );
        if (harnessRunning()) {
          if (busySessions.size === 0) void restartHarnessForCompanion();
          else {
            pendingCompanionRestart = true;
            log.appendLine("companion: harness busy — restart deferred until every turn ends");
          }
        } else {
          void vscode.window.showInformationMessage(
            "DSH Bridge：配套插件（任务清单 + 页面截图工具）已安装；重启 DSH 服务后生效。"
          );
        }
      }
    } catch (error) {
      companionStatus = { state: "error", message: (error as Error).message };
      panel.setCompanionStatus(companionStatus);
      log.appendLine(`companion sync failed: ${(error as Error).message}`);
    } finally {
      companionSyncRunning = false;
      companionSyncedClient = harness;
    }
  }

  async function restartHarnessForCompanion(): Promise<void> {
    if (companionRestartInFlight || shuttingDown) return;
    companionRestartInFlight = true;
    pendingCompanionRestart = false;
    try {
      log.appendLine("companion: restarting the owned harness to load the bundle");
      await stopHarness();
      await ensureRunning();
    } finally {
      companionRestartInFlight = false;
    }
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
      beatNow();
      tracker.handleEvent(sessionId, event);
      followEdits.handleEvent(sessionId, event);
      externalChanges.handleEvent(sessionId, event);
      if (event.type === "turn/start") busySessions.add(sessionId);
      else if (event.type === "turn/end") {
        busySessions.delete(sessionId);
        if (pendingCompanionRestart && busySessions.size === 0) void restartHarnessForCompanion();
      }
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
    panel.attachStream({ setFollowSession: (target) => stream?.setFollow("panel", target) });
    askProvider.attachStream({ setFollowSession: (target) => stream?.setFollow("ask", target) });
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
      // The harness may have been upgraded by another window or by hand since
      // this window started — re-check the release line (throttled inside
      // offerDshUpdate, so a flapping socket cannot hammer the registry).
      void offerDshUpdate();
    };
    stream.onDisconnect = () => {
      // Stream dropped. The stream itself keeps retrying; give it a grace
      // period, then check whether the harness is actually gone and respawn.
      // Only bother while we were connected: once refresh() found the harness
      // down (client === null) the slow OFFLINE_RECHECK poll owns recovery.
      busySessions.clear();
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

  /** Throttle shared by the startup check, the 6h timer and every reconnect:
   *  a long-lived window must not miss releases, but a flapping harness must
   *  not hammer the registry either. */
  const DSH_UPDATE_THROTTLE_MS = 30 * 60 * 1000;

  function dshUpdateChannel(): DshUpdateChannel {
    const value = vscode.workspace.getConfiguration("dshVsc").get<string>("dshUpdateChannel", "auto");
    return value === "stable" || value === "next" || value === "alpha" ? value : "auto";
  }

  /** Ask the npm registry for the newest DSH on the tracked channel and, when
   *  one exists, offer 立即更新/暂不更新 (a skip is remembered per version).
   *  Choosing update runs the full update → restart → verification flow with a
   *  rollback offer when the new version cannot be driven. */
  async function offerDshUpdate(): Promise<void> {
    if (shuttingDown || updatingDsh) return;
    const now = Date.now();
    if (now - lastDshUpdateCheckAt < DSH_UPDATE_THROTTLE_MS) return;
    lastDshUpdateCheckAt = now;
    const channel = dshUpdateChannel();
    const info = await checkForUpdateDetailed(makeLog, channel);
    if (shuttingDown) return;
    const stamp = new Date().toLocaleTimeString();
    if (info.kind === "error") {
      log.appendLine(`update check failed: ${info.detail ?? "unknown error"}`);
      setUpdateTip(`上次更新检测失败（${stamp}）：${info.detail ?? "未知错误"}`);
      return;
    }
    if (info.kind !== "update") {
      setUpdateTip(`DSH 已是最新版本（${stamp}，通道 ${info.channel ?? channel}）`);
      return;
    }
    setUpdateTip(`发现 DSH 新版本 v${info.latest}（${stamp}，通道 ${info.channel ?? channel}）`);
    const installed = info.installed;
    const latest = info.latest;
    if (!installed || !latest) return;
    const skipped = context.globalState.get<string>("dshVsc.skippedDshVersion");
    if (skipped === latest) {
      log.appendLine(`dsh v${latest} is available but was skipped before — not asking again`);
      return;
    }

    // Interface preflight: official release notes for (installed, latest] plus
    // a static identifier check of the new version's packages (see
    // harness/updatePreflight.ts). A missing signal only downgrades the dialog
    // copy — the runtime verification after an actual update stays the gate.
    const [notesInfo, staticResult] = await Promise.all([
      fetchReleaseNotes(installed, latest, makeLog),
      staticInterfaceCheck(latest, makeLog),
    ]);
    if (shuttingDown) return;
    const alerts = notesInfo ? scanInterfaceAlerts(notesInfo.notes) : null;
    if (notesInfo) {
      log.appendLine(
        `release notes: interval (${installed}, ${latest}] = [${notesInfo.versions.join(", ") || "no entries"}]`
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
        `DSH 新版本 v${latest}（当前 v${installed}，通道 ${info.channel ?? channel}）接口预检未通过：${parts.join("；")}。` +
          `建议先更新 dsh-vsc 插件适配该版本后再升级 DSH。`,
        "暂不更新（等待插件适配）",
        "仍要更新（自检失败自动回滚）"
      );
      if (choice === "仍要更新（自检失败自动回滚）") {
        await performDshUpdate(info);
      } else {
        // Deliberately NOT remembered: a future plugin update is exactly the
        // thing that changes this verdict, and the user must be asked again.
        log.appendLine(`user deferred dsh ${latest} (interface preflight risk)`);
      }
      return;
    }

    const preflightNote =
      staticResult.verified && alerts !== null
        ? "接口预检通过（官方通告未提及本扩展所用接口，新版本包内接口核验存在）。"
        : `接口预检未能完成（${staticResult.verified ? "未能获取官方通告" : "未能下载新版本包核验"}）。`;
    const choice = await vscode.window.showInformationMessage(
      `DSH 有新版本 v${latest}（当前 v${installed}，通道 ${info.channel ?? channel}）。${preflightNote}更新后会自动验证通信兼容性，失败可一键回滚。`,
      "立即更新",
      "暂不更新"
    );
    if (choice === "暂不更新") {
      await context.globalState.update("dshVsc.skippedDshVersion", latest);
      log.appendLine(`user chose to skip dsh ${latest}`);
      return;
    }
    if (choice !== "立即更新" || shuttingDown) return;
    await performDshUpdate(info);
  }

  async function performDshUpdate(info: UpdateInfo): Promise<boolean> {
    if (updatingDsh || shuttingDown) return false;
    const target = info.latest;
    const previous = info.installed ?? "?";
    if (!target) return false;
    updatingDsh = true;
    let outcome = true;
    try {
      const owned = harnessRunning();
      if (!owned && client) {
        // A live harness we did not start: npm would hit EBUSY on locked
        // koffi/worker files, and the new version could not take effect until
        // that process restarts anyway. Distinguish "another VS Code window
        // owns it" (heartbeat registry) from a truly external `dsh web` so the
        // advice matches the situation.
        const others = isLocalBase(configuredBase()) ? liveOtherClients(configuredBase()) : [];
        void vscode.window.showWarningMessage(
          others.length > 0
            ? `另一个 VS Code 窗口正在使用此 dsh（心跳进程 ${others.join(", ")}）。请先关闭那个窗口再更新，否则会因文件占用失败。`
            : "检测到正在运行的 dsh（不是本扩展启动的）。请先停止它，再重试更新：更新需要替换它正在使用的文件，否则会因文件占用失败。"
        );
        outcome = false;
        return false;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `DSH：正在更新到 v${target}…` },
        async (progress) => {
          if (owned) {
            // Never replace files under a live harness tree.
            log.appendLine("update: stopping the owned harness before npm install");
            await stopHarness();
          }
          progress.report({ message: `npm install -g @deepseek-ai/dsh@${target}` });
          const result = await runDshUpdate(makeLog, target);
          if (!result.ok) {
            outcome = false;
            // A failed npm run can leave a half-installed tree behind (npm
            // rolls back most of the time, but not after EBUSY/late failures).
            // Put the previous version back before restarting anything.
            let recovery = "";
            const nowInstalled = await installedDshVersion();
            if (nowInstalled && previous !== "?" && nowInstalled !== previous) {
              log.appendLine(
                `update: install left ${nowInstalled} in place (wanted ${previous}); restoring the previous version`
              );
              const restored = await installDsh(`${DSH_PACKAGE}@${previous}`, makeLog);
              recovery = restored.ok
                ? `已恢复到 v${previous}。`
                : `自动恢复失败，请手动执行 npm i -g ${DSH_PACKAGE}@${previous}。`;
              log.appendLine(
                restored.ok
                  ? `update: rolled back to ${previous}`
                  : `update: rollback to ${previous} failed: ${restored.error ?? "unknown"}`
              );
            }
            void vscode.window.showErrorMessage(
              `DSH 更新失败：${result.error ?? "未知错误"}${recovery ? ` ${recovery}` : ""}（详见 “DSH Bridge” 输出日志）`
            );
            if (owned && !shuttingDown) {
              // Put the previous version back in service.
              const back = await restartAndVerify();
              if (!back.ok) log.appendLine(`harness restart after failed update: ${back.detail}`);
            }
            return;
          }
          const newVersion = (await installedDshVersion()) ?? target;
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
          const rollbackLabel = `回滚到 v${previous}`;
          const choice = await vscode.window.showWarningMessage(
            `DSH 已更新到 v${newVersion}，但通信验证失败：${verdict.detail}。` +
              `新版本可能变更了协议或鉴权行为（扩展的兼容层尚未适配）。`,
            rollbackLabel,
            "保持新版本"
          );
          if (choice !== rollbackLabel) return;
          log.appendLine(`update: rolling back to v${previous}`);
          progress.report({ message: `回滚到 v${previous}…` });
          await stopHarness();
          const back = await installDsh(`${DSH_PACKAGE}@${previous}`, makeLog);
          if (!back.ok) {
            outcome = false;
            void vscode.window.showErrorMessage(
              `回滚失败：${back.error ?? "未知错误"}（详见 “DSH Bridge” 输出日志）`
            );
            return;
          }
          const verdict2 = await restartAndVerify();
          void vscode.window.showInformationMessage(
            verdict2.ok
              ? `已回滚到 v${previous}，通信恢复正常。`
              : `已回滚到 v${previous}，但通信仍异常：${verdict2.detail}（详见 “DSH Bridge” 输出日志）`
          );
        }
      );
    } finally {
      updatingDsh = false;
      // Hand the lifecycle back to the normal watch loop (respawn/reconnect
      // decisions if anything above left the harness down).
      scheduleHarnessCheck(DISCONNECT_RECHECK_MS);
    }
    return outcome;
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
 * Multi-window rules (several VS Code windows share ONE harness on the same
 * port + ~/.dsh):
 * - First drop our heartbeat file so we no longer count ourselves.
 * - If any OTHER live window (fresh heartbeat, alive pid) is connected to the
 *   same local base, leave the harness running — closing one of several
 *   windows must not take the service away from the others.
 * - Otherwise stop the owned instance (windowless, detached spawn owned by
 *   this extension; an orphan would outlive its owner).
 *
 * All-windows-crash cleanup is NOT here (no deactivate runs then): the
 * dist/harness-guard.mjs wrapper spawned in front of `dsh web` kills the tree
 * ~45s after the last heartbeat went stale.
 */
export function deactivate(): Promise<void> {
  shuttingDown = true;
  // Older temp diff dirs would otherwise accumulate one per reviewed file.
  cleanupTempDirs();
  // Downloaded update VSIX files: one temp dir per version.
  cleanupUpdateTemp();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  removeHeartbeat(); // leave the liveness set BEFORE deciding
  const base = heartbeatBase;
  heartbeatBase = undefined;
  logDeactivate("deactivate called");
  const owned = harnessRunning();
  const record = readPidRecord();
  logDeactivate(`owned=${owned} pidRecord=${JSON.stringify(record)} base=${base ?? "(none)"}`);
  if (!owned) {
    logDeactivate("shared or no harness — nothing to stop");
    return Promise.resolve();
  }
  if (base && isLocalBase(base)) {
    const others = liveOtherClients(base);
    if (others.length > 0) {
      logDeactivate(`leaving shared harness alive — other dsh-vsc windows: ${others.join(", ")}`);
      return Promise.resolve();
    }
  }
  logDeactivate("stopping owned instance (last live dsh-vsc window)");
  return stopHarness().then((result) => {
    logDeactivate(`stopHarness -> ${JSON.stringify(result)}`);
  });
}
