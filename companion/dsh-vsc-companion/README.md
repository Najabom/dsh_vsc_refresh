# dsh-vsc-companion

Host-side companion bundle for the [dsh-vsc](https://github.com/Najabom/dsh_vsc_refresh) VS Code extension. The extension ships this package inside its VSIX, copies it into extension storage, and installs it into the DSH profile through the official plugin manager (`installBundle`), so it needs no manual configuration.

## Capabilities

- **Task-checklist stewardship** — folds every `todo/write` into a shadow projection that survives turn resets, and contributes a dynamic runtime-context section before each request:
  - live checklist + the rule to update it step-by-step (never batch updates at the end of a task);
  - after a turn reset, the last known list plus a nudge to re-issue `todo_write` with the up-to-date statuses before continuing.
- **`page_screenshot`** — renders a local HTML file (or loopback http URL) in a headless Edge/Chromium browser **in the host process, outside the command sandbox**, captures a PNG, writes it into the session workspace, and attaches it to the conversation as an image message so the model can actually see the page. Falls back to a direct Edge headless CLI capture when `playwright-core` cannot launch.
- **`page_eval`** — evaluates one JavaScript expression inside the same host-side browser and returns a JSON result plus console output, for renderer/WebGL/shader assertions and DOM checks.

Tool names are deliberately plain; the model does not need any extra context to use them.

## License

MIT
