'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../electron/git.cjs');

function fixture({ tracking = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yoy-sync-'));
  const repo = path.join(base, 'repo');
  const primary = path.join(base, 'primary.git');
  const backup = path.join(base, 'backup.git');
  const hooks = path.join(base, 'empty-hooks');
  fs.mkdirSync(repo); fs.mkdirSync(hooks);
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  const run = (cwd, ...args) => execFileSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false', ...args], { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  const configure = (cwd) => {
    run(cwd, 'config', 'user.name', 'Sync Review');
    run(cwd, 'config', 'user.email', 'sync@example.invalid');
    run(cwd, 'config', 'core.autocrlf', 'false');
    run(cwd, 'config', 'core.hooksPath', hooks);
    run(cwd, 'config', 'commit.gpgSign', 'false');
    run(cwd, 'config', 'pull.rebase', 'false');
    run(cwd, 'config', 'pull.ff', 'true');
  };
  run(repo, 'init', '-b', 'local'); configure(repo);
  run(base, 'init', '--bare', '-b', 'release', primary);
  run(base, 'init', '--bare', '-b', 'local', backup);
  run(primary, 'config', 'core.hooksPath', hooks);
  run(backup, 'config', 'core.hooksPath', hooks);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  run(repo, 'add', '.'); run(repo, 'commit', '-m', 'base');
  run(repo, 'remote', 'add', 'team', primary);
  run(repo, 'remote', 'add', 'backup', backup);
  if (tracking) run(repo, 'push', '-u', 'team', 'local:refs/heads/release');
  const remoteCommit = () => {
    const clone = path.join(base, 'writer');
    run(base, 'clone', '-b', 'release', primary, clone); configure(clone);
    fs.writeFileSync(path.join(clone, 'remote.txt'), 'remote change\n');
    run(clone, 'add', '.'); run(clone, 'commit', '-m', 'remote change');
    run(clone, 'push', 'origin', 'HEAD:refs/heads/release');
    return run(clone, 'rev-parse', 'HEAD');
  };
  const localCommit = () => {
    fs.writeFileSync(path.join(repo, 'local.txt'), 'local change\n');
    run(repo, 'add', '.'); run(repo, 'commit', '-m', 'local change');
    return run(repo, 'rev-parse', 'HEAD');
  };
  return { base, repo, primary, backup, run, remoteCommit, localCommit };
}

test('sync metadata honors tracking names and a separate preferred push remote', async () => {
  const { repo, run } = fixture();
  run(repo, 'config', 'branch.local.pushRemote', 'backup');
  const result = await git.getBranches(repo);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.sync.remotes.sort(), ['backup', 'team']);
  assert.deepEqual(result.sync.tracking, { remote: 'team', branch: 'release' });
  assert.equal(result.sync.pushDefault, 'backup');
});

test('invalid tracking metadata never exports a credential-bearing URL', async () => {
  const { repo, run } = fixture();
  run(repo, 'config', 'branch.local.remote', 'https://private-token@example.invalid/repo');
  const result = await git.getBranches(repo);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.sync.invalidTracking, true);
  assert.doesNotMatch(JSON.stringify(result), /private-token|example.invalid/);
});

test('first publish creates exactly the requested remote branch and its upstream', async () => {
  const { repo, primary, run } = fixture({ tracking: false });
  const result = await git.push(repo, 'team', 'local:refs/heads/published', false, true);
  assert.equal(result.ok, true, result.error);
  assert.equal(run(primary, 'rev-parse', 'refs/heads/published'), run(repo, 'rev-parse', 'HEAD'));
  assert.equal(run(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'team/published');
});

test('pushing to an explicit backup preserves the existing upstream', async () => {
  const { repo, backup, run } = fixture();
  const result = await git.push(repo, 'backup', 'local:refs/heads/local', false, false);
  assert.equal(result.ok, true, result.error);
  assert.equal(run(backup, 'rev-parse', 'refs/heads/local'), run(repo, 'rev-parse', 'HEAD'));
  assert.equal(run(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'team/release');
});

test('pulling a differently named upstream fast forwards the selected local branch', async () => {
  const { repo, run, remoteCommit } = fixture();
  const expected = remoteCommit();
  const result = await git.pull(repo, 'team', 'release', 'ff-only');
  assert.equal(result.ok, true, result.error);
  assert.equal(run(repo, 'rev-parse', 'HEAD'), expected);
  assert.equal(fs.readFileSync(path.join(repo, 'remote.txt'), 'utf8'), 'remote change\n');
});

test('ff-only pull refuses divergence without rewriting local files or history', async () => {
  const { repo, run, localCommit, remoteCommit } = fixture();
  const before = localCommit(); remoteCommit();
  const result = await git.pull(repo, 'team', 'release', 'ff-only');
  assert.equal(result.ok, false);
  assert.equal(run(repo, 'rev-parse', 'HEAD'), before);
  assert.equal(fs.existsSync(path.join(repo, 'remote.txt')), false);
  assert.equal(fs.readFileSync(path.join(repo, 'local.txt'), 'utf8'), 'local change\n');
});

test('explicit merge pull is honored even when the repository prefers rebase', async () => {
  const { repo, run, localCommit, remoteCommit } = fixture();
  localCommit(); remoteCommit(); run(repo, 'config', 'pull.rebase', 'true');
  const result = await git.pull(repo, 'team', 'release', 'merge');
  assert.equal(result.ok, true, result.error);
  assert.equal(run(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
});

test('explicit rebase pull is honored even when the repository prefers merge', async () => {
  const { repo, run, localCommit, remoteCommit } = fixture();
  localCommit(); const remote = remoteCommit();
  const result = await git.pull(repo, 'team', 'release', 'rebase');
  assert.equal(result.ok, true, result.error);
  assert.equal(run(repo, 'rev-parse', 'HEAD^'), remote);
  assert.equal(fs.readFileSync(path.join(repo, 'local.txt'), 'utf8'), 'local change\n');
});

test('push cannot interpret a leading plus in a branch name as force syntax', async () => {
  const { repo, primary, run } = fixture();
  run(repo, 'branch', 'topic'); run(repo, 'checkout', '-b', '+topic');
  fs.writeFileSync(path.join(repo, 'plus.txt'), 'plus branch\n');
  run(repo, 'add', '.'); run(repo, 'commit', '-m', 'plus branch');
  const result = await git.push(repo, 'team', '+topic:refs/heads/release', false, false);
  assert.equal(result.ok, true, result.error);
  assert.equal(run(primary, 'rev-parse', 'release'), run(repo, 'rev-parse', 'HEAD'));
});

test('push rejects deletion refspecs instead of deleting a remote branch', async () => {
  const { repo, primary, run } = fixture();
  const before = run(primary, 'rev-parse', 'release');
  const result = await git.push(repo, 'team', ':refs/heads/release', false, false);
  assert.equal(result.ok, false);
  assert.equal(run(primary, 'rev-parse', 'release'), before);
});

test('push only accepts configured remote names, not arbitrary repository paths', async () => {
  const { repo, primary, run } = fixture();
  const before = run(primary, 'rev-parse', 'release');
  const result = await git.push(repo, primary, 'local:refs/heads/release');
  assert.equal(result.ok, false);
  assert.equal(run(primary, 'rev-parse', 'release'), before);
});

test('a changed upstream blocks stale first-publish confirmation', async () => {
  const { repo, primary, run } = fixture({ tracking: false });
  run(repo, 'config', 'branch.local.remote', 'backup');
  run(repo, 'config', 'branch.local.merge', 'refs/heads/local');
  const result = await git.push(repo, 'team', 'local:refs/heads/published', false, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /追踪配置已变化/);
  assert.throws(() => run(primary, 'show-ref', '--verify', '--quiet', 'refs/heads/published'));
  assert.equal(run(repo, 'config', 'branch.local.remote'), 'backup');
});

test('unknown pull policy is rejected without fetching or rewriting history', async () => {
  const { repo, run } = fixture();
  const before = run(repo, 'rev-parse', 'HEAD');
  const result = await git.pull(repo, 'team', 'release', 'unknown');
  assert.equal(result.ok, false);
  assert.equal(run(repo, 'rev-parse', 'HEAD'), before);
});

test('Unicode local and target branches retain their identities during push', async () => {
  const { repo, primary, run } = fixture();
  run(repo, 'branch', '-m', '修复/登录');
  const result = await git.push(repo, 'team', '修复/登录:refs/heads/发布/登录', false, false);
  assert.equal(result.ok, true, result.error);
  assert.equal(run(primary, 'rev-parse', 'refs/heads/发布/登录'), run(repo, 'rev-parse', 'HEAD'));
});
