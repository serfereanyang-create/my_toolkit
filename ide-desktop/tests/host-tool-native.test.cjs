const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { serveHostToolRequests } = require('../electron/host-tool-service.cjs');

function bridge() {
  const instance = new EventEmitter();
  instance.sessionId = 'native-session';
  instance.replies = [];
  instance.sendHostToolResponse = async (requestId, result) => {
    instance.replies.push({ requestId, result });
  };
  instance.ask = async (request) => {
    instance.emit('host_tool_request', request);
    for (let attempt = 0; attempt < 10 && instance.replies.length === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    return instance.replies.at(-1);
  };
  return instance;
}

test('host service routes native background screenshots to the native service', async () => {
  const instance = bridge();
  const calls = [];
  const image = { mediaType: 'image/png', data: 'encoded-png' };
  serveHostToolRequests(instance, {
    backgroundNative: {
      async execute(args) {
        calls.push(args);
        return { ok: true, output: '', data: { computerImage: image } };
      },
    },
    backgroundBrowser: undefined,
    backgroundApp: undefined,
    workspaceRoot: () => 'C:/workspace',
    sessionOf: () => 'native-announced',
  });

  const reply = await instance.ask({
    type: 'host_tool_request',
    requestId: 'native-1',
    tool: 'background_native_window_screenshot',
    input: { window: 'Notepad' },
  });

  assert.equal(reply.requestId, 'native-1');
  assert.deepEqual(reply.result, { ok: true, output: '', data: { computerImage: image } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'native-announced');
  assert.equal(calls[0].workspaceRoot, 'C:/workspace');
  assert.equal(calls[0].tool, 'background_native_window_screenshot');
  assert.deepEqual(calls[0].input, { window: 'Notepad' });
});
