import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runDesktopBridge } from '../src/cli/desktopBridge.js';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import type { AppConfig } from '../src/config/types.js';

/*
 * The `automation_task` bridge command — the one an unattended scheduled run
 * arrives on.
 *
 * Its entry point used to be a detached promise of its own, a second writer of
 * `busy` and `pendingMessages` alongside the one inside `startTurn`. Two owners
 * is how a message queued behind an automation run could be dropped: whichever
 * finished first cleared `busy` and drained the queue. It now goes through
 * `startTurn` like every other turn, and these tests pin the consequences —
 * the turn pairing the renderer relies on, and the queue surviving the run.
 */

type Collector = { events: Array<Record<string, unknown>>; emit: (event: Record<string, unknown>) => void };

function collector(): Collector {
  const events: Array<Record<string, unknown>> = [];
  return { events, emit: (event) => events.push(event) };
}

async function waitFor(
  events: Array<Record<string, unknown>>,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 30_000,
): Promise<boolean> {
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
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir: join(workspace, 'sessions'),
    noBanner: true,
    json: true,
  };
  const created = await createAgentRuntime(config);
  return { runtime: created.runtime, close: created.close };
}

test('an automation goal pairs automation_done with turn_done', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-automation-'));
  const { runtime, close } = await makeRuntime(workspace);
  const { events, emit } = collector();
  const input = new PassThrough();
  const bridge = runDesktopBridge(runtime, { input, emit, approvalTimeoutMs: 5_000 });
  try {
    await waitFor(events, (event) => event.type === 'bridge_ready');
    input.write(`${JSON.stringify({ type: 'automation_task', taskId: 'auto_test', goal: '整理项目结构' })}\n`);

    const started = await waitFor(events, (event) => event.type === 'automation_start');
    assert.ok(started, 'the run must announce that it started');
    const done = await waitFor(events, (event) => event.type === 'automation_done');
    assert.ok(done, 'the run must report its outcome');

    const startedEvent = events.find((event) => event.type === 'automation_start');
    assert.equal(startedEvent?.taskId, 'auto_test', 'automation_start carries the task id');
    const doneEvent = events.find((event) => event.type === 'automation_done');
    assert.equal(doneEvent?.taskId, 'auto_test', 'automation_done carries the same task id');

    // The renderer's turn card is closed by turn_done, not by automation_done.
    // Without this pairing the task board would stay "running" forever — the
    // exact bug that the task_board_action path had.
    const turnDone = await waitFor(events, (event) => event.type === 'turn_done');
    assert.ok(turnDone, 'an automation run must also close the renderer-facing turn');
  } finally {
    input.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.end();
    await bridge.catch(() => {});
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a message sent during an automation run is queued and still runs afterwards', async () => {
  // The regression this guards: with two drains, the automation run finishing
  // cleared `busy` and drained the queue itself, losing the message. Now one
  // owner drives both, so the queued message must actually reach the session.
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-automation-queue-'));
  const { runtime, close } = await makeRuntime(workspace);
  const { events, emit } = collector();
  const input = new PassThrough();
  const bridge = runDesktopBridge(runtime, { input, emit, approvalTimeoutMs: 5_000 });
  try {
    await waitFor(events, (event) => event.type === 'bridge_ready');
    input.write(`${JSON.stringify({ type: 'automation_task', taskId: 'auto_q', goal: '整理项目结构' })}\n`);
    await waitFor(events, (event) => event.type === 'automation_start');
    input.write(`${JSON.stringify({ type: 'user_message', text: 'AFTER-AUTOMATION' })}\n`);

    const queued = await waitFor(events, (event) =>
      event.type === 'info' && String(event.message ?? '').includes('已排队'));
    assert.ok(queued, 'a message arriving during an automation run must be queued, not dropped');

    const ran = await waitFor(events, () =>
      runtime.session.messages.some((message) =>
        message.role === 'user' && String(message.content).includes('AFTER-AUTOMATION')), 40_000);
    assert.ok(ran, 'the queued message must actually run once the automation finishes');
  } finally {
    input.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.end();
    await bridge.catch(() => {});
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a second automation command is refused while one is running', async () => {
  // `busy` is now owned by startTurn, so this must still hold for the
  // automation path: two unattended runs must not interleave on one session.
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-automation-busy-'));
  const { runtime, close } = await makeRuntime(workspace);
  const { events, emit } = collector();
  const input = new PassThrough();
  const bridge = runDesktopBridge(runtime, { input, emit, approvalTimeoutMs: 5_000 });
  try {
    await waitFor(events, (event) => event.type === 'bridge_ready');
    input.write(`${JSON.stringify({ type: 'automation_task', taskId: 'auto_1', goal: '整理项目结构' })}\n`);
    await waitFor(events, (event) => event.type === 'automation_start');
    input.write(`${JSON.stringify({ type: 'automation_task', taskId: 'auto_2', goal: '另一个目标' })}\n`);

    const busy = await waitFor(events, (event) =>
      event.type === 'automation_done' && event.taskId === 'auto_2' && event.status === 'busy');
    assert.ok(busy, 'a concurrent automation command must be refused as busy');
  } finally {
    input.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.end();
    await bridge.catch(() => {});
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});
