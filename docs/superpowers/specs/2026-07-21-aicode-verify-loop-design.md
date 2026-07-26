# aicode CLI P4 Verify Loop Design

**Date:** 2026-07-21  
**Status:** Approved for implementation

## 1. Goal

Stop task-board false completion by requiring a verification gate after a task claims done.

When a board task is textually complete:

1. discover and run available package verification scripts in order: `typecheck` → `test` → `build`;
2. mark done only if verification passes;
3. on failure, allow at most one automatic repair turn, then re-verify;
4. if still failing, mark the task blocked, pause the board, and record a pitfall when useful.

## 2. Non-goals

- Forcing full verify on every ordinary chat turn
- Multi-repair loops beyond one attempt
- Language ecosystems beyond Node package.json scripts in v1
- Replacing human `/plan continue` recovery
- OS sandboxing of verify commands

## 3. Confirmed decisions

1. Priority: P4 before P3.
2. Failure policy: write back blocked + at most one automatic repair.
3. Default suite: discover package scripts `typecheck` → `test` → `build`.
4. Missing scripts: skip, do not fail the suite solely for absence.
5. Scope: task-board tasks only by default; disable with `AICODE_VERIFY_TASKS=0`.

## 4. Architecture

```text
runTaskBoardLoop
  runTurn(task)
  detectTaskCompletion
    not done → existing blocked path
    done candidate →
      VerifySuite
        pass → markTaskDone
        fail → repair turn (max 1)
               re-verify
               pass → markTaskDone
               fail → markTaskBlocked + pause + pitfall
```

### Modules

- `cli/src/tasks/verify.ts`
  - `discoverVerifyCommands(workspaceRoot)`
  - `runVerifySuite(options)`
  - truncate outputs; structured results
- `cli/src/tasks/repair.ts` (or functions in verify.ts if small)
  - `buildRepairPrompt(task, verifyResult)`
- `cli/src/tasks/runtime.ts`
  - integrate gate after textual done
- tests: `cli/tests/task-verify.test.ts`
- docs/audit updates

### Command discovery

Read `package.json` scripts:

| script | command |
| --- | --- |
| typecheck | `npm run typecheck` |
| test | `npm test` |
| build | `npm run build` |

Run only those present, in that order. If none present, suite succeeds with all skipped.

### Execution

- Use controlled child process execution (fixed argv or tightly constrained shell equivalent already allowed by policy).
- Prefer `npm` from PATH with cwd = workspaceRoot.
- Timeout default 10 minutes per command.
- Capture stdout+stderr, truncate to ~12KB total per command for board/session safety.
- Nonzero exit or timeout => failed.

### Repair turn

- Inject failed command names, exit codes, and truncated logs.
- Instruct minimal fix and require `TASK_DONE` when finished.
- Count: max 1 repair attempt per task execution cycle.
- New Git safety unit if gitSafety is present (new unit id for the repair turn).

### Config

- Enabled when `process.env.AICODE_VERIFY_TASKS` is not `'0'` and not `'false'`.
- Optional future config flag; env is enough for v1.

## 5. Data model

```ts
export type VerifyCommandName = 'typecheck' | 'test' | 'build';

export type VerifyCommandResult = {
  name: VerifyCommandName;
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode?: number | null;
  durationMs: number;
  output: string;
  reason?: string;
};

export type VerifySuiteResult = {
  ok: boolean;
  results: VerifyCommandResult[];
  summary: string;
  failedAt?: VerifyCommandName;
};
```

Board task fields remain existing; store failure text in `task.error` and success note in `resultSummary` including `[verified]` or `[verified after repair]`.

## 6. Testing

1. discover scripts presence/absence
2. done + pass => done
3. done + fail => one repair turn invoked
4. repair + pass => done
5. repair + fail => blocked + paused
6. no scripts => skipped suite ok
7. env disable => no verify
8. output truncation

Use injectable runner in unit tests; do not rely on full repo npm test inside every case.

## 7. Acceptance

- Textual `TASK_DONE` cannot mark board task done if `npm test` fails.
- One automatic repair then re-verify is supported.
- Persistent failure blocks and pauses for `/plan continue`.
- Existing board/memory/git/nl suites remain green.
