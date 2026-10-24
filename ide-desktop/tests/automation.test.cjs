const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { classifyGitEvent, createAutomationService, normalizeTrigger, automationBus, automationSessionDir, unattendedApprovalDecision } = require('../electron/automation.cjs');

function createFixture(root) {
  const mainWindow = new EventEmitter();
  mainWindow.isDestroyed = () => false;
  mainWindow.webContents = { send() {} };
  const workspace = { getRoot: () => root };
  const calls = [];
  const agentManager = {
    async automationTask(taskId, goal) {
      calls.push({ taskId, goal });
    },
  };
  return {
    calls,
    mainWindow,
    service: createAutomationService({ workspace, agentManager, mainWindow }),
  };
}

test('automation service creates, persists, updates, and deletes workspace tasks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yoy-automation-'));
  const fixture = createFixture(root);
  try {
    await fixture.service.setWorkspace(root);
    const created = await fixture.service.create({
      name: 'Weekday checks',
      description: 'Run test board',
      trigger: { type: 'cron', expression: '0 9 * * 1-5' },
      action: { type: 'task_board', goal: 'Run checks', confirmPlan: true },
    });
    assert.match(created.id, /^auto_/);
    assert.equal(created.enabled, false);
    assert.equal((await fixture.service.list()).length, 1);

    const updated = await fixture.service.update(created.id, { name: 'Morning checks' });
    assert.equal(updated.name, 'Morning checks');

    const raw = JSON.parse(await readFile(path.join(root, '.aicode', 'automation', 'tasks.json'), 'utf8'));
    assert.equal(raw[0].name, 'Morning checks');

    assert.equal(await fixture.service.delete(created.id), true);
    assert.equal((await fixture.service.list()).length, 0);
  } finally {
    await fixture.service.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('manual run waits for bridge completion and records history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yoy-automation-run-'));
  const fixture = createFixture(root);
  try {
    await fixture.service.setWorkspace(root);
    const task = await fixture.service.create({
      name: 'Manual run',
      trigger: { type: 'manual' },
      action: { type: 'task_board', goal: 'Inspect and verify project', confirmPlan: true },
    });

    const pending = fixture.service.run(task.id);
    const deadline = Date.now() + 1000;
    while (fixture.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(fixture.calls, [{ taskId: task.id, goal: 'Inspect and verify project' }]);
    // Bug-12 fix: automation completion now signals via automationBus, not mainWindow.emit
    automationBus.emit('automation.done', { taskId: task.id, status: 'ok' });
    const result = await pending;

    assert.equal(result.ok, true);
    const stored = await fixture.service.get(task.id);
    assert.equal(stored.lastRunStatus, 'success');
    assert.equal(stored.consecutiveFailures, 0);
    const history = await fixture.service.history(task.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'success');
  } finally {
    await fixture.service.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('three failed runs disable the task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yoy-automation-fail-'));
  const fixture = createFixture(root);
  try {
    await fixture.service.setWorkspace(root);
    const task = await fixture.service.create({
      name: 'Failure guard',
      trigger: { type: 'manual' },
      action: { type: 'task_board', goal: 'Fail safely', confirmPlan: true },
    });
    await fixture.service.start(task.id);

    for (let index = 0; index < 3; index += 1) {
      const callCount = fixture.calls.length;
      const pending = fixture.service.run(task.id);
      const deadline = Date.now() + 1000;
      while (fixture.calls.length === callCount && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(fixture.calls.length, callCount + 1);
      automationBus.emit('automation.done', { taskId: task.id, status: 'error', reason: 'boom' });
      await pending;
    }

    const stored = await fixture.service.get(task.id);
    assert.equal(stored.enabled, false);
    assert.equal(stored.consecutiveFailures, 3);
    assert.equal(stored.lastRunStatus, 'failed');
  } finally {
    await fixture.service.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('cron activation is restored and can be stopped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yoy-automation-cron-'));
  const fixture = createFixture(root);
  try {
    await fixture.service.setWorkspace(root);
    const task = await fixture.service.create({
      name: 'Hourly',
      trigger: { type: 'cron', expression: '0 * * * *' },
      action: { type: 'task_board', goal: 'Run hourly check', confirmPlan: true },
    });
    await fixture.service.start(task.id);
    assert.deepEqual(fixture.service.active(), [{ id: task.id, type: 'cron' }]);

    await fixture.service.stop(task.id);
    assert.deepEqual(fixture.service.active(), []);
  } finally {
    await fixture.service.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('file watch patterns cannot escape the workspace', () => {
  assert.throws(() => normalizeTrigger({
    type: 'file_watch',
    patterns: ['../outside.txt'],
    events: ['modify'],
  }), /inside the workspace/);
  assert.throws(() => normalizeTrigger({
    type: 'file_watch',
    patterns: ['C:/outside/**/*.ts'],
    events: ['modify'],
  }), /inside the workspace/);
});

test('Git event classifier distinguishes local commits, pushes, and pulls', () => {
  const previous = { branch: 'main', head: 'local-a', remote: 'remote-a' };
  assert.equal(classifyGitEvent(previous, { branch: 'main', head: 'local-b', remote: 'remote-a' }, ['commit']), 'commit');
  assert.equal(classifyGitEvent(previous, { branch: 'main', head: 'local-a', remote: 'local-a' }, ['push']), 'push');
  assert.equal(classifyGitEvent(previous, { branch: 'main', head: 'remote-b', remote: 'remote-b' }, ['pull']), 'pull');
  assert.equal(classifyGitEvent(previous, { branch: 'main', head: 'local-b', remote: 'remote-a' }, ['push', 'pull']), undefined);
});

test('workspace changes resolve pending automation runs instead of leaving IPC blocked', async () => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), 'yoy-automation-switch-a-'));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'yoy-automation-switch-b-'));
  const fixture = createFixture(firstRoot);
  try {
    await fixture.service.setWorkspace(firstRoot);
    const task = await fixture.service.create({
      name: 'Pending run',
      trigger: { type: 'manual' },
      action: { type: 'task_board', goal: 'Wait for bridge', confirmPlan: true },
    });

    const pending = fixture.service.run(task.id);
    const deadline = Date.now() + 1000;
    while (fixture.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await fixture.service.setWorkspace(secondRoot);
    const result = await pending;

    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.reason, /workspace changed|app closed/);
  } finally {
    await fixture.service.disposeAll();
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

/*
 * An automation run is unattended and long-lived, so it must not share the
 * user's conversation: the two decisions below are what keep it out. Both are
 * pinned here because main.cjs cannot be loaded without Electron, so nothing
 * else in the suite would catch a regression in them.
 */

test('a run whose agent child dies is failed, not left running for an hour', async () => {
  /*
   * The only thing that used to resolve a run was the child's own
   * `automation_done`. A child that died mid-run never sent one, so the task
   * stayed in `running` — answering every later trigger with `busy` — until the
   * one-hour watchdog fired. The user saw a task that was permanently "running"
   * and could not be re-run, for a run that had in fact died in seconds.
   *
   * The desktop now reports the dead child on the same bus the completion uses.
   */
  const root = await mkdtemp(path.join(os.tmpdir(), 'yoy-automation-died-'));
  const fixture = createFixture(root);
  try {
    await fixture.service.setWorkspace(root);
    const task = await fixture.service.create({
      name: 'Dies mid-run',
      trigger: { type: 'manual' },
      action: { type: 'task_board', goal: 'Start something long', confirmPlan: true },
    });

    const pending = fixture.service.run(task.id);
    const deadline = Date.now() + 1000;
    while (fixture.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(fixture.calls.length, 1, 'the run must have been dispatched');

    // What main.cjs emits when the automation child exits without finishing.
    automationBus.emit('automation.bridge_gone', { reason: '自动化子进程已退出（code 1）' });
    const result = await pending;

    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /退出/);
    const stored = await fixture.service.get(task.id);
    assert.equal(stored.lastRunStatus, 'failed', 'the task must not still read as running');
    assert.equal(stored.consecutiveFailures, 1);

    // And the task must be runnable again immediately, not stuck behind `busy`.
    const second = fixture.service.run(task.id);
    const deadline2 = Date.now() + 1000;
    while (fixture.calls.length < 2 && Date.now() < deadline2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(fixture.calls.length, 2, 'a dead run must not hold the task busy');
    automationBus.emit('automation.done', { taskId: task.id, status: 'ok' });
    await second;
  } finally {
    await fixture.service.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('a run that cannot be recorded still answers its caller', async () => {
  /*
   * `finishRun` reads and writes the task and history files, so it can fail on
   * its own — a corrupt tasks.json is the easy way in. The completion listener
   * used to resolve only on success (`finishRun(...).then(resolve)`, with no
   * rejection handler), which left the awaiting IPC call pending forever: the
   * run was over, but the caller never heard so. The run must always settle.
   */
  const root = await mkdtemp(path.join(os.tmpdir(), 'yoy-automation-unwritable-'));
  const fixture = createFixture(root);
  try {
    await fixture.service.setWorkspace(root);
    const task = await fixture.service.create({
      name: 'Unrecordable',
      trigger: { type: 'manual' },
      action: { type: 'task_board', goal: 'Do the work', confirmPlan: true },
    });

    const pending = fixture.service.run(task.id);
    const deadline = Date.now() + 1000;
    while (fixture.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Corrupt the store the way a partial write or an external edit would, so
    // recording the outcome throws a parse error rather than ENOENT.
    await writeFile(path.join(root, '.aicode', 'automation', 'tasks.json'), '{ not json', 'utf8');
    automationBus.emit('automation.done', { taskId: task.id, status: 'ok' });

    const result = await pending;
    assert.equal(result.status, 'success', 'the run still reports what happened');
    assert.match(result.reason, /未能写入历史/, 'and says the record could not be written');
  } finally {
    await fixture.service.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('a run stopped by a workspace change is not counted as a failure', async () => {
  /*
   * A user switching workspace is not the task failing, so the run resolves as
   * `blocked` and records nothing. Counting it would push a task toward the
   * three-strike auto-disable for the user's own window switch. Pinned because
   * the resolution now goes through `disposeAll` rather than `finishRun`.
   *
   * The death notification that follows teardown must also find nothing to
   * settle — `pendingRuns` is cleared first, so it cannot record the same run a
   * second time.
   */
  const root = await mkdtemp(path.join(os.tmpdir(), 'yoy-automation-race-'));
  const fixture = createFixture(root);
  try {
    await fixture.service.setWorkspace(root);
    const task = await fixture.service.create({
      name: 'Racy run',
      trigger: { type: 'manual' },
      action: { type: 'task_board', goal: 'Work', confirmPlan: true },
    });

    const pending = fixture.service.run(task.id);
    while (fixture.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    await fixture.service.disposeAll();
    // The queued death notification lands after teardown has already resolved it.
    automationBus.emit('automation.bridge_gone', { reason: '自动化子进程已退出（code 1）' });
    const result = await pending;

    assert.equal(result.status, 'blocked', 'teardown wins; the run reports why it stopped');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const history = await fixture.service.history(task.id);
    assert.equal(history.length, 0, `a stopped run must not be recorded, saw ${history.length}`);
    const stored = await fixture.service.get(task.id);
    assert.equal(stored.consecutiveFailures, 0, 'a window switch must not count as a failure');
  } finally {
    await fixture.service.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('a run gets its own session scope, never the conversation one', () => {
  const dir = automationSessionDir('C:\\ws');
  assert.match(dir.replace(/\\/g, '/'), /\.aicode\/sessions-automation$/);
  // Distinct from the conversation scope is the whole point: sharing it would
  // append an unattended run to whatever chat the user is reading.
  assert.notEqual(dir, path.join('C:\\ws', '.aicode', 'sessions'));
});

test('an unattended run never waits for a human, and never escalates on its own', () => {
  // `ask` and `plan` both mean "block until someone answers". A scheduled run
  // has nobody to answer and nothing in the UI can reach it, so it is refused
  // with a reason the user can act on rather than left to fail on a timeout.
  for (const mode of ['ask', 'plan']) {
    const decision = unattendedApprovalDecision(mode);
    assert.equal(decision.ok, false, `${mode} must not run unattended`);
    assert.match(decision.reason, /无人值守|批准模式/);
  }
  // `auto` is NOT the fallback for `ask`: it widens the writable scope to the
  // whole machine (cli/src/safety/policy.ts pathScopeFor). Promoting to it would
  // hand a scheduled task more reach than the user granted its conversations.
  assert.equal(unattendedApprovalDecision('ask').approval, undefined);
  // The two modes that genuinely need no person pass through unchanged.
  assert.deepEqual(unattendedApprovalDecision('auto'), { ok: true, approval: 'auto' });
  assert.deepEqual(unattendedApprovalDecision('deny'), { ok: true, approval: 'deny' });
});
