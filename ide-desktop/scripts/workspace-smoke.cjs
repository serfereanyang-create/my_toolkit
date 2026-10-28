'use strict';
require('./lib/probe-guard.cjs');

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'workspace-review');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let server;
let previewWindow;
const reports = [];
const errors = [];
const filter = process.argv.find((argument) => argument.startsWith('--filter='))?.slice('--filter='.length);
const evaluate = (expression) => previewWindow.webContents.executeJavaScript(expression, true);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
async function waitFor(expression, name) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${name}`);
}
async function check(name, action) {
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
  try { await action(); reports.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { reports.push({ name, ok: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
const click = async (selector) => {
  const point = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const bounds = element.getBoundingClientRect(); return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }; })()`);
  await previewWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await previewWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  await settle();
};
async function section(label, expanded = true) {
  await evaluate(`(() => { const button = [...document.querySelectorAll('.gtx-row')].find(element => element.querySelector('.gtx-row-label')?.textContent === ${JSON.stringify(label)}); if (button?.getAttribute('aria-expanded') !== ${JSON.stringify(String(expanded))}) button?.click(); })()`);
  await settle();
}
async function reset(scenario = 'mixed') {
  await evaluate(`window.workspacePreview.reset(${JSON.stringify(scenario)})`);
  await settle();
  await evaluate('document.querySelector(".workspace-preview-shell").scrollTop = 0');
  await waitFor(`!document.querySelector('.gtx-panel button[title="刷新"]')?.disabled`, 'repository loaded');
}
async function input(selector, value) {
  await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); element.focus(); })()`);
  await settle();
}
async function openDiff(selector = '.gtx-file-group[aria-label="未暂存"] .gtx-file-open') {
  await click(selector);
  await waitFor('document.querySelector(".git-file-diff")?.getAttribute("aria-busy") === "false"', 'file diff read');
}
async function choose(selector, value) {
  await evaluate(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await settle();
}
async function syncInfo(value) {
  await evaluate(`window.workspacePreview.sync(${JSON.stringify(value)})`);
  await click('.gtx-panel button[title="刷新"]');
  await waitFor(`!document.querySelector('.gtx-panel button[title="刷新"]').disabled`, 'sync metadata refresh');
}
async function capture(name) {
  await evaluate('window.getSelection()?.removeAllRanges()');
  await settle();
  const image = await new Promise((resolve, reject) => {
    const onPaint = (_event, _rect, frame) => { clearTimeout(timeout); resolve(frame); };
    const timeout = setTimeout(() => { previewWindow.webContents.removeListener('paint', onPaint); reject(new Error('No fresh screenshot frame')); }, 3000);
    previewWindow.webContents.once('paint', onPaint);
    previewWindow.webContents.invalidate();
  });
  const data = image.toPNG();
  fs.writeFileSync(path.join(output, `${name}.png`), data);
  return data;
}
app.whenReady().then(async () => {
  const { createServer } = require('vite');
  const plugin = { name: 'workspace-review-page', configureServer(vite) {
    vite.middlewares.use('/__workspace-review', async (_request, response, next) => {
      try {
        const html = await vite.transformIndexHtml('/__workspace-review', '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/scripts/workspace-preview.tsx"></script></body></html>');
        response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
      } catch (error) { next(error); }
    });
  } };
  server = await createServer({ root, cacheDir: path.join(output, 'vite'), plugins: [plugin], server: { host: '127.0.0.1', port: 0 }, clearScreen: false });
  await server.listen();
  previewWindow = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true, partition: 'workspace-review' } });
  previewWindow.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await previewWindow.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/__workspace-review`);
  await previewWindow.webContents.insertCSS('* { transition: none !important; animation: none !important; }');
  await waitFor('document.documentElement.dataset.workspacePreviewReady === "true"', 'real components');
  previewWindow.webContents.debugger.attach('1.3');
  const key = async (key, code, virtualKey, modifiers = 0) => {
    await previewWindow.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, modifiers, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await previewWindow.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, modifiers });
    await settle();
  };
  await check('Partially staged files count once in the repository summary', async () => {
    await reset();
    assert.match(await evaluate('document.querySelector(".gtx-panel").textContent'), /4 个文件/);
    assert.doesNotMatch(await evaluate('document.querySelector(".gtx-row").textContent'), /5 个文件/);
  });
  await check('PR action opens its form while commit details are collapsed', async () => {
    await reset();
    await section('提交或推送', false);
    await click('.gtx-panel button[title="创建 Pull Request"]');
    assert.equal(await evaluate('!!document.querySelector(".gtx-pr-input")'), true);
  });
  await check('Branch failures are visible with changes collapsed', async () => {
    await reset();
    await section('更改', false);
    await evaluate('window.workspacePreview.fail("checkout", "分支被工作树占用")');
    await click('.gtx-branch-wrap > button');
    await evaluate('[...document.querySelectorAll(".gtx-branch-item")].find(element => element.textContent.trim() === "main").click()');
    await settle();
    assert.match(await evaluate('document.querySelector(".gtx-error")?.textContent || ""'), /分支被工作树占用/);
  });
  await check('Staging failure retains files and explains the error', async () => {
    await reset(); await section('更改');
    await evaluate('window.workspacePreview.fail("stage", "索引已锁定，请稍后重试")');
    await click('.gtx-panel button[title="暂存"]');
    assert.match(await evaluate('document.querySelector(".gtx-error")?.textContent || ""'), /索引已锁定/);
    assert.equal(await evaluate('window.workspacePreview.snapshot().unstaged.length'), 3);
  });
  await check('Repeated stage clicks submit one pending operation', async () => {
    await reset(); await section('更改');
    await evaluate(`(() => { window.workspacePreview.defer('stage'); const button = document.querySelector('.gtx-panel button[title="暂存"]'); button.click(); button.click(); })()`);
    await settle();
    try { assert.equal(await evaluate('window.workspacePreview.calls().filter(call => call.action === "stage").length'), 1); }
    finally { await evaluate('window.workspacePreview.finish("stage")'); await settle(); }
  });
  await check('Ctrl Enter never commits when nothing is staged', async () => {
    await reset('unstaged'); await section('提交或推送');
    await input('.gtx-commit-input', 'Keep uncommitted draft');
    await key('Enter', 'Enter', 13, 2);
    assert.equal(await evaluate('window.workspacePreview.calls().filter(call => call.action === "commit").length'), 0);
    assert.equal(await evaluate('document.querySelector(".gtx-commit-input").value'), 'Keep uncommitted draft');
  });
  await check('Unavailable repository never reports a clean working tree', async () => {
    await reset('unavailable');
    const text = await evaluate('document.querySelector(".gtx-panel").textContent');
    assert.match(text, /不是 Git 仓库/); assert.doesNotMatch(text, /干净/);
  });
  await check('Successful refresh clears a previous repository error', async () => {
    await reset();
    await evaluate('window.workspacePreview.fail("status", "仓库读取失败")');
    await click('.gtx-panel button[title="刷新"]');
    await section('更改');
    assert.match(await evaluate('document.querySelector(".gtx-error")?.textContent || ""'), /仓库读取失败/);
    await click('.gtx-panel button[title="刷新"]');
    assert.equal(await evaluate('!!document.querySelector(".gtx-error")'), false);
  });
  await check('Branch menu is visible beyond the closed card and Escape restores its trigger', async () => {
    await reset(); await section('更改', false); await section('提交或推送', false);
    await click('.gtx-branch-wrap > button');
    const menuLayout = await evaluate(`(() => { const menu = document.querySelector('.gtx-branch-menu'); const button = menu.querySelector('button:last-child'); const bounds = button.getBoundingClientRect(); const hit = document.elementFromPoint(bounds.left + 10, bounds.top + bounds.height / 2); return { reachable: menu.contains(hit), buttonTop: bounds.top, buttonBottom: bounds.bottom, menuTop: menu.getBoundingClientRect().top, menuBottom: menu.getBoundingClientRect().bottom, hit: hit?.className, active: document.activeElement.outerHTML }; })()`);
    await capture('branch-menu');
    assert.equal(menuLayout.reachable, true, JSON.stringify(menuLayout));
    await key('Escape', 'Escape', 27);
    assert.equal(await evaluate('document.activeElement === document.querySelector(".gtx-branch-wrap > button")'), true, await evaluate('document.activeElement.tagName + "." + document.activeElement.className'));
  });
  await check('Stage and unstage update the actual file groups', async () => {
    await reset(); await section('更改');
    await click('.gtx-panel button[title="暂存"]');
    await waitFor('window.workspacePreview.snapshot().unstaged.length === 2', 'staged working tree');
    assert.match(await evaluate('document.querySelector(".gtx-operation").textContent'), /已暂存/);
    await click('.gtx-panel button[title="取消暂存"]');
    await waitFor('window.workspacePreview.snapshot().staged.length === 0', 'unstaged index');
    assert.match(await evaluate('document.querySelector(".gtx-operation").textContent'), /已取消暂存/);
  });
  await check('Selected staging includes new files without staging other paths', async () => {
    await reset(); await section('更改');
    await click('.gtx-file-row[data-path="src/lib/sessionEvents.ts"] input');
    await click('.gtx-body-toolbar button:first-child');
    const staged = await evaluate('window.workspacePreview.calls().find(call => call.action === "stage").args');
    assert.deepEqual(staged, ['src/lib/sessionEvents.ts']);
    assert.equal(await evaluate('window.workspacePreview.snapshot().unstaged.length'), 3);
  });
  await check('Unstage failure leaves the index intact and reports its error', async () => {
    await reset();
    await evaluate('window.workspacePreview.fail("unstage", "无法释放索引锁", true)');
    await click('.gtx-panel button[title="取消暂存"]');
    assert.match(await evaluate('document.querySelector(".gtx-error").textContent'), /无法释放索引锁/);
    assert.equal(await evaluate('window.workspacePreview.snapshot().staged.length'), 1);
  });
  await check('Discard requires confirmation and retains a failed decision', async () => {
    await reset(); await section('更改');
    await click('.gtx-file-row[data-path="src/auth/refresh-token-boundary.ts"] input');
    await click('.gtx-body-toolbar .danger');
    await click('.confirm-dialog-cancel');
    assert.equal(await evaluate('window.workspacePreview.calls().filter(call => call.action === "discard").length'), 0);
    await click('.gtx-body-toolbar .danger');
    await evaluate('window.workspacePreview.fail("discard", "文件正在被其他程序使用")');
    await click('.confirm-dialog-confirm');
    assert.equal(await evaluate('!!document.querySelector(".confirm-dialog")'), true);
    assert.match(await evaluate('document.querySelector(".gtx-discard-error").textContent'), /正在被其他程序使用/);
    assert.equal(await evaluate('window.workspacePreview.snapshot().unstaged.length'), 3);
    await capture('discard-error');
    await click('.confirm-dialog-cancel');
  });
  await check('Pending discard ignores duplicate confirmations and Escape', async () => {
    await reset(); await section('更改');
    await click('.gtx-file-row[data-path="src/auth/refresh-token-boundary.ts"] input');
    await click('.gtx-body-toolbar .danger');
    await evaluate('(() => { window.workspacePreview.defer("discard"); const button = document.querySelector(".confirm-dialog-confirm"); button.click(); button.click(); })()');
    await settle(); await key('Escape', 'Escape', 27);
    assert.equal(await evaluate('window.workspacePreview.calls().filter(call => call.action === "discard").length'), 1);
    assert.equal(await evaluate('!!document.querySelector(".confirm-dialog")'), true);
    await evaluate('window.workspacePreview.finish("discard")');
    await waitFor('!document.querySelector(".confirm-dialog")', 'successful discard');
    assert.equal(await evaluate('window.workspacePreview.snapshot().unstaged.length'), 2);
  });
  await check('Commit failure preserves the description for one explicit retry', async () => {
    await reset(); await section('提交或推送');
    await input('.gtx-commit-input', 'Repair session refresh');
    await evaluate('window.workspacePreview.fail("commit", "提交钩子未通过", true)');
    await key('Enter', 'Enter', 13, 2);
    assert.match(await evaluate('document.querySelector(".gtx-error").textContent'), /提交钩子未通过/);
    assert.equal(await evaluate('document.querySelector(".gtx-commit-input").value'), 'Repair session refresh');
    await key('Enter', 'Enter', 13, 2);
    await waitFor('window.workspacePreview.snapshot().staged.length === 0', 'successful explicit retry');
    assert.equal(await evaluate('window.workspacePreview.calls().filter(call => call.action === "commit").length'), 2);
    assert.equal(await evaluate('document.querySelector(".gtx-commit-input").value'), '');
  });
  await check('IME confirmation never submits a Git commit', async () => {
    await reset(); await section('提交或推送');
    await input('.gtx-commit-input', '输入法尚未确认');
    await evaluate('document.querySelector(".gtx-commit-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, ctrlKey: true, isComposing: true, bubbles: true }))');
    await settle();
    assert.equal(await evaluate('window.workspacePreview.calls().filter(call => call.action === "commit").length'), 0);
  });
  await check('Push and pull exceptions are visible and release pending controls', async () => {
    for (const [action, position] of [['push', 2], ['pull', 3]]) {
      await reset(); await section('提交或推送');
      await evaluate(`window.workspacePreview.fail(${JSON.stringify(action)}, '模拟远程不可达', true)`);
      await click(`.gtx-commit-row button:nth-child(${position})`);
      assert.match(await evaluate('document.querySelector(".gtx-error").textContent'), /模拟远程不可达/);
      assert.equal(await evaluate(`document.querySelector('.gtx-commit-row button:nth-child(${position})').disabled`), false);
    }
  });
  await check('PR failure retains its title and a successful retry provides a real link', async () => {
    await reset(); await section('提交或推送', false);
    await click('.gtx-panel button[title="创建 Pull Request"]');
    await input('.gtx-pr input.gtx-pr-input', 'Improve session recovery');
    await evaluate('window.workspacePreview.fail("pr", "尚未登录托管平台", true)');
    await click('.gtx-pr button[type="submit"]');
    assert.match(await evaluate('document.querySelector(".gtx-error").textContent'), /尚未登录托管平台/);
    assert.equal(await evaluate('document.querySelector(".gtx-pr input.gtx-pr-input").value'), 'Improve session recovery');
    await click('.gtx-pr button[type="submit"]');
    await waitFor('!!document.querySelector(".gtx-pr a[href]")', 'created PR link');
    assert.equal(await evaluate('document.querySelector(".gtx-pr a").getAttribute("href")'), 'https://example.invalid/pr/1');
    await capture('pr-created');
  });
  await check('Branch search supports arrows and Enter without duplicate checkout', async () => {
    await reset(); await click('.gtx-branch-wrap > button');
    await input('.gtx-branch-search input', 'main');
    await key('ArrowDown', 'ArrowDown', 40); await key('Enter', 'Enter', 13);
    await waitFor('window.workspacePreview.snapshot().branch === "main"', 'keyboard checkout');
    assert.equal(await evaluate('window.workspacePreview.calls().filter(call => call.action === "checkout").length'), 1);
    assert.equal(await evaluate('!!document.querySelector(".gtx-branch-menu")'), false);
  });
  await check('Clicking the branch trigger again closes its menu', async () => {
    await reset(); await click('.gtx-branch-wrap > button');
    await click('.gtx-branch-wrap > button');
    assert.equal(await evaluate('!!document.querySelector(".gtx-branch-menu")'), false);
  });
  await check('Create branch Escape returns to search and failed names remain editable', async () => {
    await reset(); await click('.gtx-branch-wrap > button');
    await click('.gtx-branch-item.create');
    await input('.gtx-branch-create input', 'new-ui');
    await key('Escape', 'Escape', 27);
    assert.equal(await evaluate('!!document.querySelector(".gtx-branch-menu")'), true);
    assert.equal(await evaluate('document.activeElement === document.querySelector(".gtx-branch-search input")'), true);
    await click('.gtx-branch-item.create');
    await input('.gtx-branch-create input', 'new-ui');
    await evaluate('window.workspacePreview.fail("branch", "分支名称已存在")');
    await key('Enter', 'Enter', 13);
    assert.equal(await evaluate('document.querySelector(".gtx-branch-create input").value'), 'new-ui');
    assert.match(await evaluate('document.querySelector(".gtx-error").textContent'), /分支名称已存在/);
    assert.equal(await evaluate('window.workspacePreview.calls().find(call => call.action === "branch").args'), 'yoycode/new-ui');
    await key('Enter', 'Enter', 13);
    await waitFor('window.workspacePreview.snapshot().branch === "yoycode/new-ui"', 'explicit create retry');
  });
  await check('Old workspace completion cannot clear a new pending Git operation', async () => {
    await reset(); await section('提交或推送');
    await evaluate('window.workspacePreview.defer("push")');
    await click('.gtx-commit-row button:nth-child(2)');
    await evaluate('window.workspacePreview.switchWorkspace()');
    await waitFor('document.querySelector(".gtx-page-header p").textContent.includes("other-project") && !document.querySelector(".gtx-commit-row button:nth-child(3)").disabled', 'new workspace');
    await evaluate('window.workspacePreview.defer("pull")');
    await click('.gtx-commit-row button:nth-child(3)');
    await evaluate('window.workspacePreview.finish("push")');
    await settle();
    assert.match(await evaluate('document.querySelector(".gtx-operation").textContent'), /正在拉取/);
    assert.equal(await evaluate('document.querySelector(".gtx-commit-row button:nth-child(3)").disabled'), true);
    await evaluate('window.workspacePreview.finish("pull")');
    await waitFor('document.querySelector(".gtx-operation")?.textContent.includes("已拉取")', 'new operation completed');
    assert.doesNotMatch(await evaluate('document.querySelector(".gtx-operation").textContent'), /已推送/);
  });
  await check('Clean repository shows a useful empty state with sync controls', async () => {
    await reset('clean');
    assert.match(await evaluate('document.querySelector(".gtx-empty-clean").textContent'), /没有未提交的文件更改/);
    assert.equal(await evaluate('document.querySelector(".gtx-commit-row button:nth-child(2)").disabled'), false);
    await capture('clean');
  });
  await check('A stale background refresh never erases a new operation error', async () => {
    await reset(); await section('更改');
    const reads = await evaluate('window.workspacePreview.calls().filter(call => call.action === "status").length');
    await evaluate('window.workspacePreview.defer("status"); window.workspacePreview.poll()');
    await waitFor(`window.workspacePreview.calls().filter(call => call.action === 'status').length > ${reads}`, 'background status read');
    await evaluate('window.workspacePreview.fail("stage", "新出现的索引错误")');
    await click('.gtx-panel button[title="暂存"]');
    assert.match(await evaluate('document.querySelector(".gtx-error")?.textContent || ""'), /新出现的索引错误/);
    await evaluate('window.workspacePreview.finish("status")');
    await settle();
    assert.match(await evaluate('document.querySelector(".gtx-error")?.textContent || ""'), /新出现的索引错误/);
  });
  await check('File diff browsing is read only and Escape restores the selected file', async () => {
    await reset(); await openDiff();
    assert.match(await evaluate('document.querySelector(".git-diff-scroll").textContent'), /working/);
    assert.equal(await evaluate('window.workspacePreview.calls().filter(call => ["stage", "unstage", "discard", "commit", "checkout"].includes(call.action)).length'), 0);
    await key('Escape', 'Escape', 27);
    assert.equal(await evaluate('document.activeElement.dataset.gitPath'), 'src/auth/session.ts');
    assert.equal(await evaluate('document.activeElement.dataset.staged'), 'false');
  });
  await check('Staged file diff never includes working tree changes', async () => {
    await reset(); await openDiff('.gtx-file-group[aria-label="已暂存"] .gtx-file-open');
    assert.match(await evaluate('document.querySelector(".git-diff-scroll").textContent'), /'staged'/);
    assert.doesNotMatch(await evaluate('document.querySelector(".git-diff-scroll").textContent'), /'working'/);
    await click('.git-diff-source button:first-child');
    await waitFor('document.querySelector(".git-diff-scroll")?.textContent.includes("working")', 'working side');
    assert.doesNotMatch(await evaluate('document.querySelector(".git-diff-scroll").textContent'), /'staged'/);
  });
  await check('Untracked text has exact added lines and no deleted lines', async () => {
    await reset(); await openDiff('.gtx-file-group[aria-label="未跟踪"] .gtx-file-open');
    assert.equal(await evaluate('document.querySelectorAll(".git-diff-row.add").length'), 2);
    assert.equal(await evaluate('document.querySelectorAll(".git-diff-row.del").length'), 0);
    assert.match(await evaluate('document.querySelector(".git-diff-stats").textContent'), /\+2/);
    await capture('file-diff-new');
  });
  await check('Binary and empty new files never masquerade as unchanged text', async () => {
    await reset();
    await evaluate('window.workspacePreview.diff({ binary: true, diff: "" })');
    await openDiff();
    assert.match(await evaluate('document.querySelector(".git-diff-empty strong").textContent'), /二进制文件已更改/);
    assert.equal(await evaluate('!!document.querySelector(".git-diff-stats")'), false);
    await capture('file-diff-binary');
    await reset();
    await evaluate('window.workspacePreview.diff({ untracked: true, diff: "" })');
    await openDiff('.gtx-file-group[aria-label="未跟踪"] .gtx-file-open');
    assert.match(await evaluate('document.querySelector(".git-diff-empty strong").textContent'), /新文件为空/);
  });
  await check('Deleted file diff has no invalid editor jump', async () => {
    await reset();
    await evaluate(`window.workspacePreview.diff(${JSON.stringify({ diff: '--- a/removed.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const removed = true;' })})`);
    await openDiff();
    assert.equal(await evaluate('document.querySelectorAll(".git-diff-row.del").length'), 1);
    assert.equal(await evaluate('document.querySelectorAll(".git-diff-line-link").length'), 0);
    assert.equal(await evaluate('!!document.querySelector(".git-file-diff-actions .gtx-btn")'), false);
  });
  await check('File diff read failure has a working explicit retry', async () => {
    await reset();
    await evaluate('window.workspacePreview.fail("fileDiff", "文件读取暂时失败", true)');
    await openDiff();
    assert.match(await evaluate('document.querySelector(".git-diff-error").textContent'), /文件读取暂时失败/);
    await click('.git-diff-error button');
    await waitFor('!!document.querySelector(".git-diff-scroll")', 'explicit retry diff');
    assert.equal(await evaluate('window.workspacePreview.calls().filter(call => call.action === "fileDiff").length'), 2);
  });
  await check('Late working diff never replaces the selected staged version', async () => {
    await reset();
    await evaluate('window.workspacePreview.defer("fileDiff")');
    await click('.gtx-file-group[aria-label="未暂存"] .gtx-file-open');
    await waitFor('window.workspacePreview.calls().some(call => call.action === "fileDiff")', 'old read');
    await evaluate('window.workspacePreview.detach("fileDiff")');
    await click('.git-diff-source button:nth-child(2)');
    await waitFor('document.querySelector(".git-diff-scroll")?.textContent.includes("staged")', 'new staged read');
    await evaluate('window.workspacePreview.finish("fileDiff")');
    await settle();
    assert.match(await evaluate('document.querySelector(".git-diff-scroll").textContent'), /'staged'/);
    assert.doesNotMatch(await evaluate('document.querySelector(".git-diff-scroll").textContent'), /'working'/);
  });
  await check('Workspace change closes the old file diff and ignores its response', async () => {
    await reset(); await evaluate('window.workspacePreview.defer("fileDiff")');
    await click('.gtx-file-group[aria-label="未暂存"] .gtx-file-open');
    await waitFor('window.workspacePreview.calls().some(call => call.action === "fileDiff")', 'pending file read');
    await evaluate('window.workspacePreview.switchWorkspace()');
    await waitFor('document.querySelector(".gtx-page-header p")?.textContent.includes("other-project")', 'new project view');
    await evaluate('window.workspacePreview.finish("fileDiff")'); await settle();
    assert.equal(await evaluate('!!document.querySelector(".git-file-diff")'), false);
  });
  await check('Metadata changes and shortened previews explain their limits', async () => {
    await reset();
    await evaluate(`window.workspacePreview.diff(${JSON.stringify({ diff: 'diff --git a/file b/file\nold mode 100644\nnew mode 100755' })})`);
    await openDiff();
    assert.match(await evaluate('document.querySelector(".git-diff-metadata").textContent'), /100755/);
    assert.equal(await evaluate('!!document.querySelector(".git-diff-empty")'), false);
    await reset();
    await evaluate('window.workspacePreview.diff({ truncated: true, diff: "" })');
    await openDiff();
    assert.match(await evaluate('document.querySelector(".git-diff-notice").textContent'), /仅显示部分差异/);
    assert.match(await evaluate('document.querySelector(".git-diff-empty strong").textContent'), /文件过大/);
  });
  await check('Large file diff loads more without discarding later lines', async () => {
    await reset();
    const diff = '--- /dev/null\n+++ b/large.ts\n@@ -0,0 +1,600 @@\n' + Array.from({ length: 600 }, (_, index) => `+line ${index + 1}`).join('\n');
    await evaluate(`window.workspacePreview.diff(${JSON.stringify({ diff, untracked: true })})`);
    await openDiff();
    assert.equal(await evaluate('document.querySelectorAll(".git-diff-row.add").length'), 400);
    await click('.git-diff-more button');
    assert.equal(await evaluate('document.querySelectorAll(".git-diff-row.add").length'), 600);
    assert.match(await evaluate('document.querySelector(".git-diff-scroll").textContent'), /line 600/);
    assert.equal(await evaluate('!!document.querySelector(".git-diff-more")'), false);
  });
  await check('Diff line activation opens the correct current file line', async () => {
    await reset(); await openDiff();
    await click('.git-diff-line-link[data-line="2"]');
    assert.deepEqual(await evaluate('window.workspacePreview.calls().find(call => call.action === "openFile").args'), { path: 'src/auth/session.ts', line: 2 });
  });
  await check('Mapped diff scope opens a workspace path rather than a repository prefix', async () => {
    await reset();
    await evaluate('window.workspacePreview.diff({ workspacePath: "session.ts" })');
    await openDiff(); await click('.git-diff-line-link[data-line="2"]');
    assert.deepEqual(await evaluate('window.workspacePreview.calls().find(call => call.action === "openFile").args'), { path: 'session.ts', line: 2 });
  });
  await check('Outside diff scope explains why editor navigation is unavailable', async () => {
    await reset();
    await evaluate('window.workspacePreview.diff({ outsideWorkspace: true })');
    await openDiff();
    assert.match(await evaluate('document.querySelector(".git-diff-notice").textContent'), /当前工作区之外/);
    assert.equal(await evaluate('!!document.querySelector(".git-file-diff-actions .gtx-btn")'), false);
    assert.equal(await evaluate('!!document.querySelector(".git-diff-line-link")'), false);
  });
  for (const [name, width, height, theme, fontSize] of [['file-diff-light', 1440, 960, 'light', 14], ['file-diff-dark', 1280, 860, 'dark', 14], ['file-diff-narrow', 900, 720, 'dark', 18]]) {
    await check(`${name} layout keeps long code inside its scroll area`, async () => {
      await reset(); previewWindow.setContentSize(width, height);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.style.setProperty('--fs-base', '${fontSize}px')`);
      const diff = '--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+' + 'const longIdentifier = '.repeat(120);
      await evaluate(`window.workspacePreview.diff(${JSON.stringify({ diff })})`);
      await openDiff();
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      await click('.git-diff-wrap');
      assert.equal(await evaluate('document.querySelector(".git-diff-scroll").scrollWidth > document.querySelector(".git-diff-scroll").clientWidth'), true);
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      await click('.git-diff-wrap');
      await capture(name);
    });
  }
  await check('Sync target display and API honor separate push and pull remotes', async () => {
    await reset();
    await syncInfo({ remotes: ['team', 'backup'], tracking: { remote: 'team', branch: 'release' }, pushDefault: 'backup' });
    const current = await evaluate('window.workspacePreview.snapshot().branch');
    const labels = await evaluate('document.querySelector(".gtx-sync-targets").textContent');
    assert.match(labels, /team\/release/); assert.ok(labels.includes(`backup/${current}`));
    await click('.gtx-push');
    assert.deepEqual(await evaluate('window.workspacePreview.calls().find(call => call.action === "push").args'), ['backup', `refs/heads/${current}:refs/heads/${current}`, false, false]);
    await capture('sync-targets');
  });
  await check('No configured remote explains disabled sync controls', async () => {
    await reset();
    await syncInfo({ remotes: [], tracking: null, pushDefault: null });
    assert.equal(await evaluate('document.querySelector(".gtx-push").disabled'), true);
    assert.equal(await evaluate('document.querySelector(".gtx-pull").disabled'), true);
    assert.match(await evaluate('document.querySelector(".gtx-sync-targets").textContent'), /尚未配置远程/);
    assert.equal(await evaluate(`document.querySelector('.gtx-card-head button[title*="远程仓库"]').disabled`), true);
    assert.match(await evaluate('document.querySelector(".gtx-pr-readiness").textContent'), /配置远程仓库/);
  });
  await check('First publish requires a remote choice and requests tracking explicitly', async () => {
    await reset();
    await syncInfo({ remotes: ['team', 'backup'], tracking: null, pushDefault: null });
    assert.equal(await evaluate('document.querySelector(".gtx-push").disabled'), true);
    await choose('.gtx-sync-remote', 'team');
    assert.match(await evaluate('document.querySelector(".gtx-push").textContent'), /发布分支/);
    await capture('sync-publish');
    await click('.gtx-push');
    const args = await evaluate('window.workspacePreview.calls().find(call => call.action === "push").args');
    assert.equal(args[0], 'team'); assert.equal(args[3], true);
  });
  await check('Pull strategy selection is passed with the actual tracking branch', async () => {
    await reset();
    await syncInfo({ remotes: ['team'], tracking: { remote: 'team', branch: 'release' }, pushDefault: 'team' });
    await click('.gtx-sync-settings-toggle');
    await choose('.gtx-pull-strategy', 'merge');
    await click('.gtx-pull');
    assert.deepEqual(await evaluate('window.workspacePreview.calls().find(call => call.action === "pull").args'), ['team', 'release', 'merge']);
  });
  await check('Removing an explicitly chosen remote never silently redirects a sync', async () => {
    await reset();
    await syncInfo({ remotes: ['team', 'backup'], tracking: { remote: 'team', branch: 'release' }, pushDefault: 'team' });
    await click('.gtx-sync-settings-toggle'); await choose('.gtx-sync-remote', 'backup');
    await syncInfo({ remotes: ['team'], tracking: { remote: 'team', branch: 'release' }, pushDefault: 'team' });
    assert.equal(await evaluate('document.querySelector(".gtx-push").disabled'), true);
    assert.match(await evaluate('document.querySelector(".gtx-sync-targets").textContent'), /已不存在/);
    await evaluate('document.querySelector(".gtx-push").click()');
    assert.equal(await evaluate('window.workspacePreview.calls().some(call => call.action === "push")'), false);
  });
  await check('Workspace changes discard old manual remote and policy choices', async () => {
    await reset();
    await syncInfo({ remotes: ['team', 'backup'], tracking: { remote: 'team', branch: 'release' }, pushDefault: 'team' });
    await click('.gtx-sync-settings-toggle'); await choose('.gtx-sync-remote', 'backup');
    await choose('.gtx-pull-strategy', 'rebase');
    await evaluate('window.workspacePreview.switchWorkspace()');
    await waitFor('document.querySelector(".gtx-page-header p")?.textContent.includes("other-project") && !document.querySelector(".gtx-pull").disabled', 'new sync context');
    await click('.gtx-pull');
    assert.deepEqual(await evaluate('window.workspacePreview.calls().find(call => call.action === "pull").args'), ['team', 'release', 'configured']);
  });
  await check('Unborn and detached branches never offer a misleading publish or pull', async () => {
    for (const scenario of ['unborn', 'detached']) {
      await reset(scenario);
      assert.equal(await evaluate('document.querySelector(".gtx-push").disabled'), true);
      assert.equal(await evaluate('document.querySelector(".gtx-pull").disabled'), true);
    }
  });
  const screenshots = [];
  for (const [name, width, height, theme, fontSize] of [['light', 1440, 960, 'light', 14], ['dark', 1280, 860, 'dark', 14], ['narrow', 900, 720, 'light', 14], ['large-type', 900, 720, 'dark', 18]]) {
    await check(`${name} workspace layout`, async () => {
      await reset(); previewWindow.setContentSize(width, height);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.style.setProperty('--fs-base', '${fontSize}px')`);
      await section('更改'); await section('提交或推送');
      const overflow = await evaluate('document.documentElement.scrollWidth > innerWidth');
      assert.equal(overflow, false, 'workspace must not scroll horizontally');
      screenshots.push(await capture(name));
    });
  }
  await check('Themes produce distinct rendered screenshots', async () => {
    assert.ok(screenshots.length >= 2, 'at least two completed layout captures');
    assert.equal(screenshots[0].equals(screenshots[1]), false, 'light and dark must render distinct images');
  });
  await check('Quality dashboard opens with a score that matches its own breakdown', async () => {
    // 上一个布局场景停在深色 18px 上，先回到浅色常规字号再截图。
    await evaluate('document.documentElement.dataset.theme = "light"; document.documentElement.style.setProperty("--fs-base", "14px")');
    await settle();
    await click('.workspace-preview-quality');
    await waitFor('document.querySelector(".quality-dashboard")?.textContent.includes("3.8")', 'quality metrics');
    const text = await evaluate('document.querySelector(".quality-dashboard").textContent');
    // 388 个函数 / 7 个严重函数 / 14 个异味 / 1 组循环依赖：按条数扣分的旧公式
    // 把这个完全正常的夹具算成“0 分 / F / 需要重构”，现在应当落在 B 段。
    assert.match(text, /综合质量：良好/);
    const numbers = await evaluate('[...document.querySelectorAll(".score-breakdown .breakdown-value")].map((element) => Math.abs(parseFloat(element.textContent.replace("−", ""))))');
    const score = await evaluate('parseInt(document.querySelector(".grade-score").textContent, 10)');
    assert.equal(numbers.length, 3, '三个扣分明细都要在面板上');
    const deducted = numbers.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(100 - deducted - score) <= 1, `扣分明细 ${numbers.join(' + ')} 与 ${score} 分对不上`);
    assert.equal(await evaluate('document.querySelectorAll("button.metric-card").length'), 3);
    assert.equal(await evaluate('document.querySelectorAll(".metric-card svg").length'), 3, '指标卡用 lucide 图标');
    assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u, '面板里不该再有 emoji 图标');
    const lightBackground = await evaluate('getComputedStyle(document.querySelector(".quality-dashboard")).backgroundColor');
    const light = await capture('quality');
    await evaluate('document.documentElement.dataset.theme = "dark"');
    await settle();
    const darkBackground = await evaluate('getComputedStyle(document.querySelector(".quality-dashboard")).backgroundColor');
    assert.notEqual(darkBackground, lightBackground, '深色主题必须换掉面板表面颜色');
    // 离屏渲染只会在收到 damage 时合成新帧：丢掉第一帧，保证截图是主题切换之后画的。
    await capture('quality-dark');
    const dark = await capture('quality-dark');
    assert.equal(light.equals(dark), false, '深浅色必须截出两张不同的图');
    await evaluate('document.documentElement.dataset.theme = "light"');
    await settle();
  });

  await check('Quality metric cards are buttons that open their own tab', async () => {
    await evaluate('document.querySelector("button.metric-card").focus()');
    assert.equal(await evaluate('document.activeElement.className'), 'metric-card', '指标卡要能被键盘聚焦');
    await key('Enter', 'Enter', 13);
    assert.equal(await evaluate('document.querySelector(".dashboard-tabs .tab.active").textContent'), '复杂度');
    assert.equal(await evaluate('document.querySelector("#quality-tab-complexity").getAttribute("aria-selected")'), 'true');
    assert.match(await evaluate('document.querySelector(".dashboard-content").textContent'), /低 300/, '风险分布图例');
    // “高”曾经和“严重”共用同一个红色，分布图里两段合成一段、图例也分不出来。
    const dots = await evaluate('[...document.querySelectorAll(".distribution-legend .legend-dot")].map((dot) => getComputedStyle(dot).backgroundColor)');
    assert.equal(new Set(dots).size, 4, `四个风险级别要四种颜色，实际 ${dots.join(' / ')}`);
    await capture('quality-complexity');
  });

  await check('Quality tabs follow the keyboard and localise severities', async () => {
    await evaluate('document.getElementById("quality-tab-complexity").focus()');
    await key('ArrowRight', 'ArrowRight', 39);
    assert.equal(await evaluate('document.querySelector(".dashboard-tabs .tab.active").textContent'), '代码异味');
    const smellsText = await evaluate('document.querySelector(".dashboard-content").textContent');
    assert.match(smellsText, /严重/, '严重程度用中文标签');
    assert.doesNotMatch(smellsText, /\bcritical\b|\bmajor\b/, '不再把检测器英文 id 丢给用户');
    assert.match(smellsText, /超长函数/, '异味类型有中文读法');
    await key('End', 'End', 35);
    assert.equal(await evaluate('document.querySelector(".dashboard-tabs .tab.active").textContent'), '依赖关系');
    await capture('quality-dependencies');
    await key('Home', 'Home', 36);
    assert.equal(await evaluate('document.querySelector(".dashboard-tabs .tab.active").textContent'), '总览');
  });

  await check('Quality scope field is labelled and Enter re-runs the analysis', async () => {
    const count = async () => await evaluate('window.workspacePreview.calls().filter((call) => call.action.startsWith("quality:")).length');
    const before = await count();
    assert.match(await evaluate('document.querySelector(".pattern-label").textContent'), /分析范围/);
    assert.equal(await evaluate('document.querySelector(".pattern-input").getAttribute("aria-label")'), '分析范围（glob 模式，回车开始分析）');
    await evaluate('document.querySelector(".pattern-input").focus()');
    await key('Enter', 'Enter', 13);
    await waitFor(`window.workspacePreview.calls().filter((call) => call.action.startsWith("quality:")).length > ${before}`, 're-analysis after Enter');
  });

  await check('Quality panel explains an empty scope instead of showing a broken shell', async () => {
    await evaluate('window.workspacePreview.qualityScenario("empty")');
    await click('.workspace-preview-quality');
    await waitFor('document.querySelector(".quality-dashboard")?.textContent.includes("暂不给出评分")', 'empty scope score');
    const content = await evaluate('document.querySelector(".dashboard-content").textContent');
    assert.match(content, /没有可分析的函数/);
    assert.match(content, /没有可分析的内容/, '什么都没分析时不能声称“没有严重问题”');
    assert.doesNotMatch(content, /没有严重问题/);
    assert.doesNotMatch(content, /NaN|undefined|Infinity/, '空数据不能算出 NaN 宽度或坏文案');
    assert.equal(await evaluate('document.querySelectorAll("button.metric-card").length'), 3, '空范围时指标卡仍显示 0 而不是消失');
    await capture('quality-empty');
    await evaluate('window.workspacePreview.qualityScenario("normal")');
  });
  assert.deepEqual(reports.filter(report => !report.ok), [], 'workspace behavior failures');
  assert.deepEqual(errors, [], 'renderer errors');
}).catch((error) => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ reports, errors }, null, 2));
  if (errors.length) console.error(errors.join('\n'));
  if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy();
  if (server) await server.close();
  app.exit(process.exitCode || 0);
});
