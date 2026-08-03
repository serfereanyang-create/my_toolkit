const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { AgentBridge } = require('../electron/agent-bridge.cjs');

test('AgentBridge runs the cli mock provider and forwards events', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zcode-desktop-smoke-'));
  const events = [];
  const bridge = new AgentBridge({
    cliRoot: path.resolve(__dirname, '..', '..', 'cli'),
    workspaceRoot: workspace,
    sessionDir: path.join(workspace, '.aicode', 'sessions'),
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
  });
  bridge.on('event', (event) => events.push(event));
  bridge.start();
  bridge.prompt('smoke multi-tool task');

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !events.some((event) => event.type === 'turn_done')) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
  }
  bridge.dispose();

  assert.ok(events.some((event) => event.type === 'bridge_ready'));
  assert.ok(events.some((event) => event.type === 'tool_start'));
  assert.ok(events.some((event) => event.type === 'tool_result'));
  assert.ok(events.some((event) => event.type === 'turn_done'));

  await rm(workspace, { recursive: true, force: true });
});
