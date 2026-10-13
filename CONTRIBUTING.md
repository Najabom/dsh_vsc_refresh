# Contributing to DSH Bridge (dsh-vsc)

Thanks for helping. This project is a "pure bridge" to DeepSeek Harness — before you send a PR, read [docs/design.md](docs/design.md) so your change fits the philosophy, and [AGENTS.md](AGENTS.md) for the hard invariants (especially the **overlay rules** and the **no-second-server** rule).

## How to build and test

```bash
npm install
npm run typecheck    # tsc --noEmit (both configs)
npm run build        # esbuild → dist/extension.js + dist/media
npm run package      # build + vsce package → dsh-vsc-<version>.vsix
```

Manual debugging: F5 (`.vscode/launch.json`) → Extension Development Host.

Automated regression (jsdom renders the actual panel with real event streams):

```bash
node scratch/auto-test.mjs <sessionId> <turnNo>
```

## What's welcome

- **Bug fixes** with a clear reproduction and, where possible, a regression test.
- **Clarity** — docs, README, comments. The project values "explaining the architecture to newcomers" (see `docs/design.md`).
- **Upstream adaption** — if DSH ships a field that makes an overlay delta redundant, retire that delta (per the overlay retirement path) instead of keeping it.

## Before you submit

1. Branch off `main`, keep changes focused and atomic.
2. Run `npm run typecheck` and `npm run build` — they must pass.
3. If your change touches the bridge semantics, update the relevant per-directory `README.md` and, if user-facing, the README.
4. Prefer conventional commit messages (e.g. `fix(panel): …`, `feat(harness): …`, `docs: …`).

## Repo layout (short)

| Path | What it is |
|---|---|
| `src/` | Extension runtime (TS + panel assets) |
| `src/harness/overlay/` | The only intentional crossing — read its README first |
| `docs/` | Public user docs (incl. `design.md`, screenshots) |
| `internal/` | Private maintainer notes — git-ignored, do **not** commit |
| `scratch/` | Throwaway probes/tests against a live harness |
| `scripts/` | Maintainer/ops scripts |

## Code of conduct / issues

Keep it kind and specific. If you found a crash or a misleading behavior, include the extension log output ("DSH Bridge" Output channel) and steps to reproduce. See the project [issues](https://github.com/Najabom/dsh_vsc_refresh/issues).
