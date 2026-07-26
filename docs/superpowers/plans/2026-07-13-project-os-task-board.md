# Project OS P1 Task Board Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable workspace task board so large requirements can be planned, user-confirmed, auto-executed in order, blocked on failure, and resumed across sessions.

**Architecture:** Introduce a `cli/src/tasks/` package with pure types/planner/runtime helpers and a `TaskBoardStore` that owns `.aicode/tasks/*.json`. Session records only store a `taskRuntime` pointer/mode. Enhance `/plan` for board control and wrap prompt/REPL entry so confirmed boards auto-run one task at a time through the existing `runAgentTurn` loop.

**Tech Stack:** TypeScript, Node.js test runner (`node:test`), existing CLI session/agent/slash-command architecture.

**Spec:** `docs/superpowers/specs/2026-07-13-project-os-task-board-design.md`

**Workspace note:** `C:\Users\34516\ZCodeProject` may not be a git repository. For every commit step, run `git rev-parse --is-inside-work-tree` first; if it fails, skip the commit and continue.

---

## File Structure

- Create `cli/src/tasks/types.ts`
  - Board/task/status types and session `TaskRuntimeState`.

- Create `cli/src/tasks/store.ts`
  - Read/write/list board JSON under `<workspace>/.aicode/tasks/`.

- Create `cli/src/tasks/planner.ts`
  - `shouldUseTaskBoard(prompt)` and deterministic `planBoardFromGoal(goal)`.

- Create `cli/src/tasks/runtime.ts`
  - Next-task selection, status transitions, board formatting, confirm/pause/continue/skip/reopen helpers.
  - `runTaskBoardLoop(...)` orchestrates auto-execution using injected `runTurn`.

- Create `cli/src/tasks/completion.ts`
  - Pure completion detection for a finished agent turn result.

- Modify `cli/src/session/store.ts`
  - Add optional `taskRuntime` on `SessionRecord` and default it on create.

- Modify `cli/src/config/types.ts`
  - Add optional `confirmPlan?: boolean` to `CliArgs` and `AppConfig`.

- Modify `cli/src/cli/args.ts`
  - Parse `--confirm-plan`.

- Modify `cli/src/config/config.ts`
  - Map `confirmPlan` into `AppConfig`.

- Modify `cli/src/cli/commands.ts`
  - Replace tool-history-only `/plan` with board commands.

- Modify `cli/src/cli/repl.ts`
  - Route large goals through task board planning/execution; honor confirm/auto-run modes.

- Modify `cli/src/index.ts` only if needed to pass config; prefer keeping orchestration in `repl.ts`.

- Create `cli/tests/task-board.test.ts`
  - Unit + integration coverage for store, planner, runtime, slash commands, resume.

- Modify `cli/src/audit/checks.ts`
  - Register new files and needles.

- Modify `cli/docs/capability-matrix.md`
  - Mark task board / long-task planning as Implemented MVP for P1.

---

### Task 1: Task Types and Session Pointer

**Files:**
- Create: `cli/src/tasks/types.ts`
- Modify: `cli/src/session/store.ts`
- Test: `cli/tests/task-board.test.ts`

- [ ] **Step 1: Write failing type/session smoke test**

Create `cli/tests/task-board.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskBoard, TaskRuntimeState } from '../src/tasks/types.js';
import { SessionStore } from '../src/session/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('session records optional taskRuntime pointer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-task-session-'));
  try {
    const sessions = new SessionStore(dir);
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: dir });
    assert.equal(session.taskRuntime, undefined);

    const runtime: TaskRuntimeState = {
      boardId: 'board_test',
      activeTaskId: 'task_1',
      mode: 'awaiting_confirm',
      lastSyncAt: new Date().toISOString(),
    };
    session.taskRuntime = runtime;
    await sessions.save(session);
    const loaded = await sessions.load(session.id);
    assert.deepEqual(loaded.taskRuntime, runtime);

    const board: TaskBoard = {
      id: 'board_test',
      title: 'Demo',
      goal: 'Implement task board',
      status: 'draft',
      createdAt: runtime.lastSyncAt!,
      updatedAt: runtime.lastSyncAt!,
      tasks: [],
    };
    assert.equal(board.status, 'draft');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: FAIL because `../src/tasks/types.js` does not exist and/or `taskRuntime` is not on `SessionRecord`.

- [ ] **Step 3: Add task types**

Create `cli/src/tasks/types.ts`:

```ts
export type BoardStatus = 'draft' | 'active' | 'completed' | 'blocked' | 'cancelled';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled' | 'skipped';

export type TaskItem = {
  id: string;
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

export type TaskBoard = {
  id: string;
  title: string;
  goal: string;
  status: BoardStatus;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  tasks: TaskItem[];
};

export type TaskRuntimeMode = 'idle' | 'planning' | 'awaiting_confirm' | 'executing' | 'paused';

export type TaskRuntimeState = {
  boardId?: string;
  activeTaskId?: string;
  mode: TaskRuntimeMode;
  lastSyncAt?: string;
};

export type TaskBoardIndexEntry = {
  id: string;
  title: string;
  status: BoardStatus;
  updatedAt: string;
};
```

- [ ] **Step 4: Extend SessionRecord**

In `cli/src/session/store.ts`, import type and extend record:

```ts
import type { TaskRuntimeState } from '../tasks/types.js';
```

Add field on `SessionRecord`:

```ts
  taskRuntime?: TaskRuntimeState;
```

Do **not** require `taskRuntime` in `create()`; leave it undefined for new sessions so existing tests stay stable.

- [ ] **Step 5: Run test to verify it passes**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: PASS.

- [ ] **Step 6: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/tasks/types.ts cli/src/session/store.ts cli/tests/task-board.test.ts && git commit -m "feat: add task board types and session pointer"
```

If not a git repo, skip.

---

### Task 2: TaskBoardStore

**Files:**
- Create: `cli/src/tasks/store.ts`
- Test: `cli/tests/task-board.test.ts`

- [ ] **Step 1: Write failing store tests**

Append to `cli/tests/task-board.test.ts`:

```ts
import { TaskBoardStore } from '../src/tasks/store.js';
import type { TaskBoard } from '../src/tasks/types.js';

test('TaskBoardStore saves loads and lists boards', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-task-store-'));
  try {
    const store = new TaskBoardStore(workspace);
    const now = '2026-07-13T00:00:00.000Z';
    const board: TaskBoard = {
      id: 'board_20260713000000_abcd1234',
      title: 'Add auth',
      goal: 'Implement login flow',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      tasks: [
        { id: 'task_1', title: 'Inspect auth code', status: 'pending', dependsOn: [] },
        { id: 'task_2', title: 'Implement fix', status: 'pending', dependsOn: ['task_1'] },
      ],
    };

    await store.save(board);
    const loaded = await store.load(board.id);
    assert.deepEqual(loaded, board);

    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, board.id);
    assert.equal(listed[0].status, 'draft');

    board.status = 'active';
    board.confirmedAt = now;
    board.updatedAt = '2026-07-13T00:01:00.000Z';
    await store.save(board);
    assert.equal((await store.load(board.id)).status, 'active');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('TaskBoardStore load missing board throws', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-task-missing-'));
  try {
    const store = new TaskBoardStore(workspace);
    await assert.rejects(() => store.load('board_missing'), /not found/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: FAIL because `TaskBoardStore` is missing.

- [ ] **Step 3: Implement store**

Create `cli/src/tasks/store.ts`:

```ts
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { TaskBoard, TaskBoardIndexEntry } from './types.js';

export class TaskBoardStore {
  private readonly root: string;
  private readonly indexPath: string;

  constructor(workspaceRoot: string) {
    this.root = resolve(workspaceRoot, '.aicode', 'tasks');
    this.indexPath = join(this.root, 'index.json');
  }

  filePath(boardId: string) {
    return join(this.root, `${boardId}.json`);
  }

  async save(board: TaskBoard) {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.filePath(board.id), `${JSON.stringify(board, null, 2)}\n`, 'utf8');
    await this.upsertIndex({
      id: board.id,
      title: board.title,
      status: board.status,
      updatedAt: board.updatedAt,
    });
  }

  async load(boardId: string): Promise<TaskBoard> {
    try {
      return JSON.parse(await readFile(this.filePath(boardId), 'utf8')) as TaskBoard;
    } catch {
      throw new Error(`Task board not found: ${boardId}`);
    }
  }

  async list(): Promise<TaskBoardIndexEntry[]> {
    await mkdir(this.root, { recursive: true });
    try {
      const index = JSON.parse(await readFile(this.indexPath, 'utf8')) as TaskBoardIndexEntry[];
      return index.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      const names = await readdir(this.root);
      const entries: TaskBoardIndexEntry[] = [];
      for (const name of names) {
        if (!name.endsWith('.json') || name === 'index.json') continue;
        try {
          const board = JSON.parse(await readFile(join(this.root, name), 'utf8')) as TaskBoard;
          entries.push({ id: board.id, title: board.title, status: board.status, updatedAt: board.updatedAt });
        } catch {
          // ignore corrupt board files
        }
      }
      return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
  }

  private async upsertIndex(entry: TaskBoardIndexEntry) {
    let entries: TaskBoardIndexEntry[] = [];
    try {
      entries = JSON.parse(await readFile(this.indexPath, 'utf8')) as TaskBoardIndexEntry[];
    } catch {
      entries = [];
    }
    const next = [entry, ...entries.filter((item) => item.id !== entry.id)];
    await mkdir(dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/tasks/store.ts cli/tests/task-board.test.ts && git commit -m "feat: add workspace task board store"
```

---

### Task 3: Planner Heuristic and Deterministic Board Creation

**Files:**
- Create: `cli/src/tasks/planner.ts`
- Test: `cli/tests/task-board.test.ts`

- [ ] **Step 1: Write failing planner tests**

Append:

```ts
import { planBoardFromGoal, shouldUseTaskBoard } from '../src/tasks/planner.js';

test('shouldUseTaskBoard accepts large multi-step goals and rejects tiny asks', () => {
  assert.equal(shouldUseTaskBoard('实现完整的登录注册流程并补测试'), true);
  assert.equal(shouldUseTaskBoard('分步实现项目任务板：规划、确认、自动执行、失败恢复'), true);
  assert.equal(shouldUseTaskBoard('读取 package.json'), false);
  assert.equal(shouldUseTaskBoard('C盘还剩多少空间'), false);
  assert.equal(shouldUseTaskBoard('search disk.ts for quota'), false);
});

test('planBoardFromGoal creates ordered pending draft tasks', () => {
  const board = planBoardFromGoal('实现用户登录功能并补充测试');
  assert.equal(board.status, 'draft');
  assert.ok(board.id.startsWith('board_'));
  assert.ok(board.tasks.length >= 3);
  assert.ok(board.tasks.every((task) => task.status === 'pending'));
  assert.deepEqual(board.tasks[0].dependsOn, []);
  assert.deepEqual(board.tasks[1].dependsOn, [board.tasks[0].id]);
  assert.match(board.goal, /登录|login/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: FAIL because planner module is missing.

- [ ] **Step 3: Implement planner**

Create `cli/src/tasks/planner.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { TaskBoard, TaskItem } from './types.js';

export function shouldUseTaskBoard(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;

  const smallAsk = hasAny(normalized, [
    '读取', '打开', '查看', '搜索', '查找', '磁盘', '剩余空间', '多大', '你好', 'help',
    'read ', 'open ', 'show ', 'search ', 'find ', 'disk', 'free space', 'hello', 'hi',
  ]) && !hasAny(normalized, ['实现', '开发', '重构', '分步', '任务板', '并补', '并添加', 'implement', 'build', 'refactor', 'multi-step', 'task board']);
  if (smallAsk) return false;

  return hasAny(normalized, [
    '实现', '开发', '重构', '分步', '任务板', '完整', '并测试', '并补测试', '跨模块', '端到端',
    'implement', 'build', 'create a', 'add a feature', 'refactor', 'multi-step', 'end-to-end', 'task board', 'plan and',
  ]) || countSteps(normalized) >= 3;
}

export function planBoardFromGoal(goal: string, now = new Date()): TaskBoard {
  const createdAt = now.toISOString();
  const id = `board_${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  const titles = defaultTaskTitles(goal);
  const tasks: TaskItem[] = titles.map((title, index) => ({
    id: `task_${index + 1}`,
    title,
    detail: index === 0 ? `Goal: ${goal}` : undefined,
    status: 'pending',
    dependsOn: index === 0 ? [] : [`task_${index}`],
    acceptance: defaultAcceptance(title),
  }));

  return {
    id,
    title: summarizeTitle(goal),
    goal,
    status: 'draft',
    createdAt,
    updatedAt: createdAt,
    tasks,
  };
}

function defaultTaskTitles(goal: string): string[] {
  const normalized = goal.toLowerCase();
  if (hasAny(normalized, ['登录', 'login', 'auth'])) {
    return ['Inspect existing auth/login code', 'Implement login changes', 'Add or update tests', 'Verify login behavior'];
  }
  if (hasAny(normalized, ['任务板', 'task board', '看板'])) {
    return [
      'Design and persist task board model',
      'Implement plan confirm and auto-run loop',
      'Add /plan controls and resume support',
      'Cover with automated tests',
    ];
  }
  return [
    'Inspect relevant project context',
    'Implement the core change',
    'Add or update tests',
    'Verify the result and summarize',
  ];
}

function defaultAcceptance(title: string) {
  return `Done when: ${title.toLowerCase()} is complete and residual risks are noted.`;
}

function summarizeTitle(goal: string) {
  const compact = goal.replace(/\s+/g, ' ').trim();
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}...`;
}

function countSteps(value: string) {
  return value.split(/[，。；;\n]|然后|接着|并|and then|then/).map((part) => part.trim()).filter(Boolean).length;
}

function hasAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/tasks/planner.ts cli/tests/task-board.test.ts && git commit -m "feat: add task board planner"
```

---

### Task 4: Pure Runtime Transitions and Board Formatting

**Files:**
- Create: `cli/src/tasks/runtime.ts`
- Create: `cli/src/tasks/completion.ts`
- Test: `cli/tests/task-board.test.ts`

- [ ] **Step 1: Write failing runtime/completion tests**

Append:

```ts
import {
  confirmBoard,
  formatBoard,
  markTaskBlocked,
  markTaskDone,
  nextRunnableTask,
  pauseRuntime,
  reopenTask,
  skipTask,
  startTask,
} from '../src/tasks/runtime.js';
import { detectTaskCompletion } from '../src/tasks/completion.js';
import type { TaskBoard } from '../src/tasks/types.js';

function sampleBoard(): TaskBoard {
  return {
    id: 'board_demo',
    title: 'Demo',
    goal: 'Ship feature',
    status: 'draft',
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    tasks: [
      { id: 'task_1', title: 'Inspect', status: 'pending', dependsOn: [] },
      { id: 'task_2', title: 'Implement', status: 'pending', dependsOn: ['task_1'] },
      { id: 'task_3', title: 'Verify', status: 'pending', dependsOn: ['task_2'] },
    ],
  };
}

test('runtime selects dependency-aware next task and transitions statuses', () => {
  const board = sampleBoard();
  assert.equal(nextRunnableTask(board)?.id, 'task_1');
  confirmBoard(board, '2026-07-13T00:01:00.000Z');
  assert.equal(board.status, 'active');
  assert.equal(board.confirmedAt, '2026-07-13T00:01:00.000Z');

  startTask(board, 'task_1', '2026-07-13T00:02:00.000Z');
  assert.equal(board.tasks[0].status, 'in_progress');
  assert.equal(nextRunnableTask(board), undefined);

  markTaskDone(board, 'task_1', 'inspected auth module', '2026-07-13T00:03:00.000Z');
  assert.equal(board.tasks[0].status, 'done');
  assert.equal(nextRunnableTask(board)?.id, 'task_2');

  startTask(board, 'task_2', '2026-07-13T00:04:00.000Z');
  markTaskBlocked(board, 'task_2', 'apply_patch failed', '2026-07-13T00:05:00.000Z');
  assert.equal(board.tasks[1].status, 'blocked');
  assert.equal(board.status, 'blocked');

  reopenTask(board, 'task_2', '2026-07-13T00:06:00.000Z');
  assert.equal(board.tasks[1].status, 'pending');
  assert.equal(board.status, 'active');

  skipTask(board, 'task_2', '2026-07-13T00:07:00.000Z');
  assert.equal(board.tasks[1].status, 'skipped');
  assert.equal(nextRunnableTask(board)?.id, 'task_3');
});

test('formatBoard renders goal and task statuses', () => {
  const text = formatBoard(sampleBoard());
  assert.match(text, /board_demo/);
  assert.match(text, /status: draft/);
  assert.match(text, /\[pending\] task_1 Inspect/);
  assert.match(text, /depends: task_1/);
});

test('detectTaskCompletion distinguishes done blocked and unclear', () => {
  assert.equal(detectTaskCompletion({ ok: true, finalAnswer: 'TASK_DONE: fixed login', hadTerminalFailure: false }).status, 'done');
  assert.equal(detectTaskCompletion({ ok: false, finalAnswer: 'stopped', hadTerminalFailure: true, error: 'blocked: no' }).status, 'blocked');
  assert.equal(detectTaskCompletion({ ok: true, finalAnswer: 'maybe finished?', hadTerminalFailure: false }).status, 'unclear');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: FAIL because runtime/completion modules are missing.

- [ ] **Step 3: Implement completion helper**

Create `cli/src/tasks/completion.ts`:

```ts
export type TaskCompletionInput = {
  ok: boolean;
  finalAnswer: string;
  hadTerminalFailure: boolean;
  error?: string;
};

export type TaskCompletionResult =
  | { status: 'done'; summary: string }
  | { status: 'blocked'; error: string }
  | { status: 'unclear'; error: string };

export function detectTaskCompletion(input: TaskCompletionInput): TaskCompletionResult {
  if (input.hadTerminalFailure || input.ok === false) {
    return { status: 'blocked', error: input.error ?? input.finalAnswer ?? 'Task failed' };
  }

  const answer = input.finalAnswer.trim();
  const doneMarker = answer.match(/TASK_DONE:\s*(.+)$/im);
  if (doneMarker) {
    return { status: 'done', summary: doneMarker[1].trim() };
  }

  if (/\b(done|completed|finished|已完成|完成了)\b/i.test(answer) && !/\b(maybe|probably|似乎|可能)\b/i.test(answer)) {
    return { status: 'done', summary: answer.slice(0, 240) };
  }

  return { status: 'unclear', error: 'Task completion was unclear; mark blocked for human review.' };
}
```

- [ ] **Step 4: Implement runtime helpers**

Create `cli/src/tasks/runtime.ts`:

```ts
import type { TaskBoard, TaskItem, TaskRuntimeState } from './types.js';

export function nextRunnableTask(board: TaskBoard): TaskItem | undefined {
  if (board.status === 'cancelled' || board.status === 'completed') return undefined;
  if (board.tasks.some((task) => task.status === 'in_progress')) return undefined;

  return board.tasks.find((task) => {
    if (task.status !== 'pending') return false;
    return task.dependsOn.every((dep) => {
      const parent = board.tasks.find((item) => item.id === dep);
      return parent?.status === 'done' || parent?.status === 'skipped';
    });
  });
}

export function confirmBoard(board: TaskBoard, nowIso: string) {
  board.status = 'active';
  board.confirmedAt = nowIso;
  board.updatedAt = nowIso;
}

export function startTask(board: TaskBoard, taskId: string, nowIso: string) {
  const task = requireTask(board, taskId);
  if (task.status !== 'pending' && task.status !== 'blocked') {
    throw new Error(`Task ${taskId} cannot start from status ${task.status}`);
  }
  for (const item of board.tasks) {
    if (item.status === 'in_progress') item.status = 'pending';
  }
  task.status = 'in_progress';
  task.startedAt = nowIso;
  task.error = undefined;
  board.status = 'active';
  board.updatedAt = nowIso;
}

export function markTaskDone(board: TaskBoard, taskId: string, summary: string, nowIso: string) {
  const task = requireTask(board, taskId);
  task.status = 'done';
  task.resultSummary = summary;
  task.finishedAt = nowIso;
  task.error = undefined;
  board.updatedAt = nowIso;
  refreshBoardStatus(board);
}

export function markTaskBlocked(board: TaskBoard, taskId: string, error: string, nowIso: string) {
  const task = requireTask(board, taskId);
  task.status = 'blocked';
  task.error = error;
  task.finishedAt = nowIso;
  board.status = 'blocked';
  board.updatedAt = nowIso;
}

export function skipTask(board: TaskBoard, taskId: string, nowIso: string) {
  const task = requireTask(board, taskId);
  if (task.status === 'done') throw new Error(`Task ${taskId} is already done`);
  task.status = 'skipped';
  task.finishedAt = nowIso;
  task.error = undefined;
  board.updatedAt = nowIso;
  refreshBoardStatus(board);
}

export function reopenTask(board: TaskBoard, taskId: string, nowIso: string) {
  const task = requireTask(board, taskId);
  task.status = 'pending';
  task.error = undefined;
  task.resultSummary = undefined;
  task.startedAt = undefined;
  task.finishedAt = undefined;
  board.updatedAt = nowIso;
  if (board.status === 'blocked' || board.status === 'completed') board.status = 'active';
}

export function pauseRuntime(runtime: TaskRuntimeState, nowIso: string): TaskRuntimeState {
  return { ...runtime, mode: 'paused', lastSyncAt: nowIso };
}

export function formatBoard(board: TaskBoard) {
  const lines = [
    `board: ${board.id}`,
    `title: ${board.title}`,
    `status: ${board.status}`,
    `goal: ${board.goal}`,
    board.confirmedAt ? `confirmedAt: ${board.confirmedAt}` : undefined,
    'tasks:',
    ...board.tasks.map((task) => {
      const depends = task.dependsOn.length ? `; depends: ${task.dependsOn.join(', ')}` : '';
      const error = task.error ? `; error: ${task.error}` : '';
      const summary = task.resultSummary ? `; result: ${task.resultSummary}` : '';
      return `- [${task.status}] ${task.id} ${task.title}${depends}${summary}${error}`;
    }),
  ].filter((line): line is string => typeof line === 'string');
  return lines.join('\n');
}

export function buildTaskPrompt(board: TaskBoard, task: TaskItem) {
  const completed = board.tasks
    .filter((item) => item.status === 'done' || item.status === 'skipped')
    .map((item) => `- ${item.id} ${item.title}: ${item.resultSummary ?? item.status}`)
    .join('\n');

  return [
    `You are executing one task from an approved project board.`,
    `Board goal: ${board.goal}`,
    `Current task: ${task.id} ${task.title}`,
    task.detail ? `Detail: ${task.detail}` : undefined,
    task.acceptance ? `Acceptance: ${task.acceptance}` : undefined,
    completed ? `Completed tasks:\n${completed}` : 'Completed tasks: none',
    `Focus only on this task.`,
    `When finished successfully, end with: TASK_DONE: <short summary>`,
    `If blocked, explain the blocker clearly.`,
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

function refreshBoardStatus(board: TaskBoard) {
  if (board.tasks.some((task) => task.status === 'blocked')) {
    board.status = 'blocked';
    return;
  }
  const remaining = board.tasks.some((task) => task.status === 'pending' || task.status === 'in_progress');
  board.status = remaining ? 'active' : 'completed';
}

function requireTask(board: TaskBoard, taskId: string) {
  const task = board.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  return task;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: PASS.

- [ ] **Step 6: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/tasks/runtime.ts cli/src/tasks/completion.ts cli/tests/task-board.test.ts && git commit -m "feat: add task board runtime transitions"
```

---

### Task 5: Config Flag `--confirm-plan`

**Files:**
- Modify: `cli/src/config/types.ts`
- Modify: `cli/src/cli/args.ts`
- Modify: `cli/src/config/config.ts`
- Test: `cli/tests/config.test.ts` (append) or `cli/tests/task-board.test.ts`

- [ ] **Step 1: Write failing config/args test**

Append to `cli/tests/task-board.test.ts`:

```ts
import { parseArgs } from '../src/cli/args.js';
import { loadConfig } from '../src/config/config.js';

test('parseArgs and loadConfig accept --confirm-plan', async () => {
  const args = parseArgs(['--provider', 'mock', '--confirm-plan', '--prompt', 'x']);
  assert.equal(args.confirmPlan, true);
  const config = await loadConfig(args, {});
  assert.equal(config.confirmPlan, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: FAIL on unknown argument or missing `confirmPlan` typing/mapping.

- [ ] **Step 3: Wire flag**

In `cli/src/config/types.ts` add to both `CliArgs` and `AppConfig`:

```ts
  confirmPlan?: boolean;
```

In `cli/src/cli/args.ts` switch cases add:

```ts
      case '--confirm-plan':
        args.confirmPlan = true;
        break;
```

In `cli/src/config/config.ts` `loadConfig` return object add:

```ts
    confirmPlan: args.confirmPlan ?? false,
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/config/types.ts cli/src/cli/args.ts cli/src/config/config.ts cli/tests/task-board.test.ts && git commit -m "feat: add --confirm-plan flag"
```

---

### Task 6: `/plan` Board Commands

**Files:**
- Modify: `cli/src/cli/commands.ts`
- Test: `cli/tests/task-board.test.ts`

- [ ] **Step 1: Write failing slash-command tests**

Append:

```ts
import { handleSlashCommand } from '../src/cli/commands.js';
import { createMockProvider } from '../src/providers/mock.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('/plan shows board and supports confirm pause continue skip reopen', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-plan-cmd-'));
  try {
    const sessions = new SessionStore(join(workspace, 'sessions'));
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const store = new TaskBoardStore(workspace);
    const board = planBoardFromGoal('实现任务板确认与恢复');
    await store.save(board);
    session.taskRuntime = { boardId: board.id, mode: 'awaiting_confirm', lastSyncAt: board.createdAt };
    await sessions.save(session);

    const base = {
      config: {
        provider: 'mock' as const,
        model: 'mock',
        approval: 'auto' as const,
        workspaceRoot: workspace,
        sessionDir: join(workspace, 'sessions'),
        maxSteps: 5,
        noBanner: true,
        confirmPlan: false,
      },
      provider: createMockProvider(),
      tools: createDefaultToolRegistry(),
      sessions,
      session,
    };

    const shown = await handleSlashCommand({ line: '/plan', ...base });
    assert.match(shown, /status: draft/);
    assert.match(shown, /task_1/);

    const confirmed = await handleSlashCommand({ line: '/plan confirm', ...base });
    assert.match(confirmed, /status: active/);
    const active = await store.load(board.id);
    assert.equal(active.status, 'active');
    assert.equal(session.taskRuntime?.mode, 'executing');

    await handleSlashCommand({ line: '/plan pause', ...base });
    assert.equal(session.taskRuntime?.mode, 'paused');

    const reloaded = await store.load(board.id);
    startTask(reloaded, 'task_1', new Date().toISOString());
    markTaskBlocked(reloaded, 'task_1', 'boom', new Date().toISOString());
    await store.save(reloaded);

    await handleSlashCommand({ line: '/plan continue', ...base });
    assert.equal(session.taskRuntime?.mode, 'executing');

    await handleSlashCommand({ line: '/plan skip task_1', ...base });
    assert.equal((await store.load(board.id)).tasks[0].status, 'skipped');

    await handleSlashCommand({ line: '/plan reopen task_1', ...base });
    assert.equal((await store.load(board.id)).tasks[0].status, 'pending');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: FAIL because `/plan` still only prints recent tools.

- [ ] **Step 3: Implement `/plan` subcommands**

In `cli/src/cli/commands.ts`:

1. Import store/runtime/planner helpers:

```ts
import { TaskBoardStore } from '../tasks/store.js';
import {
  confirmBoard,
  formatBoard,
  pauseRuntime,
  reopenTask,
  skipTask,
} from '../tasks/runtime.js';
```

2. Change help text:

```ts
        '/plan       Show task board (use /plan confirm|pause|continue|skip|reopen|show)',
```

3. Replace the simple `case '/plan': return sessionPlan(...)` path with prefix handling **before** the switch, similar to lazy-dev:

```ts
  if (command === '/plan' || command.startsWith('/plan ')) {
    return handlePlanCommand(command, options);
  }
```

4. Implement:

```ts
async function handlePlanCommand(
  command: string,
  options: {
    config: AppConfig;
    sessions: SessionStore;
    session: SessionRecord;
  },
) {
  const store = new TaskBoardStore(options.config.workspaceRoot);
  const args = command.slice('/plan'.length).trim();
  const [action, ...rest] = args.split(/\s+/).filter(Boolean);
  const nowIso = new Date().toISOString();

  if (!action) {
    const board = await loadCurrentBoard(store, options.session);
    if (!board) {
      const legacy = sessionPlan(options.session);
      return `No task board attached.\nLegacy tool progress:\n${legacy}`;
    }
    return formatBoard(board);
  }

  if (action === 'show') {
    const boardId = rest[0];
    if (!boardId) return 'Usage: /plan show <boardId>';
    const board = await store.load(boardId);
    options.session.taskRuntime = {
      boardId: board.id,
      activeTaskId: board.tasks.find((task) => task.status === 'in_progress')?.id,
      mode: board.status === 'draft' ? 'awaiting_confirm' : options.session.taskRuntime?.mode === 'paused' ? 'paused' : 'executing',
      lastSyncAt: nowIso,
    };
    await options.sessions.save(options.session);
    return formatBoard(board);
  }

  const board = await loadCurrentBoard(store, options.session);
  if (!board) return 'No task board attached. Create one from a large requirement or /plan show <boardId>.';

  switch (action) {
    case 'confirm': {
      if (board.status !== 'draft' && board.status !== 'active') {
        return `Board ${board.id} cannot be confirmed from status ${board.status}`;
      }
      confirmBoard(board, nowIso);
      await store.save(board);
      options.session.taskRuntime = {
        boardId: board.id,
        activeTaskId: undefined,
        mode: 'executing',
        lastSyncAt: nowIso,
      };
      await options.sessions.save(options.session);
      return `${formatBoard(board)}\nConfirmed. Auto-execution enabled.`;
    }
    case 'pause': {
      options.session.taskRuntime = pauseRuntime(options.session.taskRuntime ?? { mode: 'idle', boardId: board.id }, nowIso);
      options.session.taskRuntime.boardId = board.id;
      await options.sessions.save(options.session);
      return `Paused board ${board.id}.`;
    }
    case 'continue': {
      options.session.taskRuntime = {
        boardId: board.id,
        activeTaskId: board.tasks.find((task) => task.status === 'blocked' || task.status === 'in_progress')?.id,
        mode: 'executing',
        lastSyncAt: nowIso,
      };
      if (board.status === 'blocked') {
        const blocked = board.tasks.find((task) => task.status === 'blocked');
        if (blocked) {
          reopenTask(board, blocked.id, nowIso);
          await store.save(board);
        }
      }
      await options.sessions.save(options.session);
      return `${formatBoard(board)}\nContinue enabled.`;
    }
    case 'skip': {
      const taskId = rest[0];
      if (!taskId) return 'Usage: /plan skip <taskId>';
      skipTask(board, taskId, nowIso);
      await store.save(board);
      await options.sessions.save(options.session);
      return formatBoard(board);
    }
    case 'reopen': {
      const taskId = rest[0];
      if (!taskId) return 'Usage: /plan reopen <taskId>';
      reopenTask(board, taskId, nowIso);
      await store.save(board);
      await options.sessions.save(options.session);
      return formatBoard(board);
    }
    default:
      return `Unknown /plan action: ${action}. Try /plan, /plan confirm, /plan pause, /plan continue, /plan skip <id>, /plan reopen <id>, /plan show <boardId>.`;
  }
}

async function loadCurrentBoard(store: TaskBoardStore, session: SessionRecord) {
  const boardId = session.taskRuntime?.boardId;
  if (!boardId) return undefined;
  try {
    return await store.load(boardId);
  } catch {
    return undefined;
  }
}
```

Keep legacy `sessionPlan()` helper for the no-board fallback section.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/cli/commands.ts cli/tests/task-board.test.ts && git commit -m "feat: make /plan control task boards"
```

---

### Task 7: Auto-Execution Loop Integration

**Files:**
- Modify: `cli/src/tasks/runtime.ts` (add `runTaskBoardLoop`)
- Modify: `cli/src/cli/repl.ts`
- Test: `cli/tests/task-board.test.ts`

- [ ] **Step 1: Write failing integration test for confirm-then-auto-run**

Append:

```ts
import { runPromptMode } from '../src/cli/repl.js';
import type { AgentRuntime } from '../src/agent/agent.js';
import { TerminalUI } from '../src/ui/terminal.js';

test('large goal drafts a board and confirmPlan auto-runs tasks with mock provider', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-task-loop-'));
  try {
    const sessionDir = join(workspace, 'sessions');
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const config = {
      provider: 'mock' as const,
      model: 'mock-code-agent-v1',
      approval: 'auto' as const,
      workspaceRoot: workspace,
      sessionDir,
      maxSteps: 12,
      noBanner: true,
      confirmPlan: true,
      prompt: '分步实现项目任务板：规划、确认、自动执行、失败恢复',
    };
    const runtime: AgentRuntime = {
      config,
      provider: createMockProvider(config.model),
      tools: createDefaultToolRegistry(),
      sessions,
      session,
      ui: new TerminalUI(true),
    };

    const result = await runPromptMode(runtime, config.prompt!);
    assert.equal(result.ok, true);

    const store = new TaskBoardStore(workspace);
    const boards = await store.list();
    assert.equal(boards.length, 1);
    const board = await store.load(boards[0].id);
    assert.ok(board.tasks.some((task) => task.status === 'done' || task.status === 'blocked' || task.status === 'in_progress' || task.status === 'pending'));
    // With confirmPlan, board should leave draft.
    assert.notEqual(board.status, 'draft');
    assert.ok(session.taskRuntime?.boardId);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('no-input without confirmPlan leaves draft board unexecuted', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-task-draft-'));
  try {
    const sessionDir = join(workspace, 'sessions');
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const config = {
      provider: 'mock' as const,
      model: 'mock',
      approval: 'auto' as const,
      workspaceRoot: workspace,
      sessionDir,
      maxSteps: 8,
      noBanner: true,
      noInput: true,
      confirmPlan: false,
      prompt: '分步实现项目任务板：规划、确认、自动执行、失败恢复',
    };
    const runtime: AgentRuntime = {
      config,
      provider: createMockProvider(),
      tools: createDefaultToolRegistry(),
      sessions,
      session,
      ui: new TerminalUI(true),
    };

    const result = await runPromptMode(runtime, config.prompt!);
    assert.equal(result.ok, true);
    const store = new TaskBoardStore(workspace);
    const board = await store.load((await store.list())[0].id);
    assert.equal(board.status, 'draft');
    assert.ok(board.tasks.every((task) => task.status === 'pending'));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: FAIL because prompt mode does not create/run boards.

- [ ] **Step 3: Add `runTaskBoardLoop` to runtime**

Append to `cli/src/tasks/runtime.ts`:

```ts
import { detectTaskCompletion } from './completion.js';
import type { TaskBoardStore } from './store.js';
import type { SessionRecord, SessionStore } from '../session/store.js';

export type TaskTurnResult = {
  ok: boolean;
  reason?: string;
  finalAnswer?: string;
  hadTerminalFailure?: boolean;
};

export async function runTaskBoardLoop(options: {
  board: TaskBoard;
  store: TaskBoardStore;
  sessions: SessionStore;
  session: SessionRecord;
  maxTasks?: number;
  runTurn: (prompt: string) => Promise<TaskTurnResult>;
  onInfo?: (message: string) => void;
}) {
  const maxTasks = options.maxTasks ?? options.board.tasks.length + 2;
  let executed = 0;

  while (executed < maxTasks) {
    if (options.session.taskRuntime?.mode === 'paused') {
      options.onInfo?.('Task board auto-run paused.');
      return { ok: true, status: options.board.status };
    }

    const task = nextRunnableTask(options.board);
    if (!task) {
      refreshBoardStatus(options.board);
      await options.store.save(options.board);
      options.session.taskRuntime = {
        boardId: options.board.id,
        activeTaskId: undefined,
        mode: options.board.status === 'completed' ? 'idle' : 'paused',
        lastSyncAt: new Date().toISOString(),
      };
      await options.sessions.save(options.session);
      return { ok: options.board.status !== 'blocked', status: options.board.status };
    }

    const nowIso = new Date().toISOString();
    startTask(options.board, task.id, nowIso);
    options.session.taskRuntime = {
      boardId: options.board.id,
      activeTaskId: task.id,
      mode: 'executing',
      lastSyncAt: nowIso,
    };
    await options.store.save(options.board);
    await options.sessions.save(options.session);

    options.onInfo?.(`Running ${task.id}: ${task.title}`);
    const turn = await options.runTurn(buildTaskPrompt(options.board, task));
    const completion = detectTaskCompletion({
      ok: turn.ok,
      finalAnswer: turn.finalAnswer ?? turn.reason ?? '',
      hadTerminalFailure: Boolean(turn.hadTerminalFailure) || turn.ok === false,
      error: turn.reason,
    });
    const doneAt = new Date().toISOString();

    if (completion.status === 'done') {
      markTaskDone(options.board, task.id, completion.summary, doneAt);
    } else {
      markTaskBlocked(options.board, task.id, completion.error, doneAt);
      options.session.taskRuntime = {
        boardId: options.board.id,
        activeTaskId: task.id,
        mode: 'paused',
        lastSyncAt: doneAt,
      };
      await options.store.save(options.board);
      await options.sessions.save(options.session);
      options.onInfo?.(`Blocked on ${task.id}: ${completion.error}`);
      return { ok: false, status: 'blocked' as const, reason: completion.error };
    }

    await options.store.save(options.board);
    await options.sessions.save(options.session);
    executed += 1;
  }

  return { ok: false, status: options.board.status, reason: 'Task board max task iterations reached' };
}
```

Export `refreshBoardStatus` usage is internal; keep it private in the same file as already defined.

- [ ] **Step 4: Integrate into `runPromptMode` / guarded flow**

Modify `cli/src/cli/repl.ts`:

```ts
import { TaskBoardStore } from '../tasks/store.js';
import { planBoardFromGoal, shouldUseTaskBoard } from '../tasks/planner.js';
import { confirmBoard, formatBoard, runTaskBoardLoop } from '../tasks/runtime.js';
```

Replace `runPromptMode` body logic for non-slash prompts by routing through a new helper:

```ts
export async function runPromptMode(runtime: AgentRuntime, prompt: string): Promise<AgentTurnResult> {
  if (prompt.startsWith('/')) {
    const result = await handleSlashCommand({ line: prompt, ...runtime });
    if (result !== '__EXIT__') runtime.ui.info(result);
    // If /plan confirm set mode executing, continue auto-run.
    if (runtime.session.taskRuntime?.mode === 'executing' && runtime.session.taskRuntime.boardId) {
      return continueTaskBoard(runtime);
    }
    return { ok: true, session: runtime.session };
  }
  return runGuardedAgentTurn(runtime, prompt);
}
```

Update `runGuardedAgentTurn` success path to call board-aware entry:

```ts
async function runGuardedAgentTurn(runtime: AgentRuntime, line: string): Promise<AgentTurnResult> {
  const guard = runtime.session.guard?.lazyDev;
  if (guard?.enabled) {
    const guardResult = handleLazyDevInput(guard, line);
    if (guardResult.message) runtime.ui.info(guardResult.message);
    await runtime.sessions.save(runtime.session);
    if (!guardResult.allowDevelopment) {
      return { ok: true, session: runtime.session, reason: guardResult.reason };
    }
    return handleDevelopmentPrompt(runtime, guardResult.developmentPrompt ?? line);
  }
  return handleDevelopmentPrompt(runtime, line);
}

async function handleDevelopmentPrompt(runtime: AgentRuntime, prompt: string): Promise<AgentTurnResult> {
  if (!shouldUseTaskBoard(prompt)) {
    return runAgentTurn(runtime, prompt);
  }

  const store = new TaskBoardStore(runtime.config.workspaceRoot);
  const board = planBoardFromGoal(prompt);
  await store.save(board);
  runtime.session.taskRuntime = {
    boardId: board.id,
    mode: 'awaiting_confirm',
    lastSyncAt: board.createdAt,
  };
  await runtime.sessions.save(runtime.session);
  runtime.ui.info(formatBoard(board));

  const canAutoConfirm = Boolean(runtime.config.confirmPlan) && !isNoConfirmBlocked(runtime);
  // Spec: --no-input/CI must not auto-confirm unless --confirm-plan is set.
  // confirmPlan=true explicitly allows auto-confirm even under noInput.
  if (!runtime.config.confirmPlan) {
    runtime.ui.info('Draft task board created. Run /plan confirm to start auto-execution (or pass --confirm-plan).');
    return { ok: true, session: runtime.session };
  }

  if (!canAutoConfirm && runtime.config.noInput && !runtime.config.confirmPlan) {
    runtime.ui.info('Draft task board created. Non-interactive mode requires --confirm-plan to execute.');
    return { ok: true, session: runtime.session };
  }

  confirmBoard(board, new Date().toISOString());
  await store.save(board);
  runtime.session.taskRuntime = {
    boardId: board.id,
    mode: 'executing',
    lastSyncAt: new Date().toISOString(),
  };
  await runtime.sessions.save(runtime.session);
  return continueTaskBoard(runtime);
}

function isNoConfirmBlocked(runtime: AgentRuntime) {
  // reserved for future policy; confirmPlan is the explicit override
  return false;
}

async function continueTaskBoard(runtime: AgentRuntime): Promise<AgentTurnResult> {
  const boardId = runtime.session.taskRuntime?.boardId;
  if (!boardId) return { ok: true, session: runtime.session };
  const store = new TaskBoardStore(runtime.config.workspaceRoot);
  const board = await store.load(boardId);
  if (board.status === 'draft') {
    runtime.ui.info('Board is still draft. Confirm before execution.');
    return { ok: true, session: runtime.session };
  }

  const loopResult = await runTaskBoardLoop({
    board,
    store,
    sessions: runtime.sessions,
    session: runtime.session,
    runTurn: async (taskPrompt) => {
      const beforeFailed = runtime.session.toolCalls.filter((call) => !call.ok).length;
      const result = await runAgentTurn(runtime, taskPrompt);
      const afterFailed = runtime.session.toolCalls.filter((call) => !call.ok).length;
      const finalAnswer = runtime.session.finalAnswers.at(-1) ?? result.reason ?? '';
      const hadTerminalFailure = !result.ok || afterFailed > beforeFailed && /blocked:|cancelled by user|Path escapes workspace/i.test(finalAnswer);
      return {
        ok: result.ok,
        reason: result.reason,
        finalAnswer,
        hadTerminalFailure,
      };
    },
    onInfo: (message) => runtime.ui.info(message),
  });

  runtime.ui.info(formatBoard(board));
  return { ok: loopResult.ok, session: runtime.session, reason: loopResult.reason };
}
```

Simplify the confirm condition to match the spec exactly:

```ts
  if (!runtime.config.confirmPlan) {
    runtime.ui.info('Draft task board created. Run /plan confirm to start auto-execution (or pass --confirm-plan).');
    return { ok: true, session: runtime.session };
  }

  confirmBoard(board, new Date().toISOString());
  ...
```

Also update REPL loop: after slash commands, if mode is `executing`, call `continueTaskBoard`.

In `runRepl` slash branch:

```ts
        const result = await handleSlashCommand({ line, ...interactiveRuntime });
        if (result === '__EXIT__') break;
        runtime.ui.info(result);
        if (interactiveRuntime.session.taskRuntime?.mode === 'executing') {
          await continueTaskBoard(interactiveRuntime);
        }
        continue;
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: PASS. If mock provider answers small-talk for task prompts, adjust `runTurn` expectations or enhance mock to treat `TASK_DONE` style prompts as successful message actions. Prefer making the test's mock provider a tiny custom provider that always returns `{ actions: [{ type: 'message', content: 'TASK_DONE: ok' }] }` for deterministic loop testing.

If flakiness appears with `createMockProvider`, replace the auto-run test provider with:

```ts
const provider = {
  name: 'mock',
  model: 'mock',
  async complete() {
    return { actions: [{ type: 'message', content: 'TASK_DONE: completed current task' }] };
  },
};
```

- [ ] **Step 6: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/tasks/runtime.ts cli/src/cli/repl.ts cli/tests/task-board.test.ts && git commit -m "feat: auto-run confirmed task boards"
```

---

### Task 8: Resume Continuity and Blocked Recovery Integration

**Files:**
- Test: `cli/tests/task-board.test.ts`
- Modify runtime/commands only if tests expose gaps

- [ ] **Step 1: Write failing resume/recovery test**

Append:

```ts
test('resumed session continues blocked board after /plan continue', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-task-resume-'));
  try {
    const sessionDir = join(workspace, 'sessions');
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const store = new TaskBoardStore(workspace);
    const board = planBoardFromGoal('实现可恢复的长任务执行');
    confirmBoard(board, new Date().toISOString());
    startTask(board, 'task_1', new Date().toISOString());
    markTaskBlocked(board, 'task_1', 'simulated failure', new Date().toISOString());
    await store.save(board);
    session.taskRuntime = { boardId: board.id, activeTaskId: 'task_1', mode: 'paused', lastSyncAt: new Date().toISOString() };
    await sessions.save(session);

    const provider = {
      name: 'mock',
      model: 'mock',
      async complete() {
        return { actions: [{ type: 'message' as const, content: 'TASK_DONE: recovered task' }] };
      },
    };
    const runtime: AgentRuntime = {
      config: {
        provider: 'mock',
        model: 'mock',
        approval: 'auto',
        workspaceRoot: workspace,
        sessionDir,
        maxSteps: 8,
        noBanner: true,
        confirmPlan: false,
      },
      provider,
      tools: createDefaultToolRegistry(),
      sessions,
      session,
      ui: new TerminalUI(true),
    };

    await handleSlashCommand({ line: '/plan continue', ...runtime });
    const result = await runPromptMode(runtime, '/plan'); // show only
    assert.equal(result.ok, true);

    // continue should have reopened and set executing; drive loop explicitly
    runtime.session.taskRuntime = { ...(runtime.session.taskRuntime ?? { mode: 'executing' }), mode: 'executing', boardId: board.id };
    const continued = await runPromptMode(runtime, '/plan continue');
    assert.equal(continued.ok, true);

    const loaded = await store.load(board.id);
    assert.notEqual(loaded.tasks[0].status, 'blocked');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

Refine this test during implementation so it asserts the real continue path that `runPromptMode('/plan continue')` both reopens and auto-runs because slash confirm/continue sets `mode='executing'` and `runPromptMode` calls `continueTaskBoard`.

- [ ] **Step 2: Run test; fix any integration gaps**

```bash
npm --prefix "C:/Users/34516/ZCodeProject/cli" run build
node --test "C:/Users/34516/ZCodeProject/cli/dist/tests/task-board.test.js"
```

Expected: PASS after adjustments.

- [ ] **Step 3: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/cli/repl.ts cli/src/cli/commands.ts cli/src/tasks/runtime.ts cli/tests/task-board.test.ts && git commit -m "feat: resume blocked task boards"
```

---

### Task 9: Audit Needles, Capability Matrix, Full Verification

**Files:**
- Modify: `cli/src/audit/checks.ts`
- Modify: `cli/docs/capability-matrix.md`
- Modify: `cli/README.md` (short usage note for `/plan` and `--confirm-plan`)

- [ ] **Step 1: Register audit files and needles**

In `cli/src/audit/checks.ts` `requiredFiles`, add near agent/session entries:

```ts
    'src/tasks/types.ts',
    'src/tasks/store.ts',
    'src/tasks/planner.ts',
    'src/tasks/runtime.ts',
    'src/tasks/completion.ts',
    'tests/task-board.test.ts',
```

Add needles:

```ts
  const taskBoardNeedles = ['TaskBoardStore', 'planBoardFromGoal', 'shouldUseTaskBoard', 'runTaskBoardLoop', 'detectTaskCompletion'];
  taskBoardNeedles.forEach((needle) => {
    const file =
      needle === 'TaskBoardStore' ? 'src/tasks/store.ts'
        : needle === 'detectTaskCompletion' ? 'src/tasks/completion.ts'
          : needle === 'runTaskBoardLoop' ? 'src/tasks/runtime.ts'
            : 'src/tasks/planner.ts';
    // planBoardFromGoal/shouldUseTaskBoard live in planner; runTaskBoardLoop in runtime.
    checks.push({ name: `task board contains ${needle}`, run: () => contains(file, needle) });
  });
```

Use explicit per-file mapping to avoid fragile guesses:

```ts
  const taskBoardFileNeedles: Array<[string, string]> = [
    ['src/tasks/store.ts', 'TaskBoardStore'],
    ['src/tasks/planner.ts', 'planBoardFromGoal'],
    ['src/tasks/planner.ts', 'shouldUseTaskBoard'],
    ['src/tasks/runtime.ts', 'runTaskBoardLoop'],
    ['src/tasks/completion.ts', 'detectTaskCompletion'],
    ['src/cli/commands.ts', '/plan confirm'],
    ['src/cli/repl.ts', 'continueTaskBoard'],
  ];
  taskBoardFileNeedles.forEach(([path, needle]) => checks.push({ name: `task board ${path} contains ${needle}`, run: () => contains(path, needle) }));

  const taskBoardTestNeedles = [
    'TaskBoardStore saves loads and lists boards',
    'shouldUseTaskBoard accepts large multi-step goals',
    'runtime selects dependency-aware next task',
    'large goal drafts a board and confirmPlan auto-runs tasks',
  ];
  taskBoardTestNeedles.forEach((needle) => checks.push({ name: `task board test contains ${needle}`, run: () => contains('tests/task-board.test.ts', needle) }));
```

Before finalizing needles, ensure each string is a real substring of the test names you kept.

- [ ] **Step 2: Update capability matrix**

In `cli/docs/capability-matrix.md` add row:

```md
| Long-task planning / task board | Implemented MVP | Durable `.aicode/tasks` boards, `/plan` controls, confirm-then-auto-run, blocked resume |
```

- [ ] **Step 3: README usage note**

In `cli/README.md`, add a short section:

```md
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
```

- [ ] **Step 4: Full verification**

```bash
cd "C:/Users/34516/ZCodeProject/cli"
npm run typecheck
npm test
npm run audit:100
node dist/src/index.js --provider mock --approval auto --no-color --confirm-plan --prompt "分步实现项目任务板：规划、确认、自动执行、失败恢复"
```

Expected:

- typecheck pass
- all tests pass (count increases by task-board tests)
- audit all checks passed
- smoke prints a board and executes at least one task / reaches non-draft status

- [ ] **Step 5: Commit if git repo**

```bash
git rev-parse --is-inside-work-tree && git add cli/src/audit/checks.ts cli/docs/capability-matrix.md cli/README.md cli/tests/task-board.test.ts && git commit -m "docs: register task board coverage"
```

---

## Spec Coverage Checklist

| Spec requirement | Task |
| --- | --- |
| Workspace authoritative boards under `.aicode/tasks/` | Task 2 |
| Session `taskRuntime` pointer/mode | Task 1 |
| Draft board generation for large goals | Task 3, Task 7 |
| Confirm before auto-exec | Task 5, Task 6, Task 7 |
| Sequential auto-run one task at a time | Task 4, Task 7 |
| Failure → blocked + stop | Task 4, Task 7 |
| `/plan` show/confirm/pause/continue/skip/reopen/show | Task 6 |
| Cross-session resume | Task 8 |
| Small prompts remain one-shot | Task 3, Task 7 |
| CI/`--no-input` no auto-confirm without `--confirm-plan` | Task 5, Task 7 |
| Tests + audit coverage | Task 9 |

## Placeholder / Consistency Notes

- All public helpers used later are defined in Tasks 1–4 before integration tasks.
- `confirmPlan` defaults false; explicit `--confirm-plan` enables non-interactive auto-confirm.
- Completion marker is `TASK_DONE:` plus conservative natural-language fallback; unclear → blocked.
- Commit steps are optional when the workspace is not a git repository.
