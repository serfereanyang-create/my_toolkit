import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AutomationStore, validateTaskEntry } from '../src/automation/store.js';
import { AutomationManager } from '../src/automation/manager.js';
import type { AutomationTask } from '../src/automation/types.js';

function task(id: string, extra: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id,
    name: id,
    enabled: false,
    trigger: { type: 'manual' },
    action: { type: 'task_board', goal: 'goal', confirmPlan: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

async function tempWorkspace(name: string) {
  const root = await mkdtemp(join(tmpdir(), `aicode-automation-store-${name}-`));
  return {
    root,
    automationDir: join(root, '.aicode', 'automation'),
    tasksPath: join(root, '.aicode', 'automation', 'tasks.json'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('store: a truncated tasks.json does not poison reads or future saves', async () => {
  const ws = await tempWorkspace('truncated');
  try {
    await mkdir(ws.automationDir, { recursive: true });
    // What a kill mid-write used to leave behind.
    await writeFile(ws.tasksPath, '[{"id":"a","name":"a"', 'utf8');

    const store = new AutomationStore(ws.root);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.load('a'), undefined);
    await store.save(task('b'));
    assert.deepEqual((await store.list()).map((item) => item.id), ['b']);
    // The unreadable bytes were kept aside, not silently dropped.
    const files = await readdir(ws.automationDir);
    const quarantined = files.filter((file) => file.startsWith('tasks.json.corrupt-'));
    assert.equal(quarantined.length, 1);
    assert.equal(await readFile(join(ws.automationDir, quarantined[0]!), 'utf8'), '[{"id":"a","name":"a"');
  } finally {
    await ws.cleanup();
  }
});

test('store: invalid JSON and a non-array root both start empty', async () => {
  const ws = await tempWorkspace('garbage');
  try {
    await mkdir(ws.automationDir, { recursive: true });
    const store = new AutomationStore(ws.root);
    for (const content of ['garbage{', 'null', '{"tasks":[]}', '42']) {
      await writeFile(ws.tasksPath, content, 'utf8');
      assert.deepEqual(await store.list(), [], `content ${content} must read as empty`);
    }
  } finally {
    await ws.cleanup();
  }
});

test('store: one malformed entry is dropped, the others survive', async () => {
  const ws = await tempWorkspace('entries');
  try {
    const manager = new AutomationManager(ws.root);
    const kept = await manager.createTask({ name: 'kept', trigger: { type: 'manual' }, goal: 'g', confirmPlan: true });
    const raw = JSON.parse(await readFile(ws.tasksPath, 'utf8')) as unknown[];
    raw.unshift(
      null,
      { id: 'num_cron', name: 'n', enabled: true, trigger: { type: 'cron', expression: 12345 }, action: { type: 'task_board', goal: 'g', confirmPlan: true } },
      { id: 'no_goal', name: 'n', enabled: true, trigger: { type: 'manual' }, action: { type: 'task_board', confirmPlan: true } },
      { id: 'bad_events', name: 'n', enabled: true, trigger: { type: 'file_watch', patterns: ['src/**'], events: ['explode'] }, action: { type: 'task_board', goal: 'g', confirmPlan: true } },
    );
    await writeFile(ws.tasksPath, JSON.stringify(raw), 'utf8');

    const tasks = await manager.listTasks();
    assert.deepEqual(tasks.map((item) => item.id), [kept.id]);
    // And the task that used to throw `trigger.expression.trim is not a function`
    // is simply absent rather than crashing startTask.
    await assert.rejects(() => manager.startTask('num_cron'), /Task not found: num_cron/);
  } finally {
    await ws.cleanup();
  }
});

test('store: persisted fields are normalized so hand edits cannot arm a task', () => {
  const verdict = validateTaskEntry({
    id: 'x',
    name: 'x',
    enabled: 'false', // a string used to read as truthy
    trigger: { type: 'manual' },
    action: { type: 'task_board', goal: 'g', confirmPlan: 'yes', maxTasks: 3.7 }, // used to auto-confirm
    consecutiveFailures: -4,
  });
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;
  assert.equal(verdict.task.enabled, false);
  assert.equal(verdict.task.action.confirmPlan, false);
  assert.equal(verdict.task.consecutiveFailures, 0);
  assert.equal(verdict.task.action.maxTasks, 3);

  const enabled = validateTaskEntry({ id: 'y', name: 'y', enabled: true, trigger: { type: 'manual' }, action: { type: 'task_board', goal: 'g', confirmPlan: true } });
  assert.equal(enabled.ok && enabled.task.enabled, true);
});

test('store: a corrupt history file is quarantined instead of failing every run', async () => {
  const ws = await tempWorkspace('history');
  try {
    const store = new AutomationStore(ws.root);
    const historyDir = join(ws.automationDir, 'history');
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, 't.json'), '{"taskId":"t","results":[{"status":', 'utf8');
    assert.deepEqual(await store.getHistory('t', 5), []);
    await store.recordExecution('t', { status: 'success', executedAt: '2026-01-01T00:00:00.000Z' });
    const history = JSON.parse(await readFile(join(historyDir, 't.json'), 'utf8')) as { results: unknown[] };
    assert.equal(history.results.length, 1);
    const files = await readdir(historyDir);
    assert.ok(files.some((file) => file.startsWith('t.json.corrupt-')));

    await writeFile(join(historyDir, 'u.json'), '{"taskId":"u","results":"oops"}', 'utf8');
    assert.deepEqual(await store.getHistory('u', 5), []);
  } finally {
    await ws.cleanup();
  }
});

test('store: getHistory(0) returns nothing instead of the whole history', async () => {
  const ws = await tempWorkspace('limit-zero');
  try {
    const store = new AutomationStore(ws.root);
    await store.recordExecution('t', { status: 'success', executedAt: '2026-01-01T00:00:00.000Z' });
    await store.recordExecution('t', { status: 'failed', executedAt: '2026-01-02T00:00:00.000Z' });
    // slice(-0) is slice(0): the old code returned both entries.
    assert.deepEqual(await store.getHistory('t', 0), []);
    assert.equal((await store.getHistory('t', 1)).length, 1);
    assert.equal((await store.getHistory('t', 10)).length, 2);
  } finally {
    await ws.cleanup();
  }
});

test('store: two instances writing concurrently do not lose entries', async () => {
  const ws = await tempWorkspace('concurrency');
  try {
    const a = new AutomationStore(ws.root);
    const b = new AutomationStore(ws.root);
    await Promise.all([
      ...Array.from({ length: 15 }, (_, index) => a.save(task(`a${index}`))),
      ...Array.from({ length: 15 }, (_, index) => b.save(task(`b${index}`))),
    ]);
    const stored = JSON.parse(await readFile(ws.tasksPath, 'utf8')) as AutomationTask[];
    // Before the cross-process lock one side's whole read-modify-write was lost
    // (probe: 20 + 20 saves → 20 tasks).
    assert.equal(stored.length, 30);
    assert.equal(new Set(stored.map((item) => item.id)).size, 30);
  } finally {
    await ws.cleanup();
  }
});
