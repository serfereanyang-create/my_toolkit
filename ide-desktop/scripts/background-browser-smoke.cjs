/**
 * End-to-end check of the hidden background browser against a real page.
 *
 * The unit suite (tests/background-browser.test.cjs) covers the security
 * boundary, but it cannot create a hidden window — that needs a live Electron
 * process. This script is the other half: it drives the real service through
 * every `background_browser_*` operation and asserts the results, so the
 * Electron-only path (offscreen rendering, DOM dispatch, capturePage) is
 * verified rather than assumed.
 *
 * Run: npx electron scripts/background-browser-smoke.cjs
 * Exits non-zero if any check fails.
 */
'use strict';
require('./lib/probe-guard.cjs');

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createBackgroundBrowserService } = require('../electron/background-browser.cjs');
const { serveHostToolRequests } = require('../electron/host-tool-service.cjs');

// Closing the last hidden page fires `window-all-closed`, and Electron's
// default is to quit on it — which would kill this script the moment it awaits
// after the final close, losing the buffered summary. The real app never hits
// this (its main window is open for the app's whole life); a headless script
// has to say so explicitly.
app.on('window-all-closed', () => {});

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Smoke Page</title></head><body>
<h1 id="t">HELLO</h1>
<input id="q" name="q" type="text" />
<button id="go" onclick="document.getElementById('t').textContent='CLICKED'">Go</button>
<div id="out"></div>
<script>
  document.getElementById('q').addEventListener('input', (e) => {
    document.getElementById('out').textContent = 'typed:' + e.target.value;
  });
  document.addEventListener('keydown', (e) => { document.getElementById('out').textContent += '|key:' + e.key; });
</script>
</body></html>`;

app.whenReady().then(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-smoke-'));
  fs.writeFileSync(path.join(ws, 'page.html'), PAGE);
  const svc = createBackgroundBrowserService();
  const results = [];
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
  const run = (tool, input, sessionId = 'sess-A') => svc.execute({ sessionId, workspaceRoot: ws, tool, input });

  const open = await run('background_browser_open', { path: 'page.html' });
  check('open workspace html', open.ok === true, open.output);
  const browserId = open.data?.browserId;
  check('open returns a browserId', typeof browserId === 'string' && browserId.startsWith('browser_'));

  const insp = await run('background_browser_inspect', { browserId });
  check('inspect reads the page text', insp.ok === true && String(insp.output).includes('HELLO'));

  await run('background_browser_fill', { browserId, selector: '#q', value: 'hello-fill' });
  const afterFill = await run('background_browser_inspect', { browserId });
  check('fill reaches the page', String(afterFill.output).includes('typed:hello-fill'));

  await run('background_browser_click', { browserId, selector: '#go' });
  const afterClick = await run('background_browser_inspect', { browserId });
  check('click reaches the page', String(afterClick.output).includes('CLICKED'));

  const key = await run('background_browser_key', { browserId, key: 'Enter', selector: '#q' });
  check('key reaches the page', key.ok === true, key.output);

  const shot = await run('background_browser_screenshot', { browserId });
  const img = shot.data?.computerImage;
  check('screenshot returns base64 png', shot.ok === true && img?.mediaType === 'image/png' && img.data.length > 100);
  check('screenshot path is under .aicode', typeof img?.path === 'string' && img.path.startsWith('.aicode/'), img?.path);
  check('screenshot file exists on disk', img?.path ? fs.existsSync(path.join(ws, img.path)) : false);

  const foreign = await run('background_browser_inspect', { browserId }, 'sess-B');
  check('another conversation cannot use the page', foreign.ok === false, foreign.output);

  check('status lists the open page', svc.status().some((r) => r.browserId === browserId));
  await run('background_browser_close', { browserId });
  check('status is empty after close', svc.status().length === 0);

  // ── the RPC path the CLI actually uses ──
  // Everything above calls the service directly. The CLI never does: it sends
  // `host_tool_request` over its stdin/stdout bridge and the desktop answers on
  // that same child. That wiring is exercised here against the real offscreen
  // window, so the two halves are known to meet rather than assumed to.
  const handlers = new Map();
  const replies = [];
  let announced = 'sess-rpc';
  const bridge = {
    sessionId: 'sess-from-argv',
    on(event, handler) { handlers.set(event, handler); },
    sendHostToolResponse(requestId, result) { replies.push({ requestId, result }); return Promise.resolve(); },
  };
  serveHostToolRequests(bridge, {
    backgroundBrowser: svc,
    workspaceRoot: () => ws,
    sessionOf: () => announced,
  });
  const ask = async (request) => {
    replies.length = 0;
    await handlers.get('host_tool_request')(request);
    for (let i = 0; i < 50 && replies.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return replies.at(-1);
  };

  announced = 'sess-rpc';
  const rpcOpen = await ask({ requestId: 'rpc_1', tool: 'background_browser_open', input: { path: 'page.html' } });
  check('RPC open succeeds through the bridge', rpcOpen?.result?.ok === true, rpcOpen?.result?.output);
  const rpcBrowserId = rpcOpen?.result?.data?.browserId;
  const rpcInspect = await ask({ requestId: 'rpc_2', tool: 'background_browser_inspect', input: { browserId: rpcBrowserId } });
  check('RPC inspect reads the page', String(rpcInspect?.result?.output).includes('HELLO'));
  check('RPC replies carry the request id', rpcInspect?.requestId === 'rpc_2', rpcInspect?.requestId);

  // The id in the request must be ignored: ownership comes from the bridge.
  const spoofed = await ask({
    requestId: 'rpc_3',
    tool: 'background_browser_inspect',
    sessionId: 'sess-somebody-else',
    input: { browserId: rpcBrowserId },
  });
  check('RPC ignores a caller-supplied session id', spoofed?.result?.ok === true, spoofed?.result?.output);
  const stolen = await svc.execute({
    sessionId: 'sess-somebody-else',
    workspaceRoot: ws,
    tool: 'background_browser_inspect',
    input: { browserId: rpcBrowserId },
  });
  check('the RPC page is owned by the announced session', stolen.ok === false, stolen.output);

  const unsupported = await ask({ requestId: 'rpc_4', tool: 'seize_the_mouse', input: {} });
  check('RPC refuses an unsupported capability', unsupported?.result?.ok === false, unsupported?.result?.output);

  await ask({ requestId: 'rpc_5', tool: 'background_browser_close', input: { browserId: rpcBrowserId } });
  check('RPC close leaves no page behind', svc.status().length === 0);

  await svc.disposeAll();
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\nSUMMARY: ${results.length - failed}/${results.length} passed`);
  app.exit(failed > 0 ? 1 : 0);
});
