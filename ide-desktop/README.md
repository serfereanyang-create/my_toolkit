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
