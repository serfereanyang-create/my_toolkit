import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommandJobManager } from '../src/safety/commandJobs.js';
import { pollCommandTool } from '../src/tools/pollCommand.js';
import { runCommandTool } from '../src/tools/shell.js';
import { ToolRegistry } from '../src/tools/registry.js';

async function waitForDone(manager: CommandJobManager, jobId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = manager.poll(jobId);
    if (snapshot && snapshot.status !== 'running') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${jobId} did not finish in time`);
}

function context(workspaceRoot: string, commandJobs: CommandJobManager) {
  return { workspaceRoot, approval: 'ask' as const, confirm: async () => true, commandJobs };
}

test('command job manager starts and polls a completed job without exposing a pid', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-command-job-'));
  const manager = new CommandJobManager();
  try {
    const started = manager.start({
      command: 'node -e "console.log(\'job done\')"',
      cwd: workspace,
      timeoutMs: 5000,
    });
    assert.match(started.jobId, /^job_/);
    assert.equal(started.status, 'running');

    const result = await waitForDone(manager, started.jobId);
    assert.equal(result.status, 'completed');
    assert.equal(result.code, 0);
    assert.match(result.stdout, /job done/);
    assert.equal('pid' in result, false);
  } finally {
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('command job manager enforces a total output cap and reports truncation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-command-job-output-'));
  const manager = new CommandJobManager();
  try {
    const started = manager.start({
      command: 'node -e "process.stdout.write(\'x\'.repeat(20000))"',
      cwd: workspace,
      timeoutMs: 5000,
      maxOutputBytes: 128,
    });
    const result = await waitForDone(manager, started.jobId);
    assert.equal(result.status, 'completed');
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 128);
  } finally {
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('command job manager marks timed out jobs and close removes active jobs', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-command-job-lifecycle-'));
  const manager = new CommandJobManager();
  try {
    const started = manager.start({
      command: 'node -e "setTimeout(()=>{}, 60000)"',
      cwd: workspace,
      timeoutMs: 100,
    });
    const result = await waitForDone(manager, started.jobId);
    assert.equal(result.status, 'timed_out');
    assert.equal(result.timedOut, true);

    const active = manager.start({
      command: 'node -e "setTimeout(()=>{}, 60000)"',
      cwd: workspace,
      timeoutMs: 60000,
    });
    await manager.close();
    assert.equal(manager.poll(active.jobId), undefined);
    assert.throws(() => manager.start({ command: 'node --version', cwd: workspace }), /closed/);
  } finally {
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('run_command background starts a job and poll_command reads it through ToolContext', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-command-job-tools-'));
  const manager = new CommandJobManager();
  try {
    const registry = ToolRegistry.fromTools([runCommandTool, pollCommandTool]);
    const started = await registry.execute(
      'run_command',
      { command: 'node -e "console.log(\'tool job\')"', background: true, timeoutMs: 5000 },
      context(workspace, manager),
    );
    assert.equal(started.ok, true);
    const jobId = (started.data as { jobId: string }).jobId;
    const result = await waitForDone(manager, jobId);
    assert.equal(result.status, 'completed');

    const polled = await registry.execute('poll_command', { jobId }, context(workspace, manager));
    assert.equal(polled.ok, true);
    assert.match(polled.output, /completed/);
    assert.match(polled.output, /tool job/);
  } finally {
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('run_command foreground remains available without a command job service', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-command-job-foreground-'));
  try {
    const registry = ToolRegistry.fromTools([runCommandTool, pollCommandTool]);
    const result = await registry.execute(
      'run_command',
      { command: 'node --version', timeoutMs: 5000 },
      { workspaceRoot: workspace, approval: 'auto' },
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /^v\d+/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
