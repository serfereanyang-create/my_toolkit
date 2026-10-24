import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, realpath, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { test } from 'node:test';
import { SessionStore } from '../src/session/store.js';
import { TaskBoardStore } from '../src/tasks/store.js';
import { runTaskBoardLoop } from '../src/tasks/runtime.js';
import { runVerifySuite } from '../src/tasks/verify.js';
import type { TaskBoard, TaskItem } from '../src/tasks/types.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'yoy-verify-evidence-'));
  const sessions = new SessionStore(join(root, 'sessions'));
  const session = await sessions.create({ provider: 'mock', model: 'fixture', workspaceRoot: root });
  const store = new TaskBoardStore(root);
  const board: TaskBoard = { id: 'board_evidence', title: 'Verification evidence', goal: 'Preserve verification outcomes', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [{ id: 'task_1', title: 'Implement sample', status: 'pending', dependsOn: [] }] };
  await store.save(board);
  const cleanup = async () => { const target = await realpath(root); const inside = relative(await realpath(tmpdir()), target); assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside)); await rm(target, { recursive: true, force: true }); };
  return { root, sessions, session, store, board, cleanup };
}

test('a task with no runnable checks never claims it was verified', async () => {
  const f = await fixture();
  try {
    const result = await runTaskBoardLoop({ ...f, runTurn: async () => ({ ok: true, finalAnswer: 'TASK_DONE: candidate' }) });
    assert.equal(result.ok, true);
    assert.doesNotMatch(f.board.tasks[0].resultSummary ?? '', /\[verified/i);
    assert.match(f.board.tasks[0].resultSummary ?? '', /verification skipped/i);
  } finally { await f.cleanup(); }
});

test('a malformed package manifest is a verification error rather than missing scripts', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'package.json'), '{ invalid manifest');
    const result = await runVerifySuite({ workspaceRoot: f.root, env: {} });
    assert.equal(result.ok, false);
    assert.match(result.summary, /configuration/i);
  } finally { await f.cleanup(); }
});

test('a repair cannot pass by deleting the script whose verification failed', async () => {
  const f = await fixture(); let turns = 0;
  try {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'fixture' } }));
    const result = await runTaskBoardLoop({ ...f, runTurn: async () => {
      turns += 1;
      if (turns === 2) await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { build: 'unrelated passing script' } }));
      return { ok: true, finalAnswer: 'TASK_DONE: candidate' };
    }, verifyRunner: async spec => ({ exitCode: spec.name === 'test' ? 1 : 0, output: spec.name === 'test' ? 'original failure must remain' : 'unrelated check passed' }) });
    assert.equal(result.ok, false);
    assert.equal(f.board.tasks[0].status, 'blocked');
    assert.equal(f.board.tasks[0].verification?.at(-1)?.status, 'incomplete');
    assert.equal(turns, 2);
  } finally { await f.cleanup(); }
});

test('disabled verification is recorded as skipped and does not call the runner', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const result = await runTaskBoardLoop({ ...f, verifyEnabled: false, runTurn: async () => ({ ok: true, finalAnswer: 'TASK_DONE: candidate' }), verifyRunner: async () => { calls += 1; return { exitCode: 0, output: 'must not run' }; } });
    assert.equal(result.ok, true); assert.equal(calls, 0);
    assert.equal(f.board.tasks[0].verification?.[0].status, 'skipped');
    assert.doesNotMatch(f.board.tasks[0].resultSummary ?? '', /\[verified/);
  } finally { await f.cleanup(); }
});

test('malformed script fields fail configuration validation before spawning any process', async () => {
  const f = await fixture(); let calls = 0;
  try {
    for (const scripts of [null, [], { test: 12 }, { test: '' }, { build: {} }]) {
      await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts }));
      const result = await runVerifySuite({ workspaceRoot: f.root, runner: async () => { calls += 1; return { exitCode: 0, output: '' }; }, env: {} });
      assert.equal(result.ok, false); assert.equal(result.failedAt, 'configuration');
    }
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test('terminal failure remains blocked after one repair and retains both failing attempts', async () => {
  const f = await fixture(); let turns = 0;
  try {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'fixture' } }));
    const result = await runTaskBoardLoop({ ...f, runTurn: async () => { turns += 1; return { ok: true, finalAnswer: 'TASK_DONE: candidate' }; }, verifyRunner: async () => ({ exitCode: 1, output: 'persistent failure' }) });
    assert.equal(result.ok, false); assert.equal(turns, 2);
    assert.deepEqual(f.board.tasks[0].verification?.map(attempt => attempt.status), ['failed', 'failed']);
    assert.equal(f.board.tasks[0].status, 'blocked');
  } finally { await f.cleanup(); }
});

test('cancelling real verification stores its partial output and terminal cancellation state', async () => {
  const f = await fixture(); const controller = new AbortController();
  try {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'node partial.cjs' } }));
    await writeFile(join(f.root, 'partial.cjs'), "const fs=require('node:fs');console.log('partial verification output');fs.writeFileSync('started','yes');setInterval(()=>{},1000);");
    const running = runTaskBoardLoop({ ...f, signal: controller.signal, runTurn: async () => ({ ok: true, finalAnswer: 'TASK_DONE: candidate' }) });
    const deadline = Date.now() + 8000;
    while (true) {
      try { await access(join(f.root, 'started')); break; }
      catch { if (Date.now() > deadline) { controller.abort(); await running; assert.fail('real verifier did not start'); } await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    controller.abort(); assert.equal((await running).outcome, 'cancelled');
    const task = (await f.store.load(f.board.id)).tasks[0];
    assert.equal(task.verification?.[0].status, 'cancelled');
    const cancelled = task.verification?.[0].results.find(check => check.status === 'cancelled');
    assert.ok(cancelled); assert.match(cancelled.output, /partial verification output/);
  } finally { controller.abort(); await f.cleanup(); }
});

test('failed and repaired outputs persist together after reloading the board', async () => {
  const f = await fixture(); let checks = 0;
  try {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'fixture' } }));
    const result = await runTaskBoardLoop({ ...f, runTurn: async () => ({ ok: true, finalAnswer: 'TASK_DONE: candidate' }), verifyRunner: async () => ++checks === 1 ? { exitCode: 1, output: 'original failing evidence' } : { exitCode: 0, output: 'repaired passing evidence' } });
    assert.equal(result.ok, true);
    const task = (await f.store.load(f.board.id)).tasks[0] as TaskItem & { verification?: Array<{ status: string; results: Array<{ status: string; output: string }> }> };
    assert.equal(task.verification?.length, 2);
    assert.deepEqual(task.verification?.map(attempt => attempt.status), ['failed', 'passed']);
    assert.ok(task.verification?.[0].results.some(check => check.output === 'original failing evidence'));
    assert.ok(task.verification?.[1].results.some(check => check.output === 'repaired passing evidence'));
    assert.match(await readFile(f.store.filePath(f.board.id), 'utf8'), /original failing evidence/);
  } finally { await f.cleanup(); }
});
