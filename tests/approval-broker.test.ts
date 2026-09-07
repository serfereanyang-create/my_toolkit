import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopApprovalBroker } from '../src/cli/approvalBroker.js';
import type { ApprovalRequest } from '../src/tools/types.js';

function writeRequest(path: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    tool: 'write_file',
    risk: 'write',
    input: { path, content: 'x' },
    reason: 'test write',
    message: 'allow write?',
    ...overrides,
  };
}

function makeBroker(overrides: { timeoutMs?: number } = {}) {
  const events: Array<Record<string, unknown>> = [];
  const broker = new DesktopApprovalBroker('session-1', {
    emit: (event) => events.push(event),
    timeoutMs: overrides.timeoutMs ?? 60_000,
  });
  return { broker, events };
}

test('resolve() delivers the user decision to a pending confirm', async () => {
  const { broker } = makeBroker();
  const pending = broker.confirm('allow?', writeRequest('src/a.ts'));
  broker.resolve(broker.lastRequestId(), 'allow_once');
  assert.equal(await pending, true);
});

test('allow_session caches per directory: same dir auto-allows, other dir re-prompts', async () => {
  const { broker, events } = makeBroker();
  const first = broker.confirm('allow?', writeRequest('src/a.ts'));
  broker.resolve(broker.lastRequestId(), 'allow_session');
  assert.equal(await first, 'allow_session');

  // Same directory: no new approval_needed, resolves true immediately.
  const second = broker.confirm('allow?', writeRequest('src/b.ts'));
  assert.equal(await second, true);
  assert.equal(events.filter((e) => e.type === 'approval_needed').length, 1);

  // Different directory: must prompt again.
  const third = broker.confirm('allow?', writeRequest('docs/c.md'));
  const approvalsBefore = events.filter((e) => e.type === 'approval_needed').length;
  assert.equal(approvalsBefore, 2, 'cross-directory write must raise a new approval');
  broker.resolve(broker.lastRequestId(), 'deny');
  assert.equal(await third, false);
});

test('confirm() times out and resolves as deny with an info event', async () => {
  const { broker, events } = makeBroker({ timeoutMs: 30 });
  const decision = await broker.confirm('allow?', writeRequest('src/a.ts'));
  assert.equal(decision, false, 'timed-out approval must deny');
  assert.ok(
    events.some((e) => e.type === 'info' && String(e.message).includes('审批超时')),
    'timeout must emit an info event explaining the deny',
  );
  assert.equal(broker.pendingCount, 0, 'timed-out request must leave the pending map');
});

test('denyAll() denies every pending approval with a reason event', async () => {
  const { broker, events } = makeBroker();
  const a = broker.confirm('allow?', writeRequest('src/a.ts'));
  const b = broker.confirm('allow?', writeRequest('lib/b.ts'));
  broker.denyAll('Bridge is shutting down');
  assert.equal(await a, false);
  assert.equal(await b, false);
  assert.equal(broker.pendingCount, 0);
  assert.ok(events.some((e) => e.type === 'info' && String(e.message).includes('Bridge is shutting down')));
});

test('non-write risks never use the session-allow cache', async () => {
  const { broker, events } = makeBroker();
  const shellFirst = broker.confirm('run?', {
    tool: 'run_command',
    risk: 'shell',
    input: { command: 'ls' },
    reason: 'shell',
    message: 'run?',
  });
  broker.resolve(broker.lastRequestId(), 'allow_session');
  assert.equal(await shellFirst, 'allow_session');

  const shellSecond = broker.confirm('run again?', {
    tool: 'run_command',
    risk: 'shell',
    input: { command: 'rm -rf /' },
    reason: 'shell',
    message: 'run again?',
  });
  assert.equal(events.filter((e) => e.type === 'approval_needed').length, 2, 'shell must always re-prompt');
  broker.resolve(broker.lastRequestId(), 'deny');
  assert.equal(await shellSecond, false);
});
