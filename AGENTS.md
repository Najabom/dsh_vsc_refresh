# AGENTS.md

Guidance for AI coding agents working in this repository. Read this before making changes.

## What this project is

`dsh-vsc` (DSH Bridge) is a **VS Code extension** that connects to **DeepSeek Harness (DSH)** — a local AI agent service (default `http://127.0.0.1:3080`) — as a **protocol client**. It renders DSH's work in a native sidebar panel and bridges the editor (ask-about-selection, review-agent-changes).

The defining constraint is the **"pure bridge"** philosophy: consume DSH's **wire contract (protocol)**, not its UI; never rewrite DSH; never start a second server on an existing history. Details in [docs/design.md](docs/design.md) — read it before touching architecture.

## Commands

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies |
| `npm run typecheck` | `tsc --noEmit` (root + `tsconfig.overlay.json`) |
| `npm run build` | esbuild → `dist/extension.js` + `dist/media` |
| `npm run package` | Build + `vsce package` → `dsh-vsc-<version>.vsix` |
| `node scratch/auto-test.mjs <sessionId> <turnNo>` | jsdom regression test against a live harness |

Debug via F5 (`.vscode/launch.json`) → Extension Development Host.

## Source layout

- `src/extension.ts` — entry point; activation, command registration, harness lifecycle, reference-counted shutdown.
- `src/editor/` — editor bridge: selection context, change tracking, diff building, file jumps.
- `src/events/` — `HarnessEventStream` (WebSocket event-stream client).
- `src/harness/` — protocol client, discovery, launcher, and the `overlay/` runtime patch.
- `src/panel/` — sidebar: `NativePanelProvider.ts`, native `panel.html`, embedded webview.
- `companion/` — the built-in DSH plugin (`dsh-vsc-companion`, pure ESM JS, no build step). It is **loaded by DSH, not by the extension**: a zero-dependency bundle that the extension installs/updates into the user's DSH profile on connect (`src/harness/companion.ts`). It provides the live todo-steward context section and the host-side `page_screenshot` / `page_eval` tools (playwright-core is its only runtime dependency, resolved inside the DSH profile). Keep it dependency-light and defensive — a throw there can break the harness boot. Packaged inside the VSIX via the default `files` list; do not add it to `.vscodeignore`.
- `internal/` — private maintainer docs (plan, playbook, upstream tracking, overlay contract). **git-ignored; never publish or commit to git.**
- `scratch/` — throwaway probes/tests against a live harness (real events); not production code.
- `docs/` — public user docs + screenshots.

## Architecture invariants (do not break)

1. **Never import DSH internals.** The client (`src/harness/client.ts`) reimplements the wire contract with only `fetch`; keep it thin (~200 lines). No `@deepseek-ai/dsh-*` imports in shipped code.
2. **Forward events losslessly.** The bridge must not re-model DSH event frames (`src/panel/protocol.ts`). Rendering is the panel's job.
3. **No second server.** Reuse a running harness; auto-start only when none is reachable; never spawn a second DSH writing the same `~/.dsh` history. Multi-window lifecycle: every window writes a 5s heartbeat under `%TEMP%\dsh-vsc-clients` (`src/harness/clientRegistry.ts`), the harness is wrapped by `dist/harness-guard.mjs` (built from `src/harness/guard.ts`), and shutdown stops the owned instance only when the LAST live window closes; the guard kills the tree after an all-windows crash (~45s stale) and a shared/pre-existing harness is never killed.
4. **The overlay is the only crossing, and it is guarded.** `src/harness/overlay/` is the single source for the overlay deltas. Every delta must: only mutate loaded memory (official files on disk stay byte-identical), be backed by a **SHA-256** entry in `pristine.ts`, and be gated by a **canary anchor** in `deltas.ts` — on any mismatch, degrade gracefully (skip the patch), never force it. `pristine.ts` records the dsh version its hashes came from; after bumping dsh run `npm run record-pristine` (checks the installed release; `-- --write` rewrites the table + the verify script). When DSH ships the equivalent field, **remove** the delta (retirement path), don't keep it.

## Coding conventions

- TypeScript, strict. Follow existing style in `src/`.
- Keep the bridge transparent: no invented re-modeling of DSH data.
- Per-directory `README.md` files describe each area's responsibility and boundary — keep them in sync when you move things.
- Public-facing docs live in `docs/`; anything internal/private goes in `internal/` (and stays git-ignored).

## Testing

- The repo favors verifying against the **real harness + real event streams**. `scratch/` contains many one-off probes; the maintained one is `scratch/auto-test.mjs` (jsdom runs the actual panel renderer with real `session.history` events).
- Run `npm run typecheck` before committing; `npm run build` to confirm the bundle compiles.
