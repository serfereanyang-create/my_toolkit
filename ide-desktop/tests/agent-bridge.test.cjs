const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AgentBridge, normalizeCliEvent } = require('../electron/agent-bridge.cjs');

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

test('AgentBridge sends automation tasks as structured JSON commands', () => {
  const bridge = new AgentBridge({
    cliRoot: 'C:/cli',
    workspaceRoot: 'C:/workspace',
    sessionDir: 'C:/workspace/.aicode/sessions',
    provider: 'mock',
    model: 'mock',
  });
  let written = '';
  bridge.child = {
    stdin: {
      writable: true,
      write(value) { written += value; },
    },
  };

  bridge.automationTask('auto_123', 'Run tests and verify');

  assert.deepEqual(JSON.parse(written.trim()), {
    type: 'automation_task',
    taskId: 'auto_123',
    goal: 'Run tests and verify',
  });
});
