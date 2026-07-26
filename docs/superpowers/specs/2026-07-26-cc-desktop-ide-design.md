# Claude Code–like Desktop IDE Design

Date: 2026-07-26

## Goal

Build a local **Claude Code Desktop–style AI coding IDE** for Windows. The product is a visual desktop app: workspace file tree, code editor, streaming AI chat, visible tool calls, multi-provider API key settings, graded approval, sessions, and a minimal slash-command set.

The agent runtime reuses the existing `cli/` coding agent via a **process bridge** (JSON Lines over stdin/stdout). The desktop shell is a new app under `ide-desktop/` and does **not** modify the existing paper-assistant Electron app.

## Current Context

Workspace: `C:\Users\34516\ZCodeProject` (not a git repository).

Already present:

- Root `package.json` / `electron/` / `src/`: **科研论文辅助工作台** (paper assistant). Leave untouched.
- `cli/`: Claude Code–like agent with providers (`openai`, `anthropic`, `mock`), tools, sessions, approval modes, and `--json` event output.
- Node/npm available; Electron and Vite already used elsewhere in the monorepo-style workspace.

User decisions locked in brainstorming:

| Topic | Choice |
|-------|--------|
| Product shape | General AI coding IDE desktop (CC Desktop–like), not low-code and not paper-app upgrade |
| Completeness | Closer to full CC Desktop: chat, tool visualization, streaming, sessions, slash commands |
| Architecture | Desktop UI shell + reuse `cli/` backend |
| Providers | Multi-provider settings: OpenAI-compatible / Anthropic / custom + model switch |
| Approval | Graded: reads auto; writes configurable; dangerous shell always ask |
| Approach | Process bridge (spawn cli, JSON events), not full library extraction or rewrite |

## Success Criteria

1. `ide-desktop` runs in dev and can be packaged as a Windows desktop app without breaking the paper assistant.
2. User can open one workspace folder, browse a file tree, open files in a multi-tab Monaco editor, and save.
3. Settings support OpenAI-compatible, Anthropic, and custom providers (name, base URL, API key, model) with active provider/model switch.
4. API keys are stored only in the Electron main process secure storage path; renderer never logs full keys; exports omit secrets.
5. Mock provider works end-to-end without keys (demo path).
6. At least one live provider path works when a key is configured.
7. AI chat streams assistant text (`assistant_delta` / equivalent).
8. Tool calls render as cards (`tool_start` / `tool_result`) with expandable detail.
9. Graded approval: reads auto; file writes follow settings (`ask` or auto); dangerous shell requires explicit Allow/Deny; timeout/dismiss = Deny.
10. When the agent writes a file that is open in the editor, the UI reloads or offers diff/reload.
11. Sessions persist via existing `.aicode/sessions` (or configured `sessionDir`); UI can list/resume recent sessions at least minimally.
12. Minimal slash commands: `/help`, `/model`, `/provider`, `/status` (UI-local and/or forwarded to cli).
13. Stop/cancel ends the current turn; UI returns to idle input.
14. If the cli child process crashes, UI shows offline state and **Restart Agent** recovers without a dead window.
15. Paths outside the workspace root are rejected (cli safety + main guards).
16. Automated tests cover bridge event shapes, main bridge basics, and a mock smoke path proving chat + tool card.

## Non-Goals (MVP)

1. Pixel-perfect clone of Anthropic Claude Code Desktop UI.
2. Changing or merging into the paper-assistant app.
3. Extracting `cli/` into a shared library as a hard prerequisite (may be a later phase).
4. Multi-root workspaces or multi-window project sets.
5. Full Git GUI, debugger, extension marketplace, cloud accounts.
6. Unrestricted auto-approval of dangerous shell.
7. Container/remote sandbox isolation beyond workspace path limits + approval.
8. Plugin marketplace UI (cli plugins/MCP may exist server-side; Desktop need not expose full management UI in v1).

## Architecture

### Approach: process bridge (selected)

```text
ide-desktop (Electron + React)
  Renderer: files, Monaco, chat, tools UI, settings
  Preload: narrow IPC API
  Main: window, workspace FS helpers, secrets, spawn/manage cli

cli (existing agent)
  providers, tool loop, approval, sessions
  JSON Lines protocol on stdin/stdout
```

**Why not library-embed first:** fastest path to a usable desktop while keeping CLI usable; avoids a large `cli/` refactor before UI value ships.

**Why not rewrite agent:** would discard working tools/providers/sessions and diverge from the CLI the user already has.

### Directory layout

```text
ide-desktop/
  package.json
  electron/
    main.cjs          # window, IPC, agent process, secrets
    preload.cjs       # contextBridge API
    agent-bridge.cjs  # spawn cli, parse NDJSON, map events
    secrets.cjs       # safeStorage / encrypted key store
  src/
    main.tsx
    App.tsx
    components/       # layout, file tree, editor, chat, tools, settings
    lib/              # ipc client, session view-models
    styles.css
  tests/              # unit + smoke hooks

cli/                  # enhanced only as needed for bridge
  (existing tree)
  optional desktop-friendly stdin command handling if --json REPL is insufficient
```

Root paper-assistant `electron/`, `src/`, and root `package.json` product metadata stay as-is. `ide-desktop` is a sibling app with its own scripts.

### Runtime diagram

```text
┌──────────────────────────── ide-desktop ────────────────────────────┐
│  Renderer (React)                                                   │
│  File tree | Monaco | AI chat | tool cards | terminal | settings    │
│                         preload IPC                                 │
│  Main                                                               │
│  workspace · secrets · agent child process                          │
└──────────────────┬──────────────────────────────────────────────────┘
                   │ stdin/stdout JSON Lines
                   ▼
┌──────────────────────────── cli agent ──────────────────────────────┐
│  providers (openai / anthropic / custom via openai-compatible / mock)│
│  tools (files, search, patch, shell, ...)                           │
│  approval policy · session store                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### Configuration split

| Concern | Owner | Storage |
|---------|-------|---------|
| Theme, layout, recent workspaces | ide-desktop | app userData config |
| Active provider, model, base URL, approval mode | shared with cli | `.aicode/config.json` (+ profiles) under workspace or app-managed path |
| API keys | ide-desktop main | OS-backed safeStorage / encrypted file; never committed |
| Sessions | cli session store | `.aicode/sessions` (or `sessionDir`) |

Main injects keys into the agent process environment or a secured config side-channel at spawn time; renderer only sees booleans / last-4 hints.

## UI Design

### Layout

```text
┌──────────────────────── Top Bar ────────────────────────┐
│ Workspace path · Provider/Model · Approval · Settings   │
├──────────┬──────────────────────────────┬───────────────┤
│ Activity │         Editor Area          │  AI Panel     │
│  Files   │  Tabs + Monaco               │  Sessions     │
│  Search  │  Optional diff after AI edit │  Stream chat  │
│  Chats   │                              │  Tool cards   │
│  Settings│                              │  Input + /cmd │
├──────────┴──────────────────────────────┴───────────────┤
│ Bottom: terminal / tool output (collapsible)            │
└─────────────────────────────────────────────────────────┘
```

### Surfaces

1. **Welcome** (no workspace): open folder, recent projects, API key status.
2. **Main IDE**: activity bar + editor + AI panel + bottom pane.
3. **Settings**: providers (OpenAI-compatible / Anthropic / custom), keys, models, approval defaults.
4. **Approval card/modal**: Allow once · Allow for session (writes) · Deny.
5. **Tool cards** in chat: name, short input summary, duration, ok/fail, expand raw detail.

### Visual / UX principles

- Dark, dense IDE chrome (light theme optional later).
- AI panel is the primary post-open focus.
- Every tool call is visible in the transcript.
- Minimal shortcuts v1: focus AI (`Ctrl+L` or `Ctrl+K`), save (`Ctrl+S`), settings (`Ctrl+,`), toggle bottom terminal (`Ctrl+``).

### UI non-goals

Full debug workbench, marketing hero, nested card dashboards, extension store.

## Data Flow and Protocol

### Principles

- Renderer never holds raw API keys and never spawns the agent.
- Main owns child process lifecycle and secret material.
- Communication with cli is **NDJSON** (one JSON object per line).
- Prefer extending existing `cli --json` events; add stdin command types only where interactive desktop needs them.

### Renderer ↔ Main IPC (v1 set)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `workspace.open` | R→M | Open/select folder |
| `workspace.getTree` | R→M | File tree listing |
| `fs.read` / `fs.write` | R→M | Editor load/save within workspace |
| `settings.get` / `settings.set` | R→M | Non-secret settings |
| `secrets.setApiKey` / `secrets.hasApiKey` | R→M | Store/query key presence |
| `agent.start` / `agent.prompt` / `agent.cancel` | R→M | Lifecycle + user turns |
| `agent.approve` / `agent.deny` | R→M | Approval decisions |
| `agent.event` | M→R | Forwarded cli events |
| `agent.status` | M→R | online/offline, provider, model |

### Main → cli (stdin commands)

```json
{"type":"user_message","sessionId":"...","text":"..."}
{"type":"approval_response","requestId":"...","decision":"allow_once"}
{"type":"cancel","sessionId":"..."}
{"type":"set_config","provider":"openai","model":"...","approval":"ask"}
```

`decision` values: `allow_once` | `allow_session` | `deny`.

### cli → Main (stdout events)

```json
{"type":"status","sessionId":"...","provider":"openai","model":"...","approval":"ask"}
{"type":"assistant_delta","sessionId":"...","text":"..."}
{"type":"assistant_message","sessionId":"...","text":"..."}
{"type":"tool_start","sessionId":"...","tool":"read_file","input":{}}
{"type":"tool_result","sessionId":"...","tool":"read_file","ok":true,"output":"...","data":{}}
{"type":"approval_needed","sessionId":"...","requestId":"...","tool":"shell","reason":"...","input":{}}
{"type":"turn_done","sessionId":"...","status":"ok"}
{"type":"error","sessionId":"...","message":"..."}
```

Implementation may map existing cli JSON event names to this set in `agent-bridge` if renames are cheaper than changing all cli emitters.

### File and session flow

1. User prompt → IPC → stdin `user_message`.
2. Streamed deltas update chat; tools update cards.
3. On write/patch `tool_result` with path: if tab open, reload buffer or show dirty/diff affordance.
4. Sessions written by cli store; Desktop reads index for sidebar list/resume (`resumeSessionId` or equivalent).
5. Cancel: stdin `cancel`; if unresponsive, kill agent process and respawn clean instance.

### Error flow

| Condition | Behavior |
|-----------|----------|
| No API key (non-mock) | Block turn; prompt settings |
| Provider HTTP/auth error | `error` event in chat; retry allowed |
| cli crash | agent offline + Restart |
| Approval dismissed/timeout | Deny |
| Path outside workspace | Reject at tool/main layer |

## Security, API Keys, Approval

### Providers

- **OpenAI-compatible**: base URL + API key + model (covers many gateways).
- **Anthropic**: API key + model.
- **Custom**: labeled profile using OpenAI-compatible wire format unless a dedicated adapter already exists.
- **Mock**: always available for demos/tests.

### Key handling

- Store only in main-process secure storage.
- UI: configured / missing / last 4 characters max.
- Redact from logs, doctor output, session export, crash reports.
- Do not commit keys; do not put full keys in renderer memory longer than form submit IPC.

### Graded approval matrix

| Operation | Default | Configurable |
|-----------|---------|--------------|
| Read-only tools (list/read/search/status) | Auto allow | No (stay auto) |
| File write / patch | `ask` or auto per settings | Yes |
| Shell (especially destructive/network/global) | Always ask | Must not offer “allow all dangerous shell forever” in v1 |
| Outside workspace root | Deny | No |

### Approval UX

- Inline pending card in chat (and optional modal focus).
- Actions: Allow once; Allow for this session (file writes); Deny.
- Session allow applies to write/patch class in v1; shell remains per-call unless a later explicit design revisits that.
- Top bar shows short approval mode label.

### Process boundaries

- `nodeIntegration: false`, `contextIsolation: true`.
- Only main spawns cli and reads secrets.
- Workspace root jail for editor FS APIs and agent tools.

## Testing and Acceptance

### Layers

1. **cli protocol**: event shape / approval / cancel golden tests; keep existing smoke/audit where relevant.
2. **Main bridge**: spawn, NDJSON parse, forward, restart, secret non-leak unit tests (headless where possible).
3. **Renderer**: chat transcript, tool cards, approval actions, settings form unit tests.
4. **Mock E2E smoke**: launch → open fixture workspace → mock provider turn → tool card appears → optional file write refresh.
5. **Live smoke** (optional, key-gated): one real provider round-trip; not required for default local gate.

### Acceptance checklist

Matches [Success Criteria](#success-criteria). Ship bar for “MVP done”: criteria 1–16 with mock E2E green; live provider verified manually or via optional live smoke when keys exist.

## Implementation Phases (for planning skill)

Ordered for vertical slices:

1. **Scaffold** `ide-desktop` Electron+Vite+React shell; empty layout chrome.
2. **Workspace + editor**: open folder, tree, Monaco tabs, save via main FS.
3. **Settings + secrets**: multi-provider form, secure key store, mock/live switch.
4. **Agent bridge**: spawn cli, NDJSON, status/online, prompt/cancel.
5. **Chat UX**: streaming text, tool cards, errors.
6. **Approval UX**: wire `approval_needed` / responses; graded policy display.
7. **File sync**: reload/diff after agent writes.
8. **Sessions + slash commands**: list/resume; `/help` `/model` `/provider` `/status`.
9. **Bottom terminal pane** (minimal): show recent tool/shell output; full PTY optional later.
10. **Tests + packaging scripts**: unit/smoke; `desktop:run` style script for ide-desktop.

Each phase should leave the app runnable.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| cli interactive mode is TTY-oriented, not desktop stdin | Add explicit bridge/headless turn mode if `--json` + prompt loops are insufficient |
| Event name drift between cli and UI | Single mapper in `agent-bridge`; contract tests |
| Key leakage via env dump or logs | Redaction helpers; never mirror env to renderer |
| Large monorepo workspace noise | Desktop opens user-selected folder; default can be last workspace, not forced to whole ZCodeProject |
| Scope creep toward full VS Code | Enforce non-goals; phase list above is the backlog ceiling for MVP |

## Open Questions (resolved for MVP)

| Question | Resolution |
|----------|------------|
| New app vs reuse paper electron | New `ide-desktop/` |
| Bridge vs library | Bridge first |
| Provider set | Multi-provider + custom |
| Approval | Graded B |
| UI fidelity | CC Desktop–inspired, not pixel-perfect |

No unresolved product questions block the implementation plan.

## References

- Existing agent: `cli/` (README, providers, tools, sessions, `--json`)
- Prior CLI design: `docs/superpowers/specs/2026-07-05-cli-code-agent-mvp-design.md`
- Paper assistant (do not merge): root `electron/`, `src/App.tsx`
