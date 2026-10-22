/**
 * 源代码管理 panel on a folder that is not a repository.
 *
 * What only exists at runtime: the view used to answer "not a git repository"
 * with git's own fatal message in a red banner and no way forward. It now has
 * to explain the situation, offer 初始化仓库, and — after one click — become an
 * ordinary repository view. Nothing may be staged or committed by that click.
 *
 * Run: npx electron scripts/git-init-panel-smoke.cjs
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'git-init-panel-review');
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
  const plugin = { name: 'git-init-panel-page', configureServer(vite) {
    vite.middlewares.use('/__git-init-panel', async (_request, response, next) => {
      try {
        const page = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%}</style></head><body><div id="root"></div><script type="module" src="/scripts/git-init-panel-preview.tsx"></script></body></html>';
        const html = await vite.transformIndexHtml('/__git-init-panel', page);
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'git-init-panel-review' },
  });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await window.loadURL(`http://127.0.0.1:${port}/__git-init-panel`);
  await window.webContents.insertCSS('* { transition: none !important; animation: none !important; }');
  for (let i = 0; i < 100; i += 1) {
    if (await evaluate('!!document.querySelector(".gtx-panel")')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await settle();

  const results = [];
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

  // 1. The empty state, not git's fatal message.
  const emptyTitle = await evaluate(`document.querySelector('.gtx-repo-empty h2')?.textContent ?? ''`);
  check('a non-repository explains itself', emptyTitle.includes('还不是 git 仓库'), emptyTitle);
  check('the raw git fatal message is not shown', (await evaluate(`document.body.textContent`)).includes('not a git repository') === false);
  check('no error banner for a folder that simply has no repo', (await evaluate(`document.querySelectorAll('.gtx-error').length`)) === 0);
  check('the header says there is no repository yet', (await evaluate(`document.querySelector('.gtx-page-header p')?.textContent ?? ''`)).includes('还没有版本库'));
  check('the empty state promises what init will not do', (await evaluate(`document.querySelector('.gtx-repo-empty-note')?.textContent ?? ''`)).includes('不暂存、不提交、不删除'));

  fs.writeFileSync(path.join(output, 'empty.png'), (await window.webContents.capturePage()).toPNG());
  const button = await evaluate(`[...document.querySelectorAll('.gtx-repo-empty button')].map(b => b.textContent)`);
  check('there is an 初始化仓库 entry point', button.some((label) => label.includes('初始化仓库')), JSON.stringify(button));

  // 2. One click runs git init exactly once and nothing else.
  await evaluate(`[...document.querySelectorAll('.gtx-repo-empty button')].find(b => b.textContent.includes('初始化仓库')).click()`);
  for (let i = 0; i < 50 && (await evaluate(`!!document.querySelector('.gtx-repo-empty')`)); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await settle();
  const calls = await evaluate('window.__gitCalls');
  check('clicking sends git init once', calls.filter((call) => call.startsWith('init')).length === 1, JSON.stringify(calls));
  check('init is asked for no branch the user did not choose', calls.filter((call) => call.startsWith('init'))[0] === 'init:{}', JSON.stringify(calls));
  check('nothing is staged or committed', !calls.some((call) => call.startsWith('stage') || call.startsWith('commit')), JSON.stringify(calls));

  // 3. The view becomes a normal repository view, not a second empty state.
  check('the empty state is gone after init', (await evaluate(`!document.querySelector('.gtx-repo-empty')`)) === true);
  const titles = await evaluate(`[...document.querySelectorAll('.gtx-card-title')].map(n => n.textContent)`);
  check('the repository view renders', titles.length > 0 && (await evaluate(`!document.querySelector('.gtx-panel')`)) === false, JSON.stringify(titles));
  const after = await evaluate(`document.querySelector('.gtx-page-header p')?.textContent ?? ''`);
  check('the header now reports the new repository', after.includes('0 个文件有更改'), after);
  check('the branch is shown as main', (await evaluate(`document.body.textContent`)).includes('main'));
  check('init reports success to the user', (await evaluate(`document.querySelector('.gtx-operation')?.textContent ?? ''`)).includes('已初始化'), await evaluate(`document.querySelector('.gtx-operation')?.textContent ?? ''`));
  check('no error banner after a successful init', (await evaluate(`document.querySelectorAll('.gtx-error').length`)) === 0);

  fs.writeFileSync(path.join(output, 'git-init.png'), (await window.webContents.capturePage()).toPNG());
  check('the view does not overflow horizontally', (await evaluate(`document.documentElement.scrollWidth > innerWidth + 1`)) === false);
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
