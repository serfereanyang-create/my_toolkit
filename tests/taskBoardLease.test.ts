/**
 * taskBoardLease.test.ts — 任务板运行租约与崩溃恢复
 *
 * 覆盖：无租约恢复、活租约跳过（另一进程在跑）、死进程+过期恢复并清租约、
 * TTL 内新鲜跳过（时钟偏移保护）、干净任务板不受影响。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskBoardStore } from '../src/tasks/store.js';

function board(id: string, withInProgress: boolean) {
  return {
    id,
    title: id,
    goal: 'goal',
    status: 'active' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: withInProgress
      ? [
        { id: 't1', title: 'running', status: 'in_progress' as const, dependsOn: [] as string[] },
        { id: 't2', title: 'pending', status: 'pending' as const, dependsOn: ['t1'] },
      ]
      : [{ id: 't1', title: 'done', status: 'done' as const, dependsOn: [] as string[] }],
  };
}

test('boards with in_progress tasks and no lease are recovered', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'lease-test-'));
  try {
    const store = new TaskBoardStore(ws);
    await store.save(board('b1', true));
    const repaired = await store.recoverInterrupted();
    assert.deepEqual(repaired, ['b1']);
    const after = await store.load('b1');
    assert.equal(after.tasks[0]!.status, 'blocked');
    assert.match(after.tasks[0]!.error ?? '', /Interrupted/);
    // pending 任务不受影响
    assert.equal(after.tasks[1]!.status, 'pending');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('a live lease (pid alive) blocks recovery: another process owns the board', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'lease-test-'));
  try {
    const store = new TaskBoardStore(ws);
    await store.save(board('b2', true));
    await store.writeLease('b2', 't1');
    assert.equal(await store.isLeaseLive('b2'), true);
    assert.deepEqual(await store.recoverInterrupted(), []);
    // in_progress 保持原状（没有被误标 blocked）
    const after = await store.load('b2');
    assert.equal(after.tasks[0]!.status, 'in_progress');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('a stale lease from a dead pid is recovered and the lease cleared', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'lease-test-'));
  try {
    const store = new TaskBoardStore(ws);
    await store.save(board('b3', true));
    const deadLease = {
      boardId: 'b3',
      taskId: 't1',
      pid: 999_999_999,
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    await writeFile(join(ws, '.aicode', 'tasks', 'b3.lease.json'), JSON.stringify(deadLease));
    assert.equal(await store.isLeaseLive('b3'), false);
    assert.deepEqual(await store.recoverInterrupted(), ['b3']);
    assert.equal(await store.readLease('b3'), null);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('a fresh lease with a dead pid is still treated as live (clock skew guard)', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'lease-test-'));
  try {
    const store = new TaskBoardStore(ws);
    await store.save(board('b4', true));
    const freshDead = {
      boardId: 'b4',
      taskId: 't1',
      pid: 999_999_999,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(join(ws, '.aicode', 'tasks', 'b4.lease.json'), JSON.stringify(freshDead));
    assert.deepEqual(await store.recoverInterrupted(), []);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('boards without in_progress tasks are never rewritten', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'lease-test-'));
  try {
    const store = new TaskBoardStore(ws);
    await store.save(board('b5', false));
    assert.deepEqual(await store.recoverInterrupted(), []);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
