import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { test } from 'node:test';
import { TaskBoardStore } from '../src/tasks/store.js';
import { SessionStore } from '../src/session/store.js';
import { runTaskBoardLoop, reopenTask } from '../src/tasks/runtime.js';
import { inspectTaskGraph } from '../src/tasks/graph.js';
import { handleSlashCommand } from '../src/cli/commands.js';
import type { GitProcess } from '../src/git-safety/git.js';
import type { GitRepository } from '../src/git-safety/repository.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { planBoardFromModel } from '../src/tasks/planner.js';
import type { TaskBoard, TaskItem } from '../src/tasks/types.js';

const task = (id: string, dependsOn: string[] = [], status: TaskItem['status'] = 'pending'): TaskItem => ({ id, title: id, status, dependsOn });
async function fixture(tasks: TaskItem[]) {
  const root = await mkdtemp(join(tmpdir(), 'yoy-task-graph-'));
  const sessions = new SessionStore(join(root, 'sessions'));
  const session = await sessions.create({ provider: 'mock', model: 'fixture', workspaceRoot: root });
  const store = new TaskBoardStore(root);
  const board: TaskBoard = { id: 'board_graph', title: 'Graph review', goal: 'Inspect task dependencies', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks };
  await store.save(board);
  const cleanup = async () => { const target = await realpath(root); const inside = relative(await realpath(tmpdir()), target); assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside)); await rm(target, { recursive: true, force: true }); };
  return { root, sessions, session, store, board, cleanup };
}

test('a cyclic task graph rejects all work rather than silently running its independent nodes', async () => {
  const f = await fixture([task('a', ['b']), task('b', ['a']), task('independent')]); let runs = 0;
  try {
    const result = await runTaskBoardLoop({ ...f, verifyEnabled: false, runTurn: async () => { runs += 1; return { ok: true, finalAnswer: 'TASK_DONE: no action should run' }; } });
    assert.equal(result.ok, false); assert.equal(runs, 0);
    assert.match(result.reason ?? '', /循环|cycle/);
    assert.equal(f.session.taskRuntime?.mode, 'paused');
    assert.deepEqual(f.board.tasks.map(item => item.dependsOn), [['b'], ['a'], []]);
  } finally { await f.cleanup(); }
});

test('a missing dependency produces an explicit blocker instead of an ok paused board', async () => {
  const f = await fixture([task('a', ['ghost'])]);
  try {
    const result = await runTaskBoardLoop({ ...f, runTurn: async () => { assert.fail('Missing dependencies cannot execute'); } });
    assert.equal(result.ok, false); assert.equal(f.board.status, 'blocked');
    assert.match(result.reason ?? '', /ghost/);
    assert.equal(f.board.tasks[0].status, 'pending');
  } finally { await f.cleanup(); }
});

test('cancelled tasks are not counted as a completed plan', async () => {
  const f = await fixture([task('cancelled', [], 'cancelled')]);
  try {
    const result = await runTaskBoardLoop({ ...f, runTurn: async () => { assert.fail('Cancelled tasks cannot execute'); } });
    assert.equal(result.ok, false); assert.notEqual(f.board.status, 'completed');
    assert.match(result.reason ?? '', /取消|cancel/);
  } finally { await f.cleanup(); }
});

test('an existing live execution lease is not overwritten or cleared by another board loop', async () => {
  const f = await fixture([task('running', [], 'in_progress')]);
  try {
    await f.store.writeLease(f.board.id, 'running');
    const leaseFile = join(f.root, '.aicode', 'tasks', `${f.board.id}.lease.json`);
    const before = await readFile(leaseFile, 'utf8');
    const result = await runTaskBoardLoop({ ...f, runTurn: async () => { assert.fail('Another live execution owns this board'); } });
    assert.equal(result.ok, false); assert.match(result.reason ?? '', /执行|running|owner/);
    assert.equal(await readFile(leaseFile, 'utf8'), before);
  } finally { await f.cleanup(); }
});

test('new model plans reject cyclic or ambiguous dependencies before persistence', () => {
  for (const tasks of [[task('a', ['b']), task('b', ['a'])], [task('a', ['ghost'])], [task('a', ['a'])], [task('dup'), task('dup')]]) {
    assert.throws(() => planBoardFromModel('Review graph', { planMarkdown: 'Plan', tasks }));
  }
});

test('valid dense dependencies and a long chain are inspected without recursion', () => {
  const dense = Array.from({ length: 100 }, (_, index) => task(`t${index}`, Array.from({ length: index }, (_entry, parent) => `t${parent}`)));
  const inspected = inspectTaskGraph(dense); assert.deepEqual(inspected.issues, []); assert.equal(inspected.levels.get('t99'), 100);
  const chain = Array.from({ length: 5000 }, (_, index) => task(`c${index}`, index ? [`c${index - 1}`] : []));
  assert.equal(inspectTaskGraph(chain).levels.get('c4999'), 5000);
});

test('a valid diamond executes dependencies once and allows explicitly skipped predecessors', async () => {
  const f = await fixture([task('root', [], 'skipped'), task('left', ['root', 'root']), task('right', ['root']), task('join', ['left', 'right'])]); const runs: string[] = [];
  try {
    const result = await runTaskBoardLoop({ ...f, verifyEnabled: false, runTurn: async () => { runs.push(f.session.taskRuntime!.activeTaskId!); return { ok: true, finalAnswer: 'TASK_DONE: current step' }; } });
    assert.equal(result.ok, true); assert.deepEqual(runs, ['left', 'right', 'join']); assert.equal(f.board.status, 'completed');
  } finally { await f.cleanup(); }
});

test('pending work with a live lease is also refused without touching the owning lease', async () => {
  const f = await fixture([task('pending')]);
  try {
    await f.store.writeLease(f.board.id, 'already-owned'); const before = await f.store.readLease(f.board.id);
    const result = await runTaskBoardLoop({ ...f, runTurn: async () => { assert.fail('A live lease must be respected'); } });
    assert.equal(result.status, 'busy'); assert.deepEqual(await f.store.readLease(f.board.id), before);
  } finally { await f.cleanup(); }
});

test('cancelled plan metadata stays cancelled until a task is explicitly reopened', async () => {
  const f = await fixture([task('current', [], 'cancelled')]); f.board.status = 'cancelled';
  try {
    const result = await runTaskBoardLoop({ ...f, runTurn: async () => { assert.fail('Cancelled plans must not run'); } });
    assert.equal(result.outcome, 'cancelled'); assert.equal(f.board.status, 'cancelled');
    reopenTask(f.board, 'current', new Date().toISOString()); assert.equal(f.board.status, 'active'); assert.equal(f.board.tasks[0].status, 'pending');
  } finally { await f.cleanup(); }
});

test('a malformed stored task list is preserved and cannot take down recovery', async () => {
  const f = await fixture([task('current')]);
  try {
    f.board.tasks = null as unknown as TaskItem[]; await f.store.save(f.board);
    const before = await readFile(f.store.filePath(f.board.id), 'utf8');
    assert.deepEqual(await f.store.recoverInterrupted(), []);
    assert.equal(await readFile(f.store.filePath(f.board.id), 'utf8'), before);
    const result = await runTaskBoardLoop({ ...f, runTurn: async () => { assert.fail('Malformed task lists cannot execute'); } });
    assert.equal(result.ok, false); assert.match(result.reason ?? '', /格式无效/); assert.equal(f.board.tasks, null);
  } finally { await f.cleanup(); }
});

test('a stale completed marker does not authorize unfinished work or an empty completed plan', async () => {
  for (const tasks of [[task('unfinished')], []]) {
    const f = await fixture(tasks); f.board.status = 'completed';
    try {
      const result = await runTaskBoardLoop({ ...f, runTurn: async () => { assert.fail('An inconsistent completed plan cannot execute'); } });
      assert.equal(result.ok, false); assert.equal(f.board.status, 'blocked');
    } finally { await f.cleanup(); }
  }
});

test('generated ids avoid explicit ids without renaming the declared nodes', () => {
  const board = planBoardFromModel('Graph', { planMarkdown: 'Plan', tasks: [{ title: 'Automatic' }, { id: 'task_1', title: 'Explicit' }] });
  assert.equal(board.tasks[1].id, 'task_1'); assert.notEqual(board.tasks[0].id, 'task_1');
  assert.deepEqual(inspectTaskGraph(board.tasks).issues, []);
});

test('confirmation rejects invalid graphs before asking Git to create a branch', async () => {
  const f = await fixture([task('a', ['b']), task('b', ['a'])]); f.board.status = 'draft'; await f.store.save(f.board);
  f.session.taskRuntime = { boardId: f.board.id, mode: 'awaiting_confirm' };
  try {
    await assert.rejects(handleSlashCommand({ line: '/plan confirm', config: { provider: 'mock', model: 'fixture', approval: 'auto', workspaceRoot: f.root, sessionDir: join(f.root, 'sessions'), noBanner: true }, provider: { name: 'mock', model: 'fixture', async complete() { assert.fail('A model must not be called while confirming invalid dependencies'); } }, tools: new ToolRegistry(), sessions: f.sessions, session: f.session, gitProcess: {} as GitProcess, gitRepository: { discover() { assert.fail('Git must not be called for an invalid plan'); } } as unknown as GitRepository }), /循环依赖/);
    assert.equal((await f.store.load(f.board.id)).status, 'draft');
    assert.equal(f.session.taskRuntime.mode, 'awaiting_confirm');
  } finally { await f.cleanup(); }
});

test('a draft board cannot run just because a caller sets the session mode to executing', async () => {
  const f = await fixture([task('unapproved')]); f.board.status = 'draft'; f.session.taskRuntime = { boardId: f.board.id, mode: 'executing' };
  try {
    const result = await runTaskBoardLoop({ ...f, runTurn: async () => { assert.fail('A draft plan has not been approved'); } });
    assert.equal(result.ok, false); assert.equal(result.status, 'draft');
    assert.equal(f.board.tasks[0].status, 'pending'); assert.equal(await f.store.readLease(f.board.id), null);
  } finally { await f.cleanup(); }
});
