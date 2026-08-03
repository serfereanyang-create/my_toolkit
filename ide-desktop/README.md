# ZCode Desktop IDE

Electron shell that wraps the `aicode` CLI agent in a Claude-Code-style
desktop workspace: file tree, Monaco tabs, streaming AI panel with tool
cards and structured approvals, and a bottom terminal.

The renderer talks to a long-running `aicode --desktop-bridge` child
process through the main process, exchanging newline-delimited JSON.
See `../cli/README.md#desktop-bridge` for the protocol.

## Scripts

- `npm run dev` — start Vite on 127.0.0.1:5174 and launch Electron.
- `npm run build` — typecheck and emit the production renderer bundle.
- `npm run typecheck` — TypeScript check without emit.
- `npm run desktop:run` — build then launch Electron against the bundled UI.

## Layout

- `electron/` — main process, preload, IPC bridge.
- `src/` — React renderer.
- `scripts/dev.cjs` — dev orchestrator (starts Vite, then Electron).

## Mock Provider

The default mock provider works without API keys and drives the smoke tests.
Open a workspace, keep the provider set to Mock, and send a prompt — the agent
runs its multi-tool chain with no network calls.

## Live Providers

Configure providers in Settings:

- OpenAI-compatible: base URL, model, API key (custom gateways use this path).
- Anthropic: model, API key.
- Mock: no key required.

API keys are stored by the Electron main process via `safeStorage` and are never
returned in full to the renderer — the UI only shows a `configured:####` hint.

## Verification

```bash
cd ../cli && npm run build && node --test dist/tests/desktop-bridge*.test.js
cd ../ide-desktop && npm run test && npm run build
```

`npm run test` runs three phases: TypeScript typecheck, Vitest reducer tests
(`src/**/*.test.ts`), and Node's test runner for the main-process and bridge
suites (`tests/*.test.cjs`).
