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

test('AgentBridge sends automation tasks as structured JSON commands', async () => {
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

  await bridge.automationTask('auto_123', 'Run tests and verify');

  assert.deepEqual(JSON.parse(written.trim()), {
    type: 'automation_task',
    taskId: 'auto_123',
    goal: 'Run tests and verify',
  });
});

// ─── P0 execution-overhaul: generation gating, cancel dedup, EOF flush ───────

const { EventEmitter } = require('node:events');

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { writable: true, write(value) { child.written = (child.written || '') + value; } };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function newBridge() {
  return new AgentBridge({
    cliRoot: 'C:/cli',
    workspaceRoot: 'C:/workspace',
    sessionDir: 'C:/workspace/.aicode/sessions',
    provider: 'mock',
    model: 'mock',
  });
}

test('cancel() emits turn_done+agent_offline exactly once; late exit is suppressed', () => {
  const bridge = newBridge();
  const events = [];
  bridge.on('event', (event) => events.push(event));

  const child = fakeChild();
  bridge.attach(child);
  bridge.cancel();

  assert.deepEqual(events.map((e) => e.type), ['turn_done', 'agent_offline']);
  assert.equal(events[0].status, 'cancelled');

  // The real child dies right after the kill; its natural exit handler must
  // NOT emit a second agent_offline (the original double-offline bug).
  child.emit('exit', 0);
  assert.equal(events.filter((e) => e.type === 'agent_offline').length, 1);
});

test('stale stdout after cancel is not forwarded to the renderer', () => {
  const bridge = newBridge();
  const events = [];
  bridge.on('event', (event) => events.push(event));

  const child = fakeChild();
  bridge.attach(child);
  child.stdout.emit('data', `${JSON.stringify({ type: 'info', message: 'live' })}\n`);
  assert.equal(events.filter((e) => e.type === 'info').length, 1);

  bridge.cancel();
  child.stdout.emit('data', `${JSON.stringify({ type: 'info', message: 'stale' })}\n`);
  child.stdout.emit('data', '{"type":"assistant_delta","content":"par');
  assert.equal(events.filter((e) => e.type === 'info').length, 1, 'no stale info may pass');
  assert.equal(events.filter((e) => e.type === 'assistant_delta').length, 0);
});

test('trailing stdout without newline is flushed when the child exits', () => {
  const bridge = newBridge();
  const events = [];
  bridge.on('event', (event) => events.push(event));

  const child = fakeChild();
  bridge.attach(child);
  // A final event that never got its newline before the process died.
  child.stdout.emit('data', '{"type":"turn_done","status":"ok"}');
  assert.equal(events.filter((e) => e.type === 'turn_done').length, 0);

  child.emit('exit', 0);
  const dones = events.filter((e) => e.type === 'turn_done');
  assert.equal(dones.length, 1, 'exit must flush the trailing buffered event');
  assert.equal(dones[0].status, 'ok');
  assert.equal(events.filter((e) => e.type === 'agent_offline').length, 1);
});

test('restart accepts a target resume session and passes it to the replacement child', async () => {
  const starts = [];
  const bridge = new AgentBridge({
    cliRoot: 'C:/cli',
    workspaceRoot: 'C:/workspace',
    sessionDir: 'C:/workspace/.aicode/sessions',
    provider: 'mock',
    model: 'mock',
    spawnProcess: (_command, args) => {
      starts.push(args);
      const child = fakeChild();
      queueMicrotask(() => child.stdout.emit('data', '{"type":"bridge_ready","sessionId":"sess_target"}\n'));
      return child;
    },
  });

  await bridge.start();
  await bridge.restart('sess_target');

  assert.equal(starts.length, 2);
  const resumeIndex = starts[1].indexOf('--resume');
  assert.ok(resumeIndex >= 0);
  assert.equal(starts[1][resumeIndex + 1], 'sess_target');
  await bridge.dispose();
});

test('restart waits for the previous child to exit before spawning replacement', async () => {
  const starts = [];
  const children = [];
  const bridge = new AgentBridge({
    cliRoot: 'C:/cli',
    workspaceRoot: 'C:/workspace',
    sessionDir: 'C:/workspace/.aicode/sessions',
    provider: 'mock',
    model: 'mock',
    killTree: () => {},
    spawnProcess: (_command, args) => {
      starts.push(args);
      const child = fakeChild();
      child.pid = 100 + children.length;
      child.exitCode = null;
      children.push(child);
      queueMicrotask(() => child.stdout.emit('data', '{"type":"bridge_ready","sessionId":"sess"}\n'));
      return child;
    },
  });

  await bridge.start();
  const restart = bridge.restart('sess_target');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts.length, 1);
  children[0].exitCode = 0;
  children[0].emit('exit', 0);
  await restart;
  assert.equal(starts.length, 2);
  await bridge.dispose();
});
test('undo() carries the undoId so the renderer can match undo_done', async () => {
  const bridge = newBridge();
  const child = fakeChild();
  bridge.attach(child);

  await bridge.undo(['cp-1', 'cp-2'], 'turn-9');
  const command = JSON.parse(child.written.trim());
  assert.deepEqual(command, { type: 'undo', undoId: 'turn-9', checkpointIds: ['cp-1', 'cp-2'] });
});
