'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execPath } = require('node:process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRuntimeSupervisor } = require('../electron/runtime-lifecycle.cjs');

const READY_SCRIPT = 'process.stdout.write("up\\n"); setInterval(()=>{},1000);';
const CRASH_SCRIPT = 'process.exit(1);';

function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(`timeout waiting for: ${message}`);
  })();
}

test('happy path: spawn → ready → expected stop', async () => {
  const supervisor = createRuntimeSupervisor({
    provider: 'test-runtime',
    command: execPath,
    args: ['-e', READY_SCRIPT],
    cwd: await mkdtemp(join(tmpdir(), 'runtime-ok-')),
    readyTimeoutMs: 5000,
  });
  const events = [];
  supervisor.emitter.on('spawn', (e) => events.push(['spawn', e]));
  supervisor.emitter.on('ready', (e) => events.push(['ready', e]));
  supervisor.emitter.on('exit', (e) => events.push(['exit', e]));
  try {
    supervisor.start();
    await waitFor(() => events.some(([type]) => type === 'ready'), 10_000, 'ready event');
    assert.ok(supervisor.isRunning());
    const stop = await supervisor.stop();
    assert.equal(stop.ok, true);
    await waitFor(() => events.some(([type, e]) => type === 'exit' && e.terminationKind === 'expected'), 10_000, 'expected exit');
    const ready = events.find(([type]) => type === 'ready')[1];
    assert.ok(ready.startupDurationMs >= 0);
    assert.equal(ready.runtimeGeneration, 1);
    assert.ok(ready.runtimeInstanceId);
    assert.ok(!supervisor.isRunning());
  } finally {
    await supervisor.stop();
    await rm(supervisor.diagnostics().command ? join(tmpdir()) : join(tmpdir()), { recursive: true, force: true }).catch(() => {});
  }
});

test('crash loop is bounded by the watchdog with watchdog_recycle', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'runtime-crash-'));
  const exits = [];
  const supervisor = createRuntimeSupervisor({
    provider: 'crashy',
    command: execPath,
    args: ['-e', CRASH_SCRIPT],
    cwd,
    restartBackoffMs: 50,
    maxRestarts: 2,
  });
  supervisor.emitter.on('exit', (e) => exits.push(e));
  try {
    supervisor.start();
    await waitFor(() => exits.some((e) => e.terminationKind === 'watchdog_recycle'), 15_000, 'watchdog_recycle');
    // 1 initial spawn + 2 restarts = 3 unexpected exits, then the recycle.
    const unexpected = exits.filter((e) => e.terminationKind === 'unexpected');
    assert.ok(unexpected.length >= 3, `saw ${unexpected.length} unexpected exits`);
    const recycle = exits.find((e) => e.terminationKind === 'watchdog_recycle');
    assert.ok(recycle.terminationReason.includes('crash loop'));
    assert.ok(supervisor.diagnostics().stderrTail !== undefined);
  } finally {
    await supervisor.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('stderr output lands in the diagnostics ring', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'runtime-err-'));
  const SCRIPT = 'process.stderr.write("boom-line\\n"); process.stdout.write("up\\n"); setInterval(()=>{},1000);';
  const supervisor = createRuntimeSupervisor({ provider: 'stderr-y', command: execPath, args: ['-e', SCRIPT], cwd });
  try {
    supervisor.start();
    await waitFor(() => supervisor.diagnostics().stderrTail.includes('boom-line'), 10_000, 'stderr line captured');
    assert.ok(supervisor.isRunning());
  } finally {
    await supervisor.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
