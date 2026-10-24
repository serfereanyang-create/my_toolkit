import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import { runDesktopBridge } from '../src/cli/desktopBridge.js';
import { TaskBoardStore } from '../src/tasks/store.js';
import type { TaskBoard } from '../src/tasks/types.js';

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Bridge did not reach expected task-board state');
}

test('pause during a board model call is accepted, persists resumable progress and announces cancelled exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoy-board-bridge-'));
  const created = await createAgentRuntime({ provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: root, sessionDir: join(root, 'sessions'), noBanner: true, json: true });
  const runtime = created.runtime;
  const board: TaskBoard = { id: 'board_bridge_pause', title: 'Bridge pause fixture', goal: 'Pause source inspection', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [{ id: 'task_1', title: 'Inspect source code', status: 'pending', dependsOn: [] }] };
  const store = new TaskBoardStore(root); await store.save(board);
  runtime.session.taskRuntime = { boardId: board.id, mode: 'paused' }; await runtime.sessions.save(runtime.session);
  let calls = 0;
  runtime.provider = { name: 'mock', model: 'fixture', async complete() { calls += 1; return calls === 1 ? new Promise(() => {}) : { actions: [{ type: 'message', content: 'TASK_DONE: inspected' }] }; } };
  const input = new PassThrough(); const events: Array<Record<string, unknown>> = [];
  const running = runDesktopBridge(runtime, { input, emit: event => events.push(event) });
  try {
    await waitFor(() => events.some(event => event.type === 'bridge_ready'));
    assert.ok(events.some(event => event.type === 'task_board_updated' && event.runtimeMode === 'paused'));
    input.write(`${JSON.stringify({ type: 'task_board_action', action: 'continue' })}\n`);
    await waitFor(() => calls === 1);
    input.write(`${JSON.stringify({ type: 'task_board_action', action: 'pause' })}\n`);
    await waitFor(() => events.some(event => event.type === 'turn_done'));
    const done = events.filter(event => event.type === 'turn_done');
    assert.equal(done.length, 1); assert.equal(done[0].status, 'cancelled');
    assert.equal(events.some(event => event.type === 'error'), false);
    assert.equal((await store.load(board.id)).tasks[0].status, 'pending');
    assert.equal(runtime.session.taskRuntime?.mode, 'paused');
    assert.ok(events.some(event => event.type === 'task_board_updated' && event.runtimeMode === 'paused' && event.activeTaskId === 'task_1'));
    assert.equal(await store.readLease(board.id), null);
    input.write(`${JSON.stringify({ type: 'task_board_action', action: 'continue' })}\n`);
    await waitFor(() => events.filter(event => event.type === 'turn_done').length === 2);
    assert.equal(calls, 2); assert.equal((await store.load(board.id)).status, 'completed');
    assert.equal(events.filter(event => event.type === 'turn_done')[1].status, 'ok', JSON.stringify(events.filter(event => event.type === 'error' || event.type === 'turn_done')));
    assert.ok(runtime.session.messages.some(message => message.role === 'user' && message.content.includes('approved project board') && message.displayText === '执行任务：Inspect source code'));
  } finally {
    input.end(`${JSON.stringify({ type: 'shutdown' })}\n`); await running; await created.close();
    const target = await realpath(root); const inside = relative(await realpath(tmpdir()), target); assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside)); await rm(target, { recursive: true, force: true });
  }
});
