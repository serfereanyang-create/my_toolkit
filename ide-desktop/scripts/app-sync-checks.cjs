'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async function runAppSyncChecks(context) {
  const { evaluate, click, waitFor, capture, check, ownedDirectory, gitWorkspace } = context;
  const repo = ownedDirectory('sync-repository');
  const primary = ownedDirectory('sync-primary.git');
  const backup = ownedDirectory('sync-backup.git');
  const writer = ownedDirectory('sync-writer');
  const hooks = path.join(repo, '.git', 'review-hooks');
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  const run = (cwd, ...args) => execFileSync('git', ['--literal-pathspecs', '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false', ...args], { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  const ownedRepo = (root, bare = false) => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.app-review-owned.json'), 'utf8')).owner, 'yoycode-app-review-v1');
    assert.equal(run(root, 'rev-parse', '--is-bare-repository'), String(bare));
    if (!bare) assert.equal(path.resolve(run(root, 'rev-parse', '--show-toplevel')).toLowerCase(), root.toLowerCase());
  };
  if (!fs.existsSync(path.join(repo, '.git'))) run(repo, 'init', '-b', 'local');
  ownedRepo(repo);
  fs.mkdirSync(hooks, { recursive: true });
  for (const target of [primary, backup]) {
    if (!fs.existsSync(path.join(target, 'HEAD'))) run(target, 'init', '--bare', '-b', 'release');
    ownedRepo(target, true);
    run(target, 'config', 'core.hooksPath', hooks);
  }
  const configure = (root) => {
    run(root, 'config', 'user.name', 'App Sync Review');
    run(root, 'config', 'user.email', 'sync@example.invalid');
    run(root, 'config', 'core.autocrlf', 'false');
    run(root, 'config', 'core.hooksPath', hooks);
    run(root, 'config', 'commit.gpgSign', 'false');
    run(root, 'config', 'pull.rebase', 'false');
    run(root, 'config', 'pull.ff', 'true');
    fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '.app-review-owned.json\n.aicode/\n');
  };
  configure(repo);
  let base;
  try { base = run(repo, 'rev-parse', '--verify', 'refs/ui-review/base'); }
  catch {
    fs.writeFileSync(path.join(repo, 'base.txt'), 'sync baseline\n');
    run(repo, 'add', '--', 'base.txt'); run(repo, 'commit', '-m', 'sync baseline');
    base = run(repo, 'rev-parse', 'HEAD'); run(repo, 'update-ref', 'refs/ui-review/base', base);
  }
  if (fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))) run(repo, 'merge', '--abort');
  if (fs.existsSync(path.join(repo, '.git', 'rebase-merge')) || fs.existsSync(path.join(repo, '.git', 'rebase-apply'))) run(repo, 'rebase', '--abort');
  run(repo, 'symbolic-ref', 'HEAD', 'refs/heads/local');
  run(repo, 'reset', '--hard', base);
  const remote = (name, target) => {
    if (run(repo, 'remote').split('\n').includes(name)) run(repo, 'remote', 'set-url', name, target);
    else run(repo, 'remote', 'add', name, target);
  };
  remote('team', primary); remote('backup', backup);
  run(primary, 'update-ref', '-d', 'refs/heads/local');
  run(primary, 'update-ref', '-d', 'refs/heads/release');
  run(backup, 'update-ref', '-d', 'refs/heads/local');
  run(repo, 'push', '--force', 'team', 'local:refs/heads/release');
  run(repo, 'config', 'branch.local.remote', 'team');
  run(repo, 'config', 'branch.local.merge', 'refs/heads/release');
  run(repo, 'config', 'branch.local.pushRemote', 'backup');
  run(repo, 'config', 'remote.pushDefault', '');
  if (!fs.existsSync(path.join(writer, '.git'))) run(writer, 'init', '-b', 'writer');
  ownedRepo(writer); configure(writer);
  if (run(writer, 'remote').split('\n').includes('origin')) run(writer, 'remote', 'set-url', 'origin', primary);
  else run(writer, 'remote', 'add', 'origin', primary);
  const advanceRemote = (branch, name, content) => {
    run(writer, 'fetch', 'origin', branch); run(writer, 'reset', '--hard', 'FETCH_HEAD');
    fs.writeFileSync(path.join(writer, name), content);
    run(writer, 'add', '--', name); run(writer, 'commit', '-m', `remote ${name}`);
    run(writer, 'push', 'origin', `HEAD:refs/heads/${branch}`);
    return run(writer, 'rev-parse', 'HEAD');
  };
  const advanceLocal = (name, content) => {
    fs.writeFileSync(path.join(repo, name), content);
    run(repo, 'add', '--', name); run(repo, 'commit', '-m', `local ${name}`);
    return run(repo, 'rev-parse', 'HEAD');
  };
  await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ recentWorkspaces: [repo] })})`);
  await context.reload();
  await waitFor('document.querySelector(".rail-workspace")?.textContent.trim() === "sync-repository"', 'local sync workspace');
  await gitWorkspace();
  const refresh = async () => { await click('.gtx-page-header button[title="刷新"]'); await waitFor(`!document.querySelector('.gtx-page-header button[title="刷新"]').disabled`, 'sync refresh'); };
  const ready = (phrase) => waitFor(`document.querySelector('.gtx-operation')?.textContent.includes(${JSON.stringify(phrase)}) && !document.querySelector('.gtx-page-header button[title="刷新"]').disabled`, phrase);
  const choose = async (selector, value) => {
    if (!await evaluate('Boolean(document.querySelector(".gtx-sync-remote"))')) await click('.gtx-sync-settings-toggle');
    await evaluate(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await context.settle();
  };
  await check('SYNC App shows configured push and pull destinations without assuming origin', async () => {
    await waitFor('document.querySelector(".gtx-sync-targets")?.textContent.includes("team/release")', 'tracking target');
    const targets = await evaluate('document.querySelector(".gtx-sync-targets").textContent');
    assert.match(targets, /backup\/local/); assert.match(targets, /team\/release/);
    assert.doesNotMatch(targets, /origin/); await capture('sync-configured-targets');
  });
  let release;
  await check('SYNC App fast forwards from the differently named tracked branch', async () => {
    release = advanceRemote('release', 'remote-first.txt', 'remote first\n');
    await choose('.gtx-pull-strategy', 'ff-only');
    await click('.gtx-pull'); await ready('已拉取');
    assert.equal(run(repo, 'rev-parse', 'HEAD'), release);
    assert.equal(run(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'team/release');
  });
  await check('SYNC preferred backup push leaves the pull upstream unchanged', async () => {
    const expected = advanceLocal('local-first.txt', 'local first\n'); await refresh();
    await click('.gtx-push'); await ready('已推送');
    assert.equal(run(backup, 'rev-parse', 'refs/heads/local'), expected);
    assert.equal(run(primary, 'rev-parse', 'refs/heads/release'), release);
    assert.equal(run(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'team/release');
    await capture('sync-backup-success');
  });
  let published;
  await check('SYNC first publish requires a choice and installs exactly that upstream', async () => {
    run(repo, 'config', '--unset-all', 'branch.local.remote'); run(repo, 'config', '--unset-all', 'branch.local.merge');
    run(repo, 'config', 'branch.local.pushRemote', ''); await refresh();
    assert.equal(await evaluate('document.querySelector(".gtx-push").disabled'), true);
    assert.equal(await evaluate('document.querySelector(".gtx-pull").disabled'), true);
    await choose('.gtx-sync-remote', 'team');
    assert.match(await evaluate('document.querySelector(".gtx-push").textContent'), /发布分支/);
    await click('.gtx-push'); await ready('已发布并设置追踪');
    published = run(repo, 'rev-parse', 'HEAD');
    assert.equal(run(primary, 'rev-parse', 'refs/heads/local'), published);
    assert.equal(run(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'team/local');
    assert.equal(run(primary, 'rev-parse', 'refs/heads/release'), release);
    await capture('sync-published');
  });
  await check('SYNC manual backup override never reassigns existing tracking', async () => {
    const expected = advanceLocal('local-second.txt', 'local second\n'); await refresh();
    await choose('.gtx-sync-remote', 'backup');
    await click('.gtx-push'); await ready('已推送');
    assert.equal(run(backup, 'rev-parse', 'refs/heads/local'), expected);
    assert.equal(run(primary, 'rev-parse', 'refs/heads/local'), published);
    assert.equal(run(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'team/local');
  });
  await check('SYNC removing the selected remote blocks both actions without fallback', async () => {
    const before = run(primary, 'rev-parse', 'refs/heads/local');
    run(repo, 'remote', 'remove', 'backup'); await refresh();
    assert.equal(await evaluate('document.querySelector(".gtx-push").disabled'), true);
    assert.equal(await evaluate('document.querySelector(".gtx-pull").disabled'), true);
    assert.match(await evaluate('document.querySelector(".gtx-sync-targets").textContent'), /已不存在/);
    assert.equal(run(primary, 'rev-parse', 'refs/heads/local'), before);
    await capture('sync-removed-remote');
  });
  let remoteDivergence;
  await check('SYNC ff-only divergence keeps local history and files intact', async () => {
    await choose('.gtx-sync-remote', 'team'); await choose('.gtx-pull-strategy', 'ff-only');
    remoteDivergence = advanceRemote('local', 'remote-second.txt', 'remote second\n');
    const before = run(repo, 'rev-parse', 'HEAD');
    await click('.gtx-pull');
    await waitFor('Boolean(document.querySelector(".gtx-error"))', 'fast-forward refusal');
    assert.equal(run(repo, 'rev-parse', 'HEAD'), before);
    assert.equal(fs.existsSync(path.join(repo, 'remote-second.txt')), false);
    assert.equal(await evaluate('document.querySelector(".gtx-pull").disabled'), false);
    await capture('sync-divergence-refused');
  });
  await check('SYNC explicit merge recovers from divergence while preserving both sides', async () => {
    run(repo, 'config', 'pull.rebase', 'true');
    await choose('.gtx-pull-strategy', 'merge');
    await click('.gtx-pull'); await ready('已拉取');
    assert.equal(run(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
    assert.equal(fs.readFileSync(path.join(repo, 'local-second.txt'), 'utf8'), 'local second\n');
    assert.equal(fs.readFileSync(path.join(repo, 'remote-second.txt'), 'utf8'), 'remote second\n');
    assert.equal(run(repo, 'rev-parse', 'HEAD^2'), remoteDivergence);
    await capture('sync-merge-success');
  });
  await check('SYNC explicit rebase preserves local work and produces linear history', async () => {
    advanceLocal('local-third.txt', 'local third\n');
    const expected = advanceRemote('local', 'remote-third.txt', 'remote third\n');
    run(repo, 'config', 'pull.rebase', 'false'); await refresh();
    await choose('.gtx-pull-strategy', 'rebase');
    await click('.gtx-pull'); await ready('已拉取');
    assert.equal(run(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 2);
    run(repo, 'merge-base', '--is-ancestor', expected, 'HEAD');
    assert.equal(fs.readFileSync(path.join(repo, 'local-third.txt'), 'utf8'), 'local third\n');
    assert.equal(fs.readFileSync(path.join(repo, 'remote-third.txt'), 'utf8'), 'remote third\n');
    await capture('sync-rebase-success');
  });
};
