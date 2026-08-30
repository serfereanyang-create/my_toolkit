const assert = require('node:assert/strict');
const { mkdtemp, rm, mkdir, writeFile, readdir, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { AgentBridge } = require('../electron/agent-bridge.cjs');

const CLI_ROOT = path.resolve(__dirname, '..', '..', 'cli');

function waitFor(events, type, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const match = events.find((event) => event.type === type);
      if (match) return resolve(match);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${type}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test('AgentBridge prompt files become real CLI attachments', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zcode-attach-bridge-'));
  const sessionDir = path.join(workspace, '.aicode', 'sessions');
  const sourceDir = path.join(workspace, 'input');
  await mkdir(sourceDir, { recursive: true });
  const sourceFile = path.join(sourceDir, 'notes.txt');
  await writeFile(sourceFile, 'bridge attachment text', 'utf8');

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
  bridge.start();

  try {
    const ready = await waitFor(events, 'bridge_ready');
    const sessionId = ready.sessionId;
    assert.ok(sessionId, 'bridge_ready reports a session id');

    bridge.prompt('please inspect attached file', [
      { path: sourceFile, name: 'notes.txt', size: Buffer.byteLength('bridge attachment text') },
    ]);

    await waitFor(events, 'turn_done');

    const attachmentRoot = path.join(workspace, '.aicode', 'attachments', sessionId);
    const files = await readdir(attachmentRoot);
    assert.ok(files.some((name) => name.endsWith('_notes.txt')), 'attachment copied into CLI attachment store');

    const session = JSON.parse(await readFile(path.join(sessionDir, `${sessionId}.json`), 'utf8'));
    assert.equal(session.id, sessionId, 'session file is readable after attached turn');
    assert.ok(Array.isArray(session.messages), 'session shape remains valid');
  } finally {
    bridge.dispose();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(workspace, { recursive: true, force: true });
  }
});
