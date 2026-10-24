const assert = require('node:assert/strict');
const { mkdtemp, rm, readdir, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { AgentBridge } = require('../electron/agent-bridge.cjs');

const CLI_ROOT = path.resolve(__dirname, '..', '..', 'cli');

function waitFor(events, type, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (events.some((event) => event.type === type)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${type}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function readSession(sessionDir, id) {
  return JSON.parse(await readFile(path.join(sessionDir, `${id}.json`), 'utf8'));
}

test('AgentBridge resumes a persisted session and keeps its message history', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zcode-resume-'));
  const sessionDir = path.join(workspace, '.aicode', 'sessions');

  // First run: create a session and complete one turn.
  const firstEvents = [];
  const first = new AgentBridge({
    cliRoot: CLI_ROOT,
    workspaceRoot: workspace,
    sessionDir,
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
  });
  first.on('event', (event) => firstEvents.push(event));
  first.start();
  await waitFor(firstEvents, 'bridge_ready');
  const ready = firstEvents.find((event) => event.type === 'bridge_ready');
  const sessionId = ready.sessionId;
  assert.ok(sessionId, 'bridge_ready reports a sessionId');

  first.prompt('hello there');
  await waitFor(firstEvents, 'turn_done');
  first.dispose();
  await new Promise((r) => setTimeout(r, 300));

  const afterFirst = await readSession(sessionDir, sessionId);
  const messagesAfterFirst = afterFirst.messages.length;
  assert.ok(messagesAfterFirst > 0, 'first turn persisted messages');

  // Second run: resume the same session id.
  const secondEvents = [];
  const second = new AgentBridge({
    cliRoot: CLI_ROOT,
    workspaceRoot: workspace,
    sessionDir,
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    resumeSessionId: sessionId,
  });
  second.on('event', (event) => secondEvents.push(event));
  second.start();
  await waitFor(secondEvents, 'bridge_ready');
  const resumedReady = secondEvents.find((event) => event.type === 'bridge_ready');
  assert.equal(resumedReady.sessionId, sessionId, 'resumed bridge reports the same session id');

  second.prompt('and again');
  await waitFor(secondEvents, 'turn_done');
  second.dispose();
  await new Promise((r) => setTimeout(r, 300));

  // Only one session file should exist (resume did not fork a new session).
  const files = (await readdir(sessionDir)).filter((n) => n.endsWith('.json') && n !== '.desktop-meta.json');
  assert.equal(files.length, 1, 'resume reuses the same session file');

  const afterSecond = await readSession(sessionDir, sessionId);
  assert.ok(
    afterSecond.messages.length > messagesAfterFirst,
    'resumed session accumulated more messages on top of prior history',
  );

  await rm(workspace, { recursive: true, force: true });
});

test('a restart keeps the session and re-announces it, so settings can change', async () => {
  /*
   * Why this matters for the model switcher: provider, model, approval mode and
   * the background-browser flags are all passed to the CLI as argv, so a child
   * that was already running keeps announcing its OLD model in bridge_ready
   * forever. `agent/bind` after a restart is the renderer's only way to learn
   * the settings actually took effect — so the replacement child must announce
   * the session again, under the same id, having picked up the new argv.
   */
  const workspace = await mkdtemp(path.join(tmpdir(), 'zcode-restart-'));
  const sessionDir = path.join(workspace, '.aicode', 'sessions');

  const events = [];
  const bridge = new AgentBridge({
    cliRoot: CLI_ROOT,
    workspaceRoot: workspace,
    sessionDir,
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
  });
  bridge.on('event', (event) => events.push(event));
  await bridge.start();
  await waitFor(events, 'bridge_ready');
  const sessionId = events.find((event) => event.type === 'bridge_ready').sessionId;
  assert.ok(sessionId);

  bridge.prompt('first turn');
  await waitFor(events, 'turn_done');

  // What settings.set + agent.restart does: swap the model, respawn, rebind.
  events.length = 0;
  bridge.setModel?.('mock-code-agent-v1');
  const restarted = await bridge.restart(sessionId);
  assert.equal(restarted.sessionId, sessionId, 'the restart reports the same session id');
  const ready = events.find((event) => event.type === 'bridge_ready');
  assert.ok(ready, 'the replacement child must announce bridge_ready again');
  assert.equal(ready.sessionId, sessionId, 'the session id survives the restart');
  assert.equal(ready.model, 'mock-code-agent-v1', 'bridge_ready re-reports the model the child actually runs');

  // The session must still be usable after the restart, on the same file.
  events.length = 0;
  bridge.prompt('after restart');
  await waitFor(events, 'turn_done');
  const files = (await readdir(sessionDir)).filter((n) => n.endsWith('.json') && n !== '.desktop-meta.json');
  assert.equal(files.length, 1, 'a restart must not fork the session');
  const record = await readSession(sessionDir, sessionId);
  assert.ok(record.messages.length > 0, 'the restarted session kept its history');

  await bridge.dispose();
  await rm(workspace, { recursive: true, force: true });
});
