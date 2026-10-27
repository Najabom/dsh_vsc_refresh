import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { release as osRelease, tmpdir } from "node:os";
import { join } from "node:path";
import type { CompatibilityReport } from "./harness/capabilities";

/** Facts the panel provider can report without exposing internals. */
export interface PanelDiagnostics {
  phase: string;
  connected: boolean;
  dshVersion?: string;
  activeSessionId: string | null;
  sessions: number;
  viewReady: boolean;
  lastPongAgeMs: number | null;
  panelWidth?: number;
  capabilities?: CompatibilityReport | null;
}

export interface DiagnosticsFacts extends PanelDiagnostics {
  baseUrl: string;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "(missing)";
  }
}

/** Build the Markdown report the "DSH: Export Diagnostics" command saves.
 *  Deliberately free of credentials: the extension never logs tokens, and the
 *  message bodies are not included. */
export function buildDiagnostics(
  context: vscode.ExtensionContext,
  facts: DiagnosticsFacts,
  logLines: string[]
): string {
  const pkg = (context.extension.packageJSON ?? {}) as { version?: string };
  const heartbeat = join(tmpdir(), "dsh-vsc-clients", `${process.pid}.json`);
  const record = join(tmpdir(), "dsh-vsc-harness.pid");
  return [
    "# DSH Bridge diagnostics",
    "",
    `- time: ${new Date().toISOString()}`,
    `- extension: ${pkg.version ?? "?"}`,
    `- vscode: ${vscode.version}`,
    `- os: ${process.platform} ${process.arch} (${osRelease()})`,
    `- node: ${process.version}`,
    `- base url: ${facts.baseUrl}`,
    `- phase: ${facts.phase} (connected=${facts.connected})`,
    `- DSH version: ${facts.dshVersion ?? "unknown"}`,
    `- active session: ${facts.activeSessionId ?? "-"} (sessions=${facts.sessions})`,
    `- webview: ready=${facts.viewReady} lastPongAge=${
      facts.lastPongAgeMs === null ? "-" : `${Math.round(facts.lastPongAgeMs / 1000)}s`
    } width=${facts.panelWidth ?? "-"}`,
    "",
    "## Compatibility",
    "",
    "```json",
    JSON.stringify(facts.capabilities ?? null, null, 2),
    "```",
    "",
    "## Harness record",
    "",
    "```json",
    readText(record),
    "```",
    "",
    "## This window heartbeat",
    "",
    "```json",
    readText(heartbeat),
    "```",
    "",
    "## Log (tail)",
    "",
    "```text",
    logLines.slice(-300).join("\n"),
    "```",
    "",
  ].join("\n");
}
