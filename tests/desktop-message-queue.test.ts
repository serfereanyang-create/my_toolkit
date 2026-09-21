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
 * Messages sent while a turn is running.
 *
 * The bridge used to reject a second `user_message` outright with "Agent turn
 * already running", which lost whatever the user had typed. They now queue and
 * are sent one per finished turn, in order.
 *
 * Driven in-process through the bridge's injectable input/emit, so no child
 * process is needed.
 */

type Collector = { events: Array<Record<string, unknown>>; emit: (event: Record<string, unknown>) => void };

function collector(): Collector {
  const events: Array<Record<string, unknown>> = [];
  return { events, emit: (event) => events.push(event) };
}

async function waitFor(
  events: Array<Record<string, unknown>>,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 20_000,
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

test('a message sent mid-turn is queued instead of rejected', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-queue-'));
  const { runtime, close } = await makeRuntime(workspace);
  const { events, emit } = collector();
  const input = new PassThrough();
  const bridge = runDesktopBridge(runtime, { input, emit, approvalTimeoutMs: 5_000 });
  try {
    await waitFor(events, (event) => event.type === 'bridge_ready');
    // The mock provider takes more than one round-trip for this prompt, so the
    // second message lands while the first turn is still in flight.
    input.write(`${JSON.stringify({ type: 'user_message', text: 'smoke multi-tool task' })}\n`);
    await waitFor(events, (event) => event.type === 'turn_start');
    input.write(`${JSON.stringify({ type: 'user_message', text: '排队的第一条' })}\n`);

    const queued = await waitFor(events, (event) =>
      event.type === 'info' && String(event.message ?? '').includes('已排队'));
    assert.ok(queued, 'a mid-turn message must be acknowledged as queued, not rejected');

    // The old behaviour: an error saying the turn is already running.
    const rejected = events.some((event) =>
      event.type === 'error' && String(event.message ?? '').includes('already running'));
    assert.equal(rejected, false, 'a mid-turn message must not be rejected');
  } finally {
    input.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.end();
    await bridge.catch(() => {});
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('the queued message runs after the current turn finishes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-queue-drain-'));
  const { runtime, close } = await makeRuntime(workspace);
  const { events, emit } = collector();
  const input = new PassThrough();
  const bridge = runDesktopBridge(runtime, { input, emit, approvalTimeoutMs: 5_000 });
  try {
    await waitFor(events, (event) => event.type === 'bridge_ready');
    input.write(`${JSON.stringify({ type: 'user_message', text: 'smoke multi-tool task' })}\n`);
    await waitFor(events, (event) => event.type === 'turn_start');
    input.write(`${JSON.stringify({ type: 'user_message', text: 'QUEUED-SECOND' })}\n`);

    // Two turns must complete: the original, then the queued one.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (events.filter((event) => event.type === 'turn_done').length >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const turnDones = events.filter((event) => event.type === 'turn_done');
    assert.ok(turnDones.length >= 2, `the queued message must run: saw ${turnDones.length} finished turn(s)`);

    // And the queued text must have reached the session, proving it ran rather
    // than merely being acknowledged.
    const ran = runtime.session.messages.some((message) =>
      message.role === 'user' && String(message.content).includes('QUEUED-SECOND'));
    assert.ok(ran, 'the queued message must actually be sent, not just acknowledged');
  } finally {
    input.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.end();
    await bridge.catch(() => {});
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('queued messages run in submission order', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-queue-order-'));
  const { runtime, close } = await makeRuntime(workspace);
  const { events, emit } = collector();
  const input = new PassThrough();
  const bridge = runDesktopBridge(runtime, { input, emit, approvalTimeoutMs: 5_000 });
  try {
    await waitFor(events, (event) => event.type === 'bridge_ready');
    input.write(`${JSON.stringify({ type: 'user_message', text: 'smoke multi-tool task' })}\n`);
    await waitFor(events, (event) => event.type === 'turn_start');
    input.write(`${JSON.stringify({ type: 'user_message', text: 'ORDER-FIRST' })}\n`);
    input.write(`${JSON.stringify({ type: 'user_message', text: 'ORDER-SECOND' })}\n`);

    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (events.filter((event) => event.type === 'turn_done').length >= 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const order = runtime.session.messages
      .filter((message) => message.role === 'user')
      .map((message) => String(message.content))
      .filter((text) => text.includes('ORDER-'));
    assert.equal(order.length, 2, `both queued messages must run: ${JSON.stringify(order)}`);
    assert.match(order[0], /ORDER-FIRST/);
    assert.match(order[1], /ORDER-SECOND/);
  } finally {
    input.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.end();
    await bridge.catch(() => {});
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});
