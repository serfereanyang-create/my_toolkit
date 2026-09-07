import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runDesktopBridge } from '../src/cli/desktopBridge.js';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import type { AppConfig } from '../src/config/types.js';

/*
 * Desktop approval lifecycle (P0 execution-overhaul batch), driven in-process
 * through the bridge's injectable input/emit so no child process is needed.
 *
 * Guarantees under test:
 * 1. EOF while an approval is pending: the bridge denies the pending approval
 *    and the bridge loop settles — it must never hang forever on an approval
 *    nobody can answer anymore.
 * 2. Approval timeout: an unanswered approval is denied automatically, an info
 *    event explains it, and the turn completes with a failed write result.
 */

type Collector = { events: Array<Record<string, unknown>>; emit: (event: Record<string, unknown>) => void };

function collector(): Collector {
  const events: Array<Record<string, unknown>> = [];
  return { events, emit: (event) => events.push(event) };
}

async function waitFor(events: Array<Record<string, unknown>>, predicate: (event: Record<string, unknown>) => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some(predicate)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return events.some(predicate);
}

async function makeRuntime(workspace: string) {
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'ask',
    workspaceRoot: workspace,
    sessionDir: join(workspace, 'sessions'),
    maxSteps: 6,
    noBanner: true,
    json: true,
  };
  const created = await createAgentRuntime(config);
  return { runtime: created.runtime, close: created.close };
}

test('EOF with a pending approval denies it and the bridge loop settles', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-approval-eof-'));
  const { runtime, close } = await makeRuntime(workspace);
  const { events, emit } = collector();
  const input = new PassThrough();

  const bridge = runDesktopBridge(runtime, { input, emit, approvalTimeoutMs: 60_000 });
  const ready = await waitFor(events, (event) => event.type === 'bridge_ready');
  assert.ok(ready, 'bridge_ready must be emitted on start');

  input.write(`${JSON.stringify({ type: 'user_message', text: 'smoke multi-tool task' })}\n`);
  const approvalNeeded = await waitFor(events, (event) => event.type === 'approval_needed');
  assert.ok(approvalNeeded, 'ask mode should raise approval_needed for the mock write');

  // Simulate the desktop shell dying: no approval_response, just EOF.
  input.end();

  // The whole bridge must settle — a pending approval left unresolved would
  // hang this await forever (exactly the bug this batch fixes).
  await Promise.race([
    bridge,
    new Promise((_r, reject) => setTimeout(() => reject(new Error('bridge hung after EOF: pending approval never denied')), 10_000)),
  ]);

  assert.ok(
    events.some((event) => event.type === 'turn_done' && event.status !== 'ok'),
    'the denied turn must finish with a non-ok turn_done',
  );
  assert.ok(
    events.some((event) => event.type === 'info' && String(event.message ?? '').includes('桥接正在关闭')),
    'denyAll must explain why pending approvals were denied',
  );

  await bridge;
  await close();
  await rm(workspace, { recursive: true, force: true });
});

test('approval timeout denies the request and completes the turn', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-approval-timeout-'));
  const { runtime, close } = await makeRuntime(workspace);
  const { events, emit } = collector();
  const input = new PassThrough();

  const bridge = runDesktopBridge(runtime, { input, emit, approvalTimeoutMs: 300 });
  const ready = await waitFor(events, (event) => event.type === 'bridge_ready');
  assert.ok(ready, 'bridge_ready must be emitted on start');

  input.write(`${JSON.stringify({ type: 'user_message', text: 'smoke multi-tool task' })}\n`);
  const approvalNeeded = await waitFor(events, (event) => event.type === 'approval_needed');
  assert.ok(approvalNeeded, 'ask mode should raise approval_needed');

  // Do NOT respond and do NOT end the input: the broker deadline must fire.
  const turnDone = await waitFor(events, (event) => event.type === 'turn_done', 10_000);
  assert.ok(turnDone, 'timed-out approval must still end the turn');
  assert.ok(
    events.some((event) => event.type === 'info' && String(event.message ?? '').includes('审批超时')),
    'an info event must explain the automatic deny',
  );

  // The TerminalUI JSON stream writes to process.stdout directly (production
  // shares one stdout with the bridge), so assert the deny through the real
  // side effects: the session records a failed write call and NO file lands.
  const writeCall = runtime.session.toolCalls.find((call) => call.tool === 'write_file');
  assert.ok(writeCall, 'the denied write must be recorded in the session');
  assert.equal(writeCall.ok, false, 'timed-out approval must deny the write');
  const writeLanded = await stat(join(workspace, '.smoke', 'multi-tool-result.md')).then(() => true, () => false);
  assert.equal(writeLanded, false, 'denied write must not touch the disk');

  input.end();
  await bridge;
  await close();
  await rm(workspace, { recursive: true, force: true });
});

test('task_board_action emits a paired turn_done so the UI never stays running', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-bridge-taskboard-'));
  const { runtime, close } = await makeRuntime(workspace);
  const { events, emit } = collector();
  const input = new PassThrough();

  const bridge = runDesktopBridge(runtime, { input, emit, approvalTimeoutMs: 60_000 });
  await waitFor(events, (event) => event.type === 'bridge_ready');

  input.write(`${JSON.stringify({ type: 'task_board_action', action: 'continue' })}\n`);
  const done = await waitFor(events, (event) => event.type === 'turn_done');
  assert.ok(done, 'task_board_action must emit a closing turn_done');

  input.end();
  await bridge;
  await close();
  await rm(workspace, { recursive: true, force: true });
});
