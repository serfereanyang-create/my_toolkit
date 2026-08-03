const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeCliEvent } = require('../electron/agent-bridge.cjs');

test('normalizeCliEvent maps assistant content to assistant_message', () => {
  assert.deepEqual(normalizeCliEvent({ type: 'assistant', content: 'done' }), {
    type: 'assistant_message',
    text: 'done',
  });
});

test('normalizeCliEvent maps assistant_delta content to text', () => {
  assert.deepEqual(normalizeCliEvent({ type: 'assistant_delta', content: 'he' }), {
    type: 'assistant_delta',
    text: 'he',
  });
});

test('normalizeCliEvent keeps tool events intact', () => {
  const event = { type: 'tool_start', tool: 'read_file', input: { path: 'a.ts' } };
  assert.deepEqual(normalizeCliEvent(event), event);
});
