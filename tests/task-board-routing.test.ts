import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { test } from 'node:test';
import { analyzeTaskComplexity, classifyTaskComplexity } from '../src/tasks/complexity.js';
import { detectTaskCompletion } from '../src/tasks/completion.js';
import { inspectTaskGraph } from '../src/tasks/graph.js';
import { planBoardFromGoal, planBoardFromModel, shouldUseTaskBoard, type ProposedTask } from '../src/tasks/planner.js';
import { confirmBoard, markTaskBlocked, runTaskBoardLoop, startTask } from '../src/tasks/runtime.js';
import { TaskBoardStore } from '../src/tasks/store.js';
import type { TaskBoard, TaskItem } from '../src/tasks/types.js';
import { resolveToolScopeForTurn } from '../src/tools/scope.js';
import { SessionStore } from '../src/session/store.js';
import { allExperts, codeReviewExpert, expertById } from '../src/experts/profiles.js';
import { routeTaskToExpert, selectExpertForGoal } from '../src/experts/router.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import type { AgentRuntime } from '../src/agent/agent.js';
import {
  createBugfixWorkflow,
  createFeatureWorkflow,
  createRefactorWorkflow,
  WorkflowBuilder,
} from '../src/workflow/builder.js';
import { WorkflowEngine } from '../src/workflow/engine.js';
import { WORKFLOW_TEMPLATES } from '../src/workflow/types.js';

/** Deterministic PRNG: every failure prints the seed and case index. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 1. Complexity routing: read requests must not become boards, write requests
//    must not become compact.
// ---------------------------------------------------------------------------

test('read-shaped requests are not escalated to a task board', () => {
  const cases: Array<[string, string]> = [
    ['总结以下内容：\n- 第一条\n- 第二条\n- 第三条', 'small'],
    ['以下是用户反馈：\n- 登录慢\n- 搜索慢\n- 导出慢', 'small'],
    ['解释一下项目架构', 'small'],
    ['介绍一下这个项目的架构', 'small'],
    ['read the README and tests folder', 'standard'],
  ];
  for (const [prompt, expected] of cases) {
    const analysis = analyzeTaskComplexity(prompt);
    assert.equal(analysis.complexity, expected, prompt);
    assert.equal(shouldUseTaskBoard(prompt), false, `board decision for ${prompt}`);
  }
});

test('write requests in any phrasing never resolve to compact scope', () => {
  const cases = [
    '读取配置后改正端口号',
    '看一下并调整超时时间',
    '看看并替换所有旧域名',
    '读取并实现登录接口',
    'Check the code and adjust the retry timeout',
    'Review the config and bump the version',
    'inspect and rename the foo helper',
    'update the dependency version',
    'read config.ts and write the fixed content',
  ];
  for (const prompt of cases) {
    const analysis = analyzeTaskComplexity(prompt);
    assert.notEqual(analysis.complexity, 'small', `write request classified small: ${prompt}`);
    assert.equal(analysis.hasWriteIntent, true, `write intent missed: ${prompt}`);
    const scope = resolveToolScopeForTurn({ requested: 'auto', prompt, shouldUseTaskBoard: false });
    assert.equal(scope, 'standard', `scope for ${prompt}`);
  }
});

test('environment inspection keeps standard scope because compact has no run_command', () => {
  for (const prompt of ['查看磁盘剩余空间', '检查一下进程和内存', 'check disk free space', 'show environment variables']) {
    const analysis = analyzeTaskComplexity(prompt);
    assert.equal(analysis.complexity, 'standard', prompt);
    assert.equal(resolveToolScopeForTurn({ requested: 'auto', prompt, shouldUseTaskBoard: false }), 'standard', prompt);
  }
});

test('randomized prompt corpus obeys the routing invariants (seeded)', () => {
  const seed = 0x7a5c0de;
  const random = mulberry32(seed);
  const reads = ['读取', '查看', '解释', '总结', 'read', 'inspect', 'explain', 'summarize', '检查一下'];
  const writes = ['实现', '修复', '添加', '改正', '替换', 'implement', 'fix', 'add', 'adjust', 'rename'];
  const fillers = ['文件', '配置', '模块', 'module', 'config', 'the code', '小事', 'package.json'];
  const prefixes = ['', '/plan ', '1. 读配置 2. 改入口 3. 跑测试\n'];
  for (let index = 0; index < 4000; index += 1) {
    const roll = random();
    const prefix = prefixes[Math.floor(random() * prefixes.length)];
    const parts: string[] = [];
    if (roll < 0.4) parts.push(reads[Math.floor(random() * reads.length)]);
    if (roll >= 0.4 && roll < 0.8) parts.push(writes[Math.floor(random() * writes.length)]);
    const extra = 1 + Math.floor(random() * 3);
    for (let i = 0; i < extra; i += 1) parts.push(fillers[Math.floor(random() * fillers.length)]);
    const prompt = prefix + parts.join(' ');
    const analysis = analyzeTaskComplexity(prompt);
    const context = `seed=${seed} case=${index} prompt=${JSON.stringify(prompt)}`;
    assert.ok(['small', 'standard', 'large'].includes(analysis.complexity), context);
    if (analysis.hasWriteIntent && !prompt.startsWith('/plan')) {
      assert.notEqual(analysis.complexity, 'small', `write intent classified compact: ${context}`);
    }
    if (analysis.complexity === 'small') {
      assert.equal(analysis.hasWriteIntent, false, `small with write intent: ${context}`);
    }
  }
});

test('a long body of text is not a task board by length alone', () => {
  const bodies = [
    'e'.repeat(4990),
    'word '.repeat(1200),
    'A'.repeat(4000),
    '修复 A'.repeat(250),
  ];
  for (const body of bodies) {
    assert.equal(classifyTaskComplexity(body), 'standard', `length ${body.length}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Board planning boundaries
// ---------------------------------------------------------------------------

test('planBoardFromGoal stays consumable for empty, punctuation-only, prefixed and long goals', () => {
  const goals = ['', '   ', '！！！', '/plan', '1. 只做一步', 'x'.repeat(5000), '实现\n任务板\n分步'];
  for (const goal of goals) {
    const board = planBoardFromGoal(goal);
    assert.equal(board.status, 'draft');
    assert.ok(board.tasks.length >= 1, `no tasks for ${JSON.stringify(goal.slice(0, 20))}`);
    assert.deepEqual(inspectTaskGraph(board.tasks).issues, [], `graph issues for ${JSON.stringify(goal.slice(0, 20))}`);
    assert.ok(board.title.length <= 60, 'title is bounded');
    assert.equal(board.tasks[0].dependsOn.length, 0);
    for (let index = 1; index < board.tasks.length; index += 1) {
      assert.deepEqual(board.tasks[index].dependsOn, [board.tasks[index - 1].id]);
    }
  }
  // `/plan` alone is a plan command but the template goal must not leak it.
  assert.equal(shouldUseTaskBoard('/plan'), true);
  assert.equal(shouldUseTaskBoard('1. 只做一步'), false);
});

test('planBoardFromModel rejects ambiguous graphs and resolves omitted ids', () => {
  const cycles: ProposedTask[][] = [
    [{ id: 'a', title: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B', dependsOn: ['a'] }],
    [{ id: 'a', title: 'A', dependsOn: ['a'] }],
    [{ id: 'a', title: 'A', dependsOn: ['ghost'] }],
    [{ id: 'dup', title: 'A' }, { id: 'dup', title: 'B' }],
  ];
  for (const tasks of cycles) {
    assert.throws(() => planBoardFromModel('goal', { planMarkdown: 'plan', tasks }), /计划依赖无效|任务编号重复/);
  }
  const board = planBoardFromModel('goal', {
    planMarkdown: 'plan',
    tasks: [{ title: 'first' }, { id: 'task_1', title: 'explicit' }, { title: 'third', dependsOn: ['task_1'] }],
  });
  assert.deepEqual(inspectTaskGraph(board.tasks).issues, []);
  assert.equal(new Set(board.tasks.map((task) => task.id)).size, board.tasks.length);
});

// ---------------------------------------------------------------------------
// 3. Persistence and recovery
// ---------------------------------------------------------------------------

async function workspaceFixture(tasks: TaskItem[]) {
  const root = await mkdtemp(join(tmpdir(), 'aicode-routing-'));
  const sessions = new SessionStore(join(root, 'sessions'));
  const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: root });
  const store = new TaskBoardStore(root);
  const board: TaskBoard = {
    id: 'board_routing',
    title: 'Routing',
    goal: 'Exercise task board recovery',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks,
  };
  await store.save(board);
  const cleanup = async () => {
    const target = await realpath(root);
    const inside = relative(await realpath(tmpdir()), target);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
    await rm(target, { recursive: true, force: true });
  };
  return { root, sessions, session, store, board, cleanup };
}

const task = (id: string, dependsOn: string[] = [], status: TaskItem['status'] = 'pending'): TaskItem => ({
  id, title: id, status, dependsOn,
});

test('a truncated board is reported as corrupt, not as missing', async () => {
  const f = await workspaceFixture([task('t1')]);
  try {
    const file = f.store.filePath(f.board.id);
    const full = await readFile(file, 'utf8');
    await writeFile(file, full.slice(0, Math.floor(full.length / 2)));
    await assert.rejects(() => f.store.load(f.board.id), /corrupt|unparseable/i);
    assert.deepEqual(await f.store.recoverInterrupted(), [], 'recovery skips the corrupt board');
  } finally {
    await f.cleanup();
  }
});

test('a corrupt index never crashes list, even while a lease exists', async () => {
  const f = await workspaceFixture([task('t1')]);
  try {
    const indexFile = join(f.root, '.aicode', 'tasks', 'index.json');
    for (const body of ['{not json', 'null', '{"id":"x"}', '42', '[{"updatedAt":"2026-01-01T00:00:00.000Z"}]']) {
      await writeFile(indexFile, body);
      const listed = await f.store.list();
      assert.equal(listed.length, 1, `index body ${body}`);
      assert.equal(listed[0].id, f.board.id);
    }
  } finally {
    await f.cleanup();
  }
});

test('a done task written without a recorded run is loaded as-is and satisfies dependents', async () => {
  const f = await workspaceFixture([
    task('t1', [], 'done'),
    task('t2', ['t1']),
  ]);
  try {
    const loaded = await f.store.load(f.board.id);
    assert.equal(loaded.tasks[0].status, 'done');
    const runs: string[] = [];
    const result = await runTaskBoardLoop({
      ...f,
      verifyEnabled: false,
      runTurn: async () => { runs.push(f.session.taskRuntime!.activeTaskId!); return { ok: true, finalAnswer: 'TASK_DONE: ok' }; },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(runs, ['t2'], 'the illegal-leap task is not re-run');
  } finally {
    await f.cleanup();
  }
});

test('recovery leaves a live lease owner alone even when its graph is invalid', async () => {
  const f = await workspaceFixture([task('a', ['ghost'], 'in_progress')]);
  try {
    await f.store.writeLease(f.board.id, 'a');
    const before = await readFile(f.store.filePath(f.board.id), 'utf8');
    assert.deepEqual(await f.store.recoverInterrupted(), []);
    assert.equal(await readFile(f.store.filePath(f.board.id), 'utf8'), before);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Loop termination
// ---------------------------------------------------------------------------

test('an always-failing task stops the loop after one turn instead of retrying forever', async () => {
  const f = await workspaceFixture([task('a'), task('b', ['a'])]);
  let turns = 0;
  try {
    const result = await runTaskBoardLoop({
      ...f,
      verifyEnabled: false,
      runTurn: async () => { turns += 1; return { ok: false, reason: 'boom', hadTerminalFailure: true }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.equal(turns, 1);
    assert.equal(f.board.tasks[0].status, 'blocked');
    assert.equal(f.board.tasks[1].status, 'pending');
  } finally {
    await f.cleanup();
  }
});

test('an unclear completion is blocked, not looped', async () => {
  const f = await workspaceFixture([task('a')]);
  let turns = 0;
  try {
    const result = await runTaskBoardLoop({
      ...f,
      verifyEnabled: false,
      runTurn: async () => { turns += 1; return { ok: true, finalAnswer: 'still looking at it' }; },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(turns, 1);
  } finally {
    await f.cleanup();
  }
});

test('a pause between tasks stops the loop without re-running the finished task', async () => {
  const f = await workspaceFixture([task('a'), task('b', ['a']), task('c', ['b'])]);
  const runs: string[] = [];
  try {
    const result = await runTaskBoardLoop({
      ...f,
      verifyEnabled: false,
      runTurn: async () => {
        runs.push(f.session.taskRuntime!.activeTaskId!);
        f.session.taskRuntime = { ...f.session.taskRuntime!, mode: 'paused' };
        return { ok: true, finalAnswer: 'TASK_DONE: one' };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'active');
    assert.deepEqual(runs, ['a']);
    assert.equal(f.board.tasks[0].status, 'done');
    assert.equal(f.board.tasks[1].status, 'pending');
  } finally {
    await f.cleanup();
  }
});

test('the loop is bounded by maxTasks rather than by the board size', async () => {
  const f = await workspaceFixture([task('a'), task('b'), task('c'), task('d')]);
  const runs: string[] = [];
  try {
    const result = await runTaskBoardLoop({
      ...f,
      verifyEnabled: false,
      maxTasks: 2,
      runTurn: async () => {
        runs.push(f.session.taskRuntime!.activeTaskId!);
        return { ok: true, finalAnswer: 'TASK_DONE: ok' };
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /max task iterations/i);
    assert.equal(runs.length, 2);
    assert.equal(new Set(runs).size, 2, 'no task ran twice');
  } finally {
    await f.cleanup();
  }
});

test('cyclic and missing-dependency boards exit immediately', async () => {
  for (const tasks of [[task('a', ['b']), task('b', ['a'])], [task('a', ['ghost'])]]) {
    const f = await workspaceFixture(tasks);
    try {
      let turns = 0;
      const result = await runTaskBoardLoop({ ...f, runTurn: async () => { turns += 1; return { ok: true }; } });
      assert.equal(result.ok, false);
      assert.equal(turns, 0);
      assert.match(result.reason ?? '', /循环|cycle|不存在|ghost/);
    } finally {
      await f.cleanup();
    }
  }
});

test('a thrown turn settles the supervisor unit instead of leaving it running', async () => {
  const f = await workspaceFixture([task('a')]);
  try {
    const supervisor = new Supervisor();
    const runtime = {
      config: { workspaceRoot: f.root },
      tools: createDefaultToolRegistry(),
      allTools: createDefaultToolRegistry(),
      sessions: f.sessions,
      session: f.session,
      supervisor,
    } as unknown as AgentRuntime;
    const result = await runTaskBoardLoop({
      ...f,
      runtime,
      verifyEnabled: false,
      runTurn: async () => ({ ok: true, finalAnswer: 'no marker here' }),
    });
    assert.equal(result.status, 'blocked');
    const units = supervisor.snapshot().units.filter((unit) => unit.kind === 'task');
    assert.equal(units.length, 1);
    assert.equal(units[0].status, 'failed');
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Expert routing
// ---------------------------------------------------------------------------

test('expert ids are unique and selection is deterministic for empty, symbolic, CJK and English goals', () => {
  const ids = allExperts.map((expert) => expert.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate expert id');
  for (const goal of ['', '   ', '！！！', '运行', '修复登录', '提交代码', 'security review', 'Summarize this', '优化性能']) {
    const first = selectExpertForGoal(goal).id;
    for (let attempt = 0; attempt < 3; attempt += 1) assert.equal(selectExpertForGoal(goal).id, first, goal);
  }
});

test('experts that declare themselves read-only never receive write or delegation tools', () => {
  const tools = createDefaultToolRegistry().list();
  for (const expert of allExperts) {
    const declaresReadOnly = /read-only|without modifying|Do not write files/i.test(`${expert.description} ${expert.systemPrompt}`);
    if (!declaresReadOnly) continue;
    // Documented exception: performance measures with run_command despite the
    // "do not edit code" instruction.
    if (expert.id === 'performance') continue;
    const allowed = tools.filter((tool) => expert.toolFilter(tool));
    assert.deepEqual(allowed.filter((tool) => tool.risk !== 'read' && !tool.name.startsWith('fetch_url') && !tool.name.startsWith('web_search')).map((tool) => tool.name), [], expert.id);
    assert.deepEqual(allowed.filter((tool) => ['spawn_subagent', 'review_loop', 'workflow_execute'].includes(tool.name)).map((tool) => tool.name), [], expert.id);
  }
  assert.equal(codeReviewExpert.toolFilter({ name: 'run_command', risk: 'shell', description: '' }), false);
  assert.equal(expertById('code_review')?.id, 'code_review');
});

test('mixed read+write tasks route to an expert that can write', () => {
  const goals = [
    '读取并实现登录接口',
    '读一下并修复空指针',
    'Inspect the auth module and implement the login fix',
    'Review the code and update the retry policy',
  ];
  for (const goal of goals) {
    const task = { id: 't', title: goal, status: 'pending' as const, dependsOn: [] };
    const board: TaskBoard = { id: 'b', title: 'b', goal: 'g', status: 'active', tasks: [task], createdAt: '', updatedAt: '' };
    for (const profile of [selectExpertForGoal(goal), routeTaskToExpert({ task, board, workspaceRoot: '/tmp' }).profile]) {
      assert.equal(profile.toolFilter({ name: 'write_file', risk: 'write', description: '' }), true, `${goal} -> ${profile.id}`);
    }
  }
  // A pure read still goes to the read-only expert.
  assert.equal(selectExpertForGoal('检查代码的结构和调用关系').id, 'code_search');
  // An explicit read-only boundary wins over a negated write verb.
  assert.equal(selectExpertForGoal('只读检查代码，不要修改').id, 'code_search');
});

// ---------------------------------------------------------------------------
// 6. Completion detection
// ---------------------------------------------------------------------------

test('completion markers: Chinese affirmatives are done, negations are not', () => {
  const done = ['TASK_DONE: 修好了登录', '已完成', '完成了所有步骤', '任务已完成', '已修改并验证，完成了。', 'Done: refactored the parser'];
  for (const answer of done) {
    assert.equal(detectTaskCompletion({ ok: true, finalAnswer: answer, hadTerminalFailure: false }).status, 'done', answer);
  }
  const notDone = [
    'The task is not done yet, I still need to run tests',
    "I haven't finished, blocker: missing credentials",
    '还没完成，需要用户提供 API key',
    'Tests are failing, this is not completed',
    'Done: but actually blocked on permissions',
  ];
  for (const answer of notDone) {
    assert.notEqual(detectTaskCompletion({ ok: true, finalAnswer: answer, hadTerminalFailure: false }).status, 'done', answer);
  }
});

// ---------------------------------------------------------------------------
// 7. Workflow definitions and engine termination
// ---------------------------------------------------------------------------

function engineFor(workflow: ReturnType<typeof createFeatureWorkflow>, condition: boolean) {
  const ran: string[] = [];
  const engine = new WorkflowEngine(workflow, {
    executeNode: async (node) => { ran.push(node.id); return { success: true, summary: 'ok' }; },
    createCheckpoint: async () => ({ sha: 'abc12345', branch: 'main' }),
    evaluateCondition: async () => condition,
    evaluateGate: async () => ({ passed: true, value: 1 }),
  });
  return { engine, ran };
}

test('built-in templates and factory workflows run to completion on both branches', async () => {
  for (const key of Object.keys(WORKFLOW_TEMPLATES)) {
    const workflow = WorkflowBuilder.fromTemplate(key).build();
    assert.deepEqual(inspectWorkflowDependencies(workflow), [], key);
    for (const condition of [true, false]) {
      const { engine, ran } = engineFor(workflow, condition);
      const execution = await engine.run();
      assert.equal(execution.status, 'completed', `${key} cond=${condition}`);
      assert.ok(ran.length > 0);
      assert.equal(new Set(ran).size, ran.length, `${key} executed a node twice`);
    }
  }
  for (const factory of [createFeatureWorkflow, createBugfixWorkflow, createRefactorWorkflow]) {
    const workflow = factory('demo');
    assert.deepEqual(inspectWorkflowDependencies(workflow), [], factory.name);
    for (const condition of [true, false]) {
      const { engine } = engineFor(workflow, condition);
      assert.equal((await engine.run()).status, 'completed', factory.name);
    }
  }
});

test('self-referential and dangling workflows fail as blocked instead of completing', async () => {
  const definitions = [
    {
      id: 'w1', name: 'self', description: '', version: '1', entryNode: 'a', createdAt: '', updatedAt: '',
      nodes: [{ id: 'a', type: 'task' as const, title: 'A', dependsOn: ['a'], status: 'pending' as const }],
    },
    {
      id: 'w2', name: 'dangling', description: '', version: '1', entryNode: 'a', createdAt: '', updatedAt: '',
      nodes: [
        { id: 'a', type: 'task' as const, title: 'A', dependsOn: [], status: 'pending' as const },
        { id: 'b', type: 'task' as const, title: 'B', dependsOn: ['ghost'], status: 'pending' as const },
      ],
    },
  ];
  for (const workflow of definitions) {
    const engine = new WorkflowEngine(workflow, { executeNode: async () => ({ success: true, summary: 'ok' }) });
    await assert.rejects(() => engine.run(), /blocked/i, workflow.name);
    assert.ok((engine.getExecution().blockedNodes ?? []).length > 0, workflow.name);
  }
});

test('builder allocates contiguous ids so authored dependsOn references resolve', () => {
  const workflow = new WorkflowBuilder('ids')
    .addTask('one')
    .addCheckpoint('cp', { message: 'm', dependsOn: ['task_1'] })
    .addTask('two', { dependsOn: ['checkpoint_2'] })
    .addTask('three', { dependsOn: ['task_3'] })
    .build();
  assert.deepEqual(workflow.nodes.map((node) => node.id), ['task_1', 'checkpoint_2', 'task_3', 'task_4']);
  assert.deepEqual(workflow.nodes[1].dependsOn, ['task_1']);
  assert.deepEqual(workflow.nodes[3].dependsOn, ['task_3']);
});

/** Structural check mirroring Builder.build(), for workflow definitions made by factories. */
function inspectWorkflowDependencies(workflow: { nodes: Array<{ id: string; dependsOn: string[]; parallelNodes?: string[]; branches?: Array<{ nextNodes: string[] }>; defaultNext?: string[] }> }) {
  const ids = new Set(workflow.nodes.map((node) => node.id));
  const issues: string[] = [];
  if (ids.size !== workflow.nodes.length) issues.push('duplicate node id');
  for (const node of workflow.nodes) {
    const refs = [
      ...node.dependsOn,
      ...(node.parallelNodes ?? []),
      ...(node.defaultNext ?? []),
      ...(node.branches ?? []).flatMap((branch) => branch.nextNodes),
    ];
    for (const ref of refs) if (!ids.has(ref)) issues.push(`${node.id} -> ${ref}`);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 8. State helpers
// ---------------------------------------------------------------------------

test('markTaskBlocked and startTask tolerate boards whose in-progress task vanished', () => {
  const board = planBoardFromGoal('实现任务板');
  confirmBoard(board, '2026-01-01T00:00:00.000Z');
  startTask(board, 'task_1', '2026-01-01T00:00:01.000Z');
  assert.equal(board.tasks[0].status, 'in_progress');
  markTaskBlocked(board, 'task_1', 'boom', '2026-01-01T00:00:02.000Z');
  assert.equal(board.tasks[0].status, 'blocked');
  // Starting another task reopens the previous in-progress marker rather than
  // leaving two tasks running.
  startTask(board, 'task_2', '2026-01-01T00:00:03.000Z');
  assert.equal(board.tasks.filter((item) => item.status === 'in_progress').length, 1);
});
