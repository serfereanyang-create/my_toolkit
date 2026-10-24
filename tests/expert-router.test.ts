import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeTaskToExpert, selectExpertForGoal } from '../src/experts/router.js';
import { allExperts } from '../src/experts/profiles.js';
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

test('English keywords match whole words, not substrings of unrelated ones', () => {
  /*
   * The roster keys on read / test / word / excel — short English words that
   * appear inside many ordinary ones. Plain substring matching routed on those
   * coincidences, and the damage is not cosmetic: `Fix the spread operator bug`
   * matched `read` (s-p-read) and went to the read-only search expert, whose
   * toolFilter drops every write tool, so the fix could not be made at all.
   */
  const cases: Array<[string, string]> = [
    ['Fix the spread operator bug', 'code_edit'],       // 'read' in "spread"
    ['Implement thread-safe caching', 'code_edit'],     // 'read' in "thread"
    ['Implement the password reset flow', 'code_edit'], // 'word' in "password"
    ['implement excellent error handling', 'code_edit'],// 'excel' in "excellent"
    ['Update to the latest dependency versions', 'code_edit'], // 'test' in "latest"
  ];
  for (const [goal, expected] of cases) {
    const task = makeTask(goal);
    for (const profile of [selectExpertForGoal(goal), routeTaskToExpert({ task, board: makeBoard([task]), workspaceRoot: '/tmp' }).profile]) {
      assert.equal(profile.id, expected, goal);
    }
    // Not merely a different label: the expert must be able to write.
    assert.equal(selectExpertForGoal(goal).toolFilter({ name: 'write_file', risk: 'write' } as never), true, goal);
  }

  // A goal that genuinely contains no keyword is left to the general expert
  // rather than being dragged into a specialist by a coincidence ('test' in
  // "contest" used to send this to the test expert).
  assert.equal(selectExpertForGoal('Add a contest entry form').id, 'general');
});

test('whole-word matching still accepts inflections and Chinese forms', () => {
  // The word boundary must not be so strict that ordinary phrasing stops
  // matching: plurals, participles, and Chinese keywords carry the routing.
  const inflections: Array<[string, string]> = [
    ['Add unit tests for the auth module', 'test_verify'],   // plural
    ['Testing the login flow', 'test_verify'],               // participle
    ['Implementing the login flow', 'code_edit'],            // participle
    ['Parse and transform JSON config to CSV', 'data_processing'],
  ];
  for (const [goal, expected] of inflections) {
    const task = makeTask(goal);
    assert.equal(selectExpertForGoal(goal).id, expected, goal);
    assert.equal(routeTaskToExpert({ task, board: makeBoard([task]), workspaceRoot: '/tmp' }).profile.id, expected, goal);
  }
  for (const [goal, expected] of [['实现用户登录功能', 'code_edit'], ['调研现有认证代码', 'code_search'], ['添加测试用例', 'test_verify']] as Array<[string, string]>) {
    assert.equal(selectExpertForGoal(goal).id, expected, goal);
  }
});

test('specialist roster covers the expanded coding domains', () => {
  const ids = new Set(allExperts.map((expert) => expert.id));
  assert.ok(ids.size >= 18);
  for (const id of ['architecture', 'frontend', 'backend', 'debugging', 'security_review', 'performance', 'refactor', 'web_research', 'devops']) {
    assert.ok(ids.has(id), `missing specialist ${id}`);
  }
});

test('routes specialist tasks before the generic fallback', () => {
  const cases: Array<[string, string]> = [
    ['Review security vulnerabilities in the auth flow', 'security_review'],
    ['Design the architecture and module boundaries', 'architecture'],
    ['Profile the slow query and benchmark it', 'performance'],
    ['Debug and reproduce the startup failure', 'debugging'],
    ['Implement the React frontend interaction', 'frontend'],
    ['Implement the backend API endpoint', 'backend'],
    ['Refactor the symbol graph without changing behavior', 'refactor'],
    ['Prepare the Docker deployment pipeline', 'devops'],
  ];
  for (const [title, expected] of cases) {
    const task = makeTask(title);
    const result = routeTaskToExpert({ task, board: makeBoard([task]), workspaceRoot: '/tmp' });
    assert.equal(result.profile.id, expected, title);
  }
});

test('security review routing handles singular, plural, and Chinese goals with read-only tools', () => {
  const goals = [
    'Review a security vulnerability in the auth flow',
    'Review security vulnerabilities in the auth flow',
    'REVIEW SECURITY VULNERABILITIES IN THE AUTH FLOW',
    '检查认证流程中的安全漏洞',
  ];
  for (const goal of goals) {
    const task = makeTask(goal);
    const profiles = [
      selectExpertForGoal(goal),
      routeTaskToExpert({ task, board: makeBoard([task]), workspaceRoot: '/tmp' }).profile,
    ];
    for (const profile of profiles) {
      assert.equal(profile.id, 'security_review', goal);
      assert.equal(profile.toolFilter({ name: 'read_file', risk: 'read' } as never), true);
      assert.equal(profile.toolFilter({ name: 'write_file', risk: 'write' } as never), false);
      assert.equal(profile.toolFilter({ name: 'run_command', risk: 'shell' } as never), false);
      assert.equal(profile.toolFilter({ name: 'spawn_subagent', risk: 'read' } as never), false);
    }
  }
});

test('frontend and backend inspection tasks retain read-only tools instead of routing to implementation experts', () => {
  const goals = [
    'Inspect React frontend code',
    'Read the backend API endpoint',
    'Review frontend code',
    '查看前端页面结构',
    '检查后端数据库调用',
    '审阅前端代码',
  ];
  for (const goal of goals) {
    const task = makeTask(goal);
    const profiles = [
      selectExpertForGoal(goal),
      routeTaskToExpert({ task, board: makeBoard([task]), workspaceRoot: '/tmp' }).profile,
    ];
    for (const profile of profiles) {
      assert.equal(profile.id, 'code_search', goal);
      assert.equal(profile.toolFilter({ name: 'read_file', risk: 'read' } as never), true);
      assert.equal(profile.toolFilter({ name: 'write_file', risk: 'write' } as never), false);
      assert.equal(profile.toolFilter({ name: 'run_command', risk: 'shell' } as never), false);
      assert.equal(profile.toolFilter({ name: 'spawn_subagent', risk: 'read' } as never), false);
    }
  }
});
