# Project OS Phase 2: Project Memory Design

Date: 2026-07-14

## Goal

Enable the CLI agent to remember project conventions, decisions, and pitfalls across tasks in the same workspace, so later planning and task execution can reuse prior outcomes instead of rediscovering them each turn.

This is Phase 2 (P2) of Project OS. It builds on P1 Task Board Runtime.

## Background

P1 already provides:

- Durable task boards under `.aicode/tasks/`
- Confirm-then-auto-run sequential execution
- Session `taskRuntime` pointer/mode
- `/plan` board controls and blocked resume

Current gaps for large-project continuity:

- Task `resultSummary` / `error` live only on the board and are not promoted into durable reusable project knowledge
- Planning and later tasks only see completed-task summaries for the current board, not stable conventions across boards/sessions
- Existing `readProjectContext` only loads static instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `README.md`)
- No first-class command surface for project memory inspection/edit

## Roadmap Context

| Phase | Name | Focus |
| --- | --- | --- |
| P1 | Task Board Runtime | Durable board, confirm-then-auto-run, resume |
| P2 | Project Memory | Project conventions, decisions, pitfalls |
| P3 | Codebase Navigation | Stronger indexing/search for large repos |
| P4 | Verify Loop | Build/test after tasks, write failures back to board |
| P5 | Git Workflow | Controlled branch/commit under approval |

This design covers **P2 only**.

## Scope

In scope:

- Workspace-authoritative project memory under `.aicode/memory/`
- Structured entries: `convention | decision | pitfall | note`
- Automatic memory candidates from task `done` / `blocked` outcomes
- Manual `/memory` add/list/forget controls
- Relevant memory injection into task-board planning display and single-task execution prompts
- Deterministic offline tests with mock/no network

Out of scope:

- Vector embeddings / semantic search (later if needed)
- Cross-workspace user profile memory (already handled elsewhere)
- Auto-editing `AGENTS.md` / `CLAUDE.md`
- Injecting memory into every one-shot small request by default
- P3 codebase index upgrades
- P4 verify loop orchestration
- P5 mutating git workflows

## Decisions Locked

- Storage approach: **workspace JSON memory store**, not markdown-first and not vector DB
- Write sources: **task outcomes + light manual commands**
- Injection targets: **task board planning context + single-task execution prompts**
- Success criterion: later tasks in the same project can see and follow earlier decisions/pitfalls
- Failure isolation: memory I/O/extract failures must not block board execution

## Architecture

```text
Task done/blocked
        |
        v
 extractMemoryCandidates (pure)
        |
        v
 ProjectMemoryStore (.aicode/memory/entries.json)   [authoritative]
        ^
        |
 /memory add|list|forget

planBoard / board creation path
        |
        +--> selectRelevantMemories(goal) --> optional display hints

buildTaskPrompt(task)
        |
        +--> selectRelevantMemories(goal, task) --> inject compact memory block
```

### Modules

1. `cli/src/memory/types.ts`
   - Entry types, kinds, source metadata

2. `cli/src/memory/store.ts`
   - `ProjectMemoryStore`: load/save/list/add/forget under workspace `.aicode/memory/`

3. `cli/src/memory/extract.ts`
   - Pure candidate extraction from task completion/block results
   - Dedup against existing active entries

4. `cli/src/memory/select.ts`
   - Pure relevance selection for a goal/task query

5. `cli/src/memory/format.ts`
   - Compact prompt/CLI formatting helpers

6. Integration points
   - `cli/src/tasks/runtime.ts`: record memory after task terminal states; inject into `buildTaskPrompt`
   - `cli/src/cli/repl.ts` (and/or planner path): show memory hints when creating a board
   - `cli/src/cli/commands.ts`: `/memory` command surface
   - `cli/src/audit/checks.ts`, docs, tests

## Data Model

### Storage path

```text
.aicode/memory/entries.json
```

Whole-file JSON overwrite. Single local agent assumed (same consistency model as task boards).

### Entry shape

```ts
export type MemoryKind = 'convention' | 'decision' | 'pitfall' | 'note';

export type ProjectMemoryEntry = {
  id: string; // mem_YYYYMMDDHHMMSS_xxxxxxxx
  kind: MemoryKind;
  summary: string; // short, max 240 chars
  keywords: string[]; // normalized lowercase tokens
  source: {
    type: 'task' | 'user' | 'system';
    boardId?: string;
    taskId?: string;
  };
  createdAt: string;
  updatedAt: string;
  active: boolean; // forget is soft-delete
};
```

### Store file shape

```ts
export type ProjectMemoryFile = {
  version: 1;
  updatedAt: string;
  entries: ProjectMemoryEntry[];
};
```

### Consistency rules

- Authoritative state is workspace memory file, not session state
- `forget` sets `active=false`; list/select default to active entries only
- Duplicate prevention: normalize summary (trim/lowercase/collapse whitespace); skip add when an active entry already equals or contains the candidate summary
- Keep summaries short; truncate to 240 chars on write
- Keywords derived from summary tokens plus optional explicit tokens; keep a small unique set (for example top 12)

## Write Rules

### Manual writes

`/memory add <kind> <text>`:

- Creates active entry with `source.type='user'`
- Kind required and must be one of the four kinds
- Empty text rejected

### Automatic writes from tasks

After a task reaches a terminal status in the board loop:

| Task event | Candidate behavior |
| --- | --- |
| `done` with useful `resultSummary` | Create `decision` or `note` |
| `blocked` with useful `error` | Create `pitfall` |
| Noisy/short summary (for example `ok`, `TASK_DONE: ok`, `< 12` meaningful chars) | Skip |
| Duplicate of existing active entry | Skip |

Classification heuristic for successful tasks:

- If summary mentions explicit convention language (`约定`, `convention`, `always use`, `必须使用`) → `convention`
- Else if summary mentions constraint/decision language (`use`, `must`, `never`, `不要`, `必须`, `测试用`, `prefer`) → `decision`
- Otherwise → `note`
- Automatic path does not invent high-confidence conventions from weak text; when unsure, prefer `note`

Automatic extraction is deterministic and rule-based in P2. No model call is required for extract.

### When to persist

In `runTaskBoardLoop`, after `markTaskDone` / `markTaskBlocked` updates board state and the board file is saved:

1. Load memory store (empty if missing)
2. Extract candidates from the terminal task
3. Add non-duplicate entries
4. Save memory store
5. Continue board flow even if memory save fails (warn only)

Board persistence remains authoritative for task status. Memory persistence is best-effort and independent.

## Read / Selection Rules

```ts
selectRelevantMemories(input: {
  entries: ProjectMemoryEntry[];
  goal: string;
  taskTitle?: string;
  taskDetail?: string;
  limit?: number; // default 5
}): ProjectMemoryEntry[]
```

Scoring:

1. Only `active` entries
2. Keyword hits against `goal + taskTitle + taskDetail`
3. Kind weight: `convention=3`, `decision=3`, `pitfall=2`, `note=1`
4. Recency boost from `updatedAt`
5. Stable tie-break by newer `updatedAt`, then `id`

Fallback:

- If no keyword hits, still return up to 2 newest `convention`/`decision` entries as global defaults
- Never return more than `limit`

## Injection

### Task execution prompt

`buildTaskPrompt` accepts optional memories and appends:

```text
Project memory:
- [decision] Prefer npm test for verification
- [pitfall] Do not edit generated dist/ output
```

Placement: after completed-task summaries, before "Focus only on this task."

### Planning / board creation

When a large goal creates a draft board:

- Select memories for the goal
- Print a short memory hint block to the UI (informational)
- Do not hard-fail if none exist
- Optional: include a compact memory hint in task `detail` only when highly relevant; default is UI + later task-prompt injection to avoid polluting board JSON excessively

### One-shot small requests

Default: no project-memory injection. Existing instruction-file context remains sufficient.

## Commands

| Command | Behavior |
| --- | --- |
| `/memory` | List active entries (newest first, capped) |
| `/memory list` | Same as `/memory` |
| `/memory add <kind> <text>` | Add user entry |
| `/memory forget <id\|query>` | Soft-deactivate matching entry |

Notes:

- `forget` by id preferred; query matches first active summary/keyword hit
- If no board/memory exists yet, list returns an empty-state message
- Help text updated to include `/memory`

## Agent Integration Details

### Runtime

- Extend `buildTaskPrompt(board, task, memories?)`
- In loop, after terminal task status:
  - `maybeRecordTaskMemory({ store, board, task })`
- When starting a task:
  - `memories = selectRelevantMemories(...)`
  - pass into `buildTaskPrompt`

### REPL / planning path

- After draft board creation in `handleDevelopmentPrompt`, load/select/format memories and `ui.info` them
- Confirm/auto-run path unchanged except task prompts now include memory

### Compatibility

- No provider protocol changes
- No session schema changes required for P2
- Existing task board files remain valid without memory fields

## Error Handling

| Failure | Behavior |
| --- | --- |
| Missing memory file | Treat as empty list |
| Corrupt JSON | Warn, treat as empty, next successful save rewrites valid file |
| Memory save failure during task loop | Log/info warning; board status updates still persist |
| Unknown `/memory` action | Return usage string |
| Forget target not found | Return not-found message |

## File / API Layout

```text
cli/src/memory/types.ts
cli/src/memory/store.ts
cli/src/memory/extract.ts
cli/src/memory/select.ts
cli/src/memory/format.ts
cli/src/tasks/runtime.ts          # inject + record hooks
cli/src/cli/repl.ts               # board-create memory hints
cli/src/cli/commands.ts           # /memory commands + help
cli/tests/project-memory.test.ts  # new
cli/src/audit/checks.ts           # files/needles
cli/docs/capability-matrix.md
cli/README.md
```

## Testing Strategy

Required tests in `cli/tests/project-memory.test.ts`:

1. **Store**
   - add/list/load/forget soft-delete
   - missing file => empty
2. **Extract**
   - done useful summary => entry
   - blocked error => pitfall
   - noisy summary skipped
   - duplicate skipped
3. **Select**
   - keyword relevance ranks higher
   - limit respected
   - fallback conventions/decisions when no hits
4. **Runtime integration**
   - completing a task records memory
   - next task prompt contains recorded memory summary
5. **Slash commands**
   - `/memory add|list|forget`
6. **Regression**
   - existing task-board tests remain green
   - typecheck/full suite/audit pass

## Acceptance Criteria

P2 is done when:

1. Task success/failure can create durable entries under `.aicode/memory/entries.json`.
2. Later tasks in the same workspace receive relevant prior decisions/pitfalls in their execution prompt.
3. `/memory list|add|forget` works for manual control.
4. Memory subsystem failures do not block task board execution.
5. Small one-shot prompts remain unchanged by default.
6. Typecheck, full tests, and audit checks pass with new coverage needles.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Noisy auto-extract creates junk memory | Strict usefulness/dedup filters; short summaries; soft forget |
| Irrelevant injection distracts the model | Limit 5; scoring; fallback only 2 global conventions/decisions |
| Memory file corruption | Empty fallback + rewrite on next save |
| Over-coupling to boards | Store is independent; boards only provide source metadata |
| Scope creep into vector search | Explicitly deferred |

## Follow-up (not P2)

- P3: better codebase navigation may improve keyword/source grounding
- P4: verify-loop failures can write higher-quality pitfalls automatically
- Optional later: markdown export, confidence scores, memory pinning

## Implementation Notes

- Prefer pure helpers for extract/select/format; keep I/O in `ProjectMemoryStore`
- Reuse existing CLI command/test/audit patterns from P1
- Keep mock/offline determinism
- Workspace may not be a git repository; skip commits when `git rev-parse` fails
