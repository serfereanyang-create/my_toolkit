import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { test } from 'node:test';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import { runAgentTurn } from '../src/agent/agent.js';
import { runSandboxedCommand } from '../src/safety/sandbox.js';
import { CommandJobManager } from '../src/safety/commandJobs.js';
import { parseArgs } from '../src/cli/args.js';
import { loadConfig } from '../src/config/config.js';
import type { AppConfig } from '../src/config/types.js';
import type { ProviderRequest, ProviderResponse } from '../src/providers/types.js';

async function workspace() { const root = await realpath(tmpdir()); return { root, path: await mkdtemp(join(root, 'yoy-cancel-')) }; }
async function cleanup(owned: { root: string; path: string }) {
  const target = await realpath(owned.path);
  const inside = relative(owned.root, target);
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
  await rm(target, { recursive: true, force: true });
}
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(label);
}

test('cancel aborts a non-cooperative model, discards late writes and lets the same runtime start a fresh turn', async () => {
  const owned = await workspace();
  const config: AppConfig = { provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: owned.path, sessionDir: join(owned.path, 'sessions'), noBanner: true, json: true, maxSteps: 3 };
  const created = await createAgentRuntime(config);
  let request: ProviderRequest | undefined;
  let release!: (response: ProviderResponse) => void;
  let calls = 0;
  created.runtime.provider = { name: 'mock', model: 'fixture', async complete(current) { calls += 1; request = current; current.onTextDelta?.('partial visible body'); return new Promise(resolve => { release = resolve; }); } };
  try {
    const turn = runAgentTurn(created.runtime, 'Create a file named late.txt after the model answers');
    await waitFor(() => !!request, 'model was not entered');
    created.runtime.session.providerContinuation = { responseId: 'cancelled-response', status: 'pending' };
    created.runtime.cancelCurrentTurn!();
    const result = await turn;
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.hadTerminalFailure, false);
    assert.equal(created.runtime.session.lastTurn?.outcome, 'cancelled');
    assert.equal(created.runtime.session.lastTurn?.status, 'done');
    assert.equal(created.runtime.session.providerContinuation, undefined);
    assert.ok(created.runtime.session.messages.some(message => message.interrupted && message.content.includes('partial visible body')));
    release({ actions: [{ type: 'tool', tool: 'write_file', input: { path: 'late.txt', content: 'must not write' } }] });
    request!.onTextDelta?.('late delta'); request!.onThinkingDelta?.('late thought');
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(access(join(owned.path, 'late.txt')));
    assert.equal(created.runtime.session.toolCalls.length, 0);
    assert.equal(calls, 1);
    created.runtime.provider = { name: 'mock', model: 'fixture', async complete(current) { assert.equal(current.signal?.aborted, false); return { actions: [{ type: 'message', content: 'fresh turn' }] }; } };
    assert.equal((await runAgentTurn(created.runtime, 'Answer briefly')).ok, true);
  } finally { await created.close(); await cleanup(owned); }
});

test('request deadlines can be configured without changing credentials or existing session history', async () => {
  assert.equal(parseArgs(['--request-timeout-ms', '45000']).requestTimeoutMs, 45000);
  for (const value of ['0', '-1', '1.5', '2147483648']) assert.throws(() => parseArgs(['--request-timeout-ms', value]));
  const owned = await workspace();
  try {
    const configFile = join(owned.path, 'config.json');
    await writeFile(configFile, JSON.stringify({ provider: 'mock', requestTimeoutMs: 60000 }));
    const loaded = await loadConfig({ workspace: owned.path, configPath: configFile }, {});
    assert.equal(loaded.requestTimeoutMs, 60000);
    assert.equal((await loadConfig({ workspace: owned.path, configPath: configFile, requestTimeoutMs: 30000 }, {})).requestTimeoutMs, 30000);
  } finally { await cleanup(owned); }
});

test('an unclean resumed turn discards a dangling Responses continuation without rewriting its source', async () => {
  const owned = await workspace();
  const config: AppConfig = { provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: owned.path, sessionDir: join(owned.path, 'sessions'), noBanner: true, json: true };
  const first = await createAgentRuntime(config);
  let restored;
  try {
    first.runtime.session.lastTurn = { prompt: 'interrupted', status: 'running', startedAt: '2026-10-22T00:00:00Z' };
    first.runtime.session.providerContinuation = { responseId: 'incomplete-response', status: 'pending' };
    await first.runtime.sessions.save(first.runtime.session);
    const file = join(config.sessionDir, `${first.runtime.session.id}.json`);
    const before = await readFile(file, 'utf8');
    restored = await createAgentRuntime({ ...config, resumeSessionId: first.runtime.session.id });
    assert.equal(restored.runtime.session.providerContinuation, undefined);
    assert.equal(await readFile(file, 'utf8'), before);
  } finally { await restored?.close(); await first.close(); await cleanup(owned); }
});

test('a model deadline ends an ignored signal without any late tool execution', async () => {
  const owned = await workspace();
  const config: AppConfig = { provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: owned.path, sessionDir: join(owned.path, 'sessions'), requestTimeoutMs: 30, noBanner: true, json: true };
  const created = await createAgentRuntime(config);
  created.runtime.provider = { name: 'mock', model: 'fixture', async complete() { return new Promise(() => {}); } };
  try {
    const result = await runAgentTurn(created.runtime, 'Answer briefly without using tools');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason ?? '', /deadline/);
    assert.equal(created.runtime.session.toolCalls.length, 0);
  } finally { await created.close(); await cleanup(owned); }
});

test('cancelling a foreground command stops its owned process tree and retains its output', async () => {
  const owned = await workspace();
  const controller = new AbortController();
  const script = join(owned.path, 'foreground.cjs');
  const ready = join(owned.path, 'ready.json');
  await writeFile(script, `const fs=require('node:fs');const {spawn}=require('node:child_process');const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});console.log('ready output');fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({parent:process.pid,worker:worker.pid}));setInterval(()=>{},1000);`);
  const work = runSandboxedCommand({ command: `"${process.execPath}" "${script}"`, cwd: owned.path, signal: controller.signal, timeoutMs: 10000 });
  try {
    await waitFor(async () => { try { await access(ready); return true; } catch { return false; } }, 'foreground command did not start');
    const processIds = JSON.parse(await readFile(ready, 'utf8')) as { parent: number; worker: number };
    controller.abort();
    const result = await work;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /ready output/);
    const alive = (processId: number) => { try { process.kill(processId, 0); return true; } catch { return false; } };
    await waitFor(() => !alive(processIds.parent) && !alive(processIds.worker), 'cancelled command left a child alive');
  } finally { controller.abort(); await work.catch(() => undefined); await cleanup(owned); }
});

test('background job cancellation is scoped to its turn and keeps the manager reusable', async () => {
  const owned = await workspace();
  const jobs = new CommandJobManager();
  const current = new AbortController();
  const script = join(owned.path, 'job.cjs');
  await writeFile(script, "console.log('job ready');setInterval(()=>{},1000);");
  const command = `"${process.execPath}" "${script}"`;
  try {
    const older = jobs.start({ command, cwd: owned.path, timeoutMs: 10000 });
    const active = jobs.start({ command, cwd: owned.path, signal: current.signal, timeoutMs: 10000 });
    await waitFor(() => jobs.poll(active.jobId)?.stdout.includes('job ready') === true, 'background job did not start');
    current.abort();
    await jobs.settleCancellation(current.signal);
    assert.equal(jobs.poll(active.jobId)?.status, 'killed');
    assert.ok(jobs.poll(active.jobId)?.finishedAt);
    assert.equal(jobs.poll(older.jobId)?.status, 'running');
    const next = jobs.start({ command: 'echo reusable', cwd: owned.path, timeoutMs: 5000 });
    await waitFor(() => !!jobs.poll(next.jobId)?.finishedAt, 'next background job never finished');
    assert.equal(jobs.poll(next.jobId)?.status, 'completed');
  } finally { current.abort(); await jobs.close(); await cleanup(owned); }
});
