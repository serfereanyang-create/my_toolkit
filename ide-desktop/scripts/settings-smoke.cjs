'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'settings-review');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let server;
let window;

const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

app.whenReady().then(async () => {
  const { createServer } = require('vite');
  const previewPlugin = { name: 'settings-review-page', configureServer(vite) {
    vite.middlewares.use('/__settings-review', async (_request, response, next) => {
      try {
        const html = await vite.transformIndexHtml('/__settings-review', '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/settings-preview.tsx"></script></body></html>');
        response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
      } catch (error) { next(error); }
    });
  } };
  server = await createServer({ root, plugins: [previewPlugin], server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false });
  await server.listen();
  const port = server.httpServer.address().port;
  window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'settings-review' } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadURL(`http://127.0.0.1:${port}/__settings-review`);
  await window.webContents.insertCSS('* { transition: none !important; animation: none !important; }');
  for (let index = 0; index < 300; index += 1) {
    if (await evaluate('!!document.querySelector(".settings-nav-item")')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate('!!document.querySelector(".settings-nav-item")'), true, 'settings navigation rendered');
  const cases = [['light-general', 1440, 960, 'light'], ['dark-general', 1280, 860, 'dark'], ['narrow-general', 1100, 720, 'light']];
  for (const [name, width, height, theme] of cases) {
    window.setContentSize(width, height);
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await settle();
    const report = await evaluate(`(() => { const nav=document.querySelector('.settings-nav').getBoundingClientRect(); const content=document.querySelector('.settings-content').getBoundingClientRect(); return { nav, content, overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight, active: document.querySelector('.settings-nav-item.active')?.textContent?.trim() }; })()`);
    assert.equal(report.overflow, false, `${name} does not overflow`);
    fs.writeFileSync(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG());
    console.log(`PASS ${name}`);
  }
  await evaluate('document.querySelectorAll(".settings-nav-item")[2].click()');
  await settle();
  assert.match(await evaluate('document.querySelector(".settings-page-title")?.textContent ?? ""'), /模型/);
  const model = await evaluate(`(() => ({ providerRail: !!document.querySelector('.model-provider-rail'), modelRows: document.querySelectorAll('.model-row').length, focusable: document.querySelectorAll('button,input,select').length }))()`);
  assert.ok(model.providerRail && model.modelRows >= 1 && model.focusable > 8, 'model settings exposes real controls');
  fs.writeFileSync(path.join(output, 'model-settings.png'), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, [], 'renderer errors');
  console.log(`PASS model settings: ${JSON.stringify(model)}`);
}).catch((error) => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (window && !window.isDestroyed()) window.destroy();
  if (server) await server.close();
  app.exit(process.exitCode || 0);
});
