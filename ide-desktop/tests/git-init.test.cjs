'use strict';
/*
 * `git init` support: a folder that has never been a repository can be turned
 * into one from inside the app, and getStatus says so instead of repeating
 * git's fatal "not a git repository" message.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../electron/git.cjs');

function tempDir(prefix = 'yoy-init-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

test('a plain folder reports itself as not a repository', async () => {
  const folder = tempDir();
  fs.writeFileSync(path.join(folder, 'notes.md'), '# notes\n');
  const status = await git.getStatus(folder);
  assert.equal(status.ok, false);
  assert.equal(status.notRepo, true);
  assert.equal(status.error, '这个文件夹还不是 git 仓库');
});

test('init creates a repository on main and status starts working', async () => {
  const folder = tempDir();
  fs.writeFileSync(path.join(folder, 'notes.md'), '# notes\n');

  const created = await git.initRepo(folder);
  assert.equal(created.ok, true);
  assert.equal(created.branch, 'main');
  assert.ok(fs.existsSync(path.join(folder, '.git')), '.git should exist after init');

  const status = await git.getStatus(folder);
  assert.equal(status.ok, true);
  assert.equal(status.branch, 'main');
  assert.equal(status.notRepo, undefined);
  assert.equal(status.unborn, true);
  // Nothing is staged or committed by init: the file is simply untracked.
  assert.deepEqual(status.staged, []);
  assert.deepEqual(status.untracked, ['notes.md']);
});

test('init refuses a folder that already belongs to a repository', async () => {
  const folder = tempDir();
  await git.initRepo(folder);
  const again = await git.initRepo(folder);
  assert.equal(again.ok, false);
  assert.equal(again.alreadyRepo, true);
});

test('init refuses a folder nested inside another repository', async () => {
  const parent = tempDir();
  await git.initRepo(parent);
  const child = path.join(parent, 'packages', 'inner');
  fs.mkdirSync(child, { recursive: true });

  const nested = await git.initRepo(child);
  assert.equal(nested.ok, false);
  assert.equal(nested.alreadyRepo, true);
  assert.equal(fs.existsSync(path.join(child, '.git')), false, 'no nested repository is created');
});

test('init honours a requested branch name', async () => {
  const folder = tempDir();
  const created = await git.initRepo(folder, { branch: 'trunk' });
  assert.equal(created.ok, true);
  assert.equal(created.branch, 'trunk');
  assert.equal(run(folder, 'symbolic-ref', '--short', 'HEAD'), 'trunk');
});

test('init rejects a branch name that is not a branch name', async () => {
  const folder = tempDir();
  const created = await git.initRepo(folder, { branch: 'bad name; rm -rf /' });
  assert.equal(created.ok, false);
  assert.match(created.error, /分支名称/);
  assert.equal(fs.existsSync(path.join(folder, '.git')), false);
});

test('a commit without a configured identity explains itself', async () => {
  const folder = tempDir();
  // Hide every level of git config so no machine-wide identity leaks in.
  const empty = path.join(folder, 'empty-config');
  fs.writeFileSync(empty, '');
  const previous = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_SYSTEM = empty;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    await git.initRepo(folder);
    fs.writeFileSync(path.join(folder, 'a.txt'), 'a\n');
    await git.stage(folder, ['a.txt']);
    const committed = await git.commit(folder, 'first');
    assert.equal(committed.ok, false);
    assert.equal(committed.missingIdentity, true);
    assert.match(committed.error, /user\.name/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const name = key === 'global' ? 'GIT_CONFIG_GLOBAL' : key === 'system' ? 'GIT_CONFIG_SYSTEM' : 'GIT_CONFIG_NOSYSTEM';
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('a freshly initialised folder with a huge untracked tree still lists', async () => {
  // node_modules / build output after `git init`: git status --untracked-files=all
  // blows the child-process buffer, and the panel used to just show an error.
  const folder = tempDir('yoy-flood-');
  const modules = path.join(folder, 'node_modules');
  fs.mkdirSync(modules);
  const long = 'b'.repeat(80);
  for (let i = 0; i < 6000; i += 1) fs.writeFileSync(path.join(modules, `f${i}-${long}.js`), '');
  await git.initRepo(folder);

  const status = await git.getStatus(folder);
  assert.equal(status.ok, true, `status must survive the flood, got: ${status.error || 'ok'}`);
  assert.deepEqual(status.untracked, ['node_modules/'], 'untracked directories collapse to one row instead of failing');
});
