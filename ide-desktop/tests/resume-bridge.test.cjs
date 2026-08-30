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
