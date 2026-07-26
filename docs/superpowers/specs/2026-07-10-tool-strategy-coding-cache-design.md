# Tool Strategy and Coding Ability Design

Date: 2026-07-10

## Goal

Improve the CLI agent's coding ability by making tool selection more deliberate and less repetitive. The first implementation phase prioritizes smarter tool choice. Cache improvements are included only where they support better tool routing and future project-context reuse.

## Background

The current agent loop already supports tool calls, persisted tool results, recoverable tool failures, project context injection, and dedicated tools for files, search, disk, process, git, docx, and patch-like edits. The main gaps are:

- Tool choice is mostly driven by provider prompt text or mock keyword checks.
- Tool specs are descriptive strings, not structured strategy guidance.
- Recoverable failures are returned to the model, but the recovery instruction is generic.
- The project context cache only covers top-level instruction files and is process-local.
- Coding requests do not have a consistent local strategy such as inspect, search, read, edit, verify.

## Scope

This design covers a first phase centered on tool strategy:

- Add a local tool strategy layer before provider calls.
- Classify common task intents.
- Recommend and avoid tools for each intent.
- Add cache hints that can later be backed by a persistent project index.
- Make recoverable tool failure guidance more specific.
- Reuse the strategy in mock planning where practical, so tests reflect the same behavior users see.

This design does not replace the provider protocol with native tool/function calling. It also does not replace the current patch implementation with a full patch engine. Those are follow-up phases.

## Proposed Architecture

Add `cli/src/agent/toolStrategy.ts`.

The module exports a small pure function:

```ts
export type ToolIntent =
  | 'code_edit'
  | 'code_search'
  | 'disk_growth'
  | 'disk_capacity'
  | 'project_overview'
  | 'runtime_info'
  | 'unknown';

export type ToolStrategyContext = {
  intent: ToolIntent;
  recommendedTools: string[];
  avoidTools: string[];
  reason: string;
  cacheHints: string[];
  recoveryHints: string[];
};

export function planToolStrategy(input: {
  prompt: string;
  recentTools: Array<{ tool: string; ok: boolean; output: string }>;
  workspaceRoot: string;
}): ToolStrategyContext;
```

The first version uses conservative keyword and recent-tool-result rules. It should stay deterministic and easy to test. It should not call the model or perform file I/O.

## Intent Rules

`disk_growth`:
Requests about disk growth, recent large files, cleanup, or unexplained space usage.
Recommended tools: `disk_growth`.
Avoid tools: `list_files`, `project_index`, `run_command` unless explicitly requested.

`disk_capacity`:
Requests about free space, drive capacity, or C/D drive size.
Recommended tools: `disk_info`.
Avoid tools: `run_command`.

`project_overview`:
Requests about project structure, what files exist, or repo overview.
Recommended tools: `project_index`, then `list_files` if more detail is needed.
Avoid tools: `run_command` for simple listing.

`code_search`:
Requests to find symbols, text, references, routes, components, or behavior locations.
Recommended tools: `search_text`, `project_index`, `read_file`.
Avoid tools: `run_command` unless a dedicated tool cannot answer.

`code_edit`:
Requests to implement, fix, refactor, or modify code.
Recommended tools: `project_index`, `search_text`, `read_file`, then `apply_patch` or `write_file` depending on edit size.
Avoid tools: `run_command` before inspection, direct writes before reading target files, broad file listing unless the project index is insufficient.

`runtime_info`:
Requests about environment, process memory, OS, or runtime identity.
Recommended tools: `environment_info` or `process_memory` based on prompt.
Avoid tools: `run_command` when a dedicated tool exists.

`unknown`:
No strong intent. Keep current provider behavior, but include a short instruction to prefer dedicated tools over shell.

## Agent Loop Integration

In `runAgentTurn()`:

1. Build `projectContext` as it does today.
2. Build `toolStrategy` from the current prompt and recent tool calls.
3. Pass formatted strategy guidance into the provider request.
4. Include the strategy guidance in the system prompt near tool guidance.

Provider request shape should gain an optional field:

```ts
toolStrategy?: string;
```

`buildToolSystemPrompt()` should append a compact section like:

```text
Tool strategy:
intent=code_edit
recommended=project_index, search_text, read_file, apply_patch
avoid=run_command before inspection, write_file before reading target files
reason=Code editing request; inspect relevant files before editing.
cacheHints=Use cached project index if available; avoid rereading unchanged instruction context.
```

The strategy text is guidance, not a hard policy. Safety and approval remain enforced by tools and registry.

## Recovery Guidance

Replace the generic recoverable failure note with more actionable guidance. The agent should still append the failed tool result to the session, then let the model continue.

Examples:

- Path not found: suggest `list_files`, `project_index`, or `search_text` to locate the file.
- Old text not found in patch/edit: suggest `read_file` and retry with exact surrounding text.
- Command blocked: suggest a dedicated read-only tool or ask for approval if the task truly requires shell.
- Windows command failure: suggest a platform-correct command or a dedicated tool.
- Empty search result: suggest broader query terms or project index before reading random files.

Expose this through a helper such as:

```ts
export function recoveryHintForToolFailure(tool: string, output: string): string | undefined;
```

`executeToolAction()` can include this hint in the UI info line and, more importantly, in the session message that the provider sees.

## Mock Provider Integration

The mock provider currently has independent keyword checks. The first version should import and reuse the intent classifier where it improves behavior without making the mock provider complex.

Expected changes:

- `disk_growth` prompts should produce only `disk_growth` plus the final message.
- `disk_capacity` prompts should produce only `disk_info` plus the final message unless the prompt explicitly asks for another action.
- code search prompts should prefer `search_text` over broad `list_files`.
- code edit prompts should prefer an inspect-first chain in mock mode: `project_index`, then relevant read/search tools when extractable.

## Cache Hit Improvements in This Phase

This phase does not build the full persistent cache. It prepares for it by adding strategy-level cache hints:

- Encourage using `project_index` before broad file reads for coding tasks.
- Avoid rereading instruction context when the existing `cacheKey` is unchanged.
- Prefer cached or recently observed tool results when the same prompt intent asks for the same data in one turn.

The follow-up cache phase can add:

- `.aicode/cache/project-index.json`
- workspace fingerprinting
- ignore-file awareness
- file metadata deltas
- summary reuse for unchanged files

## Testing Plan

Add or update tests for:

- tool strategy intent classification for disk, code search, code edit, project overview, and runtime info.
- provider prompt includes strategy guidance.
- disk growth prompts do not trigger `list_files`.
- code edit prompts recommend inspect/search/read before editing.
- recoverable failures produce specific recovery hints.
- existing smoke, autonomy, growth, terminal UI, and audit tests still pass.

## Non-Goals

- Native OpenAI or Anthropic tool calling.
- Full unified diff patch support.
- Persistent project index cache.
- Automatic test selection and repair loop.
- Broad refactors of the provider layer.

## Risks and Mitigations

Risk: Rules become brittle.
Mitigation: Keep strategy advisory and deterministic. Add focused tests for high-value prompts.

Risk: Strategy guidance conflicts with provider reasoning.
Mitigation: Phrase as recommended and avoided tools, not as absolute restrictions. Safety policy remains authoritative.

Risk: Mock provider diverges from real provider behavior.
Mitigation: Share intent classification, but keep provider prompt guidance as the source of behavior for hosted models.

Risk: Cache hints imply a cache that does not exist yet.
Mitigation: In phase one, cache hints are limited to existing session/tool results and the current project context cache key. Persistent cache is explicitly follow-up work.

## Success Criteria

- The agent gives hosted providers compact, explicit tool strategy guidance every turn.
- Common prompts choose fewer unnecessary tools in mock mode.
- Coding requests are guided toward inspect/search/read before edit.
- Recoverable tool failures provide concrete next-step hints.
- Existing tests pass, and new strategy tests protect the behavior.
