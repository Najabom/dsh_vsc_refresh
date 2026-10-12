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
- `internal/` — private maintainer docs (plan, playbook, upstream tracking, overlay contract). **git-ignored; never publish or commit to git.**
- `scratch/` — throwaway probes/tests against a live harness (real events); not production code.
- `docs/` — public user docs + screenshots.

## Architecture invariants (do not break)

1. **Never import DSH internals.** The client (`src/harness/client.ts`) reimplements the wire contract with only `fetch`; keep it thin (~200 lines). No `@deepseek-ai/dsh-*` imports in shipped code.
2. **Forward events losslessly.** The bridge must not re-model DSH event frames (`src/panel/protocol.ts`). Rendering is the panel's job.
3. **No second server.** Reuse a running harness; auto-start only when none is reachable; never spawn a second DSH writing the same `~/.dsh` history. Shutdown stops the owned instance deterministically (a windowless detached spawn must not outlive its owner); a shared harness is left alone.
4. **The overlay is the only crossing, and it is guarded.** `src/harness/overlay/` is the single source for the overlay deltas. Every delta must: only mutate loaded memory (official files on disk stay byte-identical), be backed by a **SHA-256** entry in `pristine.ts`, and be gated by a **canary anchor** in `deltas.ts` — on any mismatch, degrade gracefully (skip the patch), never force it. When DSH ships the equivalent field, **remove** the delta (retirement path), don't keep it.

## Coding conventions

- TypeScript, strict. Follow existing style in `src/`.
- Keep the bridge transparent: no invented re-modeling of DSH data.
- Per-directory `README.md` files describe each area's responsibility and boundary — keep them in sync when you move things.
- Public-facing docs live in `docs/`; anything internal/private goes in `internal/` (and stays git-ignored).

## Testing

- The repo favors verifying against the **real harness + real event streams**. `scratch/` contains many one-off probes; the maintained one is `scratch/auto-test.mjs` (jsdom runs the actual panel renderer with real `session.history` events).
- Run `npm run typecheck` before committing; `npm run build` to confirm the bundle compiles.
