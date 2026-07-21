import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionStore } from '../src/session/store.js';
import {
  buildRepairPrompt,
  discoverVerifyCommands,
  isVerifyTasksEnabled,
  runVerifySuite,
  type VerifyRunner,
} from '../src/tasks/verify.js';
import { runTaskBoardLoop } from '../src/tasks/runtime.js';
import { TaskBoardStore } from '../src/tasks/store.js';
import type { TaskBoard } from '../src/tasks/types.js';

async function tempWorkspace(name: string) {
  const root = await mkdtemp(join(tmpdir(), `aicode-${name}-`));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('isVerifyTasksEnabled respects disable flags', () => {
  assert.equal(isVerifyTasksEnabled({}), true);
  assert.equal(isVerifyTasksEnabled({ AICODE_VERIFY_TASKS: '0' }), false);
  assert.equal(isVerifyTasksEnabled({ AICODE_VERIFY_TASKS: 'false' }), false);
  assert.equal(isVerifyTasksEnabled({ AICODE_VERIFY_TASKS: '1' }), true);
});

test('discoverVerifyCommands finds typecheck test build scripts', async () => {
  const fixture = await tempWorkspace('verify-discover');
  try {
    await writeFile(join(fixture.root, 'package.json'), JSON.stringify({
      scripts: { typecheck: 'tsc -p tsconfig.json --noEmit', test: 'node --test', build: 'tsc -p tsconfig.json' },
    }), 'utf8');
    const commands = await discoverVerifyCommands(fixture.root);
    assert.deepEqual(commands.map((command) => command.name), ['typecheck', 'test', 'build']);
  } finally {
    await fixture.cleanup();
  }
});

test('runVerifySuite skips missing scripts and can pass empty suite', async () => {
  const fixture = await tempWorkspace('verify-empty');
  try {
    await writeFile(join(fixture.root, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
    const result = await runVerifySuite({ workspaceRoot: fixture.root, env: {} });
    assert.equal(result.ok, true);
    assert.ok(result.results.every((item) => item.status === 'skipped'));
  } finally {
    await fixture.cleanup();
  }
});

test('runVerifySuite fails on first nonzero command and truncates output', async () => {
  const fixture = await tempWorkspace('verify-fail');
  try {
    await writeFile(join(fixture.root, 'package.json'), JSON.stringify({
      scripts: { typecheck: 'tsc', test: 'node --test', build: 'tsc' },
    }), 'utf8');
    const runner: VerifyRunner = async (spec) => {
      if (spec.name === 'typecheck') return { exitCode: 0, output: 'typecheck ok' };
      if (spec.name === 'test') return { exitCode: 1, output: 'x'.repeat(20_000) };
      return { exitCode: 0, output: 'build ok' };
    };
    const result = await runVerifySuite({ workspaceRoot: fixture.root, runner, env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.failedAt, 'test');
    const failed = result.results.find((item) => item.name === 'test');
    assert.ok(failed);
    assert.ok((failed?.output.length ?? 0) < 20_000);
    assert.match(failed?.output ?? '', /truncated/i);
    assert.equal(result.results.some((item) => item.name === 'build' && item.status === 'passed'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('task board requires verification before done and repairs once', async () => {
  const fixture = await tempWorkspace('verify-loop');
  try {
    await writeFile(join(fixture.root, 'package.json'), JSON.stringify({
      scripts: { test: 'node --test' },
    }), 'utf8');
    const sessions = new SessionStore(join(fixture.root, 'sessions'));
    const session = await sessions.create({ provider: 'mock', model: 'm', workspaceRoot: fixture.root });
    const store = new TaskBoardStore(fixture.root);
    const board: TaskBoard = {
      id: 'board_verify_1',
      title: 'verify',
      goal: 'ship feature',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      tasks: [{
        id: 'task_1',
        title: 'implement',
        status: 'pending',
        dependsOn: [],
      }],
    };
    await store.save(board);

    let turns = 0;
    let verifyCalls = 0;
    const runner: VerifyRunner = async () => {
      verifyCalls += 1;
      if (verifyCalls === 1) return { exitCode: 1, output: 'FAIL once' };
      return { exitCode: 0, output: 'PASS' };
    };

    // Monkey-patch via dynamic import path is hard; call loop with injected verify by temporary env disable? 
    // Instead exercise runtime after integration using options if present.
    const loop = await runTaskBoardLoop({
      board,
      store,
      sessions,
      session,
      runTurn: async () => {
        turns += 1;
        return { ok: true, finalAnswer: `TASK_DONE: fixed attempt ${turns}` };
      },
      verifyRunner: runner,
      onInfo: () => undefined,
    });

    assert.equal(loop.ok, true);
    assert.equal(board.tasks[0]?.status, 'done');
    assert.match(board.tasks[0]?.resultSummary ?? '', /verified/i);
    assert.equal(turns, 2);
    assert.equal(verifyCalls, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('buildRepairPrompt includes failed verification output', () => {
  const prompt = buildRepairPrompt(
    { id: 'task_1', title: 'Add feature', status: 'in_progress', dependsOn: [] },
    {
      ok: false,
      failedAt: 'test',
      summary: 'Verification failed at test: exit code 1',
      results: [{
        name: 'test',
        command: 'npm test',
        status: 'failed',
        exitCode: 1,
        durationMs: 10,
        output: 'AssertionError: expected true',
        reason: 'exit code 1',
      }],
    },
  );
  assert.match(prompt, /npm test/);
  assert.match(prompt, /AssertionError/);
  assert.match(prompt, /TASK_DONE/);
});
