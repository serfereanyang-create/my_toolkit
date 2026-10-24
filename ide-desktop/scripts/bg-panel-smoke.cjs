/**
 * Background web workbench panel — rendered and driven for real.
 *
 * The panel is the only place a person can use the hidden browser without the
 * agent, so it is checked the way a person uses it: open a page, switch the
 * address field into navigation, download a file, and reveal it. The hidden
 * browser itself is stubbed at `window.zcodeDesktop`, because this test is
 * about the panel's behaviour (which tool it calls with which arguments, and
 * what it shows afterwards) rather than about Electron's download machinery,
 * which scripts/bg-download-smoke.cjs covers against a real server.
 *
 * Run: npx electron scripts/bg-panel-smoke.cjs
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'bg-panel-review');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let server;
let window;

const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
/**
 * Type into a controlled React input. Assigning `.value` alone is ignored:
 * React installs its own value tracker and treats an unchanged tracked value
 * as "nothing happened", so the native setter has to run first.
 */
const type = (selector, value) => evaluate(`(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);

app.whenReady().then(async () => {
  const { createServer } = require('vite');
  const plugin = { name: 'bg-panel-page', configureServer(vite) {
    vite.middlewares.use('/__bg-panel', async (_request, response, next) => {
      try {
        const html = await vite.transformIndexHtml('/__bg-panel', '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/bg-panel-preview.tsx"></script></body></html>');
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(html);
      } catch (error) { next(error); }
    });
  } };
  server = await createServer({ root, plugins: [plugin], server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false });
  await server.listen();
  const port = server.httpServer.address().port;
  window = new BrowserWindow({
    show: false, width: 1180, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'bg-panel-review' },
  });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadURL(`http://127.0.0.1:${port}/__bg-panel`);
  await window.webContents.insertCSS('* { transition: none !important; animation: none !important; }');
  for (let i = 0; i < 200; i += 1) {
    if (await evaluate('!!document.querySelector(".background-browser-panel")')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(await evaluate('!!document.querySelector(".background-browser-panel")'), true, 'panel rendered');

  const results = [];
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

  // 1. The first submit opens a page.
  await type('.background-browser-input-row input', 'https://example.com/start');
  await evaluate(`document.querySelectorAll('.background-browser-panel button')[0].click()`);
  await settle();
  const first = await evaluate('window.__calls');
  check('first submit opens a url', first.length === 1 && first[0].tool === 'background_browser_open' && first[0].input.url === 'https://example.com/start', JSON.stringify(first));

  // 2. Once a page is open the same field navigates instead of opening again.
  const label = await evaluate(`document.querySelector('.background-browser-input-row label span').textContent`);
  check('the address field becomes navigation', label.includes('转到'), label);
  await type('.background-browser-input-row input', 'https://example.com/next');
  await evaluate(`document.querySelectorAll('.background-browser-panel button')[0].click()`);
  await settle();
  const second = await evaluate('window.__calls');
  check('second submit navigates the same page', second.length === 2 && second[1].tool === 'background_browser_navigate' && second[1].input.browserId === 'browser_test', JSON.stringify(second[1]));

  // 3. Download without a url arms the next click; with a url it downloads.
  const rows = await evaluate(`document.querySelectorAll('.background-browser-input-row').length`);
  check('the panel exposes a download field', rows >= 3, `rows=${rows}`);
  await evaluate(`document.querySelectorAll('.background-browser-input-row')[1].querySelector('button').click()`);
  await settle();
  const third = await evaluate('window.__calls');
  check('an empty download field arms the click path', third[2]?.tool === 'background_browser_download' && !('url' in third[2].input), JSON.stringify(third[2]));

  await type('.background-browser-input-row:nth-of-type(2) input', 'https://example.com/paper.pdf');
  await evaluate(`document.querySelectorAll('.background-browser-input-row')[1].querySelector('button').click()`);
  await settle();
  const fourth = await evaluate('window.__calls');
  check('a filled download field names the url', fourth[3]?.tool === 'background_browser_download' && fourth[3].input.url === 'https://example.com/paper.pdf', JSON.stringify(fourth[3]));

  // 4. The saved path is surfaced with a reveal action, and reveal is confined
  //    to the workspace because the main process resolves it against the root.
  const saved = await evaluate(`(() => { const node = document.querySelector('.background-browser-saved'); return node ? { text: node.textContent, buttons: node.querySelectorAll('button').length } : null; })()`);
  check('the saved file is shown with a reveal action', !!saved && saved.text.includes('downloads/paper.pdf') && saved.buttons === 1, JSON.stringify(saved));
  await evaluate(`document.querySelector('.background-browser-saved button').click()`);
  await settle();
  const reveal = await evaluate('window.__revealed');
  check('reveal asks the main process for the workspace file', reveal.length === 1 && reveal[0] === 'downloads/paper.pdf', JSON.stringify(reveal));

  // 5. Inspecting a page lists its links, and a link that is a file downloads
  //    while a link that is a page navigates. Told apart here by extension only
  //    as a routing hint; the host still decides what the response is.
  await evaluate(`document.querySelectorAll('.background-browser-actions button')[0].click()`);
  await settle();
  const linkCount = await evaluate(`document.querySelectorAll('.background-browser-link').length`);
  check('inspect lists the page links', linkCount === 2, `links=${linkCount}`);
  const before = (await evaluate('window.__calls')).length;
  await evaluate(`document.querySelectorAll('.background-browser-link')[0].click()`);
  await settle();
  let calls = await evaluate('window.__calls');
  check('a file link downloads it', calls.length === before + 1 && calls.at(-1).tool === 'background_browser_download' && calls.at(-1).input.url === 'https://example.com/paper.pdf', JSON.stringify(calls.at(-1)));
  await evaluate(`document.querySelectorAll('.background-browser-link')[1].click()`);
  await settle();
  calls = await evaluate('window.__calls');
  check('a page link navigates to it', calls.at(-1).tool === 'background_browser_navigate' && calls.at(-1).input.url === 'https://example.com/next', JSON.stringify(calls.at(-1)));

  // 6. A failing call is shown as output, never as a blank panel or a throw.
  await evaluate(`window.__failNext = true`);
  await evaluate(`document.querySelectorAll('.background-browser-panel button')[0].click()`);
  await settle();
  const failed = await evaluate(`document.querySelector('.background-browser-output').textContent`);
  check('a refused call is reported in the panel', failed.includes('被策略拒绝'), failed);

  fs.writeFileSync(path.join(output, 'panel.png'), (await window.webContents.capturePage()).toPNG());
  const overflow = await evaluate(`document.documentElement.scrollWidth > innerWidth + 1`);
  check('the panel does not overflow horizontally', overflow === false);
  check('no renderer errors', errors.length === 0, errors.join(' | '));

  console.log(results.join('\n'));
  const failures = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\nSUMMARY: ${results.length - failures}/${results.length} passed`);
  process.exitCode = failures > 0 ? 1 : 0;
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await server.close();
  if (window) window.destroy();
  app.quit();
});
