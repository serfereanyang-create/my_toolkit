import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AutomationScheduler } from '../src/automation/scheduler.js';
import { AutomationManager } from '../src/automation/manager.js';
import { validateCronExpression } from '../src/automation/cron.js';
import { triggerInvalidReason } from '../src/automation/store.js';
import type { AutomationTask } from '../src/automation/types.js';

function cronTask(expression: unknown): AutomationTask {
  return {
    id: 'cron_task',
    name: 'cron task',
    enabled: true,
    trigger: { type: 'cron', expression: expression as string },
    action: { type: 'task_board', goal: 'goal', confirmPlan: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function recordingProvider() {
  const created: Array<{ title: string; cron: string; prompt: string }> = [];
  return {
    created,
    provider: {
      create: async (input: { title: string; cron: string; prompt: string }) => {
        created.push(input);
        return `host-${created.length}`;
      },
      delete: async () => {},
      list: async () => [],
    },
  };
}

test('scheduler rejects expressions a host cannot fire instead of registering them', async () => {
  // Probe before the fix: all of these were accepted by the provider.
  const cases = [
    'not a cron',
    '99 99 * * *',
    '* * * *',
    '0 9 * * * extra',
    '@daily',
    '* * * * * *',
    '*/0 * * * *',
    '0 0 * jan-13 *',
    '0 0 * * 9',
    '0 0 0 * *',
    '0 0 * * * # comment',
  ];
  const { created, provider } = recordingProvider();
  const scheduler = new AutomationScheduler({ cronProvider: provider });
  for (const expression of cases) {
    await assert.rejects(
      () => scheduler.startTask(cronTask(expression)),
      /invalid cron expression|cron expression is empty/,
      `expression ${JSON.stringify(expression)} must be rejected`,
    );
  }
  assert.deepEqual(created, [], 'no host registration may happen for an invalid expression');
});

test('scheduler accepts the documented cron forms and registers them once', async () => {
  const accepted = [
    '0 9 * * *',
    '*/30 * * * *',
    '0 0 * * 1',
    '0 */2 * * *',
    '0 9 * * 1-5',
    '15,45 8-18/2 1,15 * *',
    '0 0 * jan-mar mon-fri',
    '0 7 * * 0,6',
    '0 22 * * 1-5',
  ];
  const { created, provider } = recordingProvider();
  const scheduler = new AutomationScheduler({ cronProvider: provider });
  for (const [index, expression] of accepted.entries()) {
    assert.equal(validateCronExpression(expression), null, `${expression} should be valid`);
    // Distinct ids: a repeated id is the "already started" path, covered below.
    const id = await scheduler.startTask({ ...cronTask(expression), id: `cron_${index}` });
    assert.match(id, /^host-/);
  }
  assert.equal(created.length, accepted.length);
  // Starting the same task twice must not create a second host schedule.
  const task = { ...cronTask('0 9 * * *'), id: 'cron_same' };
  const first = await scheduler.startTask(task);
  const second = await scheduler.startTask(task);
  assert.equal(first, second);
  assert.equal(created.length, accepted.length + 1, 'only the first start of a given task registers');
});

test('scheduler reports a non-string expression instead of throwing a TypeError', async () => {
  const { provider } = recordingProvider();
  const scheduler = new AutomationScheduler({ cronProvider: provider });
  await assert.rejects(
    () => scheduler.startTask(cronTask(12345)),
    /cron expression must be a string, got number/,
  );
});

test('persisted trigger validation rejects shapes the managers cannot honour', () => {
  assert.equal(triggerInvalidReason({ type: 'cron', expression: '0 9 * * *' }), null);
  assert.match(triggerInvalidReason({ type: 'cron', expression: 12345 }) ?? '', /non-empty string/);
  assert.match(triggerInvalidReason({ type: 'file_watch', patterns: [], events: ['modify'] }) ?? '', /patterns/);
  assert.match(triggerInvalidReason({ type: 'file_watch', patterns: ['src/**'], events: ['explode'] }) ?? '', /events/);
  assert.match(triggerInvalidReason({ type: 'file_watch', patterns: ['src/**'], events: ['modify'], debounceMs: -1 }) ?? '', /debounceMs/);
  assert.match(triggerInvalidReason({ type: 'git_event', events: [] }) ?? '', /events/);
  assert.match(triggerInvalidReason({ type: 'git_event', events: ['commit'], branches: [42] }) ?? '', /branches/);
  assert.equal(triggerInvalidReason({ type: 'manual' }), null);
  assert.match(triggerInvalidReason({ type: 'telepathy' }) ?? '', /unknown trigger type/);
  assert.match(triggerInvalidReason(null) ?? '', /must be an object/);
});

test('manager refuses to create or update a task with an unusable trigger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-automation-trigger-'));
  try {
    const manager = new AutomationManager(root);
    await assert.rejects(
      () => manager.createTask({ name: 'n', trigger: { type: 'cron', expression: '99 99 * * *' }, goal: 'g', confirmPlan: true }),
      /Invalid automation trigger: minute field/,
    );
    await assert.rejects(
      () => manager.createTask({ name: 'n', trigger: { type: 'file_watch', patterns: ['../**'], events: ['modify'] }, goal: 'g', confirmPlan: true }),
      /escapes the workspace root/,
    );
    assert.deepEqual(await manager.listTasks(), [], 'a rejected definition must not be persisted');

    const task = await manager.createTask({ name: 'n', trigger: { type: 'manual' }, goal: 'g', confirmPlan: true });
    await assert.rejects(
      () => manager.updateTask(task.id, { trigger: { type: 'cron', expression: 'nope' } }),
      /Invalid automation trigger/,
    );
    const stored = await manager.getTask(task.id);
    assert.equal(stored?.trigger.type, 'manual', 'the rejected update must not change the stored trigger');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── randomized: verdicts against an independently constructed ground truth ──

/** mulberry32 — deterministic PRNG so a failing run prints a replayable seed. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('randomized: cron verdicts match an independent oracle', () => {
  const seed = 0x5eed1234;
  const rand = mulberry32(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;

  // Pieces are drawn without regard to which field they land in; the oracle
  // below decides legality from the value and the field's range, so a piece
  // that is fine for minutes but out of range for hours is judged correctly.
  const pieces = [
    '*', '0', '59', '23', '7', '*/2', '1-5', '0-59', '1,15', '10-20/5', '5/2', '*/1', '0,30', '59/2',
    '60', '99', '-1', '1-', '-5', '*/0', 'a', '1--2', '', '1,,2', '*/-3', '5-1', '1,', ',1',
    'jan', 'DEC', 'feb-mar', '1-12', 'jan,jul', '*/3', 'jan-13', '13', 'xto',
    'sun', 'SAT', 'mon-fri', '0-7', '1,3,5', '8', 'sun-mon-sat', 'mon-',
  ];
  const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const NAMES = [
    null, null, null,
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
    ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
  ];

  const oracleFieldOk = (field: string, fieldIndex: number): boolean => {
    if (field === '') return false;
    const [min, max] = RANGES[fieldIndex]!;
    const value = (raw: string): number | null => {
      const lower = raw.toLowerCase();
      const list = NAMES[fieldIndex];
      if (list && list.includes(lower)) return 1; // names are in range by definition
      if (!/^\d+$/.test(lower)) return null;
      const n = Number(lower);
      return n >= min && n <= max ? n : null;
    };
    return field.split(',').every((part) => {
      if (!part) return false;
      const slash = part.indexOf('/');
      const body = slash >= 0 ? part.slice(0, slash) : part;
      if (slash >= 0) {
        const step = part.slice(slash + 1);
        if (!/^\d+$/.test(step) || Number(step) < 1) return false;
      }
      if (body === '*') return true;
      if (body.includes('-')) {
        const ranges = body.split('-');
        if (ranges.length !== 2) return false;
        return value(ranges[0]!) !== null && value(ranges[1]!) !== null;
      }
      return value(body) !== null;
    });
  };

  for (let caseIndex = 0; caseIndex < 500; caseIndex += 1) {
    const fields = Array.from({ length: 5 }, () => pick(pieces));
    const expression = fields.join(' ');
    const expected = fields.every((field, index) => oracleFieldOk(field, index));
    const actual = validateCronExpression(expression) === null;
    assert.equal(actual, expected, `seed=${seed} case=${caseIndex} expression=${JSON.stringify(expression)}`);
  }
});

test('randomized: whitespace variants of a valid expression stay valid', () => {
  const seed = 0xc0ffee;
  const rand = mulberry32(seed);
  for (let i = 0; i < 100; i += 1) {
    const gaps = Array.from({ length: 4 }, () => ' '.repeat(1 + Math.floor(rand() * 5)));
    const expression = `0${gaps[0]}9${gaps[1]}*${gaps[2]}*${gaps[3]}1-5`;
    assert.equal(validateCronExpression(expression), null, `seed=${seed} case=${i} ${JSON.stringify(expression)}`);
  }
});

test('store keeps a quarantined copy of the unreadable tasks file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-automation-quarantine-'));
  try {
    const manager = new AutomationManager(root);
    const good = await manager.createTask({ name: 'good', trigger: { type: 'manual' }, goal: 'g', confirmPlan: true });
    const tasksPath = join(root, '.aicode', 'automation', 'tasks.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tasksPath, '[{"id":"torn",', 'utf8');
    assert.deepEqual(await manager.listTasks(), []);
    const files = await readdir(join(root, '.aicode', 'automation'));
    assert.ok(files.some((file) => file.startsWith('tasks.json.corrupt-')), 'the unreadable bytes must be preserved');
    const quarantined = files.find((file) => file.startsWith('tasks.json.corrupt-'))!;
    assert.equal(await readFile(join(root, '.aicode', 'automation', quarantined), 'utf8'), '[{"id":"torn",');
    // The store is usable again immediately.
    const next = await manager.createTask({ name: 'next', trigger: { type: 'manual' }, goal: 'g', confirmPlan: true });
    assert.deepEqual((await manager.listTasks()).map((task) => task.id), [next.id]);
    void good;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
