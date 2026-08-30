const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { classifyGitEvent, createAutomationService, normalizeTrigger, automationBus } = require('../electron/automation.cjs');

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
