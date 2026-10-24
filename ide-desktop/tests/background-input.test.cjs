'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { parseKeyChord, keyRenderer, clickRenderer, withRenderer } = require('../electron/background-input.cjs');
const { validateInput } = require('../electron/background-app.cjs');
const appId = '11111111-1111-4111-8111-111111111111';

test('key parser uses Chromium modifier bits and rejects aliases that would repeat or access prototypes', () => {
  assert.equal(parseKeyChord('Control+A').modifiers, 2);
  assert.equal(parseKeyChord('Meta+Shift+F12').modifiers, 12);
  assert.equal(parseKeyChord('F12').windowsVirtualKeyCode, 123);
  assert.equal(parseKeyChord('Space').text, ' ');
  for (const chord of ['', 'Control+', 'Control+Ctrl+A', 'constructor', '__proto__+A', 'Shift+Shift+A', 'Control+unknown']) assert.throws(() => parseKeyChord(chord));
});

test('native input validation rejects mixed, missing, non-finite and out-of-domain coordinates', () => {
  for (const input of [{ x: 1 }, { x: '1', y: 1 }, { x: NaN, y: 1 }, { x: 1, y: Infinity }, { x: -1, y: 1 }, { x: 1, y: 1, selector: '#input' }, { selector: '#input', button: ['left'] }, { selector: '#input', double: 'true' }]) assert.throws(() => validateInput('background_app_click', { appId, ...input }));
  assert.equal(validateInput('background_app_click', { appId, x: 1.5, y: 2.5 }), 'click');
  for (const input of [{ text: '' }, { text: 1 }, { text: 'hello', script: 'ignored' }]) assert.throws(() => validateInput('background_app_type', { appId, ...input }));
  assert.throws(() => validateInput('background_app_windows', { appId, windowId: 1 }));
});

test('keyboard events release held modifiers and preserve a debugger connection owned by the app', async () => {
  const events = [];
  const win = { webContents: {
    debugger: { isAttached: () => true, attach: () => assert.fail('must not reattach'), detach: () => assert.fail('must not detach app connection'), async sendCommand(method, parameters) { events.push({ method, ...parameters }); } },
    isDestroyed: () => false,
    executeJavaScript: async () => undefined,
    once() {}, removeListener() {},
  } };
  await keyRenderer(win, { key: 'Control+A' });
  assert.ok(events.every(event => event.method === 'Input.dispatchKeyEvent'));
  assert.equal(events[0].key, 'Control');
  assert.equal(events[1].key, 'a');
  assert.equal(events.at(-1).key, 'Control');
  assert.equal(events.at(-1).type, 'keyUp');
  assert.equal(events.at(-1).modifiers, 0);
});

test('screenshot pixel clicks scale to renderer CSS coordinates and disconnect only an owned debugger', async () => {
  const events = [];
  let attached = false;
  const win = { webContents: {
    debugger: { isAttached: () => attached, attach: () => { attached = true; }, detach: () => { attached = false; }, async sendCommand(method, parameters) { events.push({ method, ...parameters }); } },
    isDestroyed: () => false,
    capturePage: async () => ({ isEmpty: () => false, getSize: () => ({ width: 1600, height: 900 }) }),
    executeJavaScript: async script => script.includes('innerWidth') ? { width: 800, height: 450 } : undefined,
    once() {}, removeListener() {},
  } };
  await clickRenderer(win, { x: 800, y: 450 });
  assert.ok(events.every(event => event.method === 'Input.dispatchMouseEvent' && event.x === 400 && event.y === 225));
  assert.equal(attached, false);
  const before = events.length;
  await assert.rejects(clickRenderer(win, { x: 1600, y: 1 }), /超出/);
  assert.equal(events.length, before);
});

test('destroying a renderer settles a hanging operation and removes its lifecycle listeners', async () => {
  for (const event of ['destroyed', 'render-process-gone']) {
    const contents = new EventEmitter(); contents.isDestroyed = () => false;
    const pending = withRenderer(contents, () => new Promise(() => {}));
    contents.emit(event);
    await assert.rejects(pending, /关闭|退出/);
    assert.equal(contents.listenerCount('destroyed'), 0);
    assert.equal(contents.listenerCount('render-process-gone'), 0);
  }
});
