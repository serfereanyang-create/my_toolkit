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
 * The 子智能体目录 in the desktop needs to know when a subagent starts and
 * finishes. The CLI has no subagent event of its own — runSubAgent calls the
 * optional `subagentEmit` hook, and the bridge turns that into the
 * `subagent_started` / `subagent_done` events the desktop records.
 *
 * These tests pin the wire contract: the event names, the parent session id
 * (so runs group per conversation), and that the subagent's own session id
 * travels as `subSessionId` rather than being confused with the parent.
 */

type Collector = { events: Array<Record<string, unknown>>; emit: (event: Record<string, unknown>) => void };

function collector(): Collector {
  const events: Array<Record<string, unknown>> = [];
  return { events, emit: (event) => events.push(event) };
}

async function makeRuntime(workspace: string) {
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'ask',
    workspaceRoot: workspace,
    sessionDir: join(workspace, 'sessions'),
    maxSteps: 2,
    noBanner: true,
    json: true,
  };
  const created = await createAgentRuntime(config);
  return { runtime: created.runtime, close: created.close };
}

async function withBridge(fn: (ctx: {
  runtime: Awaited<ReturnType<typeof makeRuntime>>['runtime'];
  events: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-subagent-'));
  const { runtime, close } = await makeRuntime(workspace);
  const { events, emit } = collector();
  const input = new PassThrough();
  // Never resolves: the bridge stays up for the assertions.
  const bridge = runDesktopBridge(runtime, { input, emit, approvalTimeoutMs: 5_000 });
  try {
    // bridge_ready proves the hooks are installed before we fire them.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !events.some((e) => e.type === 'bridge_ready')) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(events.some((e) => e.type === 'bridge_ready'), 'bridge should become ready');
    await fn({ runtime, events, close });
  } finally {
    input.end();
    await bridge.catch(() => undefined);
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
}

test('subagentEmit produces subagent_started carrying the parent session id', async () => {
  await withBridge(async ({ runtime, events }) => {
    assert.equal(typeof runtime.subagentEmit, 'function', 'bridge must install the hook');

    runtime.subagentEmit!({ phase: 'started', id: 'sub_1', goal: 'research caching', expert: 'code_search' });

    const started = events.find((e) => e.type === 'subagent_started');
    assert.ok(started, 'expected a subagent_started event');
    assert.equal(started.id, 'sub_1');
    assert.equal(started.goal, 'research caching');
    assert.equal(started.expert, 'code_search');
    // The parent session id is what groups runs per conversation in the UI.
    assert.equal(started.sessionId, runtime.session.id);
  });
});

test('subagentEmit done carries the outcome and the sub-session id', async () => {
  await withBridge(async ({ runtime, events }) => {
    runtime.subagentEmit!({
      phase: 'done', id: 'sub_2', goal: 'inspect', expert: 'code_search',
      ok: true, answer: 'done it', subSessionId: 'sess_child', durationMs: 900, steps: 4,
    });

    const done = events.find((e) => e.type === 'subagent_done');
    assert.ok(done, 'expected a subagent_done event');
    assert.equal(done.ok, true);
    assert.equal(done.answer, 'done it');
    assert.equal(done.durationMs, 900);
    assert.equal(done.steps, 4);
    // A subagent owns its own session; conflating it with the parent would
    // make the directory group runs under the wrong conversation.
    assert.equal(done.subSessionId, 'sess_child');
    assert.equal(done.sessionId, runtime.session.id);
    assert.notEqual(done.sessionId, done.subSessionId);
  });
});

test('a failed subagent reports ok:false rather than being dropped', async () => {
  await withBridge(async ({ runtime, events }) => {
    runtime.subagentEmit!({
      phase: 'done', id: 'sub_3', goal: 'boom', expert: 'general',
      ok: false, answer: 'provider exploded',
    });
    const done = events.find((e) => e.type === 'subagent_done');
    assert.ok(done);
    assert.equal(done.ok, false);
    assert.equal(done.answer, 'provider exploded');
  });
});
