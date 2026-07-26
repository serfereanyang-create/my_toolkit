# Project OS Phase 1: Task Board Runtime Design

Date: 2026-07-13

## Goal

Enable the CLI agent to develop large projects through long-running, planned work: decompose a large requirement into a durable task board, require user confirmation, then execute tasks automatically in order with recoverable failures and cross-session resume.

This is Phase 1 (P1) of a larger Project OS roadmap for large-project development.

## Background

The current CLI MVP already has:

- Agent loop with tool calls, approvals, checkpoints, and sessions (`--resume`)
- Tool strategy for deliberate tool choice
- Lightweight `project_index` and read-only git tools
- Slash commands including `/plan`, which today only replays recent tool calls

Gaps for large-project work:

- No first-class task board; `/plan` is not a plan
- No durable workspace-level task state across sessions
- No confirm-then-auto-execute workflow for multi-step goals
- No structured per-task progress, acceptance, or blocked recovery

## Roadmap Context

Full Project OS is intentionally phased:

| Phase | Name | Focus |
| --- | --- | --- |
| P1 | Task Board Runtime | Durable board, confirm-then-auto-run, resume |
| P2 | Project Memory | Project conventions, decisions, pitfalls |
| P3 | Codebase Navigation | Stronger indexing/search for large repos |
| P4 | Verify Loop | Build/test after tasks, write failures back to board |
| P5 | Git Workflow | Controlled branch/commit under approval |

This design covers **P1 only**. Later phases depend on P1 but are out of scope here.

## Scope

In scope:

- Workspace-authoritative task boards under `.aicode/tasks/`
- Session progress pointers (`taskRuntime`) for current board/active task/mode
- Draft board generation for large requirements
- User confirmation before automatic execution
- Sequential auto-execution of pending tasks after confirmation
- Failure → blocked stop with `/plan continue` recovery
- Enhanced `/plan` commands and display
- Tests for store state machine, confirm/auto-run, blocked resume, slash UX

Out of scope (later phases):

- Long-term project memory beyond board/task summaries (P2)
- Symbol/vector index upgrades (P3)
- Automatic build/test orchestration (P4)
- Mutating git workflows (P5)
- Multi-user remote boards, UI kanban, priority engines

## Architecture

Add a small task-runtime layer beside the existing agent loop:

```text
User prompt / slash command
        |
        v
  TaskRuntime (mode + next action)
        |
        +--> TaskBoardStore  (.aicode/tasks/*.json)   [authoritative]
        |
        +--> SessionStore.taskRuntime                 [pointer/progress]
        |
        +--> runAgentTurn (existing)                  [single-task execution]
        |
        +--> /plan commands                           [inspect/control]
```

### Modules

1. `cli/src/tasks/types.ts`
   - `TaskBoard`, `TaskItem`, status unions, session `TaskRuntimeState`

2. `cli/src/tasks/store.ts`
   - `TaskBoardStore`: create/load/save/list boards under workspace `.aicode/tasks/`
   - Atomic-enough whole-file JSON writes; single local agent assumed

3. `cli/src/tasks/planner.ts`
   - `shouldUseTaskBoard(prompt)` heuristic for large multi-step goals
   - `planBoardFromGoal(goal)` → draft board with ordered tasks
   - First version: deterministic planner for mock/tests + provider-assisted planning path when hosted models are available
   - Planner must remain testable; mock path must not require network

4. `cli/src/tasks/runtime.ts`
   - Mode machine: `idle | planning | awaiting_confirm | executing | paused`
   - Select next runnable task (pending + dependencies satisfied)
   - Drive one task through `runAgentTurn` with scoped prompt
   - Update board/task status and session pointers
   - Auto-loop after confirm until blocked/completed/paused

5. `cli/src/cli/commands.ts` + `repl.ts`
   - Expand `/plan` into real board control surface
   - Integrate auto-execution into prompt/REPL flows without breaking simple one-shot turns

## Data Model

### Workspace board file

Path:

```text
.aicode/tasks/<boardId>.json
```

Optional index:

```text
.aicode/tasks/index.json
```

`index.json` may list `{ id, title, status, updatedAt }` for quick discovery. Board files remain authoritative.

### TaskBoard

```ts
export type BoardStatus = 'draft' | 'active' | 'completed' | 'blocked' | 'cancelled';

export type TaskBoard = {
  id: string;              // board_YYYYMMDDHHMMSS_xxxxxxxx
  title: string;
  goal: string;
  status: BoardStatus;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  tasks: TaskItem[];
};
```

### TaskItem

```ts
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'blocked'
  | 'cancelled'
  | 'skipped';

export type TaskItem = {
  id: string;              // task_1, task_2, ...
  title: string;
  detail?: string;
  status: TaskStatus;
  dependsOn: string[];
  acceptance?: string;
  resultSummary?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};
```

### Session pointer

Extend `SessionRecord`:

```ts
taskRuntime?: {
  boardId?: string;
  activeTaskId?: string;
  mode: 'idle' | 'planning' | 'awaiting_confirm' | 'executing' | 'paused';
  lastSyncAt?: string;
};
```

### Consistency rules

- Authoritative state is the workspace board file.
- Session stores only pointer/mode and is re-aligned from the board on resume.
- At most one task is `in_progress` at a time.
- A task may start only if all `dependsOn` tasks are `done` or `skipped`.
- Confirming a draft board sets board `status=active` and `confirmedAt`.
- Task failure sets task `status=blocked`, board `status=blocked`, mode `paused` or idle-with-blocked (implementation may use `paused` after block to force explicit continue).
- When all tasks are `done`/`skipped`/`cancelled` and none remain pending/in_progress/blocked, board becomes `completed`.

## User Workflow

### Happy path

1. User submits a large requirement.
2. Runtime detects board-worthy goal, creates draft board, sets mode `awaiting_confirm`.
3. CLI shows the board (via assistant output and `/plan`).
4. User runs `/plan confirm` (or clear natural-language confirmation while awaiting confirm).
5. Board becomes `active`; runtime auto-executes runnable tasks in order.
6. Each task runs as a scoped agent turn with goal/task/acceptance/context.
7. Successful task → `done` + `resultSummary`; continue next task.
8. All complete → board `completed`.

### Failure path

1. Terminal tool failure, max steps, or model failure on a task → task `blocked` + `error`.
2. Board becomes `blocked`; auto-loop stops.
3. User inspects with `/plan`.
4. User fixes context manually if needed, then `/plan continue`.
5. Continue reopens the blocked task (or starts next pending if user skipped), then resumes auto-execution.

### Small request path

Simple prompts that are not board-worthy continue to call `runAgentTurn` once, unchanged.

## Commands

Enhance `/plan`:

| Command | Behavior |
| --- | --- |
| `/plan` | Show active/current board: goal, status, tasks with status |
| `/plan confirm` | Confirm draft board and start auto-execution |
| `/plan pause` | Pause auto-execution; keep board/task state |
| `/plan continue` | Resume from blocked/paused/next pending |
| `/plan skip <taskId>` | Mark task skipped if not done |
| `/plan reopen <taskId>` | Set task back to pending (clear error/result as needed) |
| `/plan show <boardId>` | Load/show a specific board and attach session pointer |

If no board exists, `/plan` reports that and may show legacy recent tool calls as a secondary section for compatibility.

### Non-interactive / CI behavior

- `--no-input` / CI must **not** auto-confirm draft boards.
- Auto-execution is allowed only when board is already `active` or an explicit confirm flag is provided (e.g. `--confirm-plan`).
- Without confirmation, planning can create/update a draft board and exit with instructions to confirm.

## Agent Integration

### Large-goal detection

`shouldUseTaskBoard(prompt)` is a conservative heuristic. Positive signals include multi-step language, implement/build feature requests, cross-module wording, and fix-plus-verify style goals. Single-file read/search/status questions stay one-shot.

False positives should prefer one-shot over forced boards. Users can still ask explicitly to plan.

### Planning

`planBoardFromGoal`:

- Produces 3–12 tasks by default (soft range, not hard UI limit)
- Each task has title, optional detail/acceptance, ordered dependencies (usually linear `task_n depends on task_{n-1}` unless planner specifies otherwise)
- Draft board written to workspace before confirmation
- Hosted providers may help generate tasks; mock/deterministic planner must support tests offline

### Task execution prompt

When executing `task_k`, the agent turn prompt includes:

- Board goal
- Current task id/title/detail/acceptance
- Completed task summaries (compact)
- Dependency notes
- Instruction to focus only on the current task and report completion clearly

Tool strategy continues to run inside `runAgentTurn` unchanged.

### Completion detection

Order of preference:

1. Structured final signal from the model (e.g. explicit task result marker agreed by protocol)
2. Heuristic: final answer indicates completion and no unrecovered terminal tool failure in the task turn
3. Otherwise mark `blocked` with reason that completion was unclear

Do not invent success. Ambiguity becomes human-visible blocked state.

### Error mapping

| Event | Task result |
| --- | --- |
| Terminal tool failure (`blocked:`, cancelled, path escape) | `blocked` |
| Max steps reached | `blocked` |
| Provider/model request failed with no successful local fallback for the task | `blocked` |
| Recoverable tool failure that the model successfully recovers within the turn | continue; may still complete |

## File / API Layout

```text
cli/src/tasks/types.ts
cli/src/tasks/store.ts
cli/src/tasks/planner.ts
cli/src/tasks/runtime.ts
cli/src/session/store.ts          # add taskRuntime field
cli/src/cli/commands.ts           # /plan subcommands
cli/src/cli/repl.ts               # confirm/auto-run integration
cli/src/cli/args.ts               # optional --confirm-plan
cli/tests/task-board.test.ts      # new
cli/tests/autonomy.test.ts        # resume/continue integration as needed
cli/src/audit/checks.ts           # register files/needles
```

## Testing Strategy

Required tests:

1. **Store unit tests**
   - create/load/save board
   - dependency gating
   - status transitions: draft → active → completed; failure → blocked

2. **Planner tests**
   - large goal creates draft board with pending tasks
   - small goal does not force board

3. **Runtime tests**
   - confirm starts first runnable task
   - auto-advances after success
   - failure blocks and stops loop
   - continue resumes correctly
   - pause prevents auto-advance

4. **Slash command tests**
   - `/plan` renders board state
   - confirm/pause/continue/skip/reopen behaviors

5. **Session resume tests**
   - new/resumed session with same workspace board pointer continues from authoritative board file

6. **Regression**
   - existing smoke/autonomy/tool-strategy suites remain green
   - simple one-shot prompts still bypass board flow

## Acceptance Criteria

P1 is done when:

1. A large requirement can create a durable draft board in `.aicode/tasks/`.
2. `/plan` shows real task status, not only recent tools.
3. `/plan confirm` activates the board and auto-executes tasks in order.
4. A failed task becomes `blocked`, stops auto-run, and is visible in `/plan`.
5. `/plan continue` resumes from the blocked/next task.
6. A later session can attach to the same board and continue.
7. Simple prompts still work without forcing a board.
8. Typecheck, full test suite, and audit checks pass with new coverage needles.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Planner over-triggers boards for small asks | Conservative heuristic; easy one-shot fallback |
| Model does not clearly finish a task | Ambiguous completion → blocked, not silent success |
| Board/session drift | Board file authoritative; session pointer re-synced on load |
| Infinite auto-loop | Max tasks/steps guards; pause/block stops |
| CI accidental auto-run | No auto-confirm under `--no-input` without explicit flag |

## Follow-up Phases (not P1 implementation)

- **P2 Project Memory**: persist conventions/decisions; inject into planning and task prompts
- **P3 Codebase Navigation**: stronger project index/search for large repos
- **P4 Verify Loop**: run tests/build after tasks; failures write back to board
- **P5 Git Workflow**: approved branch/commit flows linked to board results

## Implementation Notes

- Prefer small pure helpers for state transitions; keep I/O in `TaskBoardStore`.
- Do not redesign tool strategy or provider protocol in P1.
- Keep mock provider usable for offline board execution tests.
- Commit/docs only when the workspace is a git repository; otherwise skip commits and leave files in tree.
