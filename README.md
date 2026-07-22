# aicode CLI MVP

A local Claude-Code-like CLI coding agent MVP. The runtime is real: provider adapters produce normalized actions, the agent loop executes tools, and sessions are persisted.

## Run

Default mode uses the configured OpenAI-compatible endpoint:

```bash
npm install
npm run build
set OPENAI_API_KEY=...
node dist/src/index.js
```

Current defaults:

- provider: `openai`
- base URL: `https://ai.furry.edu.gr/v1`
- model: `gpt-5.5`

Interactive mode from the repository root:

```bash
node cli/dist/src/index.js
```

Offline mock mode:

```bash
node cli/dist/src/index.js --provider mock --approval auto
```

CLI-friendly output modes:

```bash
node cli/dist/src/index.js --version
node cli/dist/src/index.js --help
node cli/dist/src/index.js --provider mock --approval auto --json --prompt "帮我看看项目索引"
node cli/dist/src/index.js --provider mock --approval auto --no-color --prompt "你好"
node cli/dist/src/index.js --provider mock --ci --prompt "帮我看看项目索引"
```

`--json` emits newline-delimited JSON events for automation. `--ci` implies `--no-input` and prevents the CLI from falling into the interactive REPL when no prompt is provided.

Health checks and shell completion:

```bash
node cli/dist/src/index.js --doctor
node cli/dist/src/index.js --json --doctor
node cli/dist/src/index.js completion bash
node cli/dist/src/index.js completion zsh
node cli/dist/src/index.js completion fish
node cli/dist/src/index.js completion powershell
```

## Providers

OpenAI-compatible provider:

```bash
set OPENAI_API_KEY=...
node cli/dist/src/index.js --prompt "Inspect this project"
```

Override endpoint or model:

```bash
set OPENAI_API_KEY=...
set AICODE_OPENAI_BASE_URL=https://ai.furry.edu.gr/v1
set OPENAI_MODEL=gpt-5.5
node cli/dist/src/index.js --provider openai
```

Mock provider works without keys:

```bash
node cli/dist/src/index.js --provider mock --approval auto --prompt "smoke multi-tool task"
```

Anthropic provider:

```bash
set ANTHROPIC_API_KEY=...
set ANTHROPIC_MODEL=claude-3-5-sonnet-latest
node cli/dist/src/index.js --provider anthropic --prompt "Inspect this project"
```

## Configuration

Configuration precedence is: CLI flag > environment variable > profile config > default.

Default workspace config path:

```text
.aicode/config.json
```

Example config with profiles:

```json
{
  "defaultProfile": "local",
  "profiles": {
    "local": {
      "provider": "mock",
      "approval": "auto",
      "sessionDir": ".aicode/sessions"
    },
    "openai-work": {
      "provider": "openai",
      "model": "gpt-5.5",
      "baseUrl": "https://ai.furry.edu.gr/v1"
    }
  }
}
```

Use a profile or custom config path:

```bash
node cli/dist/src/index.js --config .aicode/config.json --profile local --prompt "帮我看看项目索引"
```

`/config` shows the effective configuration with API keys redacted.

## Sessions

List sessions inside the CLI:

```text
/sessions
```

Resume a saved session:

```bash
node cli/dist/src/index.js --resume sess_YYYYMMDDHHMMSS_xxxxxxxx
```

## Slash Commands

- `/help`
- `/status`
- `/provider`
- `/model`
- `/tools`
- `/summary`
- `/plan` - show current task board
- `/plan confirm|pause|continue|skip|reopen|show` - control task board execution
- `/memory` - list project memory
- `/memory add <convention|decision|pitfall|note> <text>` - add memory
- `/memory forget <id|query>` - soft-delete memory
- `/rollback list|show|preview|apply` - inspect or apply selective Git safety rollbacks
- `/git publish <remote> <local-ref> <remote-branch>` - one-shot confirmed non-force publish
- `/export`
- `/sessions`
- `/undo`
- `/不准偷懒开发` - enable the built-in learning guard for development requests
- `/不准偷懒开发 状态` - show guard status, risk, attempts, and metrics
- `/不准偷懒开发 继续` - resume a blocked learning check
- `/不准偷懒开发 归档` - archive the current guarded requirement
- `/不准偷懒开发 取消` - cancel the current guarded requirement
- `/不准偷懒开发 关闭` - ask for exact confirmation before disabling the guard after the current requirement is passed, archived, or cancelled
- `/不准偷懒开发 确认关闭不准偷懒开发` - disable the guard when there is no active unchecked requirement
- `/不准偷懒开发 暂停` - temporarily pause the guard for non-development work
- `/不准偷懒开发 设置 ...` - adjust session guard strictness and retry count
- `/exit`

## Task boards (large work)

Large multi-step requests can create a draft board under `.aicode/tasks/`.

```bash
node dist/src/index.js --provider mock --approval auto --confirm-plan --prompt "分步实现项目任务板：规划、确认、自动执行、失败恢复"
```

Interactive controls:

- `/plan` show board
- `/plan confirm` start auto-run
- `/plan pause` / `/plan continue`
- `/plan skip <taskId>` / `/plan reopen <taskId>`

## Project memory

Task outcomes can store short conventions/decisions/pitfalls under `.aicode/memory/entries.json`.
Relevant entries are injected into later task-board execution prompts.

```bash
# interactive
/memory add decision Prefer npm test for verification
/memory list
/memory forget Prefer npm test
```

## Task verify loop

Task-board tasks are not marked done on `TASK_DONE` alone.
When enabled (default), aicode discovers package scripts and runs:

1. `npm run typecheck` (if present)
2. `npm test` (if present)
3. `npm run build` (if present)

If verification fails, the board attempts **one** automatic repair turn and re-verifies.
A second failure blocks the task and pauses the board for `/plan continue`.

Disable with:

```bash
AICODE_VERIFY_TASKS=0
```

## Native tool calling and streaming

Hosted providers now send native tool definitions and stream assistant text:

- OpenAI-compatible: `tools` + `tool_choice=auto`, SSE stream, parse streamed `tool_calls`
- Anthropic: `tools` + SSE stream, parse streamed `tool_use` / `input_json_delta`

Assistant text deltas render live in the terminal (`assistant_delta` events in `--json` mode).
If the model does not return native tool calls, aicode still accepts the older text JSON tool protocol as fallback.

## Context budget

Before each model call, aicode packs session messages into a char budget so large tool transcripts do not blow the context window.

- Default budget: `80000` characters
- Override: `AICODE_CONTEXT_BUDGET_CHARS=120000`
- Recent turns are kept first; older history is folded into one summary
- Oversized tool/assistant payloads are clipped for the model only
- On-disk session JSON still stores full outputs for resume/export

## Codebase navigation

aicode builds a lightweight TS/JS symbol index under `.aicode/nav/index.json` (mtime-aware cache).

Tools:

- `find_symbol` — locate function/class/interface/type/const definitions
- `find_references` — approximate references by identifier

Example natural language:

- “`runTaskBoardLoop` 在哪定义”
- “谁调用了 `markTaskDone`”

Code edit/search strategies now prefer `find_symbol` before broad `search_text` / file reads.

## Natural-language command extraction

High-confidence read-only requests are converted into tool chains before the model runs:

- `C盘还有多少空间` → `disk_info`
- `搜索 apply_patch` → `search_text`
- `读取 package.json` → `read_file`
- recent activity / process memory / project status also direct-execute when clear

Edit and shell requests stay model-driven with stronger strategy injection, and still pass through approval / safety policy. Direct chains reuse the normal tool registry, session logging, and recovery fallback.

## Git workflow (boards)

When a task board is confirmed (`/plan confirm` or `--confirm-plan`), aicode ensures a dedicated branch:

```text
aicode/board-<boardId>
```

After the board completes (tasks done and verified), aicode previews `git status` / diff and asks to commit once.
There is no auto-push. Manual commands:

```bash
/git status
/git commit
/git publish origin refs/heads/aicode/board-xxx aicode/board-xxx
```

Non-interactive sessions without a confirm handler skip commit and print the preview guidance.

## Git safety

Ordinary turns and task-board tasks create local hidden baseline/result snapshots under `refs/aicode/checkpoints/`.
Snapshots do not move `HEAD`, switch branches, or rewrite the real index.
Dirty worktrees are protected, and runtime data under `.aicode/` is excluded.
Audit events append to `.aicode/git-safety/audit.jsonl`.

If the workspace is not a Git repository, the CLI asks before `git init`. Without confirmation it degrades to file checkpoints (`/undo`) and records that Git protection was unavailable.

```bash
/rollback list
/rollback show <unit-id>
/rollback preview <unit-id>
/rollback apply <unit-id>
/git publish origin refs/heads/main main
```

`/rollback apply` only restores paths changed by that unit, and only when every path still matches the recorded result state. Any conflict stops the whole rollback.
`/git publish` always asks again, never force-pushes, never deletes remote branches, and never auto-publishes during task execution.
`/undo` remains the single-file checkpoint command and is not an alias for `/rollback`.

## 不准偷懒开发

`/不准偷懒开发` enables a session-level guard. When enabled, development requests are translated into professional requirements, assigned a risk level, and may require an entry-level understanding check before the main agent can call tools.

The guard is rule-based in the MVP. It persists in the session file, blocks before tool execution, and cannot be bypassed by prompt wording such as “just write it”. Simple non-development chat is allowed through without creating a guarded requirement. Low-risk requests only require translation confirmation; medium and higher risk requests require checks, and critical requests require rollback/confirmation-oriented checks.

## Verification

```bash
npm run typecheck
npm test
npm run smoke
npm run audit:100
```

The smoke command uses the mock provider to drive project inspection, file listing, file writing, file reading, text search, shell command execution, and session persistence.

## AI Coding Tools

The default tool registry includes project indexing, file read/write/search, shell execution, patching, checkpoint undo, and read-only git tools: `git_status`, `git_diff`, and `git_log`.

Project context is collected from `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `README.md` when present, then passed to hosted providers as project instructions.

## Plugins And Hooks

A local `.aicode/plugins.json` manifest can declare simple plugin command tools. Plugin tools are registered into the same tool registry and still pass through the existing approval policy.

```json
{
  "tools": [
    {
      "name": "plugin_node_version",
      "description": "Show Node version",
      "command": "node --version"
    }
  ]
}
```

The runtime exposes no-op hook lifecycle points for `beforeTool`, `afterTool`, and `onError`. This is plugin-ready/MCP-ready groundwork, not a full MCP implementation.

## Capability Matrix

See `docs/capability-matrix.md` for the tracked CLI and AI coding agent capabilities, implementation status, evidence, and advanced features that remain outside the MVP scope.
