/*
 * Capture a real screenshot of the running renderer over the DevTools
 * protocol. Same target selection rule as cdp-eval.mjs: pick the app page by
 * its file:// URL, never the embedded browser webview.
 *
 * Usage:
 *   node scripts/cdp-shot.mjs out.png                 # screenshot as-is
 *   node scripts/cdp-shot.mjs out.png --set-theme dark # force a theme first
 *   node scripts/cdp-shot.mjs out.png --minimize      # minimize window after
 */

import { writeFileSync } from 'node:fs';

const [out, ...flags] = process.argv.slice(2);
if (!out) {
  console.error('usage: node scripts/cdp-shot.mjs <out.png> [--set-theme dark|light|system] [--minimize]');
  process.exit(2);
}

const listRes = await fetch('http://127.0.0.1:9222/json/list');
const targets = await listRes.json();
const page = targets.find((t) => t.type === 'page' && t.url?.startsWith('file://'))
  ?? targets.find((t) => t.type === 'page' && t.title === 'YOYcode Desktop IDE');
if (!page) {
  console.error('app page target not found — is the app running with --remote-debugging-port=9222?');
  console.error('targets:', targets.map((t) => `${t.type}:${t.title}`).join(', '));
  process.exit(3);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);

let nextId = 1;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const timer = setTimeout(() => { console.error('CDP timeout'); process.exit(1); }, 60_000);

ws.addEventListener('open', async () => {
  try {
    // A minimized/occluded window stops producing frames and
    // Page.captureScreenshot hangs forever — restore it if the browser
    // endpoint supports it (Electron page targets may not; restore externally).
    let windowId;
    try {
      const win = await send('Browser.getWindowForTarget', { targetId: page.id });
      windowId = win.windowId;
      const bounds = await send('Browser.getWindowBounds', { windowId });
      if (bounds.bounds.windowState === 'minimized') {
        await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch { windowId = undefined; }

    const themeFlag = flags.indexOf('--set-theme');
    if (themeFlag !== -1 && flags[themeFlag + 1]) {
      const theme = flags[themeFlag + 1];
      await send('Runtime.evaluate', {
        expression: `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; 'ok'`,
        awaitPromise: true, returnByValue: true,
      });
      await new Promise((r) => setTimeout(r, 350));
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('saved', out);

    if (flags.includes('--minimize') && windowId) {
      await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      console.log('window minimized');
    }
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('EXCEPTION:', err?.message ?? err);
    process.exit(1);
  }
});
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
ws.addEventListener('error', (err) => { clearTimeout(timer); console.error('WS ERROR:', String(err?.message ?? err)); process.exit(1); });
