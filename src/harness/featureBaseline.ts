/**
 * Feature baseline for the DSH update check.
 *
 * `@deepseek-ai/dsh` is a meta package whose runtime dependencies enumerate
 * the feature bundles that make up a DSH release. This list is the snapshot
 * the bridge was built and verified against (the release that
 * `TESTED_DSH_MAX`/the contract check covers). Before offering a DSH update,
 * `harness/updatePreflight.ts` fetches the candidate version's dependency list
 * and reports every package that is NOT in here: those are features this
 * extension has never seen, and their entry points/rendering cannot be
 * surfaced in the VS Code panel until the extension adapts — so the update
 * prompt says "new feature not yet supported, wait for a plugin update"
 * instead of pretending the release is fully compatible.
 *
 * Maintenance: bump FEATURE_BASELINE_VERSION together with TESTED_DSH_MAX in
 * `harness/capabilities.ts` after verifying the new release, and append the
 * new packages here (retire nothing — the list is intentionally cumulative
 * for the versions the plugin has been adapted to).
 */

/** The DSH release this baseline was captured from. */
export const FEATURE_BASELINE_VERSION = "0.2.2-alpha.2";

/** `@deepseek-ai/dsh-*` runtime dependencies of FEATURE_BASELINE_VERSION. */
export const KNOWN_FEATURE_PACKAGES: readonly string[] = [
  "@deepseek-ai/dsh-hmr",
  "@deepseek-ai/dsh-acp-app",
  "@deepseek-ai/dsh-agent-instructions",
  "@deepseek-ai/dsh-agent-tool-presentation",
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-client-ui-agent-preset",
  "@deepseek-ai/dsh-client-ui-cordis",
  "@deepseek-ai/dsh-cmdline",
  "@deepseek-ai/dsh-command-compact",
  "@deepseek-ai/dsh-command-goal",
  "@deepseek-ai/dsh-compaction-basic",
  "@deepseek-ai/dsh-compaction-tool-result-pruner",
  "@deepseek-ai/dsh-cordis-client-runner",
  "@deepseek-ai/dsh-experimental-agent-team-profile",
  "@deepseek-ai/dsh-experimental-inspector-profile",
  "@deepseek-ai/dsh-fs-local",
  "@deepseek-ai/dsh-goal",
  "@deepseek-ai/dsh-goal-round-driver",
  "@deepseek-ai/dsh-headless",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-jobs-local",
  "@deepseek-ai/dsh-launch-environment",
  "@deepseek-ai/dsh-mcp-client",
  "@deepseek-ai/dsh-official-bundles",
  "@deepseek-ai/dsh-persona",
  "@deepseek-ai/dsh-plan-mode",
  "@deepseek-ai/dsh-pwsh-local",
  "@deepseek-ai/dsh-pwsh-sandbox",
  "@deepseek-ai/dsh-schedule",
  "@deepseek-ai/dsh-sdk-app",
  "@deepseek-ai/dsh-sdk-minimal",
  "@deepseek-ai/dsh-session-projection",
  "@deepseek-ai/dsh-session-reference",
  "@deepseek-ai/dsh-skill",
  "@deepseek-ai/dsh-skill-filesystem",
  "@deepseek-ai/dsh-skill-office",
  "@deepseek-ai/dsh-tool-workspace-dependencies",
  "@deepseek-ai/dsh-terminal",
  "@deepseek-ai/dsh-terminal-bash",
  "@deepseek-ai/dsh-time-context",
  "@deepseek-ai/dsh-tmux-context",
  "@deepseek-ai/dsh-token-meter",
  "@deepseek-ai/dsh-tool-ask-user",
  "@deepseek-ai/dsh-tool-bash",
  "@deepseek-ai/dsh-tool-bash-persistent",
  "@deepseek-ai/dsh-tool-cordis",
  "@deepseek-ai/dsh-tool-present",
  "@deepseek-ai/dsh-tool-fs",
  "@deepseek-ai/dsh-tool-fs-search",
  "@deepseek-ai/dsh-tool-goal",
  "@deepseek-ai/dsh-tool-jobs",
  "@deepseek-ai/dsh-tool-pwsh",
  "@deepseek-ai/dsh-tool-pwsh-persistent",
  "@deepseek-ai/dsh-tool-schedule",
  "@deepseek-ai/dsh-tool-skill",
  "@deepseek-ai/dsh-tool-str-replace-editor",
  "@deepseek-ai/dsh-tool-subagent",
  "@deepseek-ai/dsh-tool-subagent-control",
  "@deepseek-ai/dsh-tool-todo",
  "@deepseek-ai/dsh-tool-web",
  "@deepseek-ai/dsh-tool-workflow",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-workflow-ptc",
  "@deepseek-ai/dsh-http-proxy",
  "@deepseek-ai/dsh-mcp-resources",
  "@deepseek-ai/dsh-plugin-manager",
  "@deepseek-ai/dsh-atomic-write",
  "@deepseek-ai/dsh-agent-preset",
  "@deepseek-ai/dsh-experimental-voice-input-bundle",
  "@deepseek-ai/dsh-experimental-auto-review",
  "@deepseek-ai/dsh-experimental-cot-translation-bundle",
  "@deepseek-ai/dsh-experimental-badge-skill-bundle",
  "@deepseek-ai/dsh-experimental-ralph-bundle",
  "@deepseek-ai/dsh-experimental-session-titles-bundle",
  "@deepseek-ai/dsh-experimental-terminal-bundle",
  "@deepseek-ai/dsh-experimental-liveshare",
  "@deepseek-ai/dsh-experimental-session-search",
  "@deepseek-ai/dsh-experimental-tool-worktree",
  "@deepseek-ai/dsh-cua-bundle",
  "@deepseek-ai/dsh-experimental-plugin-market-bundle",
  "@deepseek-ai/dsh-personalized-recommendations",
  "@deepseek-ai/dsh-experimental-forge-bundle",
];
