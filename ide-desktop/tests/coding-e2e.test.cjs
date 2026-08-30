const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { AgentBridge } = require('../electron/agent-bridge.cjs');

/*
 * End-to-end "can it actually code?" test. Drives the real desktop AgentBridge
 * against the built CLI (mock provider, no network) and asserts the agent
 * translates a natural-language request into a real write_file tool call that
 * lands an actual file on disk in the workspace. This exercises the full path:
 * bridge spawn -> CLI desktop-bridge protocol -> agent loop -> tool registry ->
 * filesystem, with auto approval so writes proceed without a prompt.
 */

function runTurn(bridge, events, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('timed out waiting for turn_done')), timeoutMs);
    const timer = setInterval(() => {
      if (events.some((e) => e.type === 'turn_done')) {
        clearInterval(timer);
        clearTimeout(deadline);
        resolve();
      }
    }, 50);
  });
}

test('agent writes real code to disk from a natural-language request (e2e)', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zcode-coding-e2e-'));
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

  // Natural-language coding request: "write" + an explicit .smoke path.
  bridge.prompt('请创建文件 .smoke/hello.md 写入一段说明');
  await runTurn(bridge, events);
  bridge.dispose();

  // The agent must have invoked write_file and reported success.
  const toolStart = events.find((e) => e.type === 'tool_start' && e.tool === 'write_file');
  assert.ok(toolStart, 'expected a write_file tool_start event');
  const toolResult = events.find((e) => e.type === 'tool_result' && e.tool === 'write_file');
  assert.ok(toolResult, 'expected a write_file tool_result event');
  assert.notEqual(toolResult.ok, false, 'write_file tool_result should be ok');
  const turnDone = events.find((e) => e.type === 'turn_done');
  assert.equal(turnDone.status, 'ok', 'turn should complete ok');

  // The file must actually exist on disk with non-empty content.
  const written = path.join(workspace, '.smoke', 'hello.md');
  const info = await stat(written);
  assert.ok(info.isFile(), 'the requested file should exist on disk');
  const content = await readFile(written, 'utf8');
  assert.ok(content.length > 0, 'the written file should have content');

  await rm(workspace, { recursive: true, force: true });
});
