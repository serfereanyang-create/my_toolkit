import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeTaskToExpert } from '../src/experts/router.js';
import type { TaskBoard, TaskItem } from '../src/tasks/types.js';

function makeTask(title: string, detail?: string, acceptance?: string): TaskItem {
  return {
    id: 'task_1',
    title,
    detail,
    acceptance,
    status: 'pending',
    dependsOn: [],
  };
}

function makeBoard(tasks: TaskItem[]): TaskBoard {
  return {
    id: 'board_test',
    title: 'Test Board',
    goal: 'Test goal',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks,
  };
}

test('routes code edit tasks to codeEditExpert', () => {
  const task = makeTask('Implement login feature');
  const board = makeBoard([task]);
  const result = routeTaskToExpert({ task, board, workspaceRoot: '/tmp' });
  
  assert.equal(result.profile.id, 'code_edit');
  assert.equal(result.routedBy, 'rule');
  assert.equal(result.confidence, 1.0);
});

test('routes inspection tasks to codeSearchExpert', () => {
  const task = makeTask('Inspect existing auth code');
  const board = makeBoard([task]);
  const result = routeTaskToExpert({ task, board, workspaceRoot: '/tmp' });
  
  assert.equal(result.profile.id, 'code_search');
  assert.equal(result.routedBy, 'rule');
});

test('routes git tasks to gitOpsExpert', () => {
  const task = makeTask('Commit changes and create PR');
  const board = makeBoard([task]);
  const result = routeTaskToExpert({ task, board, workspaceRoot: '/tmp' });
  
  assert.equal(result.profile.id, 'git_ops');
  assert.equal(result.routedBy, 'rule');
  assert.equal(result.confidence, 1.0);
});

test('routes test tasks to testVerifyExpert', () => {
  const task = makeTask('Add unit tests for auth module');
  const board = makeBoard([task]);
  const result = routeTaskToExpert({ task, board, workspaceRoot: '/tmp' });
  
  assert.equal(result.profile.id, 'test_verify');
  assert.equal(result.routedBy, 'rule');
});

test('routes doc generation tasks to docGenerationExpert', () => {
  const task = makeTask('Generate project documentation in Word format');
  const board = makeBoard([task]);
  const result = routeTaskToExpert({ task, board, workspaceRoot: '/tmp' });
  
  assert.equal(result.profile.id, 'doc_generation');
  assert.equal(result.routedBy, 'rule');
});

test('routes shell/runtime tasks to shellRuntimeExpert', () => {
  const task = makeTask('Run build command and check disk space');
  const board = makeBoard([task]);
  const result = routeTaskToExpert({ task, board, workspaceRoot: '/tmp' });
  
  assert.equal(result.profile.id, 'shell_runtime');
  assert.equal(result.routedBy, 'rule');
});

test('routes data processing tasks to dataProcessingExpert', () => {
  const task = makeTask('Parse and transform JSON config to CSV');
  const board = makeBoard([task]);
  const result = routeTaskToExpert({ task, board, workspaceRoot: '/tmp' });
  
  assert.equal(result.profile.id, 'data_processing');
  assert.equal(result.routedBy, 'rule');
});

test('first task with inspection keywords routes to codeSearchExpert via position rule', () => {
  const task1 = makeTask('Read project structure'); // 'read' 在 code_search 关键词中
  const task2 = makeTask('Implement feature');
  const board = makeBoard([task1, task2]);
  const result = routeTaskToExpert({ task: task1, board, workspaceRoot: '/tmp' });
  
  assert.equal(result.profile.id, 'code_search');
});

test('last task with verification keywords routes to testVerifyExpert via position rule', () => {
  const task1 = makeTask('Implement feature');
  const task2 = makeTask('Verify results'); // 明确的 verify 关键词
  const board = makeBoard([task1, task2]);
  const result = routeTaskToExpert({ task: task2, board, workspaceRoot: '/tmp' });
  
  assert.equal(result.profile.id, 'test_verify');
});

test('follow-up implementation after search task routes to codeEditExpert via context rule', () => {
  const task1 = makeTask('Study auth');
  task1.resultSummary = 'Found auth module at src/auth.ts';
  task1.status = 'done';
  const task2 = makeTask('Modify login logic'); // 'modify' 触发 code_edit 关键词
  const board = makeBoard([task1, task2]);
  const result = routeTaskToExpert({ task: task2, board, workspaceRoot: '/tmp' });
  
  // 'modify' 会直接触发关键词路由
  assert.equal(result.profile.id, 'code_edit');
});

test('fallback to generalExpert for unclear tasks', () => {
  const task = makeTask('Do something');
  const board = makeBoard([task]);
  const result = routeTaskToExpert({ task, board, workspaceRoot: '/tmp' });
  
  assert.equal(result.profile.id, 'general');
  assert.equal(result.routedBy, 'fallback');
  assert.equal(result.confidence, 0.5);
});

test('Chinese keywords work correctly', () => {
  const task1 = makeTask('实现用户登录功能');
  const board1 = makeBoard([task1]);
  const result1 = routeTaskToExpert({ task: task1, board: board1, workspaceRoot: '/tmp' });
  assert.equal(result1.profile.id, 'code_edit');
  
  const task2 = makeTask('调研现有认证代码');
  const board2 = makeBoard([task2]);
  const result2 = routeTaskToExpert({ task: task2, board: board2, workspaceRoot: '/tmp' });
  assert.equal(result2.profile.id, 'code_search');
  
  const task3 = makeTask('添加测试用例');
  const board3 = makeBoard([task3]);
  const result3 = routeTaskToExpert({ task: task3, board: board3, workspaceRoot: '/tmp' });
  assert.equal(result3.profile.id, 'test_verify');
});
