import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runDesktopBridge } from '../src/cli/desktopBridge.js';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import { detectTaskCompletion } from '../src/tasks/completion.js';
import type { AppConfig } from '../src/config/types.js';

/*
 * Every failure must say what went wrong.
 *
 * A bare "tool failed" or an unexplained turn failure is the one thing the user
 * cannot act on, and those strings used to be what surfaced whenever a caller
 * forgot to set `reason` — the real cause was dropped at the exact moment it
 * mattered.
 */

test('detectTaskCompletion never returns a bare "Task failed"', () => {
  // The explicit error wins.
  const explicit = detectTaskCompletion({ ok: false, finalAnswer: 'ignored', hadTerminalFailure: true, error: '磁盘只读' });
  assert.equal(explicit.status, 'blocked');
  assert.match(explicit.error, /磁盘只读/);

  // With no explicit error, whatever the turn said is used.
  const fromAnswer = detectTaskCompletion({ ok: false, finalAnswer: '在 write_file 失败后停止：权限不足', hadTerminalFailure: true });
  assert.equal(fromAnswer.status, 'blocked');
  assert.match(fromAnswer.error, /权限不足/);

  // With neither, the message says the cause is missing rather than pretending
  // to be a cause.
  const nothing = detectTaskCompletion({ ok: false, finalAnswer: '', hadTerminalFailure: true });
  assert.equal(nothing.status, 'blocked');
  assert.notEqual(nothing.error, 'Task failed');
  assert.match(nothing.error, /没有返回失败原因/);
});

test('a failed turn always carries a reason on the wire', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-err-reason-'));
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir: join(workspace, 'sessions'),
    noBanner: true,
    json: true,
  };
  const { runtime, close } = await createAgentRuntime(config);
  const events: Array<Record<string, unknown>> = [];
  const input = new PassThrough();
  const bridge = runDesktopBridge(runtime, { input, emit: (event) => events.push(event), approvalTimeoutMs: 5_000 });
  try {
    await new Promise((resolve) => {
      const deadline = Date.now() + 20_000;
      const tick = () => {
        if (events.some((event) => event.type === 'bridge_ready')) return resolve(undefined);
        if (Date.now() > deadline) return resolve(undefined);
        setTimeout(tick, 20);
      };
      tick();
    });
    // A prompt the mock provider cannot satisfy with a tool: it ends the turn
    // with an error, and the reason must be present.
    input.write(`${JSON.stringify({ type: 'user_message', text: '故意触发一个失败' })}\n`);
    await new Promise((resolve) => {
      const deadline = Date.now() + 20_000;
      const tick = () => {
        if (events.some((event) => event.type === 'turn_done')) return resolve(undefined);
        if (Date.now() > deadline) return resolve(undefined);
        setTimeout(tick, 20);
      };
      tick();
    });

    const done = events.find((event) => event.type === 'turn_done');
    assert.ok(done, 'the turn must finish');
    if (done.status === 'error') {
      // The rule under test: a failed turn is never reason-less.
      assert.ok(
        typeof done.reason === 'string' && String(done.reason).trim().length > 0,
        `a failed turn must carry a reason, got: ${JSON.stringify(done.reason)}`,
      );
    }
  } finally {
    input.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.end();
    await bridge.catch(() => {});
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a tool failure reports the tool output, not a generic string', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-tool-reason-'));
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir: join(workspace, 'sessions'),
    noBanner: true,
    json: true,
  };
  const { runtime, close } = await createAgentRuntime(config);
  const events: Array<Record<string, unknown>> = [];
  const input = new PassThrough();
  const bridge = runDesktopBridge(runtime, { input, emit: (event) => events.push(event), approvalTimeoutMs: 5_000 });
  try {
    await new Promise((resolve) => {
      const deadline = Date.now() + 20_000;
      const tick = () => {
        if (events.some((event) => event.type === 'bridge_ready')) return resolve(undefined);
        if (Date.now() > deadline) return resolve(undefined);
        setTimeout(tick, 20);
      };
      tick();
    });
    // The mock's multi-tool task ends with a blocked command, which is a
    // terminal failure carrying the tool's own output.
    input.write(`${JSON.stringify({ type: 'user_message', text: 'smoke multi-tool task' })}\n`);
    await new Promise((resolve) => {
      const deadline = Date.now() + 25_000;
      const tick = () => {
        if (events.some((event) => event.type === 'turn_done')) return resolve(undefined);
        if (Date.now() > deadline) return resolve(undefined);
        setTimeout(tick, 20);
      };
      tick();
    });

    const done = events.find((event) => event.type === 'turn_done');
    assert.ok(done, 'the turn must finish');
    if (done.status === 'error') {
      const reason = String(done.reason ?? '');
      assert.notEqual(reason.trim(), 'tool failed', 'a bare "tool failed" is not an explanation');
      assert.ok(reason.trim().length > 0, 'the reason must not be empty');
    }
  } finally {
    input.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.end();
    await bridge.catch(() => {});
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});
