'use strict';
const electron = require('electron');
const { app } = electron;
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'app-review');
fs.mkdirSync(output, { recursive: true });
function ownedDirectory(name) {
  const directory = path.resolve(output, name);
  const relative = path.relative(output, directory);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const marker = path.join(directory, '.app-review-owned.json');
  if (fs.existsSync(directory)) {
    assert.ok(fs.existsSync(marker), `Refusing to reuse an unmarked directory: ${directory}`);
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).owner, 'yoycode-app-review-v1');
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ owner: 'yoycode-app-review-v1' }));
  return directory;
}
const fixture = ownedDirectory('fixture');
const profile = ownedDirectory('profile');
const reviewGitConfig = path.join(profile, 'review.gitconfig');
fs.writeFileSync(reviewGitConfig, '');
process.env.GIT_CONFIG_GLOBAL = reviewGitConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
const fixtureGitEnv = { ...process.env };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete fixtureGitEnv[name];
const runGit = (...args) => execFileSync('git', ['--literal-pathspecs', ...args], { cwd: fixture, env: fixtureGitEnv, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
if (!fs.existsSync(path.join(fixture, '.git'))) runGit('init', '-b', 'main');
assert.equal(path.resolve(runGit('rev-parse', '--show-toplevel')).toLowerCase(), fixture.toLowerCase());
runGit('config', 'user.name', 'UI Review');
runGit('config', 'user.email', 'review@example.invalid');
runGit('config', 'core.autocrlf', 'false');
runGit('config', 'commit.gpgSign', 'false');
const hooks = path.join(fixture, 'hooks');
fs.mkdirSync(hooks, { recursive: true });
runGit('config', 'core.hooksPath', hooks);
fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
const seeds = {
  '.gitignore': '.aicode/\n.app-review-owned.json\nhooks/\n',
  'src/session.ts': 'export const tokenVersion = 1;\nexport const scope = "workspace";\n',
  'src/partial.ts': 'export const version = "base";\n',
  'src/page.html': '<main>\n<h1>Before</h1>\n</main>\n',
  'src/removed.ts': 'export const removed = true;\n',
  'src/literal[1].txt': 'selected literal baseline\n',
  'src/literal1.txt': 'matching peer baseline\n',
  'src/说明 文档.txt': 'Unicode baseline\n',
  'src/rename-source.txt': 'rename baseline\n',
};
for (const [name, contents] of Object.entries(seeds)) fs.writeFileSync(path.join(fixture, name), contents);
fs.writeFileSync(path.join(fixture, 'src/image.bin'), Buffer.from([0, 1, 2, 3]));
runGit('rm', '--cached', '--force', '--ignore-unmatch', '--', 'src/renamed 中文.txt');
runGit('add', '--', ...Object.keys(seeds), 'src/image.bin');
try { runGit('diff', '--cached', '--quiet'); }
catch { runGit('commit', '-m', 'UI review baseline'); }
fs.writeFileSync(path.join(fixture, 'src/session.ts'), 'export const tokenVersion = 2;\nexport const scope = "workspace";\nexport const refreshed = true;\n');
fs.writeFileSync(path.join(fixture, 'src/page.html'), '<main>\n<h1>Updated</h1>\n</main>\n');
fs.writeFileSync(path.join(fixture, 'src/partial.ts'), 'export const version = "staged";\n');
runGit('add', '--', 'src/partial.ts');
fs.writeFileSync(path.join(fixture, 'src/partial.ts'), 'export const version = "working";\n');
fs.unlinkSync(path.join(fixture, 'src/removed.ts'));
fs.writeFileSync(path.join(fixture, 'src/image.bin'), Buffer.from([0, 4, 5, 6]));
fs.writeFileSync(path.join(fixture, 'src/new.ts'), 'export const greeting = "新文件";\nexport const ready = true;\n');
const settingsPath = path.join(profile, 'settings.json');
if (fs.existsSync(settingsPath)) assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).activeProviderId, 'mock');
const { defaultSettings } = require('../electron/settings-store.cjs');
fs.writeFileSync(settingsPath, JSON.stringify({ ...defaultSettings, recentWorkspaces: [fixture], preferences: { theme: 'light', 'gen.turnNotify': 'never', 'gen.permissionNotify': false } }, null, 2));
app.setPath('userData', profile);
const sessionData = path.join(profile, 'chromium');
fs.mkdirSync(sessionData, { recursive: true });
app.setPath('sessionData', sessionData);
app.disableHardwareAcceleration();
delete process.env.VITE_DEV_SERVER_URL;
const reports = [];
const errors = [];
let previewWindow;
class ReviewWindow extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    previewWindow = this;
    this.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    this.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)));
  }
  show() {}
  focus() {}
}
const originalLoad = Module._load;
const isolatedElectron = new Proxy(electron, { get: (target, property) => property === 'BrowserWindow' ? ReviewWindow : Reflect.get(target, property) });
Module._load = function(request, parent, isMain) {
  return request === 'electron' ? isolatedElectron : originalLoad.call(this, request, parent, isMain);
};
require('../electron/main.cjs');
const evaluate = (expression) => previewWindow.webContents.executeJavaScript(expression, true);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
async function waitFor(expression, name) {
  new (require('node:vm').Script)(expression);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (previewWindow && !previewWindow.isDestroyed() && await evaluate(expression).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${name}`);
}
async function check(name, action) {
  try { await action(); reports.push({ name, ok: true }); console.log(`PASS ${name}`); return true; }
  catch (error) {
    reports.push({ name, ok: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`);
    try {
      fs.writeFileSync(path.join(output, 'observed-failure-dom.html'), await evaluate('document.documentElement.outerHTML'));
      await capture('observed-failure');
    } catch {}
    return false;
  }
}
const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
const exists = (selector) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
async function click(selector) {
  const point = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)}); element.scrollIntoView({ block: 'nearest' }); const bounds = element.getBoundingClientRect(); return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }; })()`);
  await clickPoint(point);
}
async function clickPoint(point) {
  for (const type of ['mousePressed', 'mouseReleased']) await previewWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  await settle();
}
async function capture(name) {
  await settle();
  await new Promise((resolve, reject) => {
    const onPaint = (_event, _rect, image) => { clearTimeout(timeout); resolve(image); };
    const timeout = setTimeout(() => { previewWindow.webContents.removeListener('paint', onPaint); reject(new Error('No fresh App screenshot')); }, 3000);
    previewWindow.webContents.once('paint', onPaint); previewWindow.webContents.invalidate();
  });
  const frame = await previewWindow.webContents.capturePage();
  assert.equal(frame.isEmpty(), false, 'App capture contains real pixels');
  fs.writeFileSync(path.join(output, `${name}.png`), frame.toPNG());
}
async function gitWorkspace() {
  if (await exists('.git-diff-back')) await click('.git-diff-back');
  if (!await exists('.gtx-panel[aria-label="源代码管理"]')) await click('.rail button[aria-label="源代码管理"]');
  await waitFor('document.querySelector(".gtx-repository")?.getAttribute("aria-busy") === "false"', 'Git workspace');
}
async function openDiff(file, group = '未暂存') {
  await gitWorkspace();
  await click(`.gtx-file-group[aria-label=${JSON.stringify(group)}] .gtx-file-open[data-git-path=${JSON.stringify(file)}]`);
  await waitFor('document.querySelector(".git-file-diff")?.getAttribute("aria-busy") === "false"', `real diff for ${file}`);
}
app.whenReady().then(async () => {
  console.log('Loading the built App with its real preload and main IPC');
  await waitFor('!!document.querySelector(".rail")', 'restored isolated workspace');
  previewWindow.webContents.debugger.attach('1.3');
  await evaluate(`(() => {
    const NativeWorker = window.Worker;
    const audit = [];
    window.appWorkerReview = audit;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        const record = { url: String(url), name: options?.name, received: 0, errors: [] };
        audit.push(record);
        this.addEventListener('message', () => { record.received += 1; });
        this.addEventListener('error', event => record.errors.push(event.message));
      }
    };
  })()`);
  const booted = await check('Built App restores the isolated real Git workspace', async () => {
    const status = await evaluate('window.zcodeDesktop.git.status()');
    assert.equal(status.ok, true);
    assert.ok(status.staged.some(file => file.path === 'src/partial.ts'));
    assert.ok(status.untracked.includes('src/new.ts'));
    await capture('startup');
  });
  assert.equal(booted, true, 'App startup gate');
  const repositoryBefore = { status: runGit('status', '--porcelain=v1'), diff: runGit('diff', '--binary'), cached: runGit('diff', '--cached', '--binary') };
  const expectedFiles = repositoryBefore.status.split(/\r?\n/).filter(Boolean).length;
  const navigated = await check('Source control is reachable directly from the App sidebar', async () => {
    assert.equal(await evaluate(`!!document.querySelector('.rail button[aria-label="源代码管理"]')`), true);
    await click('.rail button[aria-label="源代码管理"]');
    await waitFor('!!document.querySelector(".gtx-file-group")', 'real Git file groups');
    await capture('git-workspace');
  });
  assert.equal(navigated, true, 'Git navigation gate');
  const reviewContext = { evaluate, click, clickPoint, waitFor, capture, check, fixture, ownedDirectory, gitWorkspace, settle,
    reload: () => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('App reload did not finish')), 30000);
      previewWindow.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
      previewWindow.webContents.reload();
    }),
    sendKey: (event) => previewWindow.webContents.debugger.sendCommand('Input.dispatchKeyEvent', event),
    /** Move the mouse without pressing: :hover-revealed controls need the state
     *  established before a click, or the click lands on what is underneath. */
    moveMouse: (point) => previewWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }),
  };
  const runWrites = () => require('./app-write-checks.cjs')(reviewContext);
  const runSync = () => require('./app-sync-checks.cjs')(reviewContext);
  const runBackground = () => require('./app-background-checks.cjs')(reviewContext);
  const runCancellation = () => require('./app-cancel-checks.cjs')(reviewContext);
  const runTaskBoard = () => require('./app-task-board-checks.cjs')(reviewContext);
  const runCopy = () => require('./app-copy-checks.cjs')(reviewContext);
  const runNewTab = () => require('./app-newtab-checks.cjs')(reviewContext);
  const runContextPanel = () => require('./app-context-checks.cjs')(reviewContext);
  if (process.argv.includes('--writes-only') || process.argv.includes('--sync-only') || process.argv.includes('--background-only') || process.argv.includes('--cancel-only') || process.argv.includes('--tasks-only') || process.argv.includes('--copy-only') || process.argv.includes('--newtab-only') || process.argv.includes('--context-only')) {
    if (process.argv.includes('--context-only')) await runContextPanel(); else if (process.argv.includes('--newtab-only')) await runNewTab(); else if (process.argv.includes('--copy-only')) await runCopy(); else if (process.argv.includes('--tasks-only')) await runTaskBoard(); else if (process.argv.includes('--cancel-only')) await runCancellation(); else if (process.argv.includes('--background-only')) await runBackground(); else if (process.argv.includes('--sync-only')) await runSync(); else await runWrites();
    assert.deepEqual(reports.filter(report => !report.ok), [], 'real App write failures');
    assert.deepEqual(errors, [], 'renderer errors');
    return;
  }
  await check('Full App reads a tracked diff through the production IPC', async () => {
    await openDiff('src/session.ts');
    assert.match(await text('.git-diff-scroll'), /tokenVersion = 1/);
    assert.match(await text('.git-diff-scroll'), /tokenVersion = 2/);
    assert.equal(await evaluate('document.querySelectorAll(".git-diff-row.add").length'), 2);
    assert.equal(await evaluate('document.querySelectorAll(".git-diff-row.del").length'), 1);
    await capture('tracked-diff-light');
  });
  await check('Full App switches index and working tree without mixing their added content', async () => {
    await openDiff('src/partial.ts', '已暂存');
    assert.match(await text('.git-diff-row.add'), /"staged"/);
    assert.doesNotMatch(await text('.git-diff-row.add'), /"working"/);
    await click('.git-diff-source button:first-child');
    await waitFor('document.querySelector(".git-diff-row.add")?.textContent.includes("working")', 'working diff');
    assert.match(await text('.git-diff-row.del'), /"staged"/);
  });
  await check('Full App renders an untracked UTF8 file as two real added lines', async () => {
    await openDiff('src/new.ts', '未跟踪');
    assert.equal(await evaluate('document.querySelectorAll(".git-diff-row.add").length'), 2);
    assert.match(await text('.git-diff-scroll'), /新文件/);
    await click('.git-diff-source button:nth-child(2)');
    await waitFor('document.querySelector(".git-diff-empty")?.textContent.includes("没有已暂存")', 'empty staged side of new file');
    assert.equal(await evaluate('document.querySelectorAll(".git-diff-row.add").length'), 0);
  });
  await check('Full App distinguishes binary and deleted file changes', async () => {
    await openDiff('src/image.bin');
    assert.match(await text('.git-diff-empty strong'), /二进制文件已更改/);
    assert.equal(await exists('.git-diff-stats'), false);
    await openDiff('src/removed.ts');
    assert.match(await text('.git-file-diff-toolbar'), /文件已删除/);
    assert.equal(await exists('.git-file-diff-actions .gtx-btn'), false);
    assert.equal(await evaluate('document.querySelectorAll(".git-diff-row.del").length'), 1);
  });
  await check('Diff line navigation opens the real Monaco editor at line three', async () => {
    await openDiff('src/session.ts');
    await click('.git-diff-line-link[data-line="3"]');
    await waitFor('!!document.querySelector(".monaco-editor .view-lines")', 'Monaco editor');
    await waitFor('document.querySelector(".monaco-editor .active-line-number")?.textContent.trim() === "3"', 'editor line three');
    assert.match(await text('.editor-tabs'), /session.ts/);
    assert.equal(await evaluate(`document.querySelector('.rail button[aria-label="文件"]').getAttribute('aria-pressed')`), 'true');
    await capture('editor-line-three');
  });
  await check('HTML line navigation opens source code rather than a rendered preview', async () => {
    await openDiff('src/page.html');
    await click('.git-diff-line-link[data-line="2"]');
    await waitFor('document.querySelector(".editor-tab.active")?.textContent.includes("page.html")', 'HTML source editor');
    await waitFor('document.querySelector(".monaco-editor .active-line-number")?.textContent.trim() === "2"', 'HTML line two');
    assert.match(await text('.monaco-editor .view-lines'), /Updated/);
    await capture('html-source-line-two');
  });
  await check('Inspector uses the same real diff reader with consistent unique file counts', async () => {
    await click('.rail button[aria-label="对话"]');
    await waitFor(`document.querySelector('.git-capsule-muted')?.textContent.trim() === '工作区 ${expectedFiles}'`, 'unique repository file count');
    await click('.git-capsule-seg:first-child');
    await waitFor(`!!document.querySelector('.inspector .insp-row[title="src/new.ts"]')`, 'untracked inspector file row');
    await click('.inspector .insp-row[title="src/new.ts"]');
    await waitFor('document.querySelector(".inspector .git-file-diff")?.getAttribute("aria-busy") === "false"', 'compact real file diff');
    assert.equal(await evaluate('document.querySelectorAll(".inspector .git-diff-row.add").length'), 2);
    assert.equal((await text('.inspector-summary .insp-muted')).trim(), `工作区 ${expectedFiles}`);
    await capture('inspector-new-file');
    await click('.inspector-back');
    await waitFor(`!!document.querySelector('.inspector .insp-row[title="src/partial.ts"]')`, 'partially staged inspector row');
    await click('.inspector .insp-row[title="src/partial.ts"]');
    await waitFor('document.querySelector(".inspector .git-diff-row.add")?.textContent.includes("staged")', 'compact index side');
    await click('.inspector .git-diff-source button:first-child');
    await waitFor('document.querySelector(".inspector .git-diff-row.add")?.textContent.includes("working")', 'compact working side');
    await capture('inspector-partial-file');
    await click('.inspector-close');
  });
  await check('Bundled TypeScript worker starts and responds under the production CSP', async () => {
    await waitFor('window.appWorkerReview.some(worker => worker.name === "typescript" && worker.received > 0)', 'real TypeScript worker response');
    const workers = await evaluate('window.appWorkerReview');
    fs.writeFileSync(path.join(output, 'workers.json'), JSON.stringify(workers, null, 2));
    assert.ok(workers.some(worker => worker.name === 'typescript' && worker.received > 0));
    assert.ok(workers.every(worker => !worker.url.startsWith('data:') && worker.errors.length === 0));
  });
  await check('Persisted dark theme applies after a full App reload', async () => {
    await evaluate('window.zcodeDesktop.settings.set({ preferences: { theme: "dark", "gen.turnNotify": "never", "gen.permissionNotify": false } })');
    previewWindow.webContents.reload();
    await waitFor('!!document.querySelector(".rail") && document.documentElement.dataset.theme === "dark"', 'persisted dark App');
    await openDiff('src/session.ts');
    assert.match(await text('.git-diff-scroll'), /tokenVersion = 2/);
    await capture('tracked-diff-dark');
    previewWindow.setContentSize(1100, 720);
    await settle();
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    await capture('tracked-diff-narrow');
  });
  await check('Diff navigation resolves repository paths inside a subdirectory workspace', async () => {
    const nestedRoot = path.join(fixture, 'src');
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ recentWorkspaces: [nestedRoot] })})`);
    previewWindow.webContents.reload();
    await waitFor('document.querySelector(".rail-workspace")?.textContent.trim() === "src"', 'subdirectory workspace');
    await openDiff('src/session.ts');
    await click('.git-diff-line-link[data-line="3"]');
    await waitFor('!!document.querySelector(".editor-tabs") || document.body.textContent.includes("无法打开文件")', 'subdirectory file navigation');
    assert.equal(await exists('.editor-tabs'), true, 'repository-relative path must resolve within the opened subdirectory');
    await waitFor('document.querySelector(".monaco-editor .active-line-number")?.textContent.trim() === "3"', 'subdirectory editor line three');
    assert.match(await text('.editor-tabs'), /session.ts/);
    await capture('subdirectory-editor-line-three');
  });
  await check('Browsing full App diffs never changes file contents or the Git index', async () => {
    const after = { status: runGit('status', '--porcelain=v1'), diff: runGit('diff', '--binary'), cached: runGit('diff', '--cached', '--binary') };
    assert.deepEqual(after, repositoryBefore);
  });
  if (process.argv.includes('--writes')) await runWrites();
  if (process.argv.includes('--sync')) await runSync();
  if (process.argv.includes('--background')) await runBackground();
  if (process.argv.includes('--cancel')) await runCancellation();
  if (process.argv.includes('--tasks')) await runTaskBoard();
  if (process.argv.includes('--copy')) await runCopy();
  if (process.argv.includes('--newtab')) await runNewTab();
  if (process.argv.includes('--context')) await runContextPanel();
  fs.writeFileSync(path.join(output, 'dom-summary.json'), JSON.stringify(await evaluate('({ title: document.title, sidebar: [...document.querySelectorAll(".rail button[aria-label]")].map(button => button.getAttribute("aria-label")), content: document.querySelector(".main")?.textContent?.slice(0, 3000) })'), null, 2));
  assert.deepEqual(reports.filter(report => !report.ok), [], 'real App workflow failures');
  assert.deepEqual(errors, [], 'renderer errors');
}).catch((error) => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ mode: process.argv.includes('--context-only') ? 'context-only' : process.argv.includes('--newtab-only') ? 'newtab-only' : process.argv.includes('--copy-only') ? 'copy-only' : process.argv.includes('--tasks-only') ? 'tasks-only' : process.argv.includes('--cancel-only') ? 'cancel-only' : process.argv.includes('--background-only') ? 'background-only' : process.argv.includes('--background') ? 'full-workflows' : process.argv.includes('--sync-only') ? 'sync-only' : process.argv.includes('--writes-only') ? 'writes-only' : process.argv.includes('--sync') ? process.argv.includes('--writes') ? 'all-git' : 'read-and-sync' : process.argv.includes('--writes') ? 'read-and-writes' : 'read-only', reports, errors, fixture, profile }, null, 2));
  if (errors.length) console.error(errors.map(message => message.slice(0, 360)).join('\n'));
  if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy();
  app.exit(process.exitCode || 0);
});
