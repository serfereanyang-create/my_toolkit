import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntime } from '../src/agent/agent.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';
import { GitProcess } from '../src/git-safety/git.js';
import {
  MAX_SUBAGENT_SEGMENTS,
  formatHandoff,
  isBudgetStop,
  runSubAgentWithRollover,
} from '../src/subagent/rollover.js';
import {
  buildPrBody,
  buildPrTitle,
  classifyGhFailure,
  prepareBoardPr,
} from '../src/git-safety/pullRequest.js';
import type { TaskBoard } from '../src/tasks/types.js';

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
      noBanner: true,
    },
    provider,
    tools: createDefaultToolRegistry(),
    sessions,
    session,
    ui: new TerminalUI(true),
  };
  return { runtime, sessions, session };
}

/*
 * "超过了就新开": a segment that exhausts its step budget starts a NEW session
 * carrying a handoff summary, instead of failing the whole sub-agent.
 */
test('a segment that exhausts its steps rolls over into a new session', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-rollover-'));
  try {
    let calls = 0;
    const provider = {
      name: 'mock' as const,
      model: 'mock',
      async complete() {
        calls += 1;
        // Segment 1 burns its budget; segment 2 (call 4 onward) finishes.
        if (calls <= 3) {
          return { actions: [{ type: 'tool' as const, tool: 'list_files', input: { pattern: `src/${calls}/**` }, callId: `c${calls}` }] };
        }
        return { actions: [{ type: 'message' as const, content: 'TASK_DONE: 交接后完成' }] };
      },
    };
    const { runtime } = await makeRuntime(workspace, provider);

    const segmentSessions: string[] = [];
    const outcome = await runSubAgentWithRollover(
      runtime,
      async () => {
        const session = await runtime.sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
        segmentSessions.push(session.id);
        return {
          runtime: { ...runtime, session, config: { ...runtime.config, maxSteps: 3 } },
          sessionId: session.id,
        };
      },
      { segmentSteps: 3, buildGoal: (segment, handoff) => `goal seg${segment}${handoff ? ' +handoff' : ''}` },
    );

    assert.equal(outcome.ok, true, `expected success after rollover, got: ${outcome.answer}`);
    assert.equal(outcome.segments.length, 2, 'the first segment must have rolled over');
    assert.equal(segmentSessions.length, 2);
    assert.notEqual(segmentSessions[0], segmentSessions[1], 'each segment must get its own session');
    assert.equal(outcome.exhausted, false);
    assert.ok(outcome.steps >= 3, `steps must accumulate across segments, got ${outcome.steps}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('rollover stops at the segment cap instead of looping forever', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-rollovercap-'));
  try {
    let calls = 0;
    const provider = {
      name: 'mock' as const,
      model: 'mock',
      async complete() {
        calls += 1;
        // Never finishes: always another read.
        return { actions: [{ type: 'tool' as const, tool: 'list_files', input: { pattern: `src/${calls}/**` }, callId: `c${calls}` }] };
      },
    };
    const { runtime } = await makeRuntime(workspace, provider);

    const outcome = await runSubAgentWithRollover(
      runtime,
      async () => {
        const session = await runtime.sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
        return { runtime: { ...runtime, session, config: { ...runtime.config, maxSteps: 2 } }, sessionId: session.id };
      },
      { segmentSteps: 2, buildGoal: () => 'goal' },
    );

    assert.equal(outcome.ok, false);
    assert.equal(outcome.exhausted, true, 'running out of segments must be reported, not hidden');
    assert.equal(outcome.segments.length, MAX_SUBAGENT_SEGMENTS);
    assert.match(outcome.answer, /段/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

/*
 * Only a budget stop is worth rolling over. A real error would repeat verbatim in
 * a fresh session, so burning the remaining segments on it is pure waste.
 */
test('a non-budget failure is returned immediately, without rolling over', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-rollovererr-'));
  try {
    const provider = {
      name: 'mock' as const,
      model: 'mock',
      async complete(): Promise<never> {
        throw new Error('provider exploded');
      },
    };
    const { runtime } = await makeRuntime(workspace, provider);

    let segmentsCreated = 0;
    const outcome = await runSubAgentWithRollover(
      runtime,
      async () => {
        segmentsCreated += 1;
        const session = await runtime.sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
        return { runtime: { ...runtime, session, config: { ...runtime.config, maxSteps: 2 } }, sessionId: session.id };
      },
      { segmentSteps: 2, buildGoal: () => 'goal' },
    );

    assert.equal(outcome.ok, false);
    assert.equal(outcome.exhausted, false, 'an error must not be reported as budget exhaustion');
    assert.equal(segmentsCreated, 1, 'a real error must not burn the remaining segments');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('isBudgetStop recognizes exactly the two budget messages', () => {
  assert.equal(isBudgetStop('Stopped after reaching max steps (3).'), true);
  assert.equal(isBudgetStop('Stopped after reaching the token budget (2000 tokens).'), true);
  assert.equal(isBudgetStop('provider exploded'), false);
  assert.equal(isBudgetStop(undefined), false);
});

test('formatHandoff injects nothing into the first segment', () => {
  assert.equal(formatHandoff(1, 'whatever'), '');
  assert.equal(formatHandoff(2, undefined), '');
  const block = formatHandoff(2, '上一段做到一半');
  assert.match(block, /第 2 段/);
  assert.match(block, /上一段做到一半/);
  // It must tell the model not to redo finished work — that is the whole point.
  assert.match(block, /不要重复/);
});

function board(overrides: Partial<TaskBoard> = {}): TaskBoard {
  return {
    id: 'board_1',
    title: '重构 tasks 模块',
    goal: '把 tasks 模块拆清楚',
    status: 'completed',
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    tasks: [
      { id: 'task_1', title: '拆 planner', status: 'done', dependsOn: [], resultSummary: '已拆' },
      { id: 'task_2', title: '补测试', status: 'blocked', dependsOn: ['task_1'], error: '工具失败' },
    ],
    ...overrides,
  };
}

test('buildPrTitle keeps a long title within 72 chars', () => {
  // Long enough to actually cross the limit — the previous fixture was 43 chars
  // and so passed without exercising the truncation at all.
  const long = '重构'.repeat(60);
  assert.ok(long.length > 72);
  const title = buildPrTitle(board({ title: long }));
  assert.ok(title.length <= 72, `title too long: ${title.length}`);
  assert.ok(title.endsWith('...'));
});

test('buildPrTitle keeps a short title verbatim', () => {
  assert.equal(buildPrTitle(board({ title: '短标题' })), '短标题');
});

test('buildPrBody lists done and blocked tasks separately', () => {
  const body = buildPrBody(board());
  assert.match(body, /## 目标/);
  assert.match(body, /把 tasks 模块拆清楚/);
  assert.match(body, /task_1.*拆 planner.*已拆/);
  assert.match(body, /## 未完成/);
  assert.match(body, /task_2.*工具失败/);
});

test('buildPrBody includes the plan when the model wrote one', () => {
  const body = buildPrBody(board({ planMarkdown: '## 我的计划\n\n先做 A 再做 B' }));
  assert.match(body, /## 计划/);
  assert.match(body, /先做 A 再做 B/);
});

test('classifyGhFailure turns each common cause into an actionable fix', () => {
  assert.equal(classifyGhFailure('ENOENT').blocker, 'gh-missing');
  assert.match(classifyGhFailure('ENOENT').detail, /cli\.github\.com/);
  assert.equal(classifyGhFailure('gh: not logged in to any hosts').blocker, 'gh-unauthenticated');
  assert.match(classifyGhFailure('not logged in').detail, /gh auth login/);
  assert.equal(classifyGhFailure('some other thing').blocker, 'unknown');
});

/*
 * A repo with no remote is the normal state on this machine, and it must be
 * reported as its own cause — not as gh's confusing "not a git repository".
 */
test('prepareBoardPr reports no-remote before trying gh', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-noremote-'));
  try {
    const git = new GitProcess(workspace);
    await git.text(['init']);
    await git.text(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);

    const prepared = await prepareBoardPr({ git, board: board() });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.blocker, 'no-remote');
    assert.match(prepared.detail ?? '', /git remote add origin/);
    // The content is still prepared even when it cannot be opened.
    assert.match(prepared.title, /重构 tasks 模块/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('prepareBoardPr reports no-commits when the branch is level with the base', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-nocommits-'));
  try {
    const git = new GitProcess(workspace);
    await git.text(['init', '-b', 'main']);
    await git.text(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
    // A remote that is never fetched: `git remote` succeeds, rev-list works.
    await git.text(['remote', 'add', 'origin', 'https://example.invalid/x.git']);

    const prepared = await prepareBoardPr({ git, board: board(), base: 'main' });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.blocker, 'no-commits');
    assert.match(prepared.detail ?? '', /没有内容可以开 PR/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('prepareBoardPr succeeds once the branch is ahead of the base', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-ahead-'));
  try {
    const git = new GitProcess(workspace);
    await git.text(['init', '-b', 'main']);
    await git.text(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
    await git.text(['remote', 'add', 'origin', 'https://example.invalid/x.git']);
    await git.text(['checkout', '-b', 'feature']);
    await git.text(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'work']);

    const prepared = await prepareBoardPr({ git, board: board(), base: 'main' });
    assert.equal(prepared.ok, true, `expected ok, blocker=${prepared.blocker} ${prepared.detail ?? ''}`);
    assert.equal(prepared.commitCount, 1);
    assert.equal(prepared.branch, 'feature');
    assert.equal(prepared.base, 'main');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
