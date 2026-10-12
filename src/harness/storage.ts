import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** DSH's on-disk home ($DSH_HOME overrides ~/.dsh, matching the harness). */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * Hard-delete one session's on-disk history. The harness exposes no session
 * delete RPC (only archive/unarchive), so a permanent delete is the same
 * effect as removing `~/.dsh/sessions/<cwd>--/<sessionId>`: the harness's
 * session index reconciles the missing log as a delete on its next pass.
 * Returns the removed directories (empty when nothing matched).
 */
export async function deleteSessionStorage(sessionId: string): Promise<string[]> {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return [];
  const root = join(dshHome(), "sessions");
  let groups: string[];
  try {
    groups = await readdir(root);
  } catch {
    return [];
  }
  const candidates = [join(root, sessionId), ...groups.map((group) => join(root, group, sessionId))];
  const removed: string[] = [];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    await rm(candidate, { recursive: true, force: true });
    removed.push(candidate);
  }
  return removed;
}
