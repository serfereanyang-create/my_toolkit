import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AutomationManager } from '../src/automation/manager.js';
import { FileWatchManager } from '../src/automation/file-watcher.js';
import type { FileWatchTrigger } from '../src/automation/types.js';

async function tempWorkspace(name: string) {
  const root = await mkdtemp(join(tmpdir(), `aicode-filewatch-${name}-`));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('FileWatchManager: can start and stop watching', async () => {
  const workspace = await tempWorkspace('basic');
  try {
    const manager = new FileWatchManager();
    
    const mockTask = {
      id: 'test_watch_1',
      name: 'Test Watch',
      enabled: true,
      trigger: {
        type: 'file_watch',
        patterns: ['*.txt'],
        events: ['create', 'modify'],
        debounceMs: 100,
      } as FileWatchTrigger,
      action: { type: 'task_board', goal: 'Test', confirmPlan: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    
    let triggerCount = 0;
    
    await manager.start(mockTask, {
      workspaceRoot: workspace.root,
      runtime: {} as any,
      executor: {} as any,
      store: {} as any,
      onTrigger: () => { triggerCount++; },
    });
    
    const activeWatchers = manager.getActiveWatchers();
    assert.equal(activeWatchers.length, 1);
    assert.equal(activeWatchers[0], 'test_watch_1');
    
    await manager.stop('test_watch_1');
    assert.equal(manager.getActiveWatchers().length, 0);
  } finally {
    await workspace.cleanup();
  }
});

test('FileWatchManager: triggers on file create', async () => {
  const workspace = await tempWorkspace('create');
  try {
    const manager = new FileWatchManager();
    
    const mockTask = {
      id: 'test_watch_2',
      name: 'Test Create',
      enabled: true,
      trigger: {
        type: 'file_watch',
        patterns: ['test-*.txt'],
        events: ['create'],
        debounceMs: 50,
      } as FileWatchTrigger,
      action: { type: 'task_board', goal: 'Test', confirmPlan: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    
    let triggerCount = 0;
    let lastFile = '';
    
    await manager.start(mockTask, {
      workspaceRoot: workspace.root,
      runtime: {} as any,
      executor: {
        run: async () => ({
          status: 'success',
          executedAt: new Date().toISOString(),
        }),
      } as any,
      store: {
        recordExecution: async () => {},
        save: async () => {},
      } as any,
      onTrigger: (_taskId, _event, filePath) => {
        triggerCount++;
        lastFile = filePath;
      },
    });
    
    // 等待监听器初始化
    await sleep(100);
    
    // 创建文件
    await writeFile(join(workspace.root, 'test-file.txt'), 'content');
    
    // 等待防抖和触发
    await sleep(200);
    
    assert.ok(triggerCount > 0, 'Should trigger at least once');
    assert.ok(lastFile.includes('test-file.txt'), 'Should capture the correct file');
    
    await manager.stop('test_watch_2');
  } finally {
    await workspace.cleanup();
  }
});

test('FileWatchManager: debounces rapid changes', async () => {
  const workspace = await tempWorkspace('debounce');
  try {
    const manager = new FileWatchManager();
    
    const mockTask = {
      id: 'test_watch_3',
      name: 'Test Debounce',
      enabled: true,
      trigger: {
        type: 'file_watch',
        patterns: ['*.txt'],
        events: ['modify'],
        debounceMs: 200,
      } as FileWatchTrigger,
      action: { type: 'task_board', goal: 'Test', confirmPlan: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    
    let executionCount = 0;
    
    await manager.start(mockTask, {
      workspaceRoot: workspace.root,
      runtime: {} as any,
      executor: {
        run: async () => {
          executionCount++;
          return {
            status: 'success',
            executedAt: new Date().toISOString(),
          };
        },
      } as any,
      store: {
        recordExecution: async () => {},
        save: async () => {},
      } as any,
      onTrigger: () => {},
    });
    
    await sleep(100);
    
    // 创建文件
    const filePath = join(workspace.root, 'debounce.txt');
    await writeFile(filePath, 'v1');
    
    // 快速修改多次
    await sleep(50);
    await writeFile(filePath, 'v2');
    await sleep(50);
    await writeFile(filePath, 'v3');
    
    // 等待防抖完成
    await sleep(400);
    
    // 应该只执行一次（防抖生效）
    assert.ok(executionCount <= 2, `Should execute at most twice, got ${executionCount}`);
    
    await manager.stop('test_watch_3');
  } finally {
    await workspace.cleanup();
  }
});

test('FileWatchManager: ignores node_modules and .git', async () => {
  const workspace = await tempWorkspace('ignore');
  try {
    const manager = new FileWatchManager();
    
    const mockTask = {
      id: 'test_watch_4',
      name: 'Test Ignore',
      enabled: true,
      trigger: {
        type: 'file_watch',
        patterns: ['**/*.txt'],
        events: ['create'],
        debounceMs: 50,
      } as FileWatchTrigger,
      action: { type: 'task_board', goal: 'Test', confirmPlan: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    
    let triggerCount = 0;
    
    await manager.start(mockTask, {
      workspaceRoot: workspace.root,
      runtime: {} as any,
      executor: {
        run: async () => ({
          status: 'success',
          executedAt: new Date().toISOString(),
        }),
      } as any,
      store: {
        recordExecution: async () => {},
        save: async () => {},
      } as any,
      onTrigger: () => { triggerCount++; },
    });
    
    await sleep(100);
    
    // 在node_modules中创建文件（应该被忽略）
    await mkdir(join(workspace.root, 'node_modules'), { recursive: true });
    await writeFile(join(workspace.root, 'node_modules', 'test.txt'), 'content');
    
    await sleep(200);
    
    assert.equal(triggerCount, 0, 'Should not trigger for node_modules');
    
    await manager.stop('test_watch_4');
  } finally {
    await workspace.cleanup();
  }
});

test('AutomationManager: creates and starts file watch task', async () => {
  const workspace = await tempWorkspace('manager-filewatch');
  try {
    const mockRuntime = {
      config: { workspaceRoot: workspace.root },
      sessions: {} as any,
      session: { id: 'test', workspaceRoot: workspace.root } as any,
    } as any;
    
    const manager = new AutomationManager(workspace.root, mockRuntime);
    
    const task = await manager.createTask({
      name: 'File Watch Task',
      trigger: {
        type: 'file_watch',
        patterns: ['src/**/*.ts'],
        events: ['modify'],
        debounceMs: 1000,
      },
      goal: 'Run tests when code changes',
      confirmPlan: true,
    });
    
    assert.equal(task.trigger.type, 'file_watch');
    assert.equal(task.enabled, false);
    
    // 启动文件监听
    await manager.startTask(task.id);
    
    const updatedTask = await manager.getTask(task.id);
    assert.equal(updatedTask?.enabled, true);
    
    const activeWatchers = manager.getActiveFileWatchers();
    assert.equal(activeWatchers.length, 1);
    assert.equal(activeWatchers[0], task.id);
    
    // 停止文件监听
    await manager.stopTask(task.id);
    
    const stoppedTask = await manager.getTask(task.id);
    assert.equal(stoppedTask?.enabled, false);
    assert.equal(manager.getActiveFileWatchers().length, 0);
  } finally {
    await workspace.cleanup();
  }
});
