'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { AgentBridge } = require('../electron/agent-bridge.cjs');
const { serveHostToolRequests } = require('../electron/host-tool-service.cjs');

function bridgeFixture(options = {}) {
  let killed = 0;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { writable: true, write(value) { child.commands.push(JSON.parse(value)); } }; child.commands = [];
  const bridge = new AgentBridge({ cliRoot: 'C:/fixture', workspaceRoot: 'C:/fixture', sessionDir: 'C:/fixture/sessions', provider: 'mock', model: 'mock', spawnProcess: () => child, killTree() { killed += 1; child.emit('exit', 0); }, ...options });
  bridge.start();
  const emit = event => child.stdout.emit('data', `${JSON.stringify(event)}\n`);
  emit({ type: 'bridge_ready', sessionId: 'fixture-session' });
  return { child, bridge, emit, killed: () => killed };
}

test('cooperative interrupt keeps the process and accepts a fresh prompt without leaking cancelled deltas', async () => {
  const fixture = bridgeFixture();
  const events = []; fixture.bridge.on('event', event => events.push(event));
  await fixture.bridge.prompt('first');
  const stopping = fixture.bridge.interrupt();
  assert.equal(fixture.bridge.interrupt(), stopping);
  fixture.emit({ type: 'assistant_delta', text: 'stale' });
  fixture.emit({ type: 'cancel_ack', sessionId: 'fixture-session' });
  fixture.emit({ type: 'turn_done', status: 'cancelled', sessionId: 'fixture-session' });
  assert.equal((await stopping).mode, 'cooperative');
  assert.equal(fixture.killed(), 0);
  assert.equal(fixture.bridge.child, fixture.child);
  assert.equal(fixture.bridge.ready, true);
  assert.equal(events.some(event => event.type === 'agent_offline'), false);
  assert.equal(events.some(event => event.type === 'assistant_delta'), false);
  fixture.emit({ type: 'assistant_delta', text: 'even later' });
  assert.equal(events.some(event => event.type === 'assistant_delta'), false);
  await fixture.bridge.prompt('fresh');
  fixture.emit({ type: 'assistant_delta', text: 'fresh' });
  fixture.emit({ type: 'turn_done', status: 'ok', sessionId: 'fixture-session' });
  assert.equal(events.find(event => event.type === 'assistant_delta').text, 'fresh');
  assert.equal(fixture.child.commands.filter(command => command.type === 'cancel').length, 1);
  await fixture.bridge.cancel();
});

test('an ignored interrupt has a bounded fallback that terminates only its owned child', async () => {
  const fixture = bridgeFixture({ interruptTimeoutMs: 20 });
  const unrelated = bridgeFixture();
  await fixture.bridge.prompt('first');
  assert.equal((await fixture.bridge.interrupt()).mode, 'terminated');
  assert.equal(fixture.killed(), 1);
  assert.equal(fixture.bridge.child, null);
  assert.equal(unrelated.killed(), 0);
  assert.equal(unrelated.bridge.ready, true);
  await unrelated.bridge.cancel();
});

test('a process exit during interruption settles immediately and is classified as expected', async () => {
  const fixture = bridgeFixture();
  const events = []; fixture.bridge.on('event', event => events.push(event));
  await fixture.bridge.prompt('first');
  const pending = fixture.bridge.interrupt(); fixture.child.emit('exit', 0);
  assert.equal((await pending).mode, 'terminated');
  assert.equal(events.find(event => event.type === 'agent_offline').expected, true);
  assert.equal(fixture.killed(), 0);
});

test('restarting or disposing an idle bridge does not invent a cancelled task', async () => {
  const fixture = bridgeFixture(); const events = []; fixture.bridge.on('event', event => events.push(event));
  await fixture.bridge.cancel();
  assert.equal(events.some(event => event.type === 'turn_done'), false);
  assert.equal(events.filter(event => event.type === 'agent_offline').length, 1);
});

test('a refused termination never reports a completed stop or starts a replacement child', async () => {
  const fixture = bridgeFixture({ interruptTimeoutMs: 10, killTree() { throw new Error('termination refused'); } });
  const events = []; fixture.bridge.on('event', event => events.push(event));
  await fixture.bridge.prompt('first');
  await assert.rejects(fixture.bridge.interrupt(), /termination refused/);
  assert.equal(events.some(event => event.type === 'turn_done' || event.type === 'agent_offline'), false);
  assert.equal(fixture.bridge.processes.has(fixture.child), true);
  await assert.rejects(fixture.bridge.start(), /termination refused/);
  fixture.child.emit('exit', 0);
});

test('host request cancellation is correlated per bridge and suppresses late replies', async () => {
  const first = new EventEmitter(); const second = new EventEmitter();
  const replies = []; const pending = [];
  for (const bridge of [first, second]) bridge.sendHostToolResponse = async (requestId, result) => { replies.push({ bridge, requestId, result }); };
  const service = { execute(request) { return new Promise(resolve => { pending.push({ request, resolve }); request.signal.addEventListener('abort', () => resolve({ ok: false, output: 'cancelled' }), { once: true }); }); } };
  const server = serveHostToolRequests(first, { backgroundApp: service, workspaceRoot: () => 'C:/first', sessionOf: () => 'first' });
  serveHostToolRequests(second, { backgroundApp: service, workspaceRoot: () => 'C:/second', sessionOf: () => 'second' });
  first.emit('host_tool_request', { requestId: 'first-request', tool: 'background_app_open', input: { path: '.' } });
  second.emit('host_tool_request', { requestId: 'second-request', tool: 'background_app_open', input: { path: '.' } });
  await new Promise(resolve => setImmediate(resolve));
  first.emit('host_tool_cancel', { requestIds: ['second-request'] });
  assert.equal(pending[1].request.signal.aborted, false);
  await server.cancelPending();
  assert.equal(pending[0].request.signal.aborted, true);
  assert.equal(pending[1].request.signal.aborted, false);
  pending[1].resolve({ ok: true, output: 'second still succeeds' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].requestId, 'second-request');
});
