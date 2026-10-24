const assert = require('node:assert/strict');
const { test } = require('node:test');
const { serveHostToolRequests } = require('../electron/host-tool-service.cjs');

/*
 * The desktop half of the hidden-browser RPC.
 *
 * The CLI asks with `host_tool_request`; the desktop answers with
 * `host_tool_response` on the same child's stdin. Each half was covered on its
 * own (cli/tests/host-tool-broker.test.ts, scripts/background-browser-smoke.cjs)
 * while the wiring between them was in main.cjs, which cannot be required under
 * `node --test`. These tests are that wiring.
 */

/** A stand-in for AgentBridge: an EventEmitter with the one method used. */
function fakeBridge({ sessionId = 'sess_from_bridge' } = {}) {
  const handlers = new Map();
  const replies = [];
  return {
    sessionId,
    replies,
    on(event, handler) { handlers.set(event, handler); },
    sendHostToolResponse(requestId, result) {
      replies.push({ requestId, result });
      return Promise.resolve();
    },
    /** Deliver one request and wait for the reply it provokes. */
    async ask(request) {
      await handlers.get('host_tool_request')(request);
      // The reply is sent from a `.then`, so give the chain a turn.
      for (let i = 0; i < 10 && replies.length === 0; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return replies.at(-1);
    },
  };
}

function fakeBrowser(result = { ok: true, output: 'done' }) {
  const calls = [];
  return {
    calls,
    async execute(args) { calls.push(args); return result; },
  };
}

function service({ bridge, browser, root = 'C:\\ws' }) {
  serveHostToolRequests(bridge, {
    backgroundBrowser: browser,
    workspaceRoot: () => root,
    sessionOf: (instance) => instance.sessionId === 'sess_from_bridge' ? 'sess_announced' : undefined,
  });
}

test('a browser request is executed and its result sent back', async () => {
  const bridge = fakeBridge();
  const browser = fakeBrowser({ ok: true, output: 'HELLO', image: { mediaType: 'image/png', data: 'x' } });
  service({ bridge, browser });

  const reply = await bridge.ask({
    type: 'host_tool_request',
    requestId: 'req_1',
    tool: 'background_browser_screenshot',
    input: { maxBytes: 10 },
  });

  assert.equal(reply.requestId, 'req_1', 'the reply must carry the request id back');
  assert.deepEqual(reply.result, { ok: true, output: 'HELLO', image: { mediaType: 'image/png', data: 'x' } });
  assert.equal(browser.calls.length, 1);
  assert.equal(browser.calls[0].tool, 'background_browser_screenshot');
  assert.deepEqual(browser.calls[0].input, { maxBytes: 10 });
});

test('the page is scoped to the session the bridge announced, not the request', async () => {
  // If the request could name its own session, one agent could drive or read
  // another conversation's hidden page.
  const bridge = fakeBridge();
  const browser = fakeBrowser();
  service({ bridge, browser });

  await bridge.ask({
    type: 'host_tool_request',
    requestId: 'req_2',
    tool: 'background_browser_open',
    sessionId: 'sess_somebody_else',
    input: { html: '<p>hi</p>' },
  });

  assert.equal(browser.calls[0].sessionId, 'sess_announced', 'the announced session wins');
});

test('a bridge that has not announced a session falls back to its configured id', async () => {
  const bridge = fakeBridge({ sessionId: 'sess_resumed' });
  const browser = fakeBrowser();
  serveHostToolRequests(bridge, {
    backgroundBrowser: browser,
    workspaceRoot: () => 'C:\\ws',
    // A resumed child knows its id from argv before `bridge_ready` arrives.
    sessionOf: () => undefined,
  });

  await bridge.ask({ type: 'host_tool_request', requestId: 'r', tool: 'background_browser_inspect', input: {} });
  assert.equal(browser.calls[0].sessionId, 'sess_resumed');
});

test('the workspace root is read per request, so a switch is picked up', async () => {
  const bridge = fakeBridge();
  const browser = fakeBrowser();
  let root = 'C:\\first';
  serveHostToolRequests(bridge, {
    backgroundBrowser: browser,
    workspaceRoot: () => root,
    sessionOf: () => 'sess_a',
  });

  await bridge.ask({ type: 'host_tool_request', requestId: 'r1', tool: 'background_browser_open', input: {} });
  root = 'C:\\second';
  await bridge.ask({ type: 'host_tool_request', requestId: 'r2', tool: 'background_browser_open', input: {} });

  assert.deepEqual(browser.calls.map((call) => call.workspaceRoot), ['C:\\first', 'C:\\second']);
});

test('an unsupported host capability is refused instead of ignored', async () => {
  // Silence would leave the CLI waiting out its whole timeout to learn nothing.
  const bridge = fakeBridge();
  const browser = fakeBrowser();
  service({ bridge, browser });

  const reply = await bridge.ask({
    type: 'host_tool_request',
    requestId: 'req_3',
    tool: 'seize_the_mouse',
    input: {},
  });

  assert.equal(reply.result.ok, false);
  assert.match(reply.result.output, /不支持/);
  assert.equal(browser.calls.length, 0, 'an unknown tool must not reach the browser service');
});

test('a missing browser service is answered, not thrown', async () => {
  const bridge = fakeBridge();
  serveHostToolRequests(bridge, {
    backgroundBrowser: undefined,
    workspaceRoot: () => 'C:\\ws',
    sessionOf: () => 'sess_a',
  });

  const reply = await bridge.ask({
    type: 'host_tool_request',
    requestId: 'req_4',
    tool: 'background_browser_open',
    input: {},
  });

  assert.equal(reply.result.ok, false);
  assert.match(reply.result.output, /不可用/);
});

test('a broken browser service still produces a reply', async () => {
  const bridge = fakeBridge();
  const browser = { async execute() { throw new Error('offscreen window died'); } };
  service({ bridge, browser });

  const reply = await bridge.ask({
    type: 'host_tool_request',
    requestId: 'req_5',
    tool: 'background_browser_open',
    input: {},
  });

  assert.equal(reply.result.ok, false);
  assert.match(reply.result.output, /offscreen window died/);
});

test('a request with no id is dropped — there is nothing to correlate a reply to', async () => {
  const bridge = fakeBridge();
  const browser = fakeBrowser();
  service({ bridge, browser });

  await bridge.ask({ type: 'host_tool_request', tool: 'background_browser_open', input: {} });

  assert.equal(bridge.replies.length, 0);
  assert.equal(browser.calls.length, 0, 'an unanswerable request must not be executed either');
});

test('a failed reply does not escape as an unhandled rejection', async () => {
  // `sendHostToolResponse` writes to a child that may already be gone; the
  // service ignores that, and must not take the process down with it.
  const bridge = fakeBridge();
  bridge.sendHostToolResponse = () => Promise.reject(new Error('EPIPE'));
  const browser = fakeBrowser();
  service({ bridge, browser });

  await bridge.ask({ type: 'host_tool_request', requestId: 'req_6', tool: 'background_browser_open', input: {} });
  assert.equal(browser.calls.length, 1, 'the work still happened');
});
test('background app requests use bridge ownership and the app service', async () => {
  const bridge = fakeBridge();
  const apps = fakeBrowser();
  serveHostToolRequests(bridge, { backgroundApp: apps, workspaceRoot: () => 'C:\\ws', sessionOf: () => 'owner' });
  const reply = await bridge.ask({ requestId: 'app-request', tool: 'background_app_open', sessionId: 'forged', input: { path: '.' } });
  assert.equal(reply.result.ok, true);
  assert.equal(apps.calls[0].sessionId, 'owner');
  assert.equal(apps.calls[0].tool, 'background_app_open');
});
