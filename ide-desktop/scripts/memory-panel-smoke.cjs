/**
 * 记忆 panel — rendered and driven for real.
 *
 * What is asserted here is what only exists at runtime: that the view reports
 * the global edit record honestly (counts, newest project first, created and
 * renamed marks), that filtering narrows rather than hides, that a file row
 * resolves to a path the editor can open, and that a machine with no history
 * gets an explanation instead of an empty rectangle.
 *
 * The bridge is stubbed (scripts/memory-panel-preview.tsx) because the point is
 * the panel's decisions; the reader itself is covered by
 * tests/memory-global.test.cjs and the writer by cli/tests/global-memory.test.ts.
 *
 * Run: npx electron scripts/memory-panel-smoke.cjs
 */
'use strict';
require('./lib/probe-guard.cjs');

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'memory-panel-review');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let server;
let window;

const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
const type = (selector, value) => evaluate(`(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);

app.whenReady().then(async () => {
  const { createServer } = require('vite');
  const plugin = { name: 'memory-panel-page', configureServer(vite) {
    vite.middlewares.use('/__memory-panel', async (_request, response, next) => {
      try {
        const page = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%}</style></head><body><div id="root"></div><script type="module" src="/scripts/memory-panel-preview.tsx"></script></body></html>';
        const html = await vite.transformIndexHtml('/__memory-panel', page);
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'memory-panel-review' },
  });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });

  const open = async (query = '') => {
    await window.loadURL(`http://127.0.0.1:${port}/__memory-panel${query}`);
    await window.webContents.insertCSS('* { transition: none !important; animation: none !important; }');
    for (let i = 0; i < 100; i += 1) {
      if (await evaluate('!!document.querySelector(".mem-panel")')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await settle();
  };

  await open();
  const results = [];
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

  const calls = await evaluate('window.__memoryCalls');
  check('mount reads the global record', calls.includes('global'), JSON.stringify(calls));
  check('mount also reads the per-project notes', calls.includes('listProjects'), JSON.stringify(calls));

  // 1. The header has to report the real totals, not a guess.
  const subtitle = await evaluate(`document.querySelector('.gtx-page-header p')?.textContent ?? ''`);
  check('the header counts edits, files and projects', subtitle.includes('8 次编辑') && subtitle.includes('42 个文件') && subtitle.includes('2 个项目'), subtitle);
  check('the header points at the memory root', (await evaluate(`document.querySelector('.gtx-page-header p')?.getAttribute('title') ?? ''`)).includes('memories/global'));

  // 2. Projects are collapsed by default and ordered by freshness.
  const projectNames = await evaluate(`[...document.querySelectorAll('.mem-project-name')].map(n => n.textContent)`);
  check('every project with history is listed', projectNames.length >= 2, JSON.stringify(projectNames));
  check('the freshest project is first', projectNames[0] === 'zcode', JSON.stringify(projectNames));
  check('projects start collapsed', (await evaluate(`document.querySelectorAll('.mem-files').length`)) === 0);

  // 3. Expanding one shows its files with what happened to them.
  await evaluate(`document.querySelectorAll('.mem-project-head')[0].click()`);
  await settle();
  const files = await evaluate(`[...document.querySelectorAll('.mem-file')].map(b => b.textContent)`);
  check('expanding a project lists its files', files.length === 4, JSON.stringify(files).slice(0, 240));
  check('a file edited more than once shows its count', files.some((f) => f.includes('3×')), JSON.stringify(files));
  check('a created file is marked', files.some((f) => f.includes('新建')));
  check('a renamed file is marked', files.some((f) => f.includes('改名')));
  check('a deleted file is marked', files.some((f) => f.includes('已删')), JSON.stringify(files).slice(0, 240));

  // 4. A file row must hand the editor an absolute path.
  await evaluate(`document.querySelectorAll('.mem-file')[0].click()`);
  await settle();
  const opened = await evaluate('window.__opened');
  check('clicking a file opens it by absolute path', opened.length === 1 && /^C:\/work\/zcode\/ide-desktop\/electron\/git\.cjs$/.test(opened[0]), JSON.stringify(opened));

  // 5. Filtering narrows the list; it must not silently drop matching projects.
  await type('.mem-search input', 'cidai');
  await settle();
  const filtered = await evaluate(`[...document.querySelectorAll('.mem-project-name')].map(n => n.textContent)`);
  check('filtering keeps only matching projects', filtered.includes('cidai') && !filtered.includes('zcode'), JSON.stringify(filtered));
  await type('.mem-search input', 'Glass.kt');
  await settle();
  const byFile = await evaluate(`[...document.querySelectorAll('.mem-file-path')].map(n => n.textContent)`);
  check('filtering matches file paths too', byFile.length === 1 && byFile[0].includes('Glass.kt'), JSON.stringify(byFile));
  await type('.mem-search input', '');
  await settle();

  // 6. The raw MEMORY.md is available without leaving the view.
  await evaluate(`[...document.querySelectorAll('.mem-toolbar button')].find(b => b.textContent.includes('MEMORY.md'))?.click()`);
  await settle();
  const indexText = await evaluate(`document.querySelector('.mem-index')?.textContent ?? ''`);
  check('MEMORY.md opens in place', indexText.includes('# 全局记忆') && indexText.includes('git-write.ts'), indexText.slice(0, 80));

  // 7. The timeline is the record, newest first, and renames read as a move.
  const timeline = await evaluate(`[...document.querySelectorAll('.mem-timeline li')].map(li => li.textContent)`);
  check('recent edits are listed newest first', timeline.length === 4 && timeline[0].includes('ide-desktop/electron/git.cjs'), JSON.stringify(timeline).slice(0, 240));
  check('a deletion reads as a deletion', timeline.some((row) => row.includes('已删除 docs/old-notes.md')), JSON.stringify(timeline).slice(0, 300));
  check('a rename reads as old → new', timeline.some((row) => row.includes('cli/src/git-write.ts → cli/src/tools/git-write.ts')), JSON.stringify(timeline).slice(0, 240));

  // 8. Per-project notes are a separate store and open read-only.
  const sectionTitles = await evaluate(`[...document.querySelectorAll('.mem-heading')].map(n => n.textContent)`);
  check('per-project notes have their own section', sectionTitles.some((t) => t.includes('项目记忆')), JSON.stringify(sectionTitles));
  await evaluate(`document.querySelectorAll('.mem-note-file')[0].click()`);
  for (let i = 0; i < 30 && !(await evaluate('!!document.querySelector(".mem-note")')); i += 1) await new Promise((r) => setTimeout(r, 100));
  const noteText = await evaluate(`document.querySelector('.mem-note')?.textContent ?? ''`);
  check('a project note opens in the panel', noteText.includes('MEMORY.md'), noteText.slice(0, 80));
  await evaluate(`document.querySelector('.mem-note button')?.click()`);
  await settle();
  check('the note can be dismissed', (await evaluate(`!document.querySelector('.mem-note')`)) === true);

  // 9. Refresh re-reads instead of reusing stale state.
  const before = (await evaluate('window.__memoryCalls')).filter((c) => c === 'global').length;
  await evaluate(`[...document.querySelectorAll('.gtx-page-header button')].find(b => b.textContent.includes('刷新'))?.click()`);
  await settle();
  const after = (await evaluate('window.__memoryCalls')).filter((c) => c === 'global').length;
  check('refresh re-reads the record', after === before + 1, `${before} → ${after}`);

  fs.writeFileSync(path.join(output, 'memory.png'), (await window.webContents.capturePage()).toPNG());
  check('the view does not overflow horizontally', (await evaluate(`document.documentElement.scrollWidth > innerWidth + 1`)) === false);

  // 10. A machine that has never edited anything gets an explanation.
  await open('?mode=empty');
  const emptyTitle = await evaluate(`document.querySelector('.gtx-repo-empty h2')?.textContent ?? ''`);
  check('an empty history explains itself', emptyTitle.includes('还没有任何编辑记录'), emptyTitle);
  check('an empty history shows no project rows', (await evaluate(`document.querySelectorAll('.mem-project').length`)) === 0);
  check('an empty history still reports where it lives', (await evaluate(`document.querySelector('.gtx-repo-empty')?.textContent ?? ''`)).includes('memories/global'));

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
