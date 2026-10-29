import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGuardConfirmationBroker } from '../src/cli/guardConfirmationBroker.js';

/** Build a channel whose events are captured so tests can answer them. */
function channelWithSink(timeoutMs = 5000) {
  const events: Array<Record<string, unknown>> = [];
  const broker = createGuardConfirmationBroker({
    sessionId: 'sess_test',
    emit: (event) => events.push(event),
    timeoutMs,
  });
  return { broker, events };
}

test('emits guard_confirmation_needed and resolves with the picked label', async () => {
  const { broker, events } = channelWithSink();
  const pending = broker.confirm({
    title: '需求翻译确认',
    question: '这份专业需求表达准确吗？',
    options: [
      { label: '准确，继续', description: '按此需求进入检查或开发' },
      { label: '补充信息', description: '我会补充更多细节' },
    ],
  });
  // The request must reach the renderer before anything can answer it.
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'guard_confirmation_needed');
  assert.equal(events[0].sessionId, 'sess_test');
  const requestId = String(events[0].requestId);
  assert.equal(broker.resolveFromDesktop(requestId, '准确，继续'), true);
  const result = await pending;
  assert.ok(result);
  assert.equal(result.selectedLabel, '准确，继续');
  assert.equal(result.source, 'popup');
});

test('an unknown request id is rejected instead of resolving someone else', async () => {
  const { broker } = channelWithSink();
  void broker.confirm({ title: 't', question: 'q', options: [{ label: 'a', description: 'b' }] });
  assert.equal(broker.resolveFromDesktop('not-a-real-id', 'a'), false);
});

test('a timeout resolves null so the guard falls back to the terminal menu', async () => {
  const { broker, events } = channelWithSink(20);
  const result = await broker.confirm({
    title: 't',
    question: 'q',
    options: [{ label: 'a', description: 'b' }],
  });
  assert.equal(result, null);
  assert.ok(events.some((e) => e.type === 'info' && String(e.message).includes('超时')));
});

test('answering after the timeout is a no-op, not a crash', async () => {
  const { broker, events } = channelWithSink(20);
  await broker.confirm({ title: 't', question: 'q', options: [{ label: 'a', description: 'b' }] });
  const requestId = String(events[0].requestId);
  assert.equal(broker.resolveFromDesktop(requestId, 'a'), false);
});

/*
 * Timeout, cancellation and re-entrancy must not be conflated. The broker used
 * to report a timeout as `guard_confirmation_resolved` — the same event a real
 * answer emits — and the desktop reacts to that event by cancelling, so one
 * silent popup cancelled every later guard prompt for the rest of the session.
 */
test('a timeout is not reported as an answer', async () => {
  const { broker, events } = channelWithSink(10);
  const result = await broker.confirm({ title: 't', question: 'q', options: [{ label: 'a', description: 'b' }] });
  assert.equal(result, null, 'timeout falls back to the terminal menu, it does not pick a label');
  assert.equal(events.some((event) => event.type === 'guard_confirmation_resolved'), false, 'a timeout must not look like a user answer');
  assert.ok(events.some((event) => event.type === 'info' && String(event.message).includes('超时')));
  // After the timeout the broker keeps accepting new questions.
  const next = broker.confirm({ title: 't2', question: 'q2', options: [{ label: 'a', description: 'b' }] });
  assert.equal(broker.resolveFromDesktop(broker.lastRequestId() ?? '', 'a'), true);
  assert.deepEqual(await next, { selectedLabel: 'a', source: 'popup' });
});

test('an answer delivered synchronously from inside the emit resolves the request', async () => {
  // The entry must be installed BEFORE the event goes out; otherwise an
  // embedding that answers from its own handler is told the request is unknown
  // and the popup waits for the full deadline.
  let seen = '';
  const broker = createGuardConfirmationBroker({
    sessionId: 's',
    timeoutMs: 50,
    emit: (event) => {
      if (event.type === 'guard_confirmation_needed') {
        seen = String(event.requestId);
        broker.resolveFromDesktop(seen, '继续');
      }
    },
  });
  assert.deepEqual(await broker.confirm({ title: 't', question: 'q', options: [{ label: '继续', description: 'b' }] }), {
    selectedLabel: '继续',
    source: 'popup',
  });
});

test('a cancelled broker refuses new questions until resumed, and close is permanent', async () => {
  const { broker } = channelWithSink();
  const pending = broker.confirm({ title: 't', question: 'q', options: [{ label: 'a', description: 'b' }] });
  broker.cancelAll('cancel');
  assert.deepEqual(await pending, { selectedLabel: '取消', source: 'auto' }, 'an in-flight question is cancelled, not left to the deadline');
  assert.deepEqual(await broker.confirm({ title: 't', question: 'q', options: [{ label: 'a', description: 'b' }] }), { selectedLabel: '取消', source: 'auto' });
  broker.resume();
  assert.equal(broker.pendingCount, 0);
  void broker.confirm({ title: 't', question: 'q', options: [{ label: 'a', description: 'b' }] });
  assert.equal(broker.pendingCount, 1, 'resume() lets the next question through');
  broker.close();
  assert.deepEqual(await broker.confirm({ title: 't', question: 'q', options: [{ label: 'a', description: 'b' }] }), { selectedLabel: '取消', source: 'auto' });
  broker.resume();
  assert.deepEqual(await broker.confirm({ title: 't', question: 'q', options: [{ label: 'a', description: 'b' }] }), { selectedLabel: '取消', source: 'auto' }, 'close is permanent');
});

test('a second answer for the same request is refused, and an unknown id never resolves anyone', async () => {
  const { broker } = channelWithSink();
  const pending = broker.confirm({ title: 't', question: 'q', options: [{ label: 'a', description: 'b' }] });
  const id = broker.lastRequestId() ?? '';
  const other = broker.confirm({ title: 't2', question: 'q2', options: [{ label: 'a', description: 'b' }] });
  const otherId = broker.lastRequestId() ?? '';
  assert.notEqual(id, otherId);
  assert.equal(broker.resolveFromDesktop(id, 'a'), true);
  assert.equal(broker.resolveFromDesktop(id, 'a'), false, 'a duplicate reply is ignored, not applied twice');
  assert.equal(broker.pendingCount, 1, 'the other request is untouched');
  broker.cancelAll();
  assert.ok(await pending);
  assert.ok(await other);
});
