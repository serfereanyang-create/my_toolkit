# Claude-Code-like CLI MVP Design

Date: 2026-07-05

## Goal

Build a local CLI coding agent MVP that is structurally similar to Claude Code and OpenCode, while remaining runnable in the current Windows workspace. The MVP must be useful, not only a mock terminal: it should accept natural-language tasks, call an LLM provider, inspect a project, run approved tools, write files through controlled operations, persist a session, and expose a compact terminal experience.

The long-term target is parity with tools such as Claude Code and OpenCode. The MVP target is a working foundation that can be extended toward that target.

## Current Context

The workspace is `C:\Users\34516\ZCodeProject`. It is not a git repository. It already contains a Node/Vite/TypeScript app, `node_modules`, and unrelated Android/PDF artifacts. Bun is not installed. Node `v24.15.0` and npm `11.12.1` are available.

OpenCode's public repository uses a Bun and TypeScript monorepo. It runs CLI development through Bun, uses packages such as `@opentui/core`, `@opentui/solid`, `@opentui/keymap`, `ai`, `effect`, and `@lydell/node-pty`. Because Bun is unavailable locally and Windows native terminal dependencies can add friction, this MVP will use Node/TypeScript first while keeping module boundaries compatible with a future Bun/OpenTUI direction.

## MVP Success Criteria

1. A CLI entrypoint can be run from this workspace with npm scripts.
2. The CLI supports interactive mode and a non-interactive `--prompt` mode for smoke testing.
3. It supports both Anthropic and OpenAI-compatible provider configuration.
4. It can run without API keys using a deterministic mock provider.
5. It can inspect the local project with safe tools: list files, read files, search text, show status.
6. It can modify files through controlled tools: write file and apply patch.
7. It can run shell commands through an approval policy.
8. It persists sessions, including messages and tool calls.
9. It exposes slash commands: `/help`, `/status`, `/provider`, `/model`, `/tools`, `/sessions`, `/exit`.
10. It has a compact Claude-Code-like terminal experience: banner, status, streamed assistant text, visible tool-call logs.
11. It includes automated tests and a smoke test that proves multi-tool orchestration.
12. It includes a 100-check implementation audit that runs as code and fails if key MVP expectations are not met.

## Non-Goals for the MVP

1. Pixel-perfect Claude Code UI parity.
2. Full OpenCode architecture or Bun monorepo migration.
3. Native PTY terminal embedding.
4. Sandboxed process isolation beyond conservative command policy and user approval.
5. MCP server support.
6. Background agents or multi-agent task decomposition.
7. Git-specific workflows, because the current workspace is not a git repository.
8. Long-running autonomous work for five real hours. Instead, the MVP will include repeatable automated review checks and smoke tests.

## Architecture

The CLI will live under `cli/` so it does not disturb the existing Vite app.

Proposed structure:

```text
cli/
  package.json
  tsconfig.json
  src/
    index.ts
    cli/args.ts
    cli/commands.ts
    cli/repl.ts
    ui/terminal.ts
    agent/agent.ts
    agent/toolLoop.ts
    providers/types.ts
    providers/mock.ts
    providers/openai.ts
    providers/anthropic.ts
    tools/registry.ts
    tools/files.ts
    tools/search.ts
    tools/shell.ts
    tools/patch.ts
    session/store.ts
    config/config.ts
    safety/policy.ts
    audit/checks.ts
  tests/
    smoke.test.ts
    audit.test.ts
```

The main control flow is:

1. Parse CLI args and load config.
2. Create provider, tool registry, session store, and terminal UI.
3. Accept user input from REPL or `--prompt`.
4. Add the user message to the session.
5. Ask the provider for the next assistant action.
6. If the response requests tool calls, validate and execute those tools through the registry.
7. Add tool results to the session and continue the loop until the assistant returns a final answer.
8. Persist the session after every turn.

## Provider Design

Provider selection is controlled by CLI flags, environment variables, or a config file.

Supported providers:

1. `mock`: deterministic provider used for tests and no-key demos.
2. `openai`: OpenAI-compatible chat completions provider. It accepts `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL`.
3. `anthropic`: Anthropic Messages API provider. It accepts `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`.

Provider interface:

```ts
type Provider = {
  name: string;
  model: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
};
```

The first version will use a simple internal tool-call protocol that all providers normalize into:

```ts
type AgentAction =
  | { type: 'message'; content: string }
  | { type: 'tool'; tool: string; input: unknown };
```

The mock provider will recognize smoke-test prompts and emit a multi-tool plan that reads project state, writes a file, reads it back, and runs a shell command. This proves the agent loop and tool registry work without spending API credits.

## Tool Design

Tools are small modules registered by name. Each tool declares a schema-like input validator, a human-readable description, a risk level, and an executor.

Initial tools:

1. `project_status`: current working directory, platform, Node/npm versions, and key files.
2. `list_files`: recursive file listing with ignore patterns for `node_modules`, build output, and binary artifacts.
3. `read_file`: read a text file inside the workspace.
4. `search_text`: search text with `rg` when available, fallback to Node traversal.
5. `write_file`: create or replace a file inside the workspace.
6. `apply_patch`: apply a unified patch to a file or create a file from patch-like edits.
7. `run_command`: execute an allowed shell command with timeout and output capture.

All paths are resolved against the workspace root. Tools must reject path traversal outside the workspace.

## Safety and Approval

The MVP will use an approval policy with three modes:

1. `ask`: default interactive mode. Read-only tools run automatically. Write and shell tools require confirmation.
2. `auto`: smoke-test and CI mode. Only commands and writes that satisfy the allowlist can run without confirmation.
3. `deny`: read-only mode. Write and shell tools are blocked.

Shell command policy:

1. Block clearly destructive commands such as `rm -rf`, `del /s`, `format`, `shutdown`, `git reset --hard`, and unrestricted recursive deletion.
2. Allow common inspection and test commands such as `node --version`, `npm --version`, `npm test`, `npm run build`, and simple directory listing.
3. Require explicit confirmation for other commands in interactive mode.

Write policy:

1. Reject absolute paths outside the workspace.
2. Create parent directories only inside the workspace.
3. In `ask` mode, show the target path and operation before writing.
4. In `auto` mode, allow writes only under configured safe output folders such as `cli/.smoke/` and test fixtures.

## Session Storage

Sessions are stored in `.aicode/sessions/` by default. Each session is JSON Lines or JSON so it is easy to inspect manually.

Session fields:

1. session id
2. created and updated timestamps
3. provider and model
4. workspace root
5. messages
6. tool calls and results
7. final answers

The CLI exposes `/sessions` to list recent sessions and `/status` to show the active one.

## Terminal Experience

The first version avoids a heavy TUI dependency. It will provide a polished line-based terminal interface:

1. compact banner with tool name, provider, model, workspace
2. prompt line for user input
3. streamed assistant output when provider supports it, otherwise chunked output
4. tool-call logs using consistent prefixes
5. concise status output
6. slash commands for control

This is intentionally simpler than OpenTUI but keeps the user-facing rhythm close to code-agent CLIs.

## Testing Strategy

Tests will use Node's built-in test runner and TypeScript compilation.

Required verification:

1. `npm run typecheck` inside `cli/`
2. `npm test` inside `cli/`
3. `npm run smoke` inside `cli/`
4. `npm run audit:100` inside `cli/`

Smoke test behavior:

1. Run CLI in non-interactive mode with provider `mock` and approval `auto`.
2. Ask it to complete a multi-tool task.
3. Confirm the agent calls at least three different tools.
4. Confirm it writes an artifact file.
5. Confirm it reads the artifact back.
6. Confirm it runs at least one allowed shell command.
7. Confirm the session file records messages and tool calls.

100-check audit:

A code-level audit script will contain at least 100 concrete assertions across categories:

1. file layout
2. package scripts
3. provider interface
4. mock provider behavior
5. OpenAI provider config
6. Anthropic provider config
7. tool registry behavior
8. tool input validation
9. workspace path safety
10. shell command safety
11. approval policy behavior
12. session persistence
13. slash commands
14. smoke-test coverage
15. README or usage output

These checks are not a substitute for product parity, but they satisfy the explicit self-review requirement in a repeatable and falsifiable way.

## Implementation Plan Summary

1. Create isolated `cli/` package using TypeScript and Node.
2. Implement shared types, config, terminal UI, and session store.
3. Implement provider adapters: mock, OpenAI-compatible, Anthropic.
4. Implement tool registry and initial tools.
5. Implement agent loop with normalized tool calls.
6. Implement REPL and non-interactive prompt mode.
7. Implement tests, smoke test, and 100-check audit.
8. Run verification and fix issues until passing.

## Risks and Mitigations

1. Provider APIs differ in tool-call format. Mitigation: normalize all responses into the internal `AgentAction` format.
2. Windows shell behavior differs from Unix. Mitigation: use Node `child_process` with explicit `shell: true`, timeouts, and cross-platform commands for tests.
3. Auto-approval can be unsafe. Mitigation: restrict `auto` writes to known safe paths and commands.
4. Terminal UI can expand too quickly. Mitigation: line-based UI first, OpenTUI later.
5. Existing workspace contains unrelated files. Mitigation: isolate code in `cli/` and generated runtime state in `.aicode/`.

## Acceptance Checklist

The MVP is accepted when these commands pass:

```bash
cd cli
npm run typecheck
npm test
npm run smoke
npm run audit:100
```

It is also accepted when the smoke output demonstrates a multi-tool chain that includes project inspection, file writing, file reading, command execution, and session persistence.
