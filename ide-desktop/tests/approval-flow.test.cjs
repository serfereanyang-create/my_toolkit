const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { AgentBridge } = require('../electron/agent-bridge.cjs');

/*
 * Regression test for the desktop-bridge approval deadlock.
 *
 * The CLI read loop must keep consuming stdin while a turn is awaiting an
 * interactive approval — otherwise the `approval_response` line never gets
 * read, the pending approval never resolves, and the turn hangs forever.
 *
 * This reproduces the exact scenario with the offline mock provider (no
 * network / API key): in `ask` mode the mock's write_file step raises an
 * approval_needed; we respond allow_once; the tool must then execute and the
 * turn must complete. Uses the mock smoke prompt whose write targets .smoke/.
 */

test('ask-mode approval resolves and the write actually executes (no deadlock)', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'yoy-approval-'));
  const events = [];
  let approvals = 0;

  const bridge = new AgentBridge({
    cliRoot: path.resolve(__dirname, '..', '..', 'cli'),
    workspaceRoot: workspace,
    sessionDir: path.join(workspace, '.aicode', 'sessions'),
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'ask',
  });

  bridge.on('event', (event) => {
    events.push(event);
    if (event.type === 'approval_needed') {
      approvals += 1;
      // Approve every prompt so the turn can proceed to completion.
      bridge.approve(event.requestId, 'allow_once');
    }
  });

  bridge.start();
  bridge.prompt('smoke multi-tool task');

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !events.some((e) => e.type === 'turn_done')) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300));
  bridge.dispose();

  // The core assertions: an approval was requested, and after approving, the
  // write tool executed and the turn finished — i.e. the loop did NOT deadlock.
  assert.ok(approvals > 0, 'at least one approval_needed should have been raised in ask mode');
  const writeStart = events.find((e) => e.type === 'tool_start' && e.tool === 'write_file');
  assert.ok(writeStart, 'write_file tool_start should be emitted');
  const writeResult = events.find((e) => e.type === 'tool_result' && e.tool === 'write_file');
  assert.ok(writeResult, 'write_file tool_result should arrive after approval (no deadlock)');
  assert.notEqual(writeResult.ok, false, 'approved write should succeed');
  const turnDone = events.find((e) => e.type === 'turn_done');
  assert.ok(turnDone, 'turn_done should be emitted (turn did not hang)');

  // And the file the mock wrote should exist on disk.
  const written = path.join(workspace, '.smoke', 'multi-tool-result.md');
  const content = await readFile(written, 'utf8');
  assert.ok(content.length > 0, 'the approved write should have landed on disk');

  await rm(workspace, { recursive: true, force: true });
});
