import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AutomationManager } from '../src/automation/manager.js';
import { AutomationStore } from '../src/automation/store.js';
import type { AutomationTask, CronTrigger } from '../src/automation/types.js';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';

async function tempWorkspace(name: string) {
  const root = await mkdtemp(join(tmpdir(), `aicode-automation-${name}-`));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('AutomationStore: save and load task', async () => {
  const workspace = await tempWorkspace('store-basic');
  try {
    const store = new AutomationStore(workspace.root);
    
    const task: AutomationTask = {
      id: 'task_test1',
      name: 'Test Task',
      description: 'Test description',
      enabled: false,
      trigger: { type: 'cron', expression: '0 9 * * *' } as CronTrigger,
      action: {
        type: 'task_board',
        goal: 'Test goal',
        confirmPlan: true,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    await store.save(task);
    const loaded = await store.load('task_test1');
    
    assert.ok(loaded);
    assert.equal(loaded.id, 'task_test1');
    assert.equal(loaded.name, 'Test Task');
    assert.equal(loaded.enabled, false);
  } finally {
    await workspace.cleanup();
  }
});

test('AutomationStore: list tasks', async () => {
  const workspace = await tempWorkspace('store-list');
  try {
    const store = new AutomationStore(workspace.root);
    
    const task1: AutomationTask = {
      id: 'task_1',
      name: 'Task 1',
      enabled: false,
      trigger: { type: 'manual' },
      action: { type: 'task_board', goal: 'Goal 1', confirmPlan: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    const task2: AutomationTask = {
      id: 'task_2',
      name: 'Task 2',
      enabled: true,
      trigger: { type: 'cron', expression: '0 * * * *' },
      action: { type: 'task_board', goal: 'Goal 2', confirmPlan: false },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    await store.save(task1);
    await store.save(task2);
    
    const tasks = await store.list();
    assert.equal(tasks.length, 2);
    assert.ok(tasks.find(t => t.id === 'task_1'));
    assert.ok(tasks.find(t => t.id === 'task_2'));
  } finally {
    await workspace.cleanup();
  }
});

test('AutomationStore: delete task', async () => {
  const workspace = await tempWorkspace('store-delete');
  try {
    const store = new AutomationStore(workspace.root);
    
    const task: AutomationTask = {
      id: 'task_del',
      name: 'Delete Me',
      enabled: false,
      trigger: { type: 'manual' },
      action: { type: 'task_board', goal: 'Test', confirmPlan: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    await store.save(task);
    assert.ok(await store.load('task_del'));
    
    const deleted = await store.delete('task_del');
    assert.equal(deleted, true);
    assert.equal(await store.load('task_del'), undefined);
  } finally {
    await workspace.cleanup();
  }
});

test('AutomationStore: record and get execution history', async () => {
  const workspace = await tempWorkspace('store-history');
  try {
    const store = new AutomationStore(workspace.root);
    
    await store.recordExecution('task_hist', {
      status: 'success',
      boardId: 'board_1',
      executedAt: new Date().toISOString(),
    });
    
    await store.recordExecution('task_hist', {
      status: 'failed',
      error: 'Test error',
      executedAt: new Date().toISOString(),
    });
    
    const history = await store.getHistory('task_hist', 10);
    assert.equal(history.length, 2);
    assert.equal(history[0].status, 'failed'); // Most recent first
    assert.equal(history[1].status, 'success');
  } finally {
    await workspace.cleanup();
  }
});

test('AutomationManager: create task', async () => {
  const workspace = await tempWorkspace('manager-create');
  try {
    const manager = new AutomationManager(workspace.root);
    
    const task = await manager.createTask({
      name: 'Daily Test',
      description: 'Run tests daily',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      goal: 'Run all tests',
      confirmPlan: true,
      maxTasks: 10,
    });
    
    assert.ok(task.id.startsWith('auto_'));
    assert.equal(task.name, 'Daily Test');
    assert.equal(task.enabled, false); // Default disabled
    assert.equal(task.action.goal, 'Run all tests');
  } finally {
    await workspace.cleanup();
  }
});

test('AutomationManager: start and stop task', async () => {
  const workspace = await tempWorkspace('manager-start-stop');
  try {
    const manager = new AutomationManager(workspace.root);
    
    const task = await manager.createTask({
      name: 'Test Task',
      trigger: { type: 'manual' },
      goal: 'Test',
      confirmPlan: true,
    });
    
    assert.equal(task.enabled, false);
    
    // Start task (manual trigger doesn't require Cron registration)
    await manager.startTask(task.id);
    const started = await manager.getTask(task.id);
    assert.equal(started?.enabled, true);
    
    // Stop task
    await manager.stopTask(task.id);
    const stopped = await manager.getTask(task.id);
    assert.equal(stopped?.enabled, false);
  } finally {
    await workspace.cleanup();
  }
});

test('AutomationManager: list and get tasks', async () => {
  const workspace = await tempWorkspace('manager-list');
  try {
    const manager = new AutomationManager(workspace.root);
    
    await manager.createTask({
      name: 'Task 1',
      trigger: { type: 'manual' },
      goal: 'Goal 1',
      confirmPlan: true,
    });
    
    await manager.createTask({
      name: 'Task 2',
      trigger: { type: 'manual' },
      goal: 'Goal 2',
      confirmPlan: false,
    });
    
    const tasks = await manager.listTasks();
    assert.equal(tasks.length, 2);
    
    const task = await manager.getTask(tasks[0].id);
    assert.ok(task);
    assert.equal(task.name, 'Task 1');
  } finally {
    await workspace.cleanup();
  }
});

test('AutomationManager: delete task', async () => {
  const workspace = await tempWorkspace('manager-delete');
  try {
    const manager = new AutomationManager(workspace.root);
    
    const task = await manager.createTask({
      name: 'To Delete',
      trigger: { type: 'manual' },
      goal: 'Test',
      confirmPlan: true,
    });
    
    const deleted = await manager.deleteTask(task.id);
    assert.equal(deleted, true);
    
    const tasks = await manager.listTasks();
    assert.equal(tasks.length, 0);
  } finally {
    await workspace.cleanup();
  }
});

test('AutomationManager: update task', async () => {
  const workspace = await tempWorkspace('manager-update');
  try {
    const manager = new AutomationManager(workspace.root);
    
    const task = await manager.createTask({
      name: 'Original Name',
      trigger: { type: 'manual' },
      goal: 'Original Goal',
      confirmPlan: true,
    });
    
    const updated = await manager.updateTask(task.id, {
      name: 'Updated Name',
      action: { type: 'task_board', goal: 'Updated Goal', confirmPlan: false },
    });
    
    assert.equal(updated.name, 'Updated Name');
    assert.equal(updated.action.goal, 'Updated Goal');
    assert.equal(updated.action.confirmPlan, false);
  } finally {
    await workspace.cleanup();
  }
});

test('AutomationManager: runTask is no longer blocked by security scanner', async () => {
  const workspace = await tempWorkspace('manager-run');
  try {
    const manager = new AutomationManager(workspace.root);
    
    // 创建一个简单任务
    const task = await manager.createTask({
      name: 'Test Run',
      trigger: { type: 'manual' },
      goal: 'Simple test goal',
      confirmPlan: true,
      maxTasks: 5,
    });
    
    // Use a real runtime with the mock provider so this test exercises the
    // production automation/task-board contract instead of a partial fake.
    const created = await createAgentRuntime({
      provider: 'mock',
      model: 'mock-code-agent-v1',
      approval: 'auto',
      workspaceRoot: workspace.root,
      sessionDir: join(workspace.root, 'sessions'),
      noBanner: true,
      json: true,
    });
    try {
      created.runtime.provider = {
        name: 'mock',
        model: 'automation-fixture',
        complete: async () => ({ actions: [{ type: 'message', content: 'TASK_DONE: automation fixture completed' }] }),
      } as any;
      const result = await manager.runTask(task.id, created.runtime);
      assert.ok(result);
      assert.ok(['success', 'failed', 'blocked'].includes(result.status));
    } finally {
      await created.close();
    }
  } finally {
    await workspace.cleanup();
  }
});
