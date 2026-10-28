const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createGuiControlService } = require('../electron/gui-control.cjs');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCount = 0;
  child.kill = () => { child.killCount += 1; return true; };
  return child;
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function service(child) {
  return createGuiControlService({
    cliRoot: 'C:/cli',
    execPath: 'node.exe',
    spawnImpl: () => child,
  });
}

test('GUI control removes the abort listener after a normal result', async () => {
  const child = fakeChild();
  const controller = new AbortController();
  const pending = service(child).invoke('computer_window_shot', { window: 'Notepad' }, controller.signal);
  await nextTurn();
  child.stdout.emit('data', Buffer.from('{"ok":true,"output":"done"}\n'));
  child.emit('close', 0);
  assert.deepEqual(await pending, { ok: true, output: 'done' });
  controller.abort();
  assert.equal(child.killCount, 0);
});

test('GUI control cancellation still kills the owned child and settles', async () => {
  const child = fakeChild();
  const controller = new AbortController();
  const pending = service(child).invoke('computer_window_shot', { window: 'Notepad' }, controller.signal);
  await nextTurn();
  controller.abort();
  assert.deepEqual(await pending, { ok: false, output: '', error: '电脑操控截图已取消。' });
  assert.equal(child.killCount, 1);
});
