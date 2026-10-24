'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async function runAppWriteChecks(context) {
  const { evaluate, click, waitFor, capture, check, fixture, ownedDirectory, gitWorkspace } = context;
  const gitEnv = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete gitEnv[name];
  const run = (root, ...args) => execFileSync('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', ...args], { cwd: root, env: gitEnv, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const assertOwned = (root) => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.app-review-owned.json'), 'utf8')).owner, 'yoycode-app-review-v1');
    assert.equal(path.resolve(run(root, 'rev-parse', '--show-toplevel').trim()).toLowerCase(), root.toLowerCase());
  };
  assertOwned(fixture);
  const file = (relative) => {
    const absolute = path.resolve(fixture, relative);
    const inside = path.relative(fixture, absolute);
    assert.ok(inside && !inside.startsWith('..') && !path.isAbsolute(inside));
    return absolute;
  };
  const read = (relative) => fs.readFileSync(file(relative), 'utf8');
  const blob = (relative, ref = '') => run(fixture, 'show', `${ref}:${relative}`);
  const cached = () => run(fixture, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean);
  const row = (group, relative, child) => `.gtx-file-group[aria-label=${JSON.stringify(group)}] .gtx-file-row[data-path=${JSON.stringify(relative)}] ${child}`;
  const notice = (value) => waitFor(`document.querySelector('.gtx-operation')?.textContent.includes(${JSON.stringify(value)}) && !document.querySelector('.gtx-page-header button[title="刷新"]').disabled`, value);
  const refresh = async () => {
    await click('.gtx-page-header button[title="刷新"]');
    await waitFor(`!document.querySelector('.gtx-page-header button[title="刷新"]').disabled`, 'refreshed write state');
  };
  const setWorkspace = async (root) => {
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ recentWorkspaces: [root] })})`);
    await context.reload();
    await waitFor(`document.querySelector('.rail-workspace')?.textContent.trim() === ${JSON.stringify(path.basename(root))}`, 'write workspace');
    await gitWorkspace();
  };
  const key = async (key, code, virtualKey, modifiers = 0) => {
    await context.sendKey({ type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, modifiers, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await context.sendKey({ type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, modifiers });
  };
  const describeCommit = async (value) => {
    await evaluate(`(() => { const input = document.querySelector('.gtx-commit-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); })()`);
    await waitFor('!document.querySelector(".gtx-commit-row .primary").disabled', 'commit description applied');
  };

  await setWorkspace(path.join(fixture, 'src'));
  const partialBefore = blob('src/partial.ts');
  await check('WRITE staging from the subdirectory touches only the selected index path', async () => {
    const before = cached();
    await click(row('未暂存', 'src/session.ts', 'button[title="暂存"]'));
    await notice('已暂存');
    assert.deepEqual(new Set(cached()), new Set([...before, 'src/session.ts']));
    assert.equal(blob('src/session.ts'), read('src/session.ts'));
    assert.equal(blob('src/partial.ts'), partialBefore);
  });
  await check('WRITE unstaging keeps newer local contents and other staged files', async () => {
    fs.writeFileSync(file('src/session.ts'), 'newer draft after staging\n');
    await click(row('已暂存', 'src/session.ts', 'button[title="取消暂存"]'));
    await notice('已取消暂存');
    assert.equal(read('src/session.ts'), 'newer draft after staging\n');
    assert.equal(cached().includes('src/session.ts'), false);
    assert.equal(blob('src/partial.ts'), partialBefore);
  });
  await check('WRITE cancelling discard changes neither the file nor index', async () => {
    const before = read('src/session.ts');
    const index = run(fixture, 'diff', '--cached', '--binary');
    await click(row('未暂存', 'src/session.ts', 'input'));
    await click('.gtx-body-toolbar .danger');
    await click('.confirm-dialog-cancel');
    assert.equal(read('src/session.ts'), before);
    assert.equal(run(fixture, 'diff', '--cached', '--binary'), index);
  });
  await check('WRITE confirming discard restores the selected index version only', async () => {
    const peer = read('src/partial.ts');
    await click('.gtx-body-toolbar .danger');
    await click('.confirm-dialog-confirm');
    await notice('已放弃');
    assert.equal(read('src/session.ts'), blob('src/session.ts'));
    assert.equal(read('src/partial.ts'), peer);
    assert.equal(blob('src/partial.ts'), partialBefore);
  });
  await check('WRITE bracket filenames never discard a matching peer', async () => {
    fs.writeFileSync(file('src/literal[1].txt'), 'discard selected literal\n');
    fs.writeFileSync(file('src/literal1.txt'), 'keep matching peer\n');
    await refresh();
    await click(row('未暂存', 'src/literal[1].txt', 'input'));
    await click('.gtx-body-toolbar .danger');
    await click('.confirm-dialog-confirm');
    await notice('已放弃');
    assert.equal(read('src/literal[1].txt'), blob('src/literal[1].txt'));
    assert.equal(read('src/literal1.txt'), 'keep matching peer\n');
  });
  await check('WRITE rename rows keep literal destinations and unstage both endpoints', async () => {
    const destination = file('src/renamed 中文.txt');
    if (fs.existsSync(destination)) { assert.ok(fs.lstatSync(destination).isFile()); fs.unlinkSync(destination); }
    run(fixture, 'mv', '--', 'src/rename-source.txt', 'src/renamed 中文.txt');
    await refresh();
    const label = await evaluate(`document.querySelector(${JSON.stringify(row('已暂存', 'src/renamed 中文.txt', '.gtx-file-directory'))}).textContent`);
    assert.match(label, /重命名自 src\/rename-source.txt/);
    await click(row('已暂存', 'src/renamed 中文.txt', 'button[title="取消暂存"]'));
    await notice('已取消暂存');
    assert.equal(cached().includes('src/rename-source.txt'), false);
    assert.equal(cached().includes('src/renamed 中文.txt'), false);
    assert.equal(read('src/renamed 中文.txt'), 'rename baseline\n');
    assert.equal(fs.existsSync(file('src/rename-source.txt')), false);
  });
  await check('WRITE a rejected commit retains its description and index for keyboard retry', async () => {
    await click(row('已暂存', 'src/partial.ts', 'button[title="取消暂存"]'));
    await notice('已取消暂存');
    assert.equal(cached().length, 0);
    fs.writeFileSync(file('src/说明 文档.txt'), 'Unicode content selected for commit\n');
    await refresh();
    await click(row('未暂存', 'src/说明 文档.txt', 'button[title="暂存"]'));
    await notice('已暂存');
    const hook = path.join(fixture, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    run(fixture, 'config', 'core.hooksPath', path.dirname(hook));
    fs.writeFileSync(hook, '#!/bin/sh\necho "UI review rejection" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    const description = 'UI review Unicode commit';
    const count = Number(run(fixture, 'rev-list', '--count', 'HEAD').trim());
    await describeCommit(description);
    await key('Enter', 'Enter', 13, 2);
    await waitFor('document.querySelector(".gtx-error")?.textContent.includes("UI review rejection")', 'real hook rejection');
    assert.doesNotMatch(await evaluate('document.querySelector(".gtx-error").textContent'), /Command failed|--literal-pathspecs/);
    await waitFor('document.activeElement === document.querySelector(".gtx-commit-input")', 'commit input focus restored');
    assert.equal(await evaluate('document.querySelector(".gtx-commit-input").value'), description);
    assert.deepEqual(cached(), ['src/说明 文档.txt']);
    await capture('write-commit-rejected');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    await key('Enter', 'Enter', 13, 2);
    await notice('已提交');
    assert.equal(Number(run(fixture, 'rev-list', '--count', 'HEAD').trim()), count + 1);
    assert.equal(run(fixture, 'log', '-1', '--format=%s').trim(), description);
    assert.deepEqual(run(fixture, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD').split('\0').filter(Boolean), ['src/说明 文档.txt']);
    assert.equal(blob('src/说明 文档.txt', 'HEAD'), read('src/说明 文档.txt'));
    assert.equal(await evaluate('document.querySelector(".gtx-commit-input").value'), '');
    await capture('write-commit-success');
  });
  await check('WRITE initial repository can unstage a newer draft and create its first commit', async () => {
    const unborn = ownedDirectory('write-unborn');
    if (!fs.existsSync(path.join(unborn, '.git'))) run(unborn, 'init', '-b', 'main');
    assertOwned(unborn);
    run(unborn, 'config', 'user.name', 'UI Write Review');
    run(unborn, 'config', 'user.email', 'review@example.invalid');
    run(unborn, 'config', 'core.autocrlf', 'false');
    run(unborn, 'config', 'commit.gpgSign', 'false');
    const hooks = path.join(unborn, '.git', 'empty-hooks');
    fs.mkdirSync(hooks, { recursive: true }); run(unborn, 'config', 'core.hooksPath', hooks);
    run(unborn, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    run(unborn, 'update-ref', '-d', 'refs/heads/main');
    run(unborn, 'read-tree', '--empty');
    fs.writeFileSync(path.join(unborn, '.git', 'info', 'exclude'), '.app-review-owned.json\n.aicode/\n');
    const name = 'draft 中文[1].txt';
    fs.writeFileSync(path.join(unborn, name), 'staged first version\n');
    run(unborn, 'add', '--', name);
    fs.writeFileSync(path.join(unborn, name), 'keep newer first draft\n');
    await setWorkspace(unborn);
    assert.equal(await evaluate('window.zcodeDesktop.git.status().then(status => status.branch)'), 'main');
    await click(row('已暂存', name, 'button[title="取消暂存"]'));
    await notice('已取消暂存');
    assert.equal(run(unborn, 'ls-files', '--cached'), '');
    assert.equal(fs.readFileSync(path.join(unborn, name), 'utf8'), 'keep newer first draft\n');
    await click(row('未跟踪', name, 'button[title="暂存"]'));
    await notice('已暂存');
    await describeCommit('Initial UI review commit');
    await click('.gtx-commit-row .primary');
    await notice('已提交');
    assert.equal(run(unborn, 'rev-list', '--count', 'HEAD').trim(), '1');
    assert.equal(run(unborn, 'show', `HEAD:${name}`), 'keep newer first draft\n');
    await capture('write-first-commit');
  });
};
