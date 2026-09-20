/*
 * Drive the running renderer over the DevTools protocol.
 *
 * Why this instead of synthetic clicks: it evaluates real expressions in the
 * live renderer, so a check can read the actual DOM, call the preload bridge,
 * and assert on the values the UI is working with — no screenshots, no focus
 * stealing, and a failure comes back as a value rather than as "the click
 * looked like it landed".
 *
 * Usage: node scripts/cdp-eval.mjs "<js expression>"
 * The expression is evaluated in the page with awaitPromise, and the result is
 * printed as JSON. Exit code is 1 when the expression throws.
 *
 * Uses the WebSocket client built into Node 22+; no dependency to install.
 */

const expression = process.argv[2];
if (!expression) {
  console.error('usage: node scripts/cdp-eval.mjs "<js expression>"');
  process.exit(2);
}

const listRes = await fetch('http://127.0.0.1:9222/json/list');
const targets = await listRes.json();
// The embedded browser panel is a webview with its own page target, so "the
// first page" can be Bing rather than the app. Select the app by its file://
// URL — otherwise an evaluation silently runs against whatever site is open.
const page = targets.find((t) => t.type === 'page' && t.url?.startsWith('file://'))
  ?? targets.find((t) => t.type === 'page' && t.title === 'YOYcode Desktop IDE');
if (!page) {
  console.error('app page target not found — is the app running with --remote-debugging-port=9222?');
  console.error('targets:', targets.map((t) => `${t.type}:${t.title}`).join(', '));
  process.exit(3);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);

const result = await new Promise((resolve, reject) => {
  // Generous: some checks walk several panels with settle waits between them.
  const timeoutMs = Number(process.env.CDP_TIMEOUT_MS) || 120_000;
  const timer = setTimeout(() => reject(new Error(`CDP timeout after ${timeoutMs}ms`)), timeoutMs);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
    }));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    if (msg.id !== 1) return;
    clearTimeout(timer);
    resolve(msg.result);
  });
  ws.addEventListener('error', (err) => { clearTimeout(timer); reject(new Error(String(err?.message ?? err))); });
});

ws.close();

if (result?.exceptionDetails) {
  const d = result.exceptionDetails;
  console.error('EXCEPTION:', d.exception?.description ?? d.text);
  process.exit(1);
}

const value = result?.result?.value;
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
