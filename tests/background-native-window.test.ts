import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBackgroundNativeTools } from '../src/tools/backgroundNative.js';

test('background native screenshot is read-only and exposes only a window selector', () => {
  const tools = createBackgroundNativeTools(async () => ({ ok: true, output: 'captured', data: { computerImage: { mediaType: 'image/png', data: 'aGVsbG8=', path: 'C:/workspace/.aicode/computer/window.png' } } }));
  assert.deepEqual(tools.map(tool => tool.name), ['background_native_window_screenshot']);
  assert.equal(tools[0].risk, 'read'); assert.equal(tools[0].parallelSafe, false);
  assert.deepEqual(tools[0].validate({ window: 'Notepad' }), { window: 'Notepad' });
  assert.throws(() => tools[0].validate({ window: '' }));
  assert.throws(() => tools[0].validate({ window: 'x', click: true }));
});

test('malformed native image responses never reach the model', async () => {
  for (const data of [undefined, { computerImage: { mediaType: 'text/plain', data: 'aGVsbG8=' } }, { computerImage: { mediaType: 'image/png', data: '' } }]) {
    const tool = createBackgroundNativeTools(async () => ({ ok: true, output: 'captured', data }))[0];
    await assert.rejects(tool.execute({ window: 'Notepad' }, { workspaceRoot: process.cwd(), approval: 'auto' }));
  }
});
