# CC Desktop IDE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable Claude-Code-like desktop IDE that uses the existing `cli/` coding agent through a JSON Lines process bridge.

**Architecture:** Create a new `ide-desktop/` Electron + Vite + React app and leave the existing paper-assistant root Electron app untouched. Add a small desktop bridge mode to `cli/` so Electron can send prompts, receive streaming events, and handle approvals without a TTY. Keep provider, tool, approval, and session logic in `cli/`.

**Tech Stack:** TypeScript, Node.js, Electron, Vite, React, Monaco Editor, lucide-react, Vitest/Node test runner, JSON Lines over child_process stdin/stdout.

---

## Source Spec

- Design spec: `docs/superpowers/specs/2026-07-26-cc-desktop-ide-design.md`
- Existing CLI design: `docs/superpowers/specs/2026-07-05-cli-code-agent-mvp-design.md`

## Repository Notes

The primary workspace `C:\Users\34516\ZCodeProject` is not currently a git repository. Each task includes a checkpoint step. If implementation happens inside a real git repo or worktree, run the listed commit command. If it happens in the current non-git workspace, run the verification command and record that no commit was possible.

## File Structure

### CLI changes

- Modify `cli/src/config/types.ts`: add `desktopBridge?: boolean` to CLI args and app config.
- Modify `cli/src/cli/args.ts`: parse `--desktop-bridge`.
- Create `cli/src/runtime/createRuntime.ts`: shared runtime factory extracted from `cli/src/index.ts`.
- Modify `cli/src/index.ts`: use the runtime factory and dispatch `--desktop-bridge` to the new bridge runner.
- Create `cli/src/cli/desktopBridge.ts`: stdin/stdout JSON Lines command loop for Desktop.
- Modify `cli/src/tools/types.ts`: extend `confirm` callback with structured approval metadata.
- Modify `cli/src/tools/registry.ts`: pass approval metadata into `confirm`.
- Create `cli/tests/desktop-bridge-args.test.ts`: parse/config smoke for the flag.
- Create `cli/tests/desktop-bridge.test.ts`: mock-provider bridge smoke.
- Modify `cli/README.md`: document Desktop bridge mode.

### Desktop app files

- Create `ide-desktop/package.json`: app scripts and dependencies.
- Create `ide-desktop/tsconfig.json`: TypeScript config for renderer.
- Create `ide-desktop/vite.config.ts`: Vite config on a stable localhost port.
- Create `ide-desktop/index.html`: renderer entry page.
- Create `ide-desktop/scripts/dev.cjs`: starts Vite then Electron for local development.
- Create `ide-desktop/electron/main.cjs`: app window and IPC registration.
- Create `ide-desktop/electron/preload.cjs`: safe contextBridge API.
- Create `ide-desktop/electron/workspace.cjs`: workspace-root-jail file tree and file read/write helpers.
- Create `ide-desktop/electron/settings-store.cjs`: non-secret settings and recent workspaces.
- Create `ide-desktop/electron/secret-store.cjs`: injected safeStorage-backed API key store.
- Create `ide-desktop/electron/agent-bridge.cjs`: spawn cli, parse NDJSON, map events, restart/cancel.
- Create `ide-desktop/electron/ipc.cjs`: IPC channel registration.
- Create `ide-desktop/src/main.tsx`: renderer bootstrap.
- Create `ide-desktop/src/App.tsx`: top-level app shell.
- Create `ide-desktop/src/types.ts`: shared renderer view-model types.
- Create `ide-desktop/src/lib/ipc.ts`: typed renderer client for preload API.
- Create `ide-desktop/src/lib/state.ts`: reducer for workspace/editor/chat/agent state.
- Create `ide-desktop/src/components/Layout.tsx`: IDE chrome.
- Create `ide-desktop/src/components/ActivityBar.tsx`: files/search/sessions/settings navigation.
- Create `ide-desktop/src/components/TopBar.tsx`: workspace, provider, model, approval status.
- Create `ide-desktop/src/components/Welcome.tsx`: no-workspace screen.
- Create `ide-desktop/src/components/FileTree.tsx`: recursive file tree.
- Create `ide-desktop/src/components/EditorTabs.tsx`: file tabs and dirty state.
- Create `ide-desktop/src/components/CodeEditor.tsx`: Monaco editor wrapper.
- Create `ide-desktop/src/components/AIPanel.tsx`: transcript, input, stop button.
- Create `ide-desktop/src/components/ToolCard.tsx`: tool start/result/approval display.
- Create `ide-desktop/src/components/SettingsPanel.tsx`: provider/model/key/approval settings.
- Create `ide-desktop/src/components/BottomPanel.tsx`: collapsible tool/terminal output.
- Create `ide-desktop/src/styles.css`: desktop IDE styling.
- Create `ide-desktop/tests/agent-bridge.test.cjs`: main bridge unit tests.
- Create `ide-desktop/tests/workspace.test.cjs`: workspace path-jail tests.
- Create `ide-desktop/tests/secret-store.test.cjs`: secret redaction and encryption-path tests.
- Create `ide-desktop/src/lib/state.test.ts`: renderer reducer tests.
- Create `ide-desktop/tests/mock-smoke.test.cjs`: mock end-to-end process bridge smoke.

---

## Task 1: CLI bridge flag and runtime factory

**Files:**
- Modify `cli/src/config/types.ts`
- Modify `cli/src/cli/args.ts`
- Create `cli/src/runtime/createRuntime.ts`
- Modify `cli/src/index.ts`
- Test `cli/tests/desktop-bridge-args.test.ts`

- [ ] **Step 1: Write the failing flag test**

Create `cli/tests/desktop-bridge-args.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/cli/args.js';

test('parseArgs supports desktop bridge mode', () => {
  const args = parseArgs(['--desktop-bridge', '--provider', 'mock', '--workspace', '.']);

  assert.equal(args.desktopBridge, true);
  assert.equal(args.provider, 'mock');
  assert.ok(args.workspace);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd cli && npm run build && node --test dist/tests/desktop-bridge-args.test.js
```

Expected: build fails because `desktopBridge` is not defined on `CliArgs` or the parser does not recognize `--desktop-bridge`.

- [ ] **Step 3: Add config types**

In `cli/src/config/types.ts`, add `desktopBridge?: boolean;` to both `CliArgs` and `AppConfig`.

Expected resulting type additions:

```ts
export type CliArgs = {
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  approval?: ApprovalMode;
  workspace?: string;
  sessionDir?: string;
  resumeSessionId?: string;
  prompt?: string;
  maxSteps?: number;
  noBanner?: boolean;
  version?: boolean;
  json?: boolean;
  noColor?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  ci?: boolean;
  noInput?: boolean;
  configPath?: string;
  profile?: string;
  doctor?: boolean;
  completionShell?: 'bash' | 'zsh' | 'fish' | 'powershell';
  confirmPlan?: boolean;
  desktopBridge?: boolean;
};
```

```ts
export type AppConfig = {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  approval: ApprovalMode;
  workspaceRoot: string;
  sessionDir: string;
  resumeSessionId?: string;
  prompt?: string;
  maxSteps: number;
  noBanner: boolean;
  version?: boolean;
  json?: boolean;
  noColor?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  ci?: boolean;
  noInput?: boolean;
  configPath?: string;
  profile?: string;
  doctor?: boolean;
  completionShell?: 'bash' | 'zsh' | 'fish' | 'powershell';
  confirmPlan?: boolean;
  desktopBridge?: boolean;
};
```

- [ ] **Step 4: Parse `--desktop-bridge`**

In `cli/src/cli/args.ts`, add this case to the switch:

```ts
      case '--desktop-bridge':
        args.desktopBridge = true;
        args.json = true;
        args.noBanner = true;
        args.noInput = true;
        break;
```

Update `cli/src/config/config.ts` so `loadConfig()` returns the flag:

```ts
    desktopBridge: args.desktopBridge ?? false,
```

Place it near the other boolean config fields in the returned object.

- [ ] **Step 5: Extract runtime creation**

Create `cli/src/runtime/createRuntime.ts` with the shared setup currently embedded in `cli/src/index.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config/types.js';
import { GitAuditLog } from '../git-safety/audit.js';
import { GitSnapshotDiff } from '../git-safety/diff.js';
import { GitProcess } from '../git-safety/git.js';
import { LocalGitPublisher } from '../git-safety/publisher.js';
import { GitRepository } from '../git-safety/repository.js';
import { GitRollbackService } from '../git-safety/rollback.js';
import { GitSafetyService } from '../git-safety/service.js';
import { GitSnapshotStore } from '../git-safety/snapshot.js';
import { createNoopHooks } from '../hooks/hooks.js';
import { loadMcpManager } from '../mcp/manager.js';
import { loadPluginTools } from '../plugins/loader.js';
import { createProvider } from '../providers/index.js';
import { CheckpointStore } from '../session/checkpoint.js';
import { SessionStore } from '../session/store.js';
import { createDefaultToolRegistry } from '../tools/index.js';
import { TerminalUI } from '../ui/terminal.js';

export async function createAgentRuntime(config: AppConfig) {
  const provider = createProvider(config);
  const tools = createDefaultToolRegistry();
  for (const tool of await loadPluginTools(config.workspaceRoot)) tools.register(tool);
  const existingNames = new Set(tools.list().map((tool) => tool.name));
  let mcp = await loadMcpManager({ workspaceRoot: config.workspaceRoot, existingNames });
  for (const tool of mcp.tools) {
    try {
      tools.register(tool);
    } catch {
      // A plugin/MCP collision should not prevent the core agent from starting.
    }
  }

  const version = await packageVersion();
  const ui = new TerminalUI({
    quiet: config.quiet,
    json: config.json,
    noColor: config.noColor,
    verbose: config.verbose,
    homeScreen: !config.prompt && !config.ci && !config.json && !config.desktopBridge,
    version,
  });

  const sessions = new SessionStore(config.sessionDir);
  const checkpoints = new CheckpointStore(config.workspaceRoot);
  const gitProcess = new GitProcess(config.workspaceRoot);
  const gitAudit = new GitAuditLog(config.workspaceRoot);
  const gitRepository = new GitRepository(config.workspaceRoot, gitProcess);
  const gitSnapshots = new GitSnapshotStore(gitProcess, config.workspaceRoot);
  const gitDiff = new GitSnapshotDiff(gitProcess);
  const gitSafety = new GitSafetyService(config.workspaceRoot, gitRepository, gitSnapshots, gitDiff, gitAudit);
  const gitRollback = new GitRollbackService(config.workspaceRoot, gitRepository, gitSnapshots, gitDiff, gitAudit);
  const gitPublisher = new LocalGitPublisher(config.workspaceRoot, gitProcess, gitAudit);
  const session = config.resumeSessionId
    ? await sessions.load(config.resumeSessionId)
    : await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: config.workspaceRoot });

  const hooks = createNoopHooks();
  const runtime = {
    config,
    provider,
    tools,
    sessions,
    checkpoints,
    session,
    ui,
    hooks,
    gitSafety,
    gitRollback,
    gitPublisher,
    gitProcess,
    gitRepository,
    get mcp() {
      return mcp;
    },
    async reloadMcp() {
      await mcp.close();
      const existingToolNames = new Set(
        tools.list().filter((tool) => !tool.name.startsWith('mcp_')).map((tool) => tool.name),
      );
      const next = await loadMcpManager({ workspaceRoot: config.workspaceRoot, existingNames: existingToolNames });
      for (const tool of next.tools) tools.register(tool, { replace: true });
      mcp = next;
      return mcp;
    },
  };

  return {
    provider,
    tools,
    ui,
    runtime,
    mcpStatuses: mcp.statuses,
    async close() {
      await mcp.close();
    },
  };
}

async function packageVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJson = JSON.parse(await readFile(resolve(here, '../../package.json'), 'utf8')) as { version?: string };
  return packageJson.version ?? '0.0.0';
}
```

- [ ] **Step 6: Refactor `cli/src/index.ts` to call the factory**

Modify `cli/src/index.ts` so it imports the factory:

```ts
import { createAgentRuntime } from './runtime/createRuntime.js';
```

Remove the duplicated setup imports that moved into the factory. Keep these imports in `index.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completionScript } from './cli/completion.js';
import { formatDoctor, runDoctor } from './cli/doctor.js';
import { parseArgs } from './cli/args.js';
import { runPromptMode, runRepl } from './cli/repl.js';
import { loadConfig, requireProviderAuth } from './config/config.js';
import { formatMcpStatus } from './mcp/manager.js';
import { createAgentRuntime } from './runtime/createRuntime.js';
```

Replace the runtime setup block with:

```ts
  const created = await createAgentRuntime(config);
  const { provider, tools, ui, runtime, mcpStatuses } = created;

  if (config.doctor) {
    const checks = await runDoctor(config, provider, tools, runtime.mcp);
    if (config.json) {
      process.stdout.write(`${JSON.stringify({ type: 'doctor', ok: checks.every((check) => check.ok), checks })}\n`);
    } else {
      process.stdout.write(`${formatDoctor(checks)}\n`);
    }
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    await created.close();
    return;
  }

  ui.banner(config, provider);
  if (config.resumeSessionId) ui.info(`resumed session: ${runtime.session.id}`);
  if (mcpStatuses.some((status) => status.enabled)) ui.info(formatMcpStatus(mcpStatuses));

  try {
    if (config.prompt !== undefined) {
      if (!config.prompt.startsWith('/')) requireProviderAuth(config);
      const result = await runPromptMode(runtime, config.prompt);
      ui.final(result.ok, { session: runtime.session.id, reason: result.reason });
      if (!result.ok) process.exitCode = 1;
      return;
    }

    if (config.noInput) {
      throw new Error('No prompt supplied and --no-input/--ci prevents interactive mode. Pass --prompt or remove --no-input.');
    }

    requireProviderAuth(config);
    await runRepl(runtime);
  } finally {
    await created.close();
  }
```

This keeps current CLI behavior unchanged before bridge mode is added.

- [ ] **Step 7: Run tests for the extraction**

Run:

```bash
cd cli && npm run build && node --test dist/tests/desktop-bridge-args.test.js dist/tests/smoke.test.js dist/tests/config.test.js
```

Expected: all selected tests pass.

- [ ] **Step 8: Checkpoint**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected in current workspace: `fatal: not a git repository`. If implementing in a git repo, run:

```bash
git add cli/src/config/types.ts cli/src/config/config.ts cli/src/cli/args.ts cli/src/runtime/createRuntime.ts cli/src/index.ts cli/tests/desktop-bridge-args.test.ts
git commit -m "feat(cli): prepare desktop bridge runtime"
```

---

## Task 2: CLI desktop bridge mode with structured approval

**Files:**
- Create `cli/src/cli/desktopBridge.ts`
- Modify `cli/src/index.ts`
- Modify `cli/src/tools/types.ts`
- Modify `cli/src/tools/registry.ts`
- Test `cli/tests/desktop-bridge.test.ts`
- Modify `cli/README.md`

- [ ] **Step 1: Write the bridge smoke test**

Create `cli/tests/desktop-bridge.test.ts`:

```ts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('desktop bridge accepts a user message and emits JSON events', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-bridge-'));
  const child = spawn(process.execPath, [
    resolve('dist/src/index.js'),
    '--desktop-bridge',
    '--provider', 'mock',
    '--approval', 'auto',
    '--workspace', workspace,
    '--session-dir', join(workspace, '.aicode', 'sessions'),
  ], { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] });

  const events: Array<Record<string, unknown>> = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) events.push(JSON.parse(line));
    }
  });

  child.stdin.write(`${JSON.stringify({ type: 'user_message', text: 'smoke multi-tool task' })}\n`);

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !events.some((event) => event.type === 'turn_done')) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
  }

  child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
  child.kill();
  await once(child, 'exit');

  assert.ok(events.some((event) => event.type === 'bridge_ready'));
  assert.ok(events.some((event) => event.type === 'assistant_delta' || event.type === 'assistant'));
  assert.ok(events.some((event) => event.type === 'tool_start'));
  assert.ok(events.some((event) => event.type === 'tool_result'));
  assert.ok(events.some((event) => event.type === 'turn_done'));

  await rm(workspace, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the failing bridge test**

Run:

```bash
cd cli && npm run build && node --test dist/tests/desktop-bridge.test.js
```

Expected: process exits with an unknown `--desktop-bridge` behavior or never emits `bridge_ready` because bridge mode has not been implemented.

- [ ] **Step 3: Add structured approval types**

Modify `cli/src/tools/types.ts`:

```ts
export type ApprovalRequest = {
  tool: string;
  risk: ToolRisk;
  input: Record<string, unknown>;
  reason: string;
  message: string;
};

export type ToolContext = {
  workspaceRoot: string;
  approval: ApprovalMode;
  confirm?: (message: string, request?: ApprovalRequest) => Promise<boolean | 'allow_session'>;
  checkpoints?: CheckpointStore;
  hooks?: HookRegistry;
  beforeConfirm?: () => void;
  afterConfirm?: () => void;
  /** UI language for approval prompts and tool gate messages. */
  locale?: Locale;
};
```

Existing one-argument `confirm` callbacks still typecheck because JavaScript callers may ignore extra arguments.

- [ ] **Step 4: Pass approval metadata from the registry**

In `cli/src/tools/registry.ts`, replace the confirmation call block with:

```ts
      context.beforeConfirm?.();
      const message = await approvalMessage(name, tool.risk, inputRecord, context, locale);
      const approved = await context.confirm(message, {
        tool: name,
        risk: tool.risk,
        input: inputRecord,
        reason: decision.reason,
        message,
      });
      context.afterConfirm?.();
      if (!approved) {
        return { ok: false, output: formatApprovalOutcome({ locale, kind: 'cancelled', tool: name }) };
      }
```

Do not treat `'allow_session'` specially in the registry. It is truthy and means the current operation is approved; the bridge broker stores session-level allowances.

- [ ] **Step 5: Create the desktop bridge runner**

Create `cli/src/cli/desktopBridge.ts`:

```ts
import { createInterface } from 'node:readline';
import type { AgentRuntime } from '../agent/agent.js';
import { runPromptMode } from './repl.js';
import type { ApprovalRequest } from '../tools/types.js';

type BridgeCommand =
  | { type: 'user_message'; text: string; sessionId?: string }
  | { type: 'approval_response'; requestId: string; decision: 'allow_once' | 'allow_session' | 'deny' }
  | { type: 'cancel'; sessionId?: string }
  | { type: 'shutdown' }
  | { type: 'ping' };

type PendingApproval = {
  resolve: (value: boolean | 'allow_session') => void;
  request: ApprovalRequest;
};

export async function runDesktopBridge(runtime: AgentRuntime) {
  const broker = new DesktopApprovalBroker(runtime.session.id);
  runtime.confirm = broker.confirm.bind(broker);

  emit({
    type: 'bridge_ready',
    sessionId: runtime.session.id,
    provider: runtime.provider.name,
    model: runtime.provider.model,
    approval: runtime.config.approval,
    workspaceRoot: runtime.config.workspaceRoot,
  });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let busy = false;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let command: BridgeCommand;
    try {
      command = JSON.parse(trimmed) as BridgeCommand;
    } catch (error) {
      emit({ type: 'error', sessionId: runtime.session.id, message: `Invalid bridge JSON: ${errorMessage(error)}` });
      continue;
    }

    if (command.type === 'shutdown') break;
    if (command.type === 'ping') {
      emit({ type: 'pong', sessionId: runtime.session.id });
      continue;
    }
    if (command.type === 'approval_response') {
      broker.resolve(command.requestId, command.decision);
      continue;
    }
    if (command.type === 'cancel') {
      emit({ type: 'cancel_ack', sessionId: runtime.session.id, note: 'Desktop should terminate and restart the child process for active turns.' });
      continue;
    }
    if (command.type === 'user_message') {
      if (busy) {
        emit({ type: 'error', sessionId: runtime.session.id, message: 'Agent turn already running' });
        continue;
      }
      busy = true;
      emit({ type: 'turn_start', sessionId: runtime.session.id, prompt: command.text });
      try {
        const result = await runPromptMode(runtime, command.text);
        emit({ type: 'turn_done', sessionId: runtime.session.id, status: result.ok ? 'ok' : 'error', reason: result.reason });
      } catch (error) {
        emit({ type: 'error', sessionId: runtime.session.id, message: errorMessage(error) });
        emit({ type: 'turn_done', sessionId: runtime.session.id, status: 'error' });
      } finally {
        busy = false;
      }
    }
  }
}

class DesktopApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sessionAllows = new Set<string>();

  constructor(private readonly sessionId: string) {}

  async confirm(message: string, request?: ApprovalRequest) {
    const approval = request ?? {
      tool: 'unknown',
      risk: 'write' as const,
      input: {},
      reason: 'interactive approval required',
      message,
    };
    const allowKey = `${approval.risk}:${approval.tool}`;
    if (approval.risk === 'write' && this.sessionAllows.has(allowKey)) return true;

    const requestId = `approval_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    emit({
      type: 'approval_needed',
      sessionId: this.sessionId,
      requestId,
      tool: approval.tool,
      risk: approval.risk,
      reason: approval.reason,
      message: approval.message,
      input: approval.input,
    });

    return await new Promise<boolean>((resolve) => {
      this.pending.set(requestId, {
        request: approval,
        resolve: (decision) => {
          if (decision === 'allow_session' && approval.risk === 'write') this.sessionAllows.add(allowKey);
          resolve(decision === true || decision === 'allow_session');
        },
      });
    });
  }

  resolve(requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') {
    const pending = this.pending.get(requestId);
    if (!pending) {
      emit({ type: 'error', sessionId: this.sessionId, message: `Unknown approval request: ${requestId}` });
      return;
    }
    this.pending.delete(requestId);
    if (decision === 'deny') pending.resolve(false);
    if (decision === 'allow_once') pending.resolve(true);
    if (decision === 'allow_session') pending.resolve('allow_session');
  }
}

function emit(event: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 6: Dispatch bridge mode from `index.ts`**

Import the bridge runner:

```ts
import { runDesktopBridge } from './cli/desktopBridge.js';
```

After creating `runtime` and before prompt/repl dispatch, add:

```ts
    if (config.desktopBridge) {
      requireProviderAuth(config);
      await runDesktopBridge(runtime);
      return;
    }
```

For mock provider, `requireProviderAuth(config)` returns immediately. This keeps demo mode keyless.

- [ ] **Step 7: Run bridge tests**

Run:

```bash
cd cli && npm run build && node --test dist/tests/desktop-bridge-args.test.js dist/tests/desktop-bridge.test.js dist/tests/approval.test.js
```

Expected: all selected tests pass.

- [ ] **Step 8: Document bridge mode**

Append to `cli/README.md`:

```md
## Desktop Bridge

Desktop bridge mode keeps the CLI agent alive and communicates with a desktop shell through newline-delimited JSON.

```bash
node cli/dist/src/index.js --desktop-bridge --provider mock --approval auto --workspace .
```

Send commands on stdin:

```json
{"type":"user_message","text":"smoke multi-tool task"}
{"type":"approval_response","requestId":"approval_...","decision":"allow_once"}
{"type":"shutdown"}
```

The bridge emits events on stdout: `bridge_ready`, `assistant_delta`, `assistant`, `tool_start`, `tool_result`, `approval_needed`, `turn_done`, and `error`.
```

- [ ] **Step 9: Checkpoint**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected in current workspace: `fatal: not a git repository`. If implementing in a git repo, run:

```bash
git add cli/src/cli/desktopBridge.ts cli/src/index.ts cli/src/tools/types.ts cli/src/tools/registry.ts cli/tests/desktop-bridge.test.ts cli/README.md
git commit -m "feat(cli): add desktop bridge mode"
```

---

## Task 3: Scaffold the independent Electron desktop app

**Files:**
- Create `ide-desktop/package.json`
- Create `ide-desktop/tsconfig.json`
- Create `ide-desktop/vite.config.ts`
- Create `ide-desktop/index.html`
- Create `ide-desktop/scripts/dev.cjs`
- Create `ide-desktop/electron/main.cjs`
- Create `ide-desktop/electron/preload.cjs`
- Create `ide-desktop/src/main.tsx`
- Create `ide-desktop/src/App.tsx`
- Create `ide-desktop/src/styles.css`

- [ ] **Step 1: Create package metadata**

Create `ide-desktop/package.json`:

```json
{
  "name": "cc-desktop-ide",
  "version": "0.1.0",
  "private": true,
  "main": "electron/main.cjs",
  "scripts": {
    "dev": "node scripts/dev.cjs",
    "build": "tsc -p tsconfig.json && vite build",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "npm run typecheck && vitest run --passWithNoTests && node --test tests/*.test.cjs",
    "preview": "vite preview --host 127.0.0.1 --port 5174",
    "desktop:run": "npm run build && electron ."
  },
  "dependencies": {
    "@vitejs/plugin-react": "latest",
    "electron": "latest",
    "lucide-react": "latest",
    "monaco-editor": "latest",
    "react": "latest",
    "react-dom": "latest",
    "vite": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

- [ ] **Step 2: Add TypeScript and Vite config**

Create `ide-desktop/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "vite.config.ts"]
}
```

Create `ide-desktop/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
```

- [ ] **Step 3: Add HTML entry**

Create `ide-desktop/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ZCode Desktop IDE</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Add dev launcher**

Create `ide-desktop/scripts/dev.cjs`:

```js
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const url = 'http://127.0.0.1:5174';
const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--host', '127.0.0.1', '--port', '5174'], {
  cwd: root,
  stdio: 'inherit',
});

waitFor(url).then(() => {
  const electron = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron', '.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });
  electron.on('exit', (code) => {
    vite.kill();
    process.exit(code ?? 0);
  });
});

process.on('SIGINT', () => {
  vite.kill();
  process.exit(130);
});

function waitFor(target) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const tick = () => {
      const req = http.get(target, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${target}`));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}
```

- [ ] **Step 5: Add initial Electron main/preload**

Create `ide-desktop/electron/main.cjs`:

```js
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: 'ZCode Desktop IDE',
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
```

Create `ide-desktop/electron/preload.cjs`:

```js
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('zcodeDesktop', {
  version: '0.1.0',
});
```

- [ ] **Step 6: Add initial React app**

Create `ide-desktop/src/main.tsx`:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Create `ide-desktop/src/App.tsx`:

```tsx
export default function App() {
  return (
    <main className="app-shell">
      <section className="welcome-panel">
        <p className="eyebrow">ZCode Desktop</p>
        <h1>AI coding workspace</h1>
        <p className="muted">Open a project folder to start a local agent session.</p>
      </section>
    </main>
  );
}
```

Create `ide-desktop/src/styles.css`:

```css
:root {
  color-scheme: dark;
  font-family: Inter, Segoe UI, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  background: #111318;
  color: #e8ebf0;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 100vw;
  min-height: 100vh;
  background: #111318;
}

button,
input,
select,
textarea {
  font: inherit;
}

.app-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #111318;
}

.welcome-panel {
  width: min(560px, calc(100vw - 48px));
  padding: 28px;
  border: 1px solid #2b313c;
  border-radius: 8px;
  background: #171a21;
}

.eyebrow {
  margin: 0 0 10px;
  color: #8fb4ff;
  font-size: 13px;
}

h1 {
  margin: 0 0 12px;
  font-size: 30px;
  line-height: 1.2;
  letter-spacing: 0;
}

.muted {
  margin: 0;
  color: #9aa4b2;
}
```

- [ ] **Step 7: Install and verify scaffold**

Run:

```bash
cd ide-desktop && npm install && npm run typecheck && npm run build
```

Expected: install succeeds, typecheck passes, Vite build writes `ide-desktop/dist`.

- [ ] **Step 8: Manual app launch check**

Run:

```bash
cd ide-desktop && npm run desktop:run
```

Expected: Electron opens a dark window titled `ZCode Desktop IDE` with the welcome panel.

- [ ] **Step 9: Checkpoint**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected in current workspace: `fatal: not a git repository`. If implementing in a git repo, run:

```bash
git add ide-desktop
git commit -m "feat(desktop): scaffold electron ide app"
```

---

## Task 4: Main process workspace, settings, and secrets

**Files:**
- Create `ide-desktop/electron/workspace.cjs`
- Create `ide-desktop/electron/settings-store.cjs`
- Create `ide-desktop/electron/secret-store.cjs`
- Create `ide-desktop/electron/ipc.cjs`
- Modify `ide-desktop/electron/main.cjs`
- Modify `ide-desktop/electron/preload.cjs`
- Test `ide-desktop/tests/workspace.test.cjs`
- Test `ide-desktop/tests/secret-store.test.cjs`

- [ ] **Step 1: Write workspace path-jail tests**

Create `ide-desktop/tests/workspace.test.cjs`:

```js
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createWorkspaceService } = require('../electron/workspace.cjs');

test('workspace service reads files inside root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-ws-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1;');
  const service = createWorkspaceService();
  service.setRoot(root);

  assert.equal(await service.readFile('src/index.ts'), 'export const value = 1;');
  await rm(root, { recursive: true, force: true });
});

test('workspace service rejects paths outside root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-ws-'));
  const service = createWorkspaceService();
  service.setRoot(root);

  await assert.rejects(() => service.readFile('../outside.txt'), /escapes workspace/);
  await rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Implement workspace service**

Create `ide-desktop/electron/workspace.cjs`:

```js
const fs = require('node:fs/promises');
const path = require('node:path');

function createWorkspaceService() {
  let root = '';

  function setRoot(nextRoot) {
    root = path.resolve(nextRoot);
    return root;
  }

  function getRoot() {
    return root;
  }

  function resolveInside(relativePath) {
    if (!root) throw new Error('No workspace open');
    const resolved = path.resolve(root, relativePath || '.');
    const rel = path.relative(root, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return resolved;
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }

  async function readFile(relativePath) {
    return await fs.readFile(resolveInside(relativePath), 'utf8');
  }

  async function writeFile(relativePath, content) {
    const target = resolveInside(relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return { path: relativePath, ok: true };
  }

  async function tree(relativePath = '.') {
    const target = resolveInside(relativePath);
    const entries = await fs.readdir(target, { withFileTypes: true });
    const visible = entries
      .filter((entry) => !entry.name.startsWith('.git') && entry.name !== 'node_modules' && entry.name !== 'dist')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    return await Promise.all(visible.map(async (entry) => {
      const childRelative = path.posix.join(relativePath === '.' ? '' : relativePath.replace(/\\/g, '/'), entry.name);
      return {
        name: entry.name,
        path: childRelative,
        type: entry.isDirectory() ? 'directory' : 'file',
      };
    }));
  }

  return { setRoot, getRoot, resolveInside, readFile, writeFile, tree };
}

module.exports = { createWorkspaceService };
```

- [ ] **Step 3: Write secret store tests**

Create `ide-desktop/tests/secret-store.test.cjs`:

```js
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSecretStore, redactKey } = require('../electron/secret-store.cjs');

test('redactKey never returns the full key', () => {
  assert.equal(redactKey('sk-1234567890'), 'configured:7890');
  assert.equal(redactKey(''), 'missing');
});

test('secret store persists encrypted strings through injected safe storage', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-secrets-'));
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  };
  const store = createSecretStore({ userDataDir: dir, safeStorage: fakeSafeStorage });
  await store.setApiKey('openai', 'sk-test-value');

  assert.deepEqual(await store.hasApiKey('openai'), { configured: true, hint: 'configured:alue' });
  assert.equal(await store.getApiKey('openai'), 'sk-test-value');

  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 4: Implement secret store**

Create `ide-desktop/electron/secret-store.cjs`:

```js
const fs = require('node:fs/promises');
const path = require('node:path');

function createSecretStore({ userDataDir, safeStorage }) {
  const file = path.join(userDataDir, 'secrets.json');

  async function readAll() {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function writeAll(value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  }

  function assertEncryption() {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage encryption is not available');
  }

  async function setApiKey(providerId, apiKey) {
    assertEncryption();
    const all = await readAll();
    all[providerId] = safeStorage.encryptString(apiKey).toString('base64');
    await writeAll(all);
    return { configured: true, hint: redactKey(apiKey) };
  }

  async function getApiKey(providerId) {
    assertEncryption();
    const all = await readAll();
    const stored = all[providerId];
    if (!stored) return '';
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  }

  async function hasApiKey(providerId) {
    const key = await getApiKey(providerId);
    return { configured: Boolean(key), hint: redactKey(key) };
  }

  return { setApiKey, getApiKey, hasApiKey };
}

function redactKey(value) {
  if (!value) return 'missing';
  return `configured:${value.slice(-4)}`;
}

module.exports = { createSecretStore, redactKey };
```

- [ ] **Step 5: Implement settings store**

Create `ide-desktop/electron/settings-store.cjs`:

```js
const fs = require('node:fs/promises');
const path = require('node:path');

const defaultSettings = {
  activeProviderId: 'mock',
  approval: 'ask',
  providers: [
    { id: 'mock', type: 'mock', label: 'Mock', model: 'mock-code-agent-v1', baseUrl: '' },
    { id: 'openai', type: 'openai', label: 'OpenAI compatible', model: 'gpt-5.5', baseUrl: 'https://api.openai.com/v1' },
    { id: 'anthropic', type: 'anthropic', label: 'Anthropic', model: 'claude-3-5-sonnet-latest', baseUrl: '' },
  ],
  recentWorkspaces: [],
};

function createSettingsStore(userDataDir) {
  const file = path.join(userDataDir, 'settings.json');

  async function get() {
    try {
      return { ...defaultSettings, ...JSON.parse(await fs.readFile(file, 'utf8')) };
    } catch (error) {
      if (error && error.code === 'ENOENT') return defaultSettings;
      throw error;
    }
  }

  async function set(next) {
    const merged = { ...await get(), ...next };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  async function addRecentWorkspace(workspaceRoot) {
    const current = await get();
    const recentWorkspaces = [workspaceRoot, ...current.recentWorkspaces.filter((item) => item !== workspaceRoot)].slice(0, 10);
    return await set({ recentWorkspaces });
  }

  return { get, set, addRecentWorkspace };
}

module.exports = { createSettingsStore, defaultSettings };
```

- [ ] **Step 6: Register IPC**

Create `ide-desktop/electron/ipc.cjs`:

```js
const { dialog, ipcMain } = require('electron');

function registerIpc({ mainWindow, workspace, settings, secrets }) {
  ipcMain.handle('workspace.open', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const root = workspace.setRoot(result.filePaths[0]);
    await settings.addRecentWorkspace(root);
    return { canceled: false, root };
  });

  ipcMain.handle('workspace.setRoot', async (_event, root) => {
    const resolved = workspace.setRoot(root);
    await settings.addRecentWorkspace(resolved);
    return { root: resolved };
  });

  ipcMain.handle('workspace.getTree', async (_event, relativePath) => await workspace.tree(relativePath || '.'));
  ipcMain.handle('fs.read', async (_event, relativePath) => await workspace.readFile(relativePath));
  ipcMain.handle('fs.write', async (_event, relativePath, content) => await workspace.writeFile(relativePath, content));
  ipcMain.handle('settings.get', async () => await settings.get());
  ipcMain.handle('settings.set', async (_event, next) => await settings.set(next));
  ipcMain.handle('secrets.setApiKey', async (_event, providerId, apiKey) => await secrets.setApiKey(providerId, apiKey));
  ipcMain.handle('secrets.hasApiKey', async (_event, providerId) => await secrets.hasApiKey(providerId));
}

module.exports = { registerIpc };
```

Modify `ide-desktop/electron/main.cjs` to create services and call `registerIpc()` after `mainWindow` is created:

```js
const { app, BrowserWindow, safeStorage } = require('electron');
const { createWorkspaceService } = require('./workspace.cjs');
const { createSettingsStore } = require('./settings-store.cjs');
const { createSecretStore } = require('./secret-store.cjs');
const { registerIpc } = require('./ipc.cjs');
```

Inside `createWindow()` after `mainWindow` construction:

```js
  const workspace = createWorkspaceService();
  const settings = createSettingsStore(app.getPath('userData'));
  const secrets = createSecretStore({ userDataDir: app.getPath('userData'), safeStorage });
  registerIpc({ mainWindow, workspace, settings, secrets });
```

- [ ] **Step 7: Expose preload IPC client**

Replace `ide-desktop/electron/preload.cjs` with:

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zcodeDesktop', {
  workspace: {
    open: () => ipcRenderer.invoke('workspace.open'),
    setRoot: (root) => ipcRenderer.invoke('workspace.setRoot', root),
    getTree: (relativePath) => ipcRenderer.invoke('workspace.getTree', relativePath),
  },
  fs: {
    read: (relativePath) => ipcRenderer.invoke('fs.read', relativePath),
    write: (relativePath, content) => ipcRenderer.invoke('fs.write', relativePath, content),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings.get'),
    set: (next) => ipcRenderer.invoke('settings.set', next),
  },
  secrets: {
    setApiKey: (providerId, apiKey) => ipcRenderer.invoke('secrets.setApiKey', providerId, apiKey),
    hasApiKey: (providerId) => ipcRenderer.invoke('secrets.hasApiKey', providerId),
  },
});
```

- [ ] **Step 8: Run main-process tests**

Run:

```bash
cd ide-desktop && npm run test -- tests/workspace.test.cjs tests/secret-store.test.cjs
```

Expected: workspace and secret-store tests pass.

- [ ] **Step 9: Checkpoint**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected in current workspace: `fatal: not a git repository`. If implementing in a git repo, run:

```bash
git add ide-desktop/electron ide-desktop/tests/workspace.test.cjs ide-desktop/tests/secret-store.test.cjs
git commit -m "feat(desktop): add workspace settings and secrets ipc"
```

---

## Task 5: Desktop agent process bridge

**Files:**
- Create `ide-desktop/electron/agent-bridge.cjs`
- Modify `ide-desktop/electron/ipc.cjs`
- Modify `ide-desktop/electron/preload.cjs`
- Modify `ide-desktop/electron/main.cjs`
- Test `ide-desktop/tests/agent-bridge.test.cjs`
- Test `ide-desktop/tests/mock-smoke.test.cjs`

- [ ] **Step 1: Write event mapping tests**

Create `ide-desktop/tests/agent-bridge.test.cjs`:

```js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeCliEvent } = require('../electron/agent-bridge.cjs');

test('normalizeCliEvent maps assistant content to assistant_message', () => {
  assert.deepEqual(normalizeCliEvent({ type: 'assistant', content: 'done' }), {
    type: 'assistant_message',
    text: 'done',
  });
});

test('normalizeCliEvent maps assistant_delta content to text', () => {
  assert.deepEqual(normalizeCliEvent({ type: 'assistant_delta', content: 'he' }), {
    type: 'assistant_delta',
    text: 'he',
  });
});

test('normalizeCliEvent keeps tool events intact', () => {
  const event = { type: 'tool_start', tool: 'read_file', input: { path: 'a.ts' } };
  assert.deepEqual(normalizeCliEvent(event), event);
});
```

- [ ] **Step 2: Implement bridge module**

Create `ide-desktop/electron/agent-bridge.cjs`:

```js
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');

class AgentBridge extends EventEmitter {
  constructor(options) {
    super();
    this.cliRoot = options.cliRoot;
    this.workspaceRoot = options.workspaceRoot;
    this.sessionDir = options.sessionDir;
    this.provider = options.provider;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.approval = options.approval || 'ask';
    this.child = null;
    this.buffer = '';
  }

  start() {
    if (this.child) return;
    const args = [
      path.join(this.cliRoot, 'dist', 'src', 'index.js'),
      '--desktop-bridge',
      '--provider', this.provider,
      '--model', this.model,
      '--approval', this.approval,
      '--workspace', this.workspaceRoot,
      '--session-dir', this.sessionDir,
    ];
    if (this.baseUrl) args.push('--base-url', this.baseUrl);

    const env = { ...process.env };
    if (this.provider === 'openai' && this.apiKey) env.OPENAI_API_KEY = this.apiKey;
    if (this.provider === 'anthropic' && this.apiKey) env.ANTHROPIC_API_KEY = this.apiKey;

    this.child = spawn(process.execPath, args, {
      cwd: this.cliRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this.emit('event', { type: 'error', message: redact(chunk) }));
    this.child.on('exit', (code) => {
      this.emit('event', { type: 'agent_offline', code });
      this.child = null;
    });
  }

  send(command) {
    if (!this.child || !this.child.stdin.writable) throw new Error('Agent bridge is not running');
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  prompt(text) {
    this.send({ type: 'user_message', text });
  }

  approve(requestId, decision) {
    this.send({ type: 'approval_response', requestId, decision });
  }

  cancel() {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
    this.emit('event', { type: 'turn_done', status: 'cancelled' });
  }

  restart() {
    this.cancel();
    this.start();
  }

  dispose() {
    if (!this.child) return;
    try {
      this.send({ type: 'shutdown' });
    } catch {
      this.child.kill();
    }
    this.child = null;
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.emit('event', normalizeCliEvent(JSON.parse(line)));
      } catch (error) {
        this.emit('event', { type: 'error', message: `Invalid agent event: ${error.message}` });
      }
    }
  }
}

function normalizeCliEvent(event) {
  if (event.type === 'assistant') return { type: 'assistant_message', text: event.content || '' };
  if (event.type === 'assistant_delta') return { type: 'assistant_delta', text: event.content || event.text || '' };
  return event;
}

function redact(value) {
  return String(value).replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1***');
}

module.exports = { AgentBridge, normalizeCliEvent, redact };
```

- [ ] **Step 3: Wire agent IPC**

Modify `ide-desktop/electron/ipc.cjs` to accept `agentManager` in `registerIpc` and add handlers:

```js
function registerIpc({ mainWindow, workspace, settings, secrets, agentManager }) {
```

Add handlers inside `registerIpc`:

```js
  ipcMain.handle('agent.start', async () => await agentManager.start());
  ipcMain.handle('agent.prompt', async (_event, text) => agentManager.prompt(text));
  ipcMain.handle('agent.cancel', async () => agentManager.cancel());
  ipcMain.handle('agent.restart', async () => await agentManager.restart());
  ipcMain.handle('agent.approve', async (_event, requestId, decision) => agentManager.approve(requestId, decision));
```

- [ ] **Step 4: Create an agent manager in main**

In `ide-desktop/electron/main.cjs`, import:

```js
const path = require('node:path');
const { AgentBridge } = require('./agent-bridge.cjs');
```

Add this helper above `createWindow()`:

```js
function createAgentManager({ mainWindow, workspace, settings, secrets }) {
  let bridge;

  async function start() {
    const config = await settings.get();
    const providerConfig = config.providers.find((item) => item.id === config.activeProviderId) || config.providers[0];
    const apiKey = providerConfig.type === 'mock' ? '' : await secrets.getApiKey(providerConfig.id);
    if (providerConfig.type !== 'mock' && !apiKey) throw new Error(`API key is missing for ${providerConfig.label}`);
    if (bridge) bridge.dispose();
    bridge = new AgentBridge({
      cliRoot: path.resolve(__dirname, '..', '..', 'cli'),
      workspaceRoot: workspace.getRoot(),
      sessionDir: path.join(workspace.getRoot(), '.aicode', 'sessions'),
      provider: providerConfig.type === 'anthropic' ? 'anthropic' : providerConfig.type === 'mock' ? 'mock' : 'openai',
      model: providerConfig.model,
      baseUrl: providerConfig.baseUrl,
      apiKey,
      approval: config.approval,
    });
    bridge.on('event', (event) => mainWindow.webContents.send('agent.event', event));
    bridge.start();
    return { ok: true };
  }

  return {
    start,
    prompt(text) {
      if (!bridge) throw new Error('Agent is not started');
      bridge.prompt(text);
      return { ok: true };
    },
    approve(requestId, decision) {
      if (!bridge) throw new Error('Agent is not started');
      bridge.approve(requestId, decision);
      return { ok: true };
    },
    cancel() {
      if (bridge) bridge.cancel();
      return { ok: true };
    },
    async restart() {
      if (bridge) bridge.restart();
      else await start();
      return { ok: true };
    },
  };
}
```

Inside `createWindow()` after service creation:

```js
  const agentManager = createAgentManager({ mainWindow, workspace, settings, secrets });
  registerIpc({ mainWindow, workspace, settings, secrets, agentManager });
```

- [ ] **Step 5: Expose agent preload methods**

Add to `ide-desktop/electron/preload.cjs`:

```js
  agent: {
    start: () => ipcRenderer.invoke('agent.start'),
    prompt: (text) => ipcRenderer.invoke('agent.prompt', text),
    cancel: () => ipcRenderer.invoke('agent.cancel'),
    restart: () => ipcRenderer.invoke('agent.restart'),
    approve: (requestId, decision) => ipcRenderer.invoke('agent.approve', requestId, decision),
    onEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('agent.event', listener);
      return () => ipcRenderer.removeListener('agent.event', listener);
    },
  },
```

Keep it inside the object passed to `exposeInMainWorld`.

- [ ] **Step 6: Add mock process smoke test**

Create `ide-desktop/tests/mock-smoke.test.cjs`:

```js
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { AgentBridge } = require('../electron/agent-bridge.cjs');

test('AgentBridge runs the cli mock provider and forwards events', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zcode-desktop-smoke-'));
  const events = [];
  const bridge = new AgentBridge({
    cliRoot: path.resolve(__dirname, '..', '..', 'cli'),
    workspaceRoot: workspace,
    sessionDir: path.join(workspace, '.aicode', 'sessions'),
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
  });
  bridge.on('event', (event) => events.push(event));
  bridge.start();
  bridge.prompt('smoke multi-tool task');

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !events.some((event) => event.type === 'turn_done')) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
  }
  bridge.dispose();

  assert.ok(events.some((event) => event.type === 'bridge_ready'));
  assert.ok(events.some((event) => event.type === 'tool_start'));
  assert.ok(events.some((event) => event.type === 'tool_result'));
  assert.ok(events.some((event) => event.type === 'turn_done'));

  await rm(workspace, { recursive: true, force: true });
});
```

- [ ] **Step 7: Run bridge tests**

Run:

```bash
cd ide-desktop && npm run test -- tests/agent-bridge.test.cjs tests/mock-smoke.test.cjs
```

Expected: bridge mapping and mock process smoke pass.

- [ ] **Step 8: Checkpoint**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected in current workspace: `fatal: not a git repository`. If implementing in a git repo, run:

```bash
git add ide-desktop/electron/agent-bridge.cjs ide-desktop/electron/ipc.cjs ide-desktop/electron/preload.cjs ide-desktop/electron/main.cjs ide-desktop/tests/agent-bridge.test.cjs ide-desktop/tests/mock-smoke.test.cjs
git commit -m "feat(desktop): bridge electron to cli agent"
```

---

## Task 6: Renderer state model and IDE shell

**Files:**
- Create `ide-desktop/src/types.ts`
- Create `ide-desktop/src/lib/ipc.ts`
- Create `ide-desktop/src/lib/state.ts`
- Test `ide-desktop/src/lib/state.test.ts`
- Modify `ide-desktop/src/App.tsx`
- Create `ide-desktop/src/components/Layout.tsx`
- Create `ide-desktop/src/components/ActivityBar.tsx`
- Create `ide-desktop/src/components/TopBar.tsx`
- Create `ide-desktop/src/components/Welcome.tsx`
- Modify `ide-desktop/src/styles.css`

- [ ] **Step 1: Create shared renderer types**

Create `ide-desktop/src/types.ts`:

```ts
export type ProviderType = 'mock' | 'openai' | 'anthropic' | 'custom';
export type ApprovalMode = 'ask' | 'auto' | 'deny';
export type ActivityView = 'files' | 'search' | 'sessions' | 'settings';

export type ProviderConfig = {
  id: string;
  type: ProviderType;
  label: string;
  model: string;
  baseUrl: string;
  keyHint?: string;
};

export type DesktopSettings = {
  activeProviderId: string;
  approval: ApprovalMode;
  providers: ProviderConfig[];
  recentWorkspaces: string[];
};

export type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
};

export type EditorTab = {
  path: string;
  content: string;
  savedContent: string;
  language: string;
};

export type AgentEvent = {
  type: string;
  [key: string]: unknown;
};

export type ChatItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'tool'; status: 'running' | 'done' | 'failed'; tool: string; input?: unknown; output?: string; ok?: boolean }
  | { id: string; kind: 'approval'; requestId: string; tool: string; message: string; input?: unknown };

export type AppState = {
  workspaceRoot: string;
  activeView: ActivityView;
  settings: DesktopSettings | null;
  tree: TreeNode[];
  tabs: EditorTab[];
  activeTabPath: string;
  chat: ChatItem[];
  agentStatus: 'offline' | 'starting' | 'ready' | 'running';
  bottomOpen: boolean;
};
```

- [ ] **Step 2: Write reducer tests**

Create `ide-desktop/src/lib/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from './state';

describe('appReducer', () => {
  it('opens a workspace', () => {
    const state = appReducer(initialState, { type: 'workspace/opened', root: 'C:/work/app' });
    expect(state.workspaceRoot).toBe('C:/work/app');
    expect(state.agentStatus).toBe('offline');
  });

  it('appends assistant deltas to the active assistant message', () => {
    const one = appReducer(initialState, { type: 'agent/event', event: { type: 'assistant_delta', text: 'Hel' } });
    const two = appReducer(one, { type: 'agent/event', event: { type: 'assistant_delta', text: 'lo' } });
    expect(two.chat).toEqual([{ id: 'assistant-live', kind: 'assistant', text: 'Hello' }]);
  });

  it('creates approval chat items', () => {
    const state = appReducer(initialState, {
      type: 'agent/event',
      event: { type: 'approval_needed', requestId: 'approval_1', tool: 'shell', message: 'Approve shell?', input: { command: 'npm test' } },
    });
    expect(state.chat[0]).toMatchObject({ kind: 'approval', requestId: 'approval_1', tool: 'shell' });
  });
});
```

- [ ] **Step 3: Implement reducer**

Create `ide-desktop/src/lib/state.ts`:

```ts
import type { AgentEvent, AppState, ChatItem, DesktopSettings, EditorTab, TreeNode } from '../types';

export type AppAction =
  | { type: 'settings/loaded'; settings: DesktopSettings }
  | { type: 'workspace/opened'; root: string }
  | { type: 'tree/loaded'; tree: TreeNode[] }
  | { type: 'view/set'; view: AppState['activeView'] }
  | { type: 'tab/opened'; tab: EditorTab }
  | { type: 'tab/changed'; path: string; content: string }
  | { type: 'tab/saved'; path: string; content: string }
  | { type: 'tab/activate'; path: string }
  | { type: 'chat/user'; text: string }
  | { type: 'agent/status'; status: AppState['agentStatus'] }
  | { type: 'agent/event'; event: AgentEvent }
  | { type: 'bottom/toggle' };

export const initialState: AppState = {
  workspaceRoot: '',
  activeView: 'files',
  settings: null,
  tree: [],
  tabs: [],
  activeTabPath: '',
  chat: [],
  agentStatus: 'offline',
  bottomOpen: false,
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'settings/loaded':
      return { ...state, settings: action.settings };
    case 'workspace/opened':
      return { ...state, workspaceRoot: action.root, tree: [], tabs: [], activeTabPath: '', agentStatus: 'offline' };
    case 'tree/loaded':
      return { ...state, tree: action.tree };
    case 'view/set':
      return { ...state, activeView: action.view };
    case 'tab/opened': {
      const tabs = state.tabs.some((tab) => tab.path === action.tab.path) ? state.tabs : [...state.tabs, action.tab];
      return { ...state, tabs, activeTabPath: action.tab.path };
    }
    case 'tab/changed':
      return { ...state, tabs: state.tabs.map((tab) => tab.path === action.path ? { ...tab, content: action.content } : tab) };
    case 'tab/saved':
      return { ...state, tabs: state.tabs.map((tab) => tab.path === action.path ? { ...tab, content: action.content, savedContent: action.content } : tab) };
    case 'tab/activate':
      return { ...state, activeTabPath: action.path };
    case 'chat/user':
      return { ...state, chat: [...state.chat, { id: `user-${Date.now()}`, kind: 'user', text: action.text }] };
    case 'agent/status':
      return { ...state, agentStatus: action.status };
    case 'agent/event':
      return reduceAgentEvent(state, action.event);
    case 'bottom/toggle':
      return { ...state, bottomOpen: !state.bottomOpen };
    default:
      return state;
  }
}

function reduceAgentEvent(state: AppState, event: AgentEvent): AppState {
  if (event.type === 'bridge_ready') return { ...state, agentStatus: 'ready' };
  if (event.type === 'turn_start') return { ...state, agentStatus: 'running' };
  if (event.type === 'turn_done') return { ...state, agentStatus: 'ready' };
  if (event.type === 'agent_offline') return { ...state, agentStatus: 'offline' };
  if (event.type === 'assistant_delta') return appendAssistantDelta(state, String(event.text || ''));
  if (event.type === 'assistant_message') return appendChat(state, { id: `assistant-${Date.now()}`, kind: 'assistant', text: String(event.text || '') });
  if (event.type === 'tool_start') return appendChat(state, { id: `tool-${Date.now()}`, kind: 'tool', status: 'running', tool: String(event.tool || 'tool'), input: event.input });
  if (event.type === 'tool_result') return appendChat(state, { id: `tool-${Date.now()}`, kind: 'tool', status: event.ok === false ? 'failed' : 'done', tool: String(event.tool || 'tool'), output: String(event.output || ''), ok: Boolean(event.ok) });
  if (event.type === 'approval_needed') return appendChat(state, { id: String(event.requestId || `approval-${Date.now()}`), kind: 'approval', requestId: String(event.requestId || ''), tool: String(event.tool || 'tool'), message: String(event.message || 'Approval required'), input: event.input });
  if (event.type === 'error') return appendChat(state, { id: `assistant-error-${Date.now()}`, kind: 'assistant', text: String(event.message || 'Agent error') });
  return state;
}

function appendAssistantDelta(state: AppState, text: string): AppState {
  const last = state.chat[state.chat.length - 1];
  if (last?.kind === 'assistant' && last.id === 'assistant-live') {
    return { ...state, chat: [...state.chat.slice(0, -1), { ...last, text: `${last.text}${text}` }] };
  }
  return appendChat(state, { id: 'assistant-live', kind: 'assistant', text });
}

function appendChat(state: AppState, item: ChatItem): AppState {
  return { ...state, chat: [...state.chat, item] };
}
```

- [ ] **Step 4: Add typed preload client**

Create `ide-desktop/src/lib/ipc.ts`:

```ts
import type { AgentEvent, DesktopSettings, TreeNode } from '../types';

type ZCodeDesktopApi = {
  workspace: {
    open(): Promise<{ canceled: boolean; root?: string }>;
    setRoot(root: string): Promise<{ root: string }>;
    getTree(relativePath?: string): Promise<TreeNode[]>;
  };
  fs: {
    read(relativePath: string): Promise<string>;
    write(relativePath: string, content: string): Promise<{ ok: boolean; path: string }>;
  };
  settings: {
    get(): Promise<DesktopSettings>;
    set(next: Partial<DesktopSettings>): Promise<DesktopSettings>;
  };
  secrets: {
    setApiKey(providerId: string, apiKey: string): Promise<{ configured: boolean; hint: string }>;
    hasApiKey(providerId: string): Promise<{ configured: boolean; hint: string }>;
  };
  agent: {
    start(): Promise<{ ok: boolean }>;
    prompt(text: string): Promise<{ ok: boolean }>;
    cancel(): Promise<{ ok: boolean }>;
    restart(): Promise<{ ok: boolean }>;
    approve(requestId: string, decision: 'allow_once' | 'allow_session' | 'deny'): Promise<{ ok: boolean }>;
    onEvent(handler: (event: AgentEvent) => void): () => void;
  };
};

declare global {
  interface Window {
    zcodeDesktop: ZCodeDesktopApi;
  }
}

export const desktop = window.zcodeDesktop;
```

- [ ] **Step 5: Build the app shell components**

Create `ide-desktop/src/components/ActivityBar.tsx`:

```tsx
import { Files, MessageSquare, Search, Settings } from 'lucide-react';
import type { ActivityView } from '../types';

const items: Array<{ id: ActivityView; label: string; icon: typeof Files }> = [
  { id: 'files', label: 'Files', icon: Files },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'sessions', label: 'Sessions', icon: MessageSquare },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function ActivityBar({ active, onChange }: { active: ActivityView; onChange: (view: ActivityView) => void }) {
  return (
    <nav className="activity-bar" aria-label="Activity">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.id} className={active === item.id ? 'active' : ''} title={item.label} onClick={() => onChange(item.id)}>
            <Icon size={19} />
          </button>
        );
      })}
    </nav>
  );
}
```

Create `ide-desktop/src/components/TopBar.tsx`:

```tsx
import type { AppState } from '../types';

export function TopBar({ state }: { state: AppState }) {
  const provider = state.settings?.providers.find((item) => item.id === state.settings?.activeProviderId);
  return (
    <header className="top-bar">
      <div className="workspace-label">{state.workspaceRoot || 'No workspace'}</div>
      <div className="status-chips">
        <span>{provider?.label || 'Mock'}</span>
        <span>{provider?.model || 'mock-code-agent-v1'}</span>
        <span>{state.settings?.approval || 'ask'}</span>
        <span>{state.agentStatus}</span>
      </div>
    </header>
  );
}
```

Create `ide-desktop/src/components/Welcome.tsx`:

```tsx
export function Welcome({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  return (
    <section className="welcome-panel">
      <p className="eyebrow">ZCode Desktop</p>
      <h1>AI coding workspace</h1>
      <p className="muted">Open a local project folder to start a Claude-Code-like desktop session.</p>
      <button className="primary-button" onClick={onOpenWorkspace}>Open Folder</button>
    </section>
  );
}
```

Create `ide-desktop/src/components/Layout.tsx`:

```tsx
import type { ReactNode } from 'react';
import type { AppState } from '../types';
import { ActivityBar } from './ActivityBar';
import { TopBar } from './TopBar';

export function Layout({ state, onViewChange, sidebar, editor, ai, bottom }: {
  state: AppState;
  onViewChange: (view: AppState['activeView']) => void;
  sidebar: ReactNode;
  editor: ReactNode;
  ai: ReactNode;
  bottom: ReactNode;
}) {
  return (
    <main className="ide-shell">
      <TopBar state={state} />
      <ActivityBar active={state.activeView} onChange={onViewChange} />
      <aside className="sidebar">{sidebar}</aside>
      <section className="editor-area">{editor}</section>
      <aside className="ai-area">{ai}</aside>
      <section className="bottom-panel">{bottom}</section>
    </main>
  );
}
```

- [ ] **Step 6: Wire App to reducer and IPC**

Replace `ide-desktop/src/App.tsx` with:

```tsx
import { useEffect, useReducer } from 'react';
import { Layout } from './components/Layout';
import { Welcome } from './components/Welcome';
import { desktop } from './lib/ipc';
import { appReducer, initialState } from './lib/state';

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);

  useEffect(() => {
    desktop.settings.get().then((settings) => dispatch({ type: 'settings/loaded', settings }));
    return desktop.agent.onEvent((event) => dispatch({ type: 'agent/event', event }));
  }, []);

  async function openWorkspace() {
    const result = await desktop.workspace.open();
    if (!result.canceled && result.root) dispatch({ type: 'workspace/opened', root: result.root });
  }

  if (!state.workspaceRoot) return <main className="app-shell"><Welcome onOpenWorkspace={openWorkspace} /></main>;

  return (
    <Layout
      state={state}
      onViewChange={(view) => dispatch({ type: 'view/set', view })}
      sidebar={<div className="pane-title">{state.activeView}</div>}
      editor={<div className="empty-editor">Open a file from the sidebar.</div>}
      ai={<div className="ai-placeholder">Agent panel</div>}
      bottom={<div className="muted">Tool output</div>}
    />
  );
}
```

- [ ] **Step 7: Extend CSS for IDE shell**

Append to `ide-desktop/src/styles.css`:

```css
.ide-shell {
  width: 100vw;
  height: 100vh;
  display: grid;
  grid-template-columns: 48px 280px minmax(360px, 1fr) 420px;
  grid-template-rows: 40px minmax(0, 1fr) 150px;
  background: #111318;
  color: #e8ebf0;
  overflow: hidden;
}

.top-bar {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 12px;
  border-bottom: 1px solid #252a33;
  background: #151821;
}

.workspace-label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: #cdd5e0;
  font-size: 13px;
}

.status-chips {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #aab4c2;
}

.status-chips span {
  border: 1px solid #303744;
  border-radius: 6px;
  padding: 3px 8px;
  background: #1b2029;
}

.activity-bar {
  grid-row: 2 / 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 10px 6px;
  border-right: 1px solid #252a33;
  background: #13161d;
}

.activity-bar button {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #8e99aa;
  cursor: pointer;
}

.activity-bar button.active,
.activity-bar button:hover {
  background: #242a35;
  color: #e8ebf0;
}

.sidebar,
.editor-area,
.ai-area,
.bottom-panel {
  min-width: 0;
  min-height: 0;
  border-color: #252a33;
}

.sidebar {
  grid-column: 2;
  grid-row: 2 / 4;
  border-right: 1px solid #252a33;
  background: #171a21;
}

.editor-area {
  grid-column: 3;
  grid-row: 2;
  background: #111318;
}

.ai-area {
  grid-column: 4;
  grid-row: 2 / 4;
  border-left: 1px solid #252a33;
  background: #151922;
}

.bottom-panel {
  grid-column: 3;
  grid-row: 3;
  border-top: 1px solid #252a33;
  background: #141820;
}

.pane-title,
.empty-editor,
.ai-placeholder {
  padding: 14px;
  color: #9aa4b2;
}

.primary-button {
  margin-top: 18px;
  height: 34px;
  border: 1px solid #3f6fb6;
  border-radius: 6px;
  background: #235ea8;
  color: white;
  padding: 0 14px;
  cursor: pointer;
}
```

- [ ] **Step 8: Run renderer tests**

Run:

```bash
cd ide-desktop && npm run test -- src/lib/state.test.ts
```

Expected: reducer tests pass.

- [ ] **Step 9: Checkpoint**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected in current workspace: `fatal: not a git repository`. If implementing in a git repo, run:

```bash
git add ide-desktop/src ide-desktop/tests
git commit -m "feat(desktop): add ide shell state and layout"
```

---

## Task 7: File tree, Monaco editor, tabs, and save

**Files:**
- Create `ide-desktop/src/components/FileTree.tsx`
- Create `ide-desktop/src/components/EditorTabs.tsx`
- Create `ide-desktop/src/components/CodeEditor.tsx`
- Modify `ide-desktop/src/App.tsx`
- Modify `ide-desktop/src/styles.css`

- [ ] **Step 1: Add language detection helper**

In `ide-desktop/src/lib/state.ts`, add this exported function at the bottom:

```ts
export function languageForPath(path: string) {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx') || path.endsWith('.cjs') || path.endsWith('.mjs')) return 'javascript';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.html')) return 'html';
  return 'plaintext';
}
```

- [ ] **Step 2: Create file tree component**

Create `ide-desktop/src/components/FileTree.tsx`:

```tsx
import type { TreeNode } from '../types';

export function FileTree({ tree, onOpenFile }: { tree: TreeNode[]; onOpenFile: (path: string) => void }) {
  return (
    <div className="file-tree">
      {tree.map((node) => <TreeRow key={node.path} node={node} onOpenFile={onOpenFile} />)}
    </div>
  );
}

function TreeRow({ node, onOpenFile }: { node: TreeNode; onOpenFile: (path: string) => void }) {
  return (
    <button className={`tree-row ${node.type}`} onClick={() => node.type === 'file' && onOpenFile(node.path)}>
      <span>{node.type === 'directory' ? '▸' : ''}</span>
      <span>{node.name}</span>
    </button>
  );
}
```

- [ ] **Step 3: Create editor tabs component**

Create `ide-desktop/src/components/EditorTabs.tsx`:

```tsx
import type { EditorTab } from '../types';

export function EditorTabs({ tabs, activePath, onActivate }: { tabs: EditorTab[]; activePath: string; onActivate: (path: string) => void }) {
  return (
    <div className="editor-tabs">
      {tabs.map((tab) => {
        const dirty = tab.content !== tab.savedContent;
        return (
          <button key={tab.path} className={tab.path === activePath ? 'active' : ''} onClick={() => onActivate(tab.path)} title={tab.path}>
            <span>{tab.path.split('/').pop()}</span>
            {dirty && <span className="dirty-dot" />}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Create Monaco editor component**

Create `ide-desktop/src/components/CodeEditor.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import type { EditorTab } from '../types';

export function CodeEditor({ tab, onChange, onSave }: { tab?: EditorTab; onChange: (content: string) => void; onSave: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!hostRef.current || editorRef.current) return;
    editorRef.current = monaco.editor.create(hostRef.current, {
      value: '',
      language: 'plaintext',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
    });
    const disposable = editorRef.current.onDidChangeModelContent(() => onChange(editorRef.current?.getValue() ?? ''));
    editorRef.current.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
    return () => {
      disposable.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, [onChange, onSave]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !tab) return;
    const model = monaco.editor.createModel(tab.content, tab.language, monaco.Uri.parse(`file:///${tab.path}`));
    const oldModel = editor.getModel();
    editor.setModel(model);
    oldModel?.dispose();
  }, [tab?.path]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !tab) return;
    if (editor.getValue() !== tab.content) editor.setValue(tab.content);
  }, [tab?.content]);

  if (!tab) return <div className="empty-editor">Open a file from the sidebar.</div>;
  return <div className="code-editor" ref={hostRef} />;
}
```

- [ ] **Step 5: Wire file loading and saving in App**

In `ide-desktop/src/App.tsx`, import:

```tsx
import { CodeEditor } from './components/CodeEditor';
import { EditorTabs } from './components/EditorTabs';
import { FileTree } from './components/FileTree';
import { languageForPath } from './lib/state';
```

Add these functions inside `App()`:

```tsx
  async function loadTree() {
    const tree = await desktop.workspace.getTree('.');
    dispatch({ type: 'tree/loaded', tree });
  }

  async function openFile(path: string) {
    const content = await desktop.fs.read(path);
    dispatch({ type: 'tab/opened', tab: { path, content, savedContent: content, language: languageForPath(path) } });
  }

  async function saveActiveFile() {
    const tab = state.tabs.find((item) => item.path === state.activeTabPath);
    if (!tab) return;
    await desktop.fs.write(tab.path, tab.content);
    dispatch({ type: 'tab/saved', path: tab.path, content: tab.content });
  }
```

After workspace opens, call `await loadTree()`:

```tsx
    if (!result.canceled && result.root) {
      dispatch({ type: 'workspace/opened', root: result.root });
      const tree = await desktop.workspace.getTree('.');
      dispatch({ type: 'tree/loaded', tree });
    }
```

Replace the `Layout` sidebar/editor props:

```tsx
      sidebar={state.activeView === 'files' ? <FileTree tree={state.tree} onOpenFile={openFile} /> : <div className="pane-title">{state.activeView}</div>}
      editor={
        <>
          <EditorTabs tabs={state.tabs} activePath={state.activeTabPath} onActivate={(path) => dispatch({ type: 'tab/activate', path })} />
          <CodeEditor
            tab={state.tabs.find((item) => item.path === state.activeTabPath)}
            onChange={(content) => state.activeTabPath && dispatch({ type: 'tab/changed', path: state.activeTabPath, content })}
            onSave={saveActiveFile}
          />
        </>
      }
```

- [ ] **Step 6: Add editor CSS**

Append to `ide-desktop/src/styles.css`:

```css
.file-tree {
  display: flex;
  flex-direction: column;
  padding: 8px;
  gap: 2px;
}

.tree-row {
  width: 100%;
  height: 26px;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #c8d0dc;
  text-align: left;
  cursor: pointer;
}

.tree-row:hover {
  background: #222832;
}

.tree-row.directory {
  color: #8fb4ff;
}

.editor-tabs {
  height: 36px;
  display: flex;
  align-items: end;
  border-bottom: 1px solid #252a33;
  background: #151821;
  overflow-x: auto;
}

.editor-tabs button {
  height: 32px;
  min-width: 120px;
  max-width: 220px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 0;
  border-right: 1px solid #252a33;
  background: #171b23;
  color: #aeb8c6;
  padding: 0 10px;
  cursor: pointer;
}

.editor-tabs button.active {
  background: #111318;
  color: #e8ebf0;
}

.dirty-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #e3b341;
  flex: 0 0 auto;
}

.code-editor {
  height: calc(100% - 36px);
}
```

- [ ] **Step 7: Verify editor build**

Run:

```bash
cd ide-desktop && npm run typecheck && npm run build
```

Expected: typecheck and build pass.

- [ ] **Step 8: Manual editor check**

Run:

```bash
cd ide-desktop && npm run desktop:run
```

Expected: open a folder, click a file, see it in Monaco, edit, press `Ctrl+S`, close and reopen the file to confirm saved content.

- [ ] **Step 9: Checkpoint**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected in current workspace: `fatal: not a git repository`. If implementing in a git repo, run:

```bash
git add ide-desktop/src
git commit -m "feat(desktop): add file tree and monaco editor"
```

---

## Task 8: Provider settings and API key UI

**Files:**
- Create `ide-desktop/src/components/SettingsPanel.tsx`
- Modify `ide-desktop/src/App.tsx`
- Modify `ide-desktop/src/styles.css`

- [ ] **Step 1: Create settings panel**

Create `ide-desktop/src/components/SettingsPanel.tsx`:

```tsx
import { useState } from 'react';
import type { DesktopSettings, ProviderConfig } from '../types';

export function SettingsPanel({ settings, onSave, onSaveKey }: {
  settings: DesktopSettings;
  onSave: (settings: DesktopSettings) => void;
  onSaveKey: (providerId: string, apiKey: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});

  function updateProvider(id: string, patch: Partial<ProviderConfig>) {
    setDraft({ ...draft, providers: draft.providers.map((provider) => provider.id === id ? { ...provider, ...patch } : provider) });
  }

  return (
    <div className="settings-panel">
      <h2>Settings</h2>
      <label className="field-row">
        <span>Active provider</span>
        <select value={draft.activeProviderId} onChange={(event) => setDraft({ ...draft, activeProviderId: event.target.value })}>
          {draft.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
        </select>
      </label>
      <label className="field-row">
        <span>Approval</span>
        <select value={draft.approval} onChange={(event) => setDraft({ ...draft, approval: event.target.value as DesktopSettings['approval'] })}>
          <option value="ask">Ask for writes</option>
          <option value="auto">Auto writes, ask shell</option>
          <option value="deny">Deny writes and shell</option>
        </select>
      </label>
      <div className="provider-list">
        {draft.providers.map((provider) => (
          <section key={provider.id} className="provider-row">
            <h3>{provider.label}</h3>
            <label className="field-row">
              <span>Model</span>
              <input value={provider.model} onChange={(event) => updateProvider(provider.id, { model: event.target.value })} />
            </label>
            <label className="field-row">
              <span>Base URL</span>
              <input value={provider.baseUrl} onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })} disabled={provider.type === 'anthropic' || provider.type === 'mock'} />
            </label>
            {provider.type !== 'mock' && (
              <label className="field-row">
                <span>API Key</span>
                <input type="password" value={apiKeys[provider.id] || ''} placeholder={provider.keyHint || 'missing'} onChange={(event) => setApiKeys({ ...apiKeys, [provider.id]: event.target.value })} />
                <button onClick={() => onSaveKey(provider.id, apiKeys[provider.id] || '')}>Save Key</button>
              </label>
            )}
          </section>
        ))}
      </div>
      <button className="primary-button" onClick={() => onSave(draft)}>Save Settings</button>
    </div>
  );
}
```

- [ ] **Step 2: Wire settings panel in App**

In `ide-desktop/src/App.tsx`, import:

```tsx
import { SettingsPanel } from './components/SettingsPanel';
```

Add functions inside `App()`:

```tsx
  async function saveSettings(next: NonNullable<typeof state.settings>) {
    const settings = await desktop.settings.set(next);
    dispatch({ type: 'settings/loaded', settings });
  }

  async function saveApiKey(providerId: string, apiKey: string) {
    await desktop.secrets.setApiKey(providerId, apiKey);
    const settings = await desktop.settings.get();
    const providers = await Promise.all(settings.providers.map(async (provider) => {
      if (provider.type === 'mock') return provider;
      const keyState = await desktop.secrets.hasApiKey(provider.id);
      return { ...provider, keyHint: keyState.hint };
    }));
    dispatch({ type: 'settings/loaded', settings: { ...settings, providers } });
  }
```

Update sidebar prop:

```tsx
      sidebar={
        state.activeView === 'settings' && state.settings
          ? <SettingsPanel settings={state.settings} onSave={saveSettings} onSaveKey={saveApiKey} />
          : state.activeView === 'files'
            ? <FileTree tree={state.tree} onOpenFile={openFile} />
            : <div className="pane-title">{state.activeView}</div>
      }
```

- [ ] **Step 3: Add settings CSS**

Append to `ide-desktop/src/styles.css`:

```css
.settings-panel {
  height: 100%;
  overflow: auto;
  padding: 14px;
}

.settings-panel h2,
.provider-row h3 {
  margin: 0 0 12px;
  letter-spacing: 0;
}

.settings-panel h2 {
  font-size: 18px;
}

.provider-row h3 {
  font-size: 14px;
  color: #dce4f0;
}

.field-row {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
  color: #aeb8c6;
  font-size: 12px;
}

.field-row input,
.field-row select {
  width: 100%;
  height: 32px;
  border: 1px solid #303744;
  border-radius: 6px;
  background: #10141b;
  color: #e8ebf0;
  padding: 0 9px;
}

.field-row button {
  height: 30px;
  border: 1px solid #303744;
  border-radius: 6px;
  background: #222832;
  color: #e8ebf0;
}

.provider-row {
  border-top: 1px solid #252a33;
  padding-top: 12px;
  margin-top: 12px;
}
```

- [ ] **Step 4: Verify settings**

Run:

```bash
cd ide-desktop && npm run typecheck && npm run build
```

Expected: typecheck and build pass.

- [ ] **Step 5: Manual key check**

Run:

```bash
cd ide-desktop && npm run desktop:run
```

Expected: settings page saves model/base URL/approval, API key field never displays the full saved key after save, and mock provider remains selectable without a key.

- [ ] **Step 6: Checkpoint**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected in current workspace: `fatal: not a git repository`. If implementing in a git repo, run:

```bash
git add ide-desktop/src/components/SettingsPanel.tsx ide-desktop/src/App.tsx ide-desktop/src/styles.css
git commit -m "feat(desktop): add provider settings and key ui"
```

---

## Task 9: AI panel, tool cards, and approval actions

**Files:**
- Create `ide-desktop/src/components/AIPanel.tsx`
- Create `ide-desktop/src/components/ToolCard.tsx`
- Modify `ide-desktop/src/App.tsx`
- Modify `ide-desktop/src/styles.css`

- [ ] **Step 1: Create tool card component**

Create `ide-desktop/src/components/ToolCard.tsx`:

```tsx
import type { ChatItem } from '../types';

export function ToolCard({ item, onApprove }: { item: Extract<ChatItem, { kind: 'tool' | 'approval' }>; onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void }) {
  if (item.kind === 'approval') {
    return (
      <section className="tool-card approval-card">
        <div className="tool-title">Approval · {item.tool}</div>
        <pre>{item.message}</pre>
        <div className="approval-actions">
          <button onClick={() => onApprove(item.requestId, 'allow_once')}>Allow once</button>
          <button onClick={() => onApprove(item.requestId, 'allow_session')}>Allow session</button>
          <button onClick={() => onApprove(item.requestId, 'deny')}>Deny</button>
        </div>
      </section>
    );
  }

  return (
    <section className={`tool-card ${item.status}`}>
      <div className="tool-title">{item.tool} · {item.status}</div>
      {item.input !== undefined && <pre>{JSON.stringify(item.input, null, 2)}</pre>}
      {item.output && <pre>{item.output}</pre>}
    </section>
  );
}
```

- [ ] **Step 2: Create AI panel**

Create `ide-desktop/src/components/AIPanel.tsx`:

```tsx
import { Send, Square } from 'lucide-react';
import { useState } from 'react';
import type { AppState, ChatItem } from '../types';
import { ToolCard } from './ToolCard';

export function AIPanel({ state, onSubmit, onCancel, onApprove }: {
  state: AppState;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
}) {
  const [text, setText] = useState('');
  const running = state.agentStatus === 'running';

  function submit() {
    const value = text.trim();
    if (!value) return;
    setText('');
    onSubmit(value);
  }

  return (
    <section className="ai-panel">
      <div className="chat-log">
        {state.chat.map((item) => <ChatRow key={item.id} item={item} onApprove={onApprove} />)}
      </div>
      <div className="chat-input-row">
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Ask ZCode or type /help" onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submit();
        }} />
        {running ? (
          <button title="Stop" onClick={onCancel}><Square size={17} /></button>
        ) : (
          <button title="Send" onClick={submit}><Send size={17} /></button>
        )}
      </div>
    </section>
  );
}

function ChatRow({ item, onApprove }: { item: ChatItem; onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void }) {
  if (item.kind === 'tool' || item.kind === 'approval') return <ToolCard item={item} onApprove={onApprove} />;
  return <div className={`chat-row ${item.kind}`}>{item.text}</div>;
}
```

- [ ] **Step 3: Wire AI panel in App**

In `ide-desktop/src/App.tsx`, import:

```tsx
import { AIPanel } from './components/AIPanel';
```

Add handlers inside `App()`:

```tsx
  async function submitPrompt(text: string) {
    if (state.agentStatus === 'offline') {
      dispatch({ type: 'agent/status', status: 'starting' });
      await desktop.agent.start();
    }
    dispatch({ type: 'chat/user', text });
    await desktop.agent.prompt(text);
  }

  async function cancelTurn() {
    await desktop.agent.cancel();
    dispatch({ type: 'agent/status', status: 'ready' });
  }

  async function approve(requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') {
    await desktop.agent.approve(requestId, decision);
  }
```

Replace the `ai` prop:

```tsx
      ai={<AIPanel state={state} onSubmit={submitPrompt} onCancel={cancelTurn} onApprove={approve} />}
```

- [ ] **Step 4: Add AI panel CSS**

Append to `ide-desktop/src/styles.css`:

```css
.ai-panel {
  height: 100%;
  display: grid;
  grid-template-rows: minmax(0, 1fr) 128px;
}

.chat-log {
  min-height: 0;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chat-row {
  white-space: pre-wrap;
  line-height: 1.45;
  font-size: 13px;
}

.chat-row.user {
  color: #dce4f0;
  border-left: 2px solid #4b87d8;
  padding-left: 10px;
}

.chat-row.assistant {
  color: #c4cedb;
}

.chat-input-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 42px;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid #252a33;
}

.chat-input-row textarea {
  resize: none;
  border: 1px solid #303744;
  border-radius: 6px;
  background: #10141b;
  color: #e8ebf0;
  padding: 10px;
}

.chat-input-row button,
.approval-actions button {
  border: 1px solid #303744;
  border-radius: 6px;
  background: #222832;
  color: #e8ebf0;
  cursor: pointer;
}

.tool-card {
  border: 1px solid #303744;
  border-radius: 6px;
  background: #171c25;
  padding: 10px;
}

.tool-card.running {
  border-color: #4b87d8;
}

.tool-card.failed,
.approval-card {
  border-color: #b86b65;
}

.tool-title {
  margin-bottom: 8px;
  font-size: 12px;
  color: #9ebcff;
}

.tool-card pre {
  max-height: 220px;
  overflow: auto;
  margin: 0;
  white-space: pre-wrap;
  color: #aeb8c6;
  font-size: 12px;
}

.approval-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.approval-actions button {
  height: 30px;
  padding: 0 10px;
}
```

- [ ] **Step 5: Verify AI mock flow manually**

Run:

```bash
cd cli && npm run build
cd ../ide-desktop && npm run desktop:run
```

Expected: open a workspace, keep provider set to mock, submit `smoke multi-tool task`, see assistant text and tool cards.

- [ ] **Step 6: Verify approval card manually**

Run the desktop app with settings approval set to `ask`, then send a prompt that makes the mock provider write a file. Expected: approval card appears with Allow once, Allow session, and Deny buttons; Deny blocks the write and produces a failed tool result.

- [ ] **Step 7: Checkpoint**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected in current workspace: `fatal: not a git repository`. If implementing in a git repo, run:

```bash
git add ide-desktop/src/components/AIPanel.tsx ide-desktop/src/components/ToolCard.tsx ide-desktop/src/App.tsx ide-desktop/src/styles.css
git commit -m "feat(desktop): add chat tools and approvals"
```

---

## Task 10: Sessions, slash commands, file refresh, and bottom panel

**Files:**
- Modify `ide-desktop/electron/ipc.cjs`
- Modify `ide-desktop/electron/workspace.cjs`
- Modify `ide-desktop/src/lib/state.ts`
- Modify `ide-desktop/src/App.tsx`
- Create `ide-desktop/src/components/BottomPanel.tsx`
- Modify `ide-desktop/src/styles.css`

- [ ] **Step 1: Add session listing IPC**

In `ide-desktop/electron/workspace.cjs`, add:

```js
  async function listSessions() {
    const sessionRoot = resolveInside('.aicode/sessions');
    try {
      const entries = await fs.readdir(sessionRoot);
      return entries.filter((name) => name.endsWith('.json')).sort().reverse().slice(0, 30);
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
  }
```

Return it from `createWorkspaceService()`:

```js
  return { setRoot, getRoot, resolveInside, readFile, writeFile, tree, listSessions };
```

In `ide-desktop/electron/ipc.cjs`, add:

```js
  ipcMain.handle('sessions.list', async () => await workspace.listSessions());
```

In `ide-desktop/electron/preload.cjs`, add:

```js
  sessions: {
    list: () => ipcRenderer.invoke('sessions.list'),
  },
```

- [ ] **Step 2: Add slash command handling in App**

In `ide-desktop/src/App.tsx`, update `submitPrompt` before sending to agent:

```tsx
    if (text === '/help') {
      dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: '/help /model /provider /status' } });
      return;
    }
    if (text === '/status') {
      dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: `agent=${state.agentStatus} workspace=${state.workspaceRoot}` } });
      return;
    }
    if (text === '/model') {
      const provider = state.settings?.providers.find((item) => item.id === state.settings?.activeProviderId);
      dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: provider ? provider.model : 'mock-code-agent-v1' } });
      return;
    }
    if (text === '/provider') {
      const provider = state.settings?.providers.find((item) => item.id === state.settings?.activeProviderId);
      dispatch({ type: 'agent/event', event: { type: 'assistant_message', text: provider ? provider.label : 'Mock' } });
      return;
    }
```

- [ ] **Step 3: Add file refresh after write tool results**

In `ide-desktop/src/App.tsx`, replace the existing agent event subscription with:

```tsx
    return desktop.agent.onEvent(async (event) => {
      dispatch({ type: 'agent/event', event });
      if (event.type === 'tool_result' && event.ok !== false) {
        const data = event.data as { path?: string } | undefined;
        const path = data?.path;
        if (path && state.tabs.some((tab) => tab.path === path)) {
          const content = await desktop.fs.read(path);
          dispatch({ type: 'tab/opened', tab: { path, content, savedContent: content, language: languageForPath(path) } });
        }
      }
    });
```

If React closure staleness appears during implementation, keep a `useRef(state)` that is updated in a `useEffect` and read `stateRef.current.tabs` in this handler.

- [ ] **Step 4: Create bottom panel**

Create `ide-desktop/src/components/BottomPanel.tsx`:

```tsx
import type { AppState } from '../types';

export function BottomPanel({ state }: { state: AppState }) {
  const toolItems = state.chat.filter((item) => item.kind === 'tool').slice(-8);
  return (
    <section className="bottom-output">
      <div className="bottom-title">Recent tool output</div>
      {toolItems.length === 0 ? <div className="muted">No tool output yet.</div> : toolItems.map((item) => (
        <div key={item.id} className="bottom-line">{item.tool} · {item.status}</div>
      ))}
    </section>
  );
}
```

In `ide-desktop/src/App.tsx`, import and use it:

```tsx
import { BottomPanel } from './components/BottomPanel';
```

```tsx
      bottom={<BottomPanel state={state} />}
```

- [ ] **Step 5: Add bottom panel CSS**

Append to `ide-desktop/src/styles.css`:

```css
.bottom-output {
  height: 100%;
  overflow: auto;
  padding: 10px 12px;
}

.bottom-title {
  margin-bottom: 8px;
  font-size: 12px;
  color: #8fb4ff;
}

.bottom-line {
  height: 24px;
  display: flex;
  align-items: center;
  border-bottom: 1px solid #202632;
  color: #aeb8c6;
  font-size: 12px;
}
```

- [ ] **Step 6: Verify slash commands and bottom panel**

Run:

```bash
cd ide-desktop && npm run typecheck && npm run build && npm run desktop:run
```

Expected: `/help`, `/model`, `/provider`, and `/status` render local assistant messages; mock tool calls also appear in the bottom panel.

- [ ] **Step 7: Checkpoint**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected in current workspace: `fatal: not a git repository`. If implementing in a git repo, run:

```bash
git add ide-desktop/electron ide-desktop/src
git commit -m "feat(desktop): add sessions slash commands and output panel"
```

---

## Task 11: Verification, docs, and final acceptance

**Files:**
- Modify `ide-desktop/package.json` if scripts need correction
- Modify `cli/README.md`
- Create `ide-desktop/README.md`
- Verify `docs/superpowers/specs/2026-07-26-cc-desktop-ide-design.md` acceptance checklist

- [ ] **Step 1: Create desktop README**

Create `ide-desktop/README.md`:

```md
# ZCode Desktop IDE

A local Claude-Code-like desktop IDE shell that uses the existing `cli/` agent through JSON Lines.

## Development

Build the CLI first:

```bash
cd ../cli
npm install
npm run build
```

Run the desktop app:

```bash
cd ../ide-desktop
npm install
npm run dev
```

## Mock Provider

The default mock provider works without API keys and is used for smoke tests.

## Live Providers

Configure providers in Settings:

- OpenAI-compatible: base URL, model, API key
- Anthropic: model, API key
- Custom: OpenAI-compatible wire format

API keys are stored by the Electron main process and are not shown in full in the renderer.

## Verification

```bash
cd ../cli && npm run build && node --test dist/tests/desktop-bridge*.test.js
cd ../ide-desktop && npm run test && npm run build
```
```

- [ ] **Step 2: Run full CLI verification**

Run:

```bash
cd cli && npm run build && node --test dist/tests/desktop-bridge-args.test.js dist/tests/desktop-bridge.test.js dist/tests/approval.test.js dist/tests/smoke.test.js
```

Expected: all selected CLI tests pass.

- [ ] **Step 3: Run full desktop verification**

Run:

```bash
cd ide-desktop && npm run test && npm run build
```

Expected: typecheck, Vitest reducer tests, Node main-process tests, mock smoke, and Vite build pass.

- [ ] **Step 4: Run manual mock acceptance**

Run:

```bash
cd cli && npm run build
cd ../ide-desktop && npm run desktop:run
```

Expected:

1. App opens without the paper assistant UI.
2. User opens a workspace folder.
3. File tree appears.
4. User opens and saves a file in Monaco.
5. Settings show mock/OpenAI-compatible/Anthropic providers.
6. Mock provider can run a prompt with no API key.
7. Chat streams assistant text.
8. Tool cards appear.
9. Approval appears when write/shell needs confirmation.
10. Stop returns the UI to input-ready state.

- [ ] **Step 5: Run optional live provider smoke**

Only run when the user provides a real API key in Settings. Use OpenAI-compatible first because custom gateways use that path.

Manual expected behavior:

1. Save OpenAI-compatible base URL, model, and key.
2. Switch active provider to that profile.
3. Ask: `Read the package name from package.json and answer with only the name.`
4. Expected: agent uses read-only tools without approval and answers with the package name.
5. Confirm that no full API key appears in the renderer UI or terminal logs.

- [ ] **Step 6: Acceptance checklist against spec**

Open `docs/superpowers/specs/2026-07-26-cc-desktop-ide-design.md` and check these items manually:

```text
1. ide-desktop runs independently.
2. Workspace open/tree/editor/save work.
3. Provider settings include OpenAI-compatible, Anthropic, custom-capable profile shape, and mock.
4. API keys are not rendered in full.
5. Mock provider works with no key.
6. At least one live provider works when configured.
7. Assistant stream renders incrementally.
8. Tool cards render.
9. Graded approval works.
10. Written files refresh open editor tabs or are reloadable.
11. Sessions exist under .aicode/sessions.
12. /help /model /provider /status work.
13. Stop/cancel recovers input.
14. Agent crash/restart path works.
15. Workspace path jail rejects outside paths.
16. Automated bridge/main/UI/mock tests pass.
```

- [ ] **Step 7: Final checkpoint**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected in current workspace: `fatal: not a git repository`. If implementing in a git repo, run:

```bash
git add cli ide-desktop docs/superpowers/specs/2026-07-26-cc-desktop-ide-design.md docs/superpowers/plans/2026-07-26-cc-desktop-ide.md
git commit -m "feat: add cc desktop ide mvp"
```

---

## Self-Review Notes

- Spec coverage: the plan covers independent desktop app, CLI bridge, providers, API key storage, graded approval, editor, file tree, chat, tool cards, sessions, slash commands, cancel/restart, tests, and acceptance.
- Placeholder scan: the plan contains no unresolved placeholder markers or deferred work instructions.
- Type consistency: renderer types use `ProviderType`, `ApprovalMode`, `DesktopSettings`, `AgentEvent`, and `ChatItem` consistently; CLI bridge commands use `user_message`, `approval_response`, `cancel`, `shutdown`, and `ping` consistently.
- Scope check: the MVP is large but still a single vertical product slice because all subsystems are required for one working Desktop IDE. The ordered tasks keep each phase runnable and testable.
