import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, writeFile, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { test } from 'node:test';
import { SessionStore } from '../src/session/store.js';
import { TaskBoardStore } from '../src/tasks/store.js';
import { runTaskBoardLoop, nextRunnableTask } from '../src/tasks/runtime.js';
import type { TaskBoard } from '../src/tasks/types.js';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import { runAgentTurn } from '../src/agent/agent.js';
import { runVerifySuite } from '../src/tasks/verify.js';
import type { GitSafetyService } from '../src/git-safety/service.js';
import type { GitUnitContext, GitUnitOutcome } from '../src/git-safety/types.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aicode-task-cancel-'));
  const sessions = new SessionStore(join(root, 'sessions'));
  const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: root });
  const board: TaskBoard = { id: 'board_cancel', title: 'cancel', goal: 'cancel current task', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), tasks: [{ id: 'task_1', title: 'long task', status: 'pending', dependsOn: [] }, { id: 'task_2', title: 'after', status: 'pending', dependsOn: ['task_1'] }] };
  const store = new TaskBoardStore(root); await store.save(board);
  const cleanup = async () => { const resolved = await realpath(root); const inside = relative(await realpath(tmpdir()), resolved); assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside)); await rm(resolved, { recursive: true, force: true }); };
  return { root, sessions, session, board, store, cleanup };
}

test('cancelled task returns to pending and pauses the board without verification or auto-commit', async () => {
  const f = await fixture(); let verifyCalls = 0; const updates: string[] = [];
  try {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'must-not-run' } }));
    const result = await runTaskBoardLoop({ board: f.board, store: f.store, sessions: f.sessions, session: f.session, verifyRunner: async () => { verifyCalls += 1; return { exitCode: 0, output: 'must not run' }; }, onUpdate: () => { updates.push(f.session.taskRuntime!.mode); }, runTurn: async () => ({ ok: false, outcome: 'cancelled', finalAnswer: 'stopped', reason: 'stopped' }) });
    assert.equal(result.ok, false); assert.equal(result.status, 'paused');
    assert.equal(f.board.status, 'active'); assert.equal(f.board.tasks[0].status, 'pending'); assert.equal(f.board.tasks[0].finishedAt, undefined);
    assert.equal(f.session.taskRuntime?.mode, 'paused'); assert.equal(f.session.taskRuntime?.activeTaskId, 'task_1');
    assert.equal(verifyCalls, 0); assert.deepEqual(updates, ['executing', 'paused']); assert.equal(nextRunnableTask(f.board)?.id, 'task_1');
    assert.equal(result.outcome, 'cancelled'); assert.equal(await f.store.readLease(f.board.id), null);
    const saved = await f.store.load(f.board.id); assert.equal(saved.tasks[0].status, 'pending');
  } finally { await f.cleanup(); }
});

test('continue after cancellation reruns the same task, then allows dependent work', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const first = await runTaskBoardLoop({ board: f.board, store: f.store, sessions: f.sessions, session: f.session, verifyEnabled: false, runTurn: async () => { calls += 1; return { ok: false, outcome: 'cancelled', finalAnswer: 'pause' }; } });
    assert.equal(first.status, 'paused');
    f.session.taskRuntime = { boardId: f.board.id, activeTaskId: 'task_1', mode: 'executing', lastSyncAt: new Date().toISOString() };
    const second = await runTaskBoardLoop({ board: f.board, store: f.store, sessions: f.sessions, session: f.session, verifyEnabled: false, runTurn: async () => { calls += 1; return calls === 2 ? { ok: true, outcome: 'done', finalAnswer: 'TASK_DONE: first' } : { ok: true, outcome: 'done', finalAnswer: 'TASK_DONE: second' }; } });
    assert.equal(second.ok, true); assert.equal(calls, 3); assert.equal(f.board.tasks[0].status, 'done'); assert.equal(f.board.tasks[1].status, 'done');
  } finally { await f.cleanup(); }
});

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(label);
}

test('verification cancellation pauses without repairing, finishing dependent work or accepting a late result', async () => {
  const f = await fixture(); const controller = new AbortController(); let entered = false; let turns = 0; let release!: (result: { exitCode: number; output: string }) => void;
  try {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'fixture' } }));
    const loop = runTaskBoardLoop({ ...f, signal: controller.signal, runTurn: async () => { turns += 1; return { ok: true, finalAnswer: 'TASK_DONE: initial work' }; }, verifyRunner: async (_spec, _cwd, _timeout, signal) => { assert.ok(signal); entered = true; return new Promise(resolve => { release = resolve; }); } });
    await waitFor(() => entered, 'verification not entered'); controller.abort();
    const result = await loop;
    assert.equal(result.outcome, 'cancelled'); assert.equal(f.board.tasks[0].status, 'pending'); assert.equal(f.board.tasks[1].status, 'pending');
    assert.equal(turns, 1); assert.equal(f.session.taskRuntime?.mode, 'paused');
    release({ exitCode: 1, output: 'late failure' }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.board.tasks[0].error, undefined); assert.equal(turns, 1);
  } finally { controller.abort(); await f.cleanup(); }
});

test('cancelling the repair turn pauses instead of reporting a verification failure', async () => {
  const f = await fixture(); let turns = 0; let checks = 0;
  try {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'fixture' } }));
    const result = await runTaskBoardLoop({ ...f, runTurn: async () => ++turns === 1 ? { ok: true, finalAnswer: 'TASK_DONE: initial' } : { ok: false, outcome: 'cancelled', reason: 'user stopped repair' }, verifyRunner: async () => { checks += 1; return { exitCode: 1, output: 'real failed check' }; } });
    assert.equal(result.outcome, 'cancelled'); assert.equal(checks, 1); assert.equal(turns, 2);
    assert.equal(f.board.status, 'active'); assert.equal(f.board.tasks[0].status, 'pending'); assert.equal(f.board.tasks[0].error, undefined);
  } finally { await f.cleanup(); }
});

test('the board cancellation handler survives a completed model turn and the next session restores its role tools', async () => {
  const f = await fixture();
  const created = await createAgentRuntime({ provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: f.root, sessionDir: join(f.root, 'sessions'), noBanner: true, json: true });
  const runtime = created.runtime; const before = { allTools: runtime.allTools, tools: runtime.tools, scope: runtime.toolScope, filter: runtime.toolFilter, signal: runtime.requestSignal, cancel: runtime.cancelCurrentTurn };
  let verifying = false; let offered: string[] = [];
  f.board.tasks[0].title = 'Inspect and search existing source';
  runtime.provider = { name: 'mock', model: 'fixture', async complete(request) { offered = request.tools.map(tool => tool.name); return { actions: [{ type: 'message', content: 'TASK_DONE: analysed' }] }; } };
  try {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'fixture' } }));
    const loop = runTaskBoardLoop({ ...f, session: runtime.session, sessions: runtime.sessions, runtime, runTurn: prompt => runAgentTurn(runtime, prompt), verifyRunner: async () => { verifying = true; return new Promise(() => {}); } });
    await waitFor(() => verifying, 'model did not enter verification'); runtime.cancelCurrentTurn!();
    assert.equal((await loop).outcome, 'cancelled');
    assert.equal(offered.includes('write_file'), false); assert.equal(offered.includes('spawn_subagent'), false);
    assert.equal(runtime.tools, before.tools); assert.equal(runtime.allTools, before.allTools); assert.equal(runtime.toolScope, before.scope); assert.equal(runtime.toolFilter, before.filter); assert.equal(runtime.requestSignal, before.signal); assert.equal(runtime.cancelCurrentTurn, before.cancel);
  } finally { await created.close(); await f.cleanup(); }
});

test('a real npm verification process and worker stop on cancellation before the next check starts', async () => {
  const f = await fixture(); const controller = new AbortController();
  try {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'node verify.cjs', build: 'node next.cjs' } }));
    await writeFile(join(f.root, 'verify.cjs'), "const fs=require('node:fs');const {spawn}=require('node:child_process');const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync('pids.json',JSON.stringify({parent:process.pid,worker:worker.pid}));setInterval(()=>{},1000);");
    await writeFile(join(f.root, 'next.cjs'), "require('node:fs').writeFileSync('must-not-run.txt','unexpected');");
    const work = runVerifySuite({ workspaceRoot: f.root, signal: controller.signal });
    const rejection = assert.rejects(work, error => (error as Error).name === 'AbortError');
    await waitFor(async () => { try { await access(join(f.root, 'pids.json')); return true; } catch { return false; } }, 'npm verifier never started');
    const processIds = JSON.parse(await readFile(join(f.root, 'pids.json'), 'utf8')) as { parent: number; worker: number };
    controller.abort(); await rejection;
    const alive = (processId: number) => { try { process.kill(processId, 0); return true; } catch { return false; } };
    await waitFor(() => !alive(processIds.parent) && !alive(processIds.worker), 'verifier left worker processes');
    await assert.rejects(access(join(f.root, 'must-not-run.txt')));
  } finally { controller.abort(); await f.cleanup(); }
});

test('a cancellation during repaired verification never records a successful Git unit or finishes it twice', async () => {
  const f = await fixture(); const controller = new AbortController(); let checks = 0; let started = 0;
  const outcomes: Array<{ id: string; outcome: GitUnitOutcome }> = [];
  const safety = {
    async startUnit() { return { unitId: `unit-${++started}`, warnings: [] } as unknown as GitUnitContext; },
    async finishUnit(unit: GitUnitContext, outcome: GitUnitOutcome) { outcomes.push({ id: unit.unitId, outcome }); },
  } as unknown as GitSafetyService;
  try {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'fixture' } }));
    const loop = runTaskBoardLoop({ ...f, signal: controller.signal, gitSafety: safety, runTurn: async () => ({ ok: true, finalAnswer: 'TASK_DONE: candidate' }), verifyRunner: async () => ++checks === 1 ? { exitCode: 1, output: 'first check failed' } : new Promise(() => {}) });
    await waitFor(() => checks === 2, 'repair never entered verification'); controller.abort();
    assert.equal((await loop).outcome, 'cancelled');
    assert.deepEqual(outcomes, [{ id: 'unit-1', outcome: 'failed' }, { id: 'unit-2', outcome: 'cancelled' }]);
    assert.equal(f.board.tasks[0].status, 'pending');
  } finally { controller.abort(); await f.cleanup(); }
});
