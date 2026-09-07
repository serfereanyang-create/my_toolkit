import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentRuntime } from '../src/agent/agent.js';
import { SessionStore } from '../src/session/store.js';
import { runTaskBoardLoop } from '../src/tasks/runtime.js';
import { TaskBoardStore } from '../src/tasks/store.js';
import type { TaskBoard } from '../src/tasks/types.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';

function deterministicProvider() {
  return {
    name: 'mock' as const,
    model: 'mock',
    async complete() {
      return { actions: [{ type: 'message' as const, content: 'TASK_DONE: completed current task' }] };
    },
  };
}

test('task board loop routes tasks to different experts and records expertId', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-expert-loop-'));
  try {
    const sessionDir = join(workspace, 'sessions');
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const store = new TaskBoardStore(workspace);
    
    const board: TaskBoard = {
      id: 'board_expert_test',
      title: 'Expert routing test',
      goal: 'Test expert routing',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      tasks: [
        { id: 'task_1', title: 'Inspect auth code', status: 'pending', dependsOn: [] },
        { id: 'task_2', title: 'Implement login', status: 'pending', dependsOn: ['task_1'] },
        { id: 'task_3', title: 'Add tests', status: 'pending', dependsOn: ['task_2'] },
      ],
    };
    await store.save(board);
    
    const runtime: AgentRuntime = {
      config: {
        provider: 'mock',
        model: 'mock',
        approval: 'auto',
        workspaceRoot: workspace,
        sessionDir,
        maxSteps: 5,
        noBanner: true,
      },
      provider: deterministicProvider(),
      tools: createDefaultToolRegistry(),
      allTools: createDefaultToolRegistry(),
      sessions,
      session,
      ui: new TerminalUI(true),
    };
    
    const result = await runTaskBoardLoop({
      board,
      store,
      sessions,
      session,
      runtime,
      runTurn: async () => ({ ok: true, finalAnswer: 'TASK_DONE: done' }),
      onInfo: () => undefined,
    });
    
    assert.equal(result.ok, true);
    assert.equal(board.tasks[0].status, 'done');
    assert.equal(board.tasks[1].status, 'done');
    assert.equal(board.tasks[2].status, 'done');
    
    // 验证专家路由
    assert.equal(board.tasks[0].expertId, 'code_search');
    assert.ok(board.tasks[0].expertConfidence !== undefined);
    assert.equal(board.tasks[1].expertId, 'code_edit');
    assert.ok(board.tasks[1].expertConfidence !== undefined);
    assert.equal(board.tasks[2].expertId, 'test_verify');
    assert.ok(board.tasks[2].expertConfidence !== undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('task board without runtime parameter still works (backward compatibility)', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-compat-'));
  try {
    const sessionDir = join(workspace, 'sessions');
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
    const store = new TaskBoardStore(workspace);
    
    const board: TaskBoard = {
      id: 'board_compat',
      title: 'Compat test',
      goal: 'Test backward compatibility',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      tasks: [
        { id: 'task_1', title: 'Do something', status: 'pending', dependsOn: [] },
      ],
    };
    await store.save(board);
    
    // 不传 runtime 参数（旧代码路径）
    const result = await runTaskBoardLoop({
      board,
      store,
      sessions,
      session,
      runTurn: async () => ({ ok: true, finalAnswer: 'TASK_DONE: done' }),
      onInfo: () => undefined,
    });
    
    assert.equal(result.ok, true);
    assert.equal(board.tasks[0].status, 'done');
    // 没有 runtime，不会记录 expertId
    assert.equal(board.tasks[0].expertId, undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
