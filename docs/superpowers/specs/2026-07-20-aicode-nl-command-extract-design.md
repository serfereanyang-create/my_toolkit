# aicode CLI Natural-Language Command Extraction Design

**Date:** 2026-07-20  
**Status:** Approved for implementation

## 1. Goal

Make natural-language requests more reliably control the aicode tool chain by introducing a built-in command extraction and conversion layer.

First version priorities:

1. stably map intent to a tool chain;
2. execute high-confidence read-only requests directly;
3. leave low-confidence or write/shell requests to the model, with stronger strategy guidance.

## 2. Non-goals

This version will not:

- fully replace the model for complex multi-file edits;
- auto-execute `write_file`, `apply_patch`, `rename_file`, `create_docx`, or `run_command`;
- invent missing high-risk arguments;
- build a general NL parser for arbitrary conversation;
- change slash-command behavior;
- bypass approval, Git safety, hooks, or session logging.

## 3. Confirmed Product Decisions

1. Primary goal: stable intent → tool-chain mapping.
2. Execution strength: high-confidence direct execution; low-confidence model fallback.
3. High-confidence direct scope: read-only tools with explicit or safe default arguments only.
4. Shared extractor for mock and real providers; no separate mock-only rule system.
5. Existing approval, Git safety, session tool-call logging, and recovery loops remain authoritative.

## 4. Architecture

Add a focused package under the agent layer:

```text
cli/src/agent/commandExtract/
  types.ts
  extract.ts
  plan.ts
  format.ts
  execute.ts
  index.ts
```

Integration point:

```text
runAgentTurn(prompt)
  → extract + plan
  → high-confidence readonly chain? execute locally
  → otherwise provider.complete(strategy)
```

### 4.1 `types.ts`

Define:

- `CommandIntent`:
  - `disk_capacity`
  - `disk_growth`
  - `project_status`
  - `project_index`
  - `code_search`
  - `file_read`
  - `runtime_info`
  - `process_memory`
  - `recent_activity`
  - `code_edit`
  - `shell_command`
  - `unknown`
- `Confidence`: `high | medium | low`
- `CommandSlots`: optional `path`, `query`, `drive`, `hours`, `minMb`, `limit`, `command`
- `ExtractionResult`: intent, slots, confidence, reasons
- `PlannedToolStep`: tool name + input
- `CommandPlan`:
  - `mode: 'execute' | 'strategy'`
  - optional tool steps
  - strategy payload for provider injection

### 4.2 `extract.ts`

Responsibilities:

- normalize Chinese/English prompt text;
- classify intent using ordered rules;
- extract only high-value slots;
- assign confidence.

Intent precedence (highest first):

1. explicit file read with path
2. code search with query or code path
3. disk growth
4. disk capacity
5. process memory
6. runtime/environment info
7. recent activity
8. project index / project status
9. code edit
10. shell command
11. unknown

Confidence rules:

- `high` only when intent is read-only and required slots are explicit or have a safe default;
- `medium` when intent is clear but slots are weak;
- `low` for unknown or conflicting signals.

Examples of high confidence:

- “C盘还有多少空间” → `disk_capacity` + drive `C`
- “搜索 apply_patch” → `code_search` + query `apply_patch`
- “读取 package.json” → `file_read` + path `package.json`
- “看看最近会话在干嘛” → `recent_activity`

Examples that must not be high-confidence execute:

- “帮我改登录按钮样式” → `code_edit` strategy only
- “运行 npm test” → `shell_command` strategy only
- “读一下那个文件” without path → not execute

### 4.3 `plan.ts`

Convert extraction into either:

1. an executable read-only tool chain, or
2. a strategy-only plan.

Direct-execute allowlist:

- `disk_info`
- `disk_growth`
- `project_status`
- `project_index`
- `search_text`
- `read_file`
- `environment_info`
- `process_memory`
- `recent_activity`

Never direct-execute:

- `write_file`
- `apply_patch`
- `rename_file`
- `create_docx`
- `run_command`

Chain examples:

- disk capacity → `[disk_info]`
- disk growth → `[disk_growth]`
- file read → `[read_file]`
- code search with query → `[search_text, project_index?]`
- project overview → `[project_status]` or `[project_index]`
- recent activity → `[recent_activity]`
- process memory → `[process_memory]`
- runtime info → `[environment_info]`
- code edit strategy → recommend `project_index, search_text, read_file, apply_patch/write_file`
- shell strategy → recommend dedicated tools first; only then `run_command` under approval

### 4.4 `execute.ts`

When plan mode is `execute`:

1. run each planned tool through existing `runtime.tools.execute`;
2. record every tool call via session store;
3. surface tool UI events;
4. if all succeed, return a short final answer summarizing outcomes;
5. if a recoverable failure occurs, stop direct execution and fall back to the provider with existing tool results already in session;
6. terminal failures keep current agent semantics (`cancelled`, `blocked`, path escape).

Direct execution must not invent a parallel tool runtime. It reuses:

- approval policy
- hooks
- checkpoints
- Git safety unit ownership already established by `runAgentTurn`

### 4.5 `format.ts`

Produce provider-facing strategy text from the same extraction/plan:

```text
Tool strategy:
intent=code_search
confidence=high
recommended=search_text, project_index
avoid=list_files for broad discovery
slots=query:apply_patch
```

For strategy-only mode, this text is injected into `provider.complete`.

## 5. Agent Integration

### 5.1 `runAgentTurn`

Before provider planning:

1. extract + plan the prompt;
2. if `mode === 'execute'`, run the chain and return on full success;
3. otherwise continue existing provider loop with formatted strategy;
4. keep existing Git safety wrapper ownership and result fields.

### 5.2 Mock provider

`mock.planNaturalLanguage` must reuse the shared extractor/planner instead of maintaining a second keyword system. Mock may still serialize multi-step chains one tool per turn for compatibility with existing tests, but the planned steps come from the shared planner.

### 5.3 `toolStrategy.ts`

Keep as the lower-level classification helper where useful, but command extraction becomes the public NL control path. Avoid duplicating divergent keyword lists; extract shared helpers if needed.

### 5.4 Fallback

`planLocalFallback` remains a narrow model-failure recovery path. It is not the main NL command converter.

## 6. Error Handling

- Missing required slot for an otherwise clear intent → strategy only, not execute.
- Tool blocked by approval or path policy → terminal failure as today.
- Recoverable tool failure during direct chain → degrade to provider with partial results preserved.
- Extractor exceptions → log/info warning and fall back to provider path; never crash the turn.
- Shell-looking natural language without an explicit command string → never synthesize a command.

## 7. Testing

Add `cli/tests/command-extract.test.ts` covering:

1. Chinese and English intent classification;
2. slot extraction for path/query/drive/hours/limit;
3. high-confidence execute plans for readonly tools;
4. strategy-only plans for edit/shell/ambiguous prompts;
5. agent integration:
   - high-confidence prompt does not call provider;
   - low-confidence prompt calls provider with strategy;
   - direct-chain recoverable failure falls back to provider;
6. mock reuse of shared planner for representative NL prompts.

Regression targets:

- `tests/tool-strategy.test.ts`
- `tests/smoke.test.ts`
- `tests/autonomy.test.ts`
- `tests/task-board.test.ts`
- `tests/project-memory.test.ts`
- Git safety suites

Also update structural audit needles for the new package and tests.

## 8. Acceptance Criteria

1. “C 盘还有多少空间” executes `disk_info` directly.
2. “搜索 apply_patch” executes `search_text` directly.
3. “读取 package.json” executes `read_file` directly.
4. “帮我改登录按钮样式” does not write files directly; model receives inspect-first strategy.
5. “运行 npm test” does not execute shell directly; remains approval-bound model path.
6. Mock and real provider share one extraction/planning source of truth.
7. Existing approval, Git safety, session logging, and board/memory flows continue to pass.

## 9. Implementation Notes

- Prefer small pure functions for extract/plan so unit tests do not need providers.
- Keep first version ruthlessly scoped to readonly high-confidence cases.
- Do not expand direct execution to write/shell without a later approved design.
- Preserve current one-tool-per-provider-turn protocol for model mode; direct mode may execute a full local chain in one user turn because no model re-planning is required.
