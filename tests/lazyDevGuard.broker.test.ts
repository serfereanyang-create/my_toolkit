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
