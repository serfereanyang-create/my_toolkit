'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AgentBridge } = require('../electron/agent-bridge.cjs');

async function waitFor(predicate, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(label);
}

test('a real CLI cancels its HTTP stream, returns queued intent and accepts another turn on the same process', async () => {
  const workspace = path.resolve(__dirname, '..', 'out', 'interrupt-review', 'live-bridge');
  await fs.mkdir(workspace, { recursive: true });
  const attachment = path.join(workspace, 'context.txt'); await fs.writeFile(attachment, 'context data');
  let requests = 0;
  let closed = false;
  const server = createServer((request, response) => {
    request.resume(); requests += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) {
      response.write('data: {"choices":[{"delta":{"content":"partial before stop"}}]}\n\n');
      response.once('close', () => { closed = true; });
    } else response.end(`data: {"choices":[{"delta":{"content":"fresh reply ${requests}"}}]}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const events = [];
  let forced = 0;
  const bridge = new AgentBridge({ cliRoot: path.resolve(__dirname, '..', '..', 'cli'), workspaceRoot: workspace, sessionDir: path.join(workspace, 'sessions'), provider: 'openai', model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-only', approval: 'auto', requestTimeoutMs: 5000, killTree(child) { forced += 1; child.kill('SIGKILL'); } });
  bridge.on('event', event => events.push(event));
  try {
    await bridge.start();
    const child = bridge.child; const sessionId = bridge.sessionId;
    await bridge.prompt('Reply briefly while I inspect cancellation');
    await waitFor(() => events.some(event => event.type === 'assistant_delta' && event.text.includes('partial before stop')), 'real stream never started');
    assert.equal(bridge.isRunning(), true);
    await bridge.prompt('queued one', [{ path: attachment, name: 'context.txt', size: 12 }]);
    await bridge.prompt('queued two');
    await waitFor(() => events.some(event => event.type === 'info' && String(event.message).includes('第 2 条')), 'messages did not reach the backend queue');
    const result = await bridge.interrupt();
    assert.equal(result.mode, 'cooperative');
    await waitFor(() => closed, 'HTTP stream remained connected');
    assert.equal(bridge.child, child); assert.equal(bridge.ready, true); assert.equal(forced, 0);
    assert.equal(bridge.isRunning(), false);
    assert.equal(requests, 1);
    const acknowledgement = events.find(event => event.type === 'cancel_ack');
    assert.deepEqual(acknowledgement.queued.map(message => message.text), ['queued one', 'queued two']);
    assert.equal(acknowledgement.queued[0].files[0].path, attachment);
    const stopped = events.find(event => event.type === 'turn_done');
    assert.equal(stopped.status, 'cancelled'); assert.match(stopped.cancelledReply, /partial before stop/);
    assert.equal(events.some(event => event.type === 'error' || event.type === 'agent_offline'), false);
    const saved = JSON.parse(await fs.readFile(path.join(workspace, 'sessions', `${sessionId}.json`), 'utf8'));
    assert.ok(saved.messages.some(message => message.interrupted && message.content.includes('partial before stop')));
    assert.equal(saved.lastTurn.outcome, 'cancelled');
    await bridge.prompt('Now answer a fresh short message');
    await waitFor(() => events.filter(event => event.type === 'turn_done').length === 2, 'fresh turn did not finish');
    assert.equal(requests, 2); assert.equal(bridge.child, child); assert.equal(bridge.sessionId, sessionId);
    assert.equal(events.filter(event => event.type === 'turn_done')[1].status, 'ok');
    await fs.writeFile(path.join(workspace, 'result.json'), JSON.stringify({ cooperative: true, samePid: child.pid, requests, forced, queued: acknowledgement.queued.map(message => ({ text: message.text, files: message.files })), stoppedStatus: stopped.status }, null, 2));
  } finally { await bridge.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
