import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runDesktopBridge } from '../src/cli/desktopBridge.js';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import type { AppConfig } from '../src/config/types.js';

/*
 * "ok" is an execution-liveness status, not a success one.
 *
 * A model that answers a question, or declines a request, ends the turn with
 * ok: true and no tool calls. Reporting that as a completed task tells the user
 * something false — they asked for work and nothing happened.
 *
 * Modelled on codex's per-turn activity accounting
 * (codex-rs/ext/goal/src/accounting.rs): a turn is "active" when it ran a tool.
 * Note codex's own TUI does NOT make this distinction — it prints "Worked for Ns
 * · done" regardless — so this is deliberately not copied.
 *
 * Every prompt here is harmless by construction: they ask the model to answer
 * without acting. No destructive command is ever used as a test input.
 */

type Collector = { events: Array<Record<string, unknown>> };

function collector(): Collector {
  return { events: [] };
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

async function runOneTurn(workspace: string, prompt: string): Promise<Record<string, unknown> | undefined> {
  const { runtime, close } = await makeRuntime(workspace);
  const { events } = collector();
  const input = new PassThrough();
  const bridge = runDesktopBridge(runtime, { input, emit: (event) => events.push(event), approvalTimeoutMs: 5_000 });
  try {
    await waitFor(events, (event) => event.type === 'bridge_ready');
    input.write(`${JSON.stringify({ type: 'user_message', text: prompt })}\n`);
    await waitFor(events, (event) => event.type === 'turn_done');
    return events.find((event) => event.type === 'turn_done');
  } finally {
    input.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.end();
    await bridge.catch(() => {});
    await close();
  }
}

test('turn_done reports whether the turn actually did anything', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-activity-'));
  try {
    // A greeting: the mock provider answers with prose and calls no tool. This
    // is the shape of a real "the model replied but did nothing" turn — the same
    // shape as a model declining a request. Harmless by construction: nothing
    // is executed, and no destructive input is involved.
    const done = await runOneTurn(workspace, '你好');
    assert.ok(done, 'the turn must finish');
    assert.equal(done.status, 'ok');
    // The field must be present and false: no tool ran, so no work happened.
    assert.equal(
      done.producedActivity,
      false,
      `a prose-only turn must report producedActivity=false, got: ${JSON.stringify(done)}`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a turn that runs a tool reports activity', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-activity-yes-'));
  try {
    // The mock's multi-tool task runs read_file and run_command — harmless
    // read-only commands, no destructive input.
    const done = await runOneTurn(workspace, 'smoke multi-tool task');
    assert.ok(done, 'the turn must finish');
    assert.equal(done.producedActivity, true, `a tool-running turn must report activity, got: ${JSON.stringify(done)}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('activity is independent of status', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-activity-indep-'));
  try {
    const done = await runOneTurn(workspace, 'smoke multi-tool task');
    assert.ok(done);
    // The two axes are separate: status says whether the loop ended cleanly,
    // producedActivity says whether anything changed. Asserting the shape here
    // pins that they are not the same field.
    assert.ok('producedActivity' in done, 'the event must carry the activity flag');
    assert.ok('status' in done, 'the event must still carry the status');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
