import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntime } from '../src/agent/agent.js';
import { taskBoardEventPayload } from '../src/cli/desktopBridge.js';
import { runPromptMode } from '../src/cli/repl.js';
import { createMockProvider } from '../src/providers/mock.js';
import { SessionStore } from '../src/session/store.js';
import { PLANNING_TURN_INSTRUCTION, PLANNING_TURN_MAX_STEPS, planBoardFromModel } from '../src/tasks/planner.js';
import { validateProposePlanInput } from '../src/tasks/proposeTool.js';
import { TaskBoardStore } from '../src/tasks/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';

const LARGE_GOAL = '分步实现项目任务板：规划、确认、自动执行、失败恢复';

function proposal() {
  return {
    title: '任务板规划落地',
    planMarkdown: [
      '## 目标',
      '把大任务的规划权交给模型，产出可审批的计划书。',
      '',
      '## 关键改动',
      '- `src/tasks/proposeTool.ts`：新增 propose_plan 工具',
      '- `src/cli/repl.ts`：大任务先跑规划轮',
      '',
      '## 风险',
      '模型可能不调用工具，需要回退模板。',
    ].join('\n'),
    tasks: [
      { id: 'tool', title: '实现 propose_plan 工具', acceptance: '工具落盘并置为待批准', dependsOn: [] },
      { id: 'wiring', title: '接上规划轮', acceptance: '大任务走规划轮', dependsOn: ['tool'] },
    ],
  };
}

/**
 * A provider that calls propose_plan once and then stops, so the planning turn
 * ends the way a real one does. Later calls answer TASK_DONE, which is what the
 * task loop needs to close out a step when --confirm-plan runs the board.
 */
function planningProvider() {
  let calls = 0;
  return {
    name: 'mock' as const,
    model: 'mock',
    async complete() {
      calls += 1;
      if (calls === 1) {
        return { actions: [{ type: 'tool' as const, tool: 'propose_plan', input: proposal(), callId: 'p1' }] };
      }
      return { actions: [{ type: 'message' as const, content: 'TASK_DONE: 计划已提交。' }] };
    },
  };
}

/** A provider that never plans — the fallback path. */
function noPlanProvider() {
  return {
    name: 'mock' as const,
    model: 'mock',
    async complete() {
      return { actions: [{ type: 'message' as const, content: '我直接开始做了。' }] };
    },
  };
}

async function makeRuntime(workspace: string, provider: AgentRuntime['provider']) {
  const sessionDir = join(workspace, 'sessions');
  const sessions = new SessionStore(sessionDir);
  const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
  const runtime: AgentRuntime = {
    config: {
      provider: 'mock' as const,
      model: 'mock-code-agent-v1',
      approval: 'auto' as const,
      workspaceRoot: workspace,
      sessionDir,
      maxSteps: 6,
      noBanner: true,
      confirmPlan: false,
    },
    provider: provider as unknown as AgentRuntime['provider'],
    tools: createDefaultToolRegistry(),
    sessions,
    session,
    ui: new TerminalUI(true),
  };
  return { runtime, sessions, session };
}

test('planBoardFromModel keeps the model prose and its own steps', () => {
  const board = planBoardFromModel(LARGE_GOAL, proposal());
  assert.equal(board.status, 'draft');
  assert.equal(board.goal, LARGE_GOAL);
  assert.match(board.planMarkdown ?? '', /## 目标/);
  assert.equal(board.tasks.length, 2);
  assert.deepEqual(board.tasks[0].dependsOn, []);
  assert.deepEqual(board.tasks[1].dependsOn, ['tool']);
  assert.equal(board.tasks[0].acceptance, '工具落盘并置为待批准');
});

test('planBoardFromModel refuses missing and self references rather than silently dropping them', () => {
  assert.throws(() => planBoardFromModel(LARGE_GOAL, {
    planMarkdown: 'body',
    tasks: [
      { id: 'a', title: 'A', dependsOn: ['ghost', 'a'] },
      { title: 'B', dependsOn: ['a'] },
    ],
  }), /依赖/);
});

test('planBoardFromModel rejects ambiguous repeated explicit ids', () => {
  assert.throws(() => planBoardFromModel(LARGE_GOAL, {
    planMarkdown: 'body',
    tasks: [
      { id: 'dup', title: 'A' },
      { id: 'dup', title: 'B' },
    ],
  }), /编号重复/);
});

test('validateProposePlanInput rejects a plan with no body or no steps', () => {
  assert.throws(() => validateProposePlanInput({ tasks: [{ title: 'x' }] }), /planMarkdown/);
  assert.throws(() => validateProposePlanInput({ planMarkdown: 'x', tasks: [] }), /at least one step/);
  assert.throws(() => validateProposePlanInput({ planMarkdown: 'x', tasks: [{ title: '  ' }] }), /title/);
  assert.throws(() => validateProposePlanInput({ planMarkdown: 'x', tasks: 'nope' }), /must be an array/);
});

test('a planning turn persists the model plan and parks on awaiting_confirm', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-propose-'));
  try {
    const { runtime, session } = await makeRuntime(workspace, planningProvider());
    const result = await runPromptMode(runtime, LARGE_GOAL);
    assert.equal(result.ok, true);

    const store = new TaskBoardStore(workspace);
    const boards = await store.list();
    assert.equal(boards.length, 1, 'exactly one board: the planning turn must not also draft a template board');
    const board = await store.load(boards[0].id);
    assert.match(board.planMarkdown ?? '', /## 关键改动/);
    assert.equal(board.title, '任务板规划落地');
    assert.equal(board.goal, LARGE_GOAL, 'the goal is the user request, not the planning instruction');
    assert.equal(board.status, 'draft');
    assert.equal(board.tasks.length, 2);
    assert.equal(session.taskRuntime?.boardId, board.id);
    assert.equal(session.taskRuntime?.mode, 'awaiting_confirm');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a model that does not plan falls back to the template board', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-noplan-'));
  try {
    const { runtime, session } = await makeRuntime(workspace, noPlanProvider());
    const result = await runPromptMode(runtime, LARGE_GOAL);
    assert.equal(result.ok, true);

    const store = new TaskBoardStore(workspace);
    const boards = await store.list();
    assert.equal(boards.length, 1);
    const board = await store.load(boards[0].id);
    assert.equal(board.planMarkdown, undefined, 'template boards carry no plan document');
    assert.equal(board.goal, LARGE_GOAL);
    assert.equal(session.taskRuntime?.mode, 'awaiting_confirm');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('the planning instruction never reaches a non-planning turn', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-planleak-'));
  try {
    const seen: string[] = [];
    const provider = {
      name: 'mock' as const,
      model: 'mock',
      async complete(request: { messages: Array<{ role: string; content: string }> }) {
        seen.push(...request.messages.filter((m) => m.role === 'user').map((m) => m.content));
        return { actions: [{ type: 'message' as const, content: 'ok' }] };
      },
    };
    const { runtime } = await makeRuntime(workspace, provider);
    // A small ask: no task board, therefore no planning instruction.
    await runPromptMode(runtime, '现在几点');
    assert.equal(seen.some((content) => content.includes('<planning-turn>')), false);
    assert.equal(runtime.planGoal, undefined, 'the planning marker must not survive the turn');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a planning turn carries the instruction and clears it afterwards', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-planinstr-'));
  try {
    const seen: string[] = [];
    const provider = {
      name: 'mock' as const,
      model: 'mock',
      async complete(request: { messages: Array<{ role: string; content: string }> }) {
        seen.push(...request.messages.filter((m) => m.role === 'user').map((m) => m.content));
        return { actions: [{ type: 'message' as const, content: 'ok' }] };
      },
    };
    const { runtime } = await makeRuntime(workspace, provider);
    await runPromptMode(runtime, LARGE_GOAL);
    assert.ok(
      seen.some((content) => content.includes(PLANNING_TURN_INSTRUCTION)),
      'the planning turn must tell the model to plan',
    );
    assert.equal(runtime.planGoal, undefined);
    assert.equal(runtime.planProposed, undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('re-proposing replaces the session draft board instead of adding a second one', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-repropose-'));
  try {
    let call = 0;
    const provider = {
      name: 'mock' as const,
      model: 'mock',
      async complete() {
        call += 1;
        if (call % 2 === 1) {
          const next = proposal();
          next.title = `第 ${call} 版计划`;
          return { actions: [{ type: 'tool' as const, tool: 'propose_plan', input: next, callId: `p${call}` }] };
        }
        return { actions: [{ type: 'message' as const, content: '已更新计划。' }] };
      },
    };
    const { runtime, session } = await makeRuntime(workspace, provider);
    await runPromptMode(runtime, LARGE_GOAL);
    const firstBoardId = session.taskRuntime?.boardId;
    await runPromptMode(runtime, LARGE_GOAL);

    const store = new TaskBoardStore(workspace);
    const boards = await store.list();
    assert.equal(boards.length, 1, 'a revised plan must not leave a stale second card');
    assert.equal(session.taskRuntime?.boardId, firstBoardId);
    const board = await store.load(boards[0].id);
    assert.equal(board.title, '第 3 版计划');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('the desktop bridge emits the plan document and both board id keys', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-planemit-'));
  try {
    const { runtime } = await makeRuntime(workspace, planningProvider());
    const boards: unknown[] = [];
    runtime.taskBoardEmit = (board) => boards.push(board);
    await runPromptMode(runtime, LARGE_GOAL);
    assert.equal(boards.length, 1);

    const payload = taskBoardEventPayload(boards[0] as never, { sessionId: 'sess_x', runtimeMode: 'awaiting_confirm' });
    assert.match(String(payload.planMarkdown), /## 目标/);
    assert.ok(typeof payload.id === 'string' && payload.id.length > 0);
    assert.equal(payload.id, payload.boardId);
    assert.equal(payload.runtimeMode, 'awaiting_confirm');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('taskBoardEventPayload tolerates a board with no plan or tasks', () => {
  const payload = taskBoardEventPayload({ id: 'b1' }, { sessionId: 's', runtimeMode: 'idle' });
  assert.equal(payload.id, 'b1');
  assert.equal(payload.planMarkdown, undefined);
  assert.deepEqual(payload.tasks, []);
  assert.equal(payload.activeTaskId, undefined);
});

test('confirmPlan confirms and runs a model-proposed plan instead of stopping at the draft', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-planauto-'));
  try {
    const { runtime, session } = await makeRuntime(workspace, planningProvider());
    runtime.config.confirmPlan = true;
    const result = await runPromptMode(runtime, LARGE_GOAL);
    assert.equal(result.ok, true);

    const store = new TaskBoardStore(workspace);
    const boards = await store.list();
    assert.equal(boards.length, 1);
    const board = await store.load(boards[0].id);
    assert.match(board.planMarkdown ?? '', /## 目标/);
    // The whole point of --confirm-plan: no approval stop.
    assert.notEqual(board.status, 'draft');
    assert.ok(board.confirmedAt, 'the board must carry a confirmation timestamp');
    // The loop ran the steps to completion, which parks the runtime back on
    // 'idle' — anything still awaiting confirmation would have left it there.
    assert.notEqual(session.taskRuntime?.mode, 'awaiting_confirm');
    assert.ok(board.tasks.every((task) => task.status !== 'pending'));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

/*
 * The step cap is what makes "the model writes the plan" a guarantee rather
 * than a hope. A model that ignores the opening instruction and keeps reading
 * must still be cut off inside the planning turn and nudged into proposing.
 */
test('a planning turn that only explores is cut off and nudged into proposing', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-planbudget-'));
  try {
    let calls = 0;
    let sawFinalCall = false;
    const provider = {
      name: 'mock' as const,
      model: 'mock',
      async complete(request: { messages: Array<{ role: string; content: string }> }) {
        calls += 1;
        if (request.messages.some((m) => m.content.includes('<planning-turn-final-call>'))) {
          sawFinalCall = true;
          return { actions: [{ type: 'tool' as const, tool: 'propose_plan', input: proposal(), callId: 'p-final' }] };
        }
        // First response opens the turn; everything after is another read.
        return { actions: [{ type: 'tool' as const, tool: 'list_files', input: { pattern: 'src/**/*.ts' }, callId: `c${calls}` }] };
      },
    };
    const { runtime } = await makeRuntime(workspace, provider);
    // A budget well above the planning cap: without the cap this turn would run
    // all 20 steps, so the assertion below is about the cap and not about
    // maxSteps happening to be small.
    runtime.config.maxSteps = 20;
    await runPromptMode(runtime, LARGE_GOAL);

    assert.ok(sawFinalCall, 'the last budgeted step must carry the final-call nudge');
    assert.ok(calls <= PLANNING_TURN_MAX_STEPS, `planning turn spent ${calls} steps, over the ${PLANNING_TURN_MAX_STEPS} cap`);

    const store = new TaskBoardStore(workspace);
    const boards = await store.list();
    assert.equal(boards.length, 1);
    const board = await store.load(boards[0].id);
    assert.match(board.planMarkdown ?? '', /## 目标/, 'the cut-off turn must still produce the model plan, not the template');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a planning turn stops early once the model proposes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-planearly-'));
  try {
    let calls = 0;
    const provider = {
      name: 'mock' as const,
      model: 'mock',
      async complete() {
        calls += 1;
        if (calls === 1) {
          return { actions: [{ type: 'tool' as const, tool: 'propose_plan', input: proposal(), callId: 'p1' }] };
        }
        return { actions: [{ type: 'message' as const, content: '计划已提交。' }] };
      },
    };
    const { runtime } = await makeRuntime(workspace, provider);
    await runPromptMode(runtime, LARGE_GOAL);
    assert.ok(calls <= 3, `a prompt proposal must not burn the budget: ${calls} model calls`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

/*
 * Prose alone was not enough. A model mid-survey treats "stop reading and
 * propose" as one more thing to investigate, so the last budgeted step must
 * withdraw the read tools: propose_plan is then the only tool offered, and a
 * stale tool name is refused instead of executed.
 */
test('the last planning step offers propose_plan as the only tool', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-planwithdraw-'));
  try {
    const offered: string[][] = [];
    let calls = 0;
    const provider = {
      name: 'mock' as const,
      model: 'mock',
      async complete(request: { messages: Array<{ role: string; content: string }>; tools: Array<{ name: string }> }) {
        calls += 1;
        offered.push(request.tools.map((t) => t.name));
        // A distinct pattern each time: an identical call would be caught by the
        // duplicate-tool guard and never reach the withdrawal check under test.
        return { actions: [{ type: 'tool' as const, tool: 'list_files', input: { pattern: `src/${calls}/**` }, callId: `c${calls}` }] };
      },
    };
    const { runtime } = await makeRuntime(workspace, provider);
    runtime.config.maxSteps = 20;
    await runPromptMode(runtime, LARGE_GOAL);

    assert.ok(offered.length > 0);
    // Every step before the last keeps the real toolset.
    assert.ok(offered[0].includes('list_files'), 'the survey must start with the read tools');
    const last = offered[offered.length - 1];
    assert.deepEqual(last, ['propose_plan'], `the final step must offer only propose_plan, got: ${last.join(', ')}`);

    // The withdrawn call was refused, not executed.
    const session = runtime.session;
    const refused = session.messages.filter((m) => m.role === 'tool' && m.name === 'list_files' && String(m.content).includes('不可用'));
    assert.ok(refused.length > 0, 'a stale read on the final step must be refused');
    // And the turn still fell back to the template board rather than hanging.
    const boards = await new TaskBoardStore(workspace).list();
    assert.equal(boards.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('propose_plan refuses to run inside a sub-agent', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-plansub-'));
  try {
    const { runtime } = await makeRuntime(workspace, createMockProvider() as never);
    const { createProposePlanTool } = await import('../src/tasks/proposeTool.js');
    const tool = createProposePlanTool({ ...runtime, subAgentDepth: 1 });
    const result = await tool.execute(proposal() as never, { workspaceRoot: workspace, approval: 'auto' });
    assert.equal(result.ok, false);
    assert.match(result.output, /只能由主智能体调用/);
    const store = new TaskBoardStore(workspace);
    assert.equal((await store.list()).length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
