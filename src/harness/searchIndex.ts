/**
 * Opt-in for DSH full-text session search.
 *
 * DSH ships with the session-query-sqlite row patched to `openAt: never`
 * (both the base and the Web bundle), so `session/search` fails with
 * SESSION_QUERY_SEARCH_DISABLED. The only supported way in is a later patch
 * layer that restates the row's config with `openAt: first-search`; the
 * user's profile `cordis.patch.yml` is applied last, so the settings card
 * edits exactly that file.
 *
 * The index path stays at the official Web default (":memory:"): the index
 * is rebuilt on demand from the append-only session logs, so it can never go
 * stale relative to the logs. Writes are idempotent, keep the file's line
 * endings, and leave a .dshbridge.bak copy behind before the first change.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SessionSearchProfileState {
  profile: string;
  file: string;
  exists: boolean;
  enabled: boolean;
}

export interface SessionSearchConfigState {
  home: string;
  profiles: SessionSearchProfileState[];
  enabledProfiles: string[];
  enabled: boolean;
}

export interface EnableSessionSearchResult {
  ok: boolean;
  changed: boolean;
  profiles: string[];
  alreadyEnabled: string[];
  error?: string;
}

const ROW_ID = "session-query-sqlite";
const MARKER = "# DSH Bridge：会话搜索 opt-in（openAt=first-search；删除本段即可恢复 DSH 默认的关闭状态）";

export function dshHome(): string {
  const env = process.env.DSH_HOME;
  if (env && env.trim()) return env.trim();
  return path.join(os.homedir(), ".dsh");
}

interface PatchEntry {
  profile: string;
  file: string;
  exists: boolean;
}

function patchEntries(): PatchEntry[] {
  const dir = path.join(dshHome(), "profiles");
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((profile) => {
    const file = path.join(dir, profile, "cordis.patch.yml");
    let exists = false;
    try {
      exists = fs.statSync(file).isFile();
    } catch {
      exists = false;
    }
    return { profile, file, exists };
  });
}

interface RowLocation {
  found: boolean;
  enabled: boolean;
  openAtIndex: number;
  openAtValue: string;
}

function locateRow(lines: string[]): RowLocation {
  for (let i = 0; i < lines.length; i++) {
    if (!/^-\s+id:\s*session-query-sqlite\s*$/.test(lines[i])) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^-\s/.test(lines[j])) {
        end = j;
        break;
      }
    }
    let openAtIndex = -1;
    let openAtValue = "";
    for (let j = i + 1; j < end; j++) {
      const match = /^\s*openAt:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/.exec(lines[j]);
      if (match) {
        openAtIndex = j;
        openAtValue = match[1];
      }
    }
    // Missing openAt means the schema default (startup) applies: enabled.
    const enabled = openAtValue === "" || openAtValue === "first-search" || openAtValue === "startup";
    return { found: true, enabled, openAtIndex, openAtValue };
  }
  return { found: false, enabled: false, openAtIndex: -1, openAtValue: "" };
}

const APPEND_BLOCK = [
  MARKER,
  "- id: " + ROW_ID,
  "  config:",
  "    path: ':memory:'",
  "    openAt: first-search",
];

function describeEntry(entry: PatchEntry): SessionSearchProfileState {
  let enabled = false;
  if (entry.exists) {
    try {
      enabled = locateRow(fs.readFileSync(entry.file, "utf8").split(/\r?\n/)).enabled;
    } catch {
      enabled = false;
    }
  }
  return { profile: entry.profile, file: entry.file, exists: entry.exists, enabled };
}

export function describeSessionSearchConfig(): SessionSearchConfigState {
  const profiles = patchEntries().map(describeEntry);
  const enabledProfiles = profiles.filter((p) => p.enabled).map((p) => p.profile);
  return { home: dshHome(), profiles, enabledProfiles, enabled: enabledProfiles.length > 0 };
}

function backup(file: string): void {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + ".dshbridge.bak");
  } catch {
    /* best effort */
  }
}

const PROFILE_HEADER = [
  "# Your patch layer for this dsh profile, applied after every bundle layer:",
  "# a top-level YAML array of loader patch entries (id-targeted config",
  "# overrides, disables, and insert lists; `!!js` expressions allowed).",
];

export function enableSessionSearchConfig(): EnableSessionSearchResult {
  const entries = patchEntries();
  if (!entries.length) {
    return {
      ok: false,
      changed: false,
      profiles: [],
      alreadyEnabled: [],
      error: "未找到 DSH profile 目录（" + path.join(dshHome(), "profiles") + "）；请先启动过一次 DSH。",
    };
  }
  const changed: string[] = [];
  const already: string[] = [];
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      if (entry.exists) {
        const text = fs.readFileSync(entry.file, "utf8");
        const eol = text.includes("\r\n") ? "\r\n" : "\n";
        const lines = text.split(/\r?\n/);
        const row = locateRow(lines);
        if (row.found && row.enabled) {
          already.push(entry.profile);
          continue;
        }
        if (row.found && row.openAtIndex >= 0) {
          backup(entry.file);
          lines[row.openAtIndex] = "    openAt: first-search";
          fs.writeFileSync(entry.file, lines.join(eol));
          changed.push(entry.profile);
          continue;
        }
        if (row.found) {
          failures.push(entry.profile + "：已有 session-query-sqlite 条目但 openAt 值无法识别，未自动改写");
          continue;
        }
        backup(entry.file);
        const base = text.length && !/[\r\n]$/.test(text) ? text + eol : text;
        fs.writeFileSync(entry.file, base + APPEND_BLOCK.join(eol) + eol);
        changed.push(entry.profile);
        continue;
      }
      const profileDir = path.dirname(entry.file);
      if (!fs.existsSync(profileDir)) continue;
      const eol = "\r\n";
      const header = PROFILE_HEADER.join(eol) + eol + eol;
      fs.writeFileSync(entry.file, header + APPEND_BLOCK.join(eol) + eol);
      changed.push(entry.profile);
    } catch (error) {
      failures.push(entry.profile + "：" + (error as Error).message);
    }
  }
  if (!changed.length && !already.length) {
    return {
      ok: false,
      changed: false,
      profiles: [],
      alreadyEnabled: [],
      error: failures.length ? failures.join("；") : "没有找到可写入的 DSH profile 配置。",
    };
  }
  return {
    ok: true,
    changed: changed.length > 0,
    profiles: changed,
    alreadyEnabled: already,
    error: failures.length ? failures.join("；") : undefined,
  };
}
