'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../electron/git.cjs');

function fixture({ initialCommit = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yoy-git-write-'));
  const run = (...args) => execFileSync('git', args, { cwd: directory, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run('init', '-b', 'main');
  run('config', 'user.name', 'Write Review');
  run('config', 'user.email', 'review@example.invalid');
  run('config', 'core.autocrlf', 'false');
  run('config', 'core.quotePath', 'true');
  run('config', 'commit.gpgSign', 'false');
  const hooks = path.join(directory, '.git', 'empty-hooks');
  fs.mkdirSync(hooks); run('config', 'core.hooksPath', hooks);
  const subdirectory = path.join(directory, 'packages', 'app');
  fs.mkdirSync(subdirectory, { recursive: true });
  fs.writeFileSync(path.join(subdirectory, 'file.txt'), 'base\n');
  fs.writeFileSync(path.join(directory, 'peer.txt'), 'peer base\n');
  if (initialCommit) { run('add', '.'); run('commit', '-m', 'test baseline'); }
  return { directory, subdirectory, run };
}

test('stage resolves a repository-relative selection from a subdirectory workspace', async () => {
  const { directory, subdirectory, run } = fixture();
  fs.writeFileSync(path.join(subdirectory, 'file.txt'), 'selected edit\n');
  fs.writeFileSync(path.join(directory, 'peer.txt'), 'keep peer edit\n');
  const result = await git.stage(subdirectory, ['packages/app/file.txt']);
  assert.equal(result.ok, true, result.error);
  assert.match(run('diff', '--cached'), /selected edit/);
  assert.doesNotMatch(run('diff', '--cached'), /keep peer edit/);
});

test('unstage resolves a subdirectory selection and preserves the working copy', async () => {
  const { subdirectory, run } = fixture();
  fs.writeFileSync(path.join(subdirectory, 'file.txt'), 'staged edit\n');
  run('add', '--', 'packages/app/file.txt');
  fs.writeFileSync(path.join(subdirectory, 'file.txt'), 'newer working edit\n');
  const result = await git.unstage(subdirectory, ['packages/app/file.txt']);
  assert.equal(result.ok, true, result.error);
  assert.equal(run('diff', '--cached'), '');
  assert.equal(fs.readFileSync(path.join(subdirectory, 'file.txt'), 'utf8'), 'newer working edit\n');
});

test('discard restores the selected index version from a subdirectory and keeps peers', async () => {
  const { directory, subdirectory, run } = fixture();
  fs.writeFileSync(path.join(subdirectory, 'file.txt'), 'index version\n');
  run('add', '--', 'packages/app/file.txt');
  fs.writeFileSync(path.join(subdirectory, 'file.txt'), 'discard this version\n');
  fs.writeFileSync(path.join(directory, 'peer.txt'), 'keep peer version\n');
  const result = await git.discardChanges(subdirectory, ['packages/app/file.txt']);
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(path.join(subdirectory, 'file.txt'), 'utf8'), 'index version\n');
  assert.equal(fs.readFileSync(path.join(directory, 'peer.txt'), 'utf8'), 'keep peer version\n');
  assert.match(run('diff', '--cached'), /index version/);
});

test('unstage before the first commit preserves newer file contents', async () => {
  const { subdirectory, directory, run } = fixture({ initialCommit: false });
  run('add', '--', 'packages/app/file.txt');
  fs.writeFileSync(path.join(subdirectory, 'file.txt'), 'latest draft\n');
  const result = await git.unstage(directory, ['packages/app/file.txt']);
  assert.equal(result.ok, true, result.error);
  assert.equal(run('ls-files', '--cached'), '');
  assert.equal(fs.readFileSync(path.join(subdirectory, 'file.txt'), 'utf8'), 'latest draft\n');
});

test('status keeps Unicode and spaced filenames literal', async () => {
  const { directory } = fixture();
  const name = '说明 文档[1].txt';
  fs.writeFileSync(path.join(directory, name), '中文内容\n');
  const status = await git.getStatus(directory);
  assert.equal(status.ok, true, status.error);
  assert.ok(status.untracked.includes(name), JSON.stringify(status.untracked));
});

test('status exposes rename destination and original path separately', async () => {
  const { directory, run } = fixture();
  run('mv', '--', 'peer.txt', 'renamed peer.txt');
  const status = await git.getStatus(directory);
  const renamed = status.staged.find((file) => file.path === 'renamed peer.txt');
  assert.ok(renamed, JSON.stringify(status.staged));
  assert.equal(renamed.originalPath, 'peer.txt');
});

test('unstaging a rename restores both index endpoints without moving the file', async () => {
  const { directory, run } = fixture();
  run('mv', '--', 'peer.txt', 'renamed.txt');
  const result = await git.unstage(directory, ['renamed.txt']);
  assert.equal(result.ok, true, result.error);
  assert.equal(run('diff', '--cached'), '');
  assert.equal(fs.readFileSync(path.join(directory, 'renamed.txt'), 'utf8'), 'peer base\n');
  assert.equal(fs.existsSync(path.join(directory, 'peer.txt')), false);
});

test('staging a bracket filename never also stages a wildcard peer', async () => {
  const { directory, run } = fixture();
  fs.writeFileSync(path.join(directory, 'data[1].txt'), 'selected\n');
  fs.writeFileSync(path.join(directory, 'data1.txt'), 'not selected\n');
  const result = await git.stage(directory, ['data[1].txt']);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(run('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean), ['data[1].txt']);
});

test('discarding a bracket filename never discards a wildcard peer', async () => {
  const { directory, run } = fixture();
  fs.writeFileSync(path.join(directory, 'data[1].txt'), 'selected base\n');
  fs.writeFileSync(path.join(directory, 'data1.txt'), 'peer base\n');
  run('add', '.'); run('commit', '-m', 'literal path baseline');
  fs.writeFileSync(path.join(directory, 'data[1].txt'), 'discard selected\n');
  fs.writeFileSync(path.join(directory, 'data1.txt'), 'keep peer\n');
  const result = await git.discardChanges(directory, ['data[1].txt']);
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(path.join(directory, 'data[1].txt'), 'utf8'), 'selected base\n');
  assert.equal(fs.readFileSync(path.join(directory, 'data1.txt'), 'utf8'), 'keep peer\n');
});

test('invalid mixed selections fail before staging any valid member', async () => {
  const { directory, subdirectory, run } = fixture();
  fs.writeFileSync(path.join(subdirectory, 'file.txt'), 'keep unstaged\n');
  const result = await git.stage(directory, ['packages/app/file.txt', '../outside.txt']);
  assert.equal(result.ok, false);
  assert.equal(run('diff', '--cached'), '');
});

test('first-commit status reports the real branch name', async () => {
  const { directory } = fixture({ initialCommit: false });
  const status = await git.getStatus(directory);
  assert.equal(status.ok, true, status.error);
  assert.equal(status.branch, 'main');
  assert.equal(status.unborn, true);
});

test('stage accepts a large literal selection without Windows command-line limits', async () => {
  const { directory, run } = fixture();
  const names = Array.from({ length: 400 }, (_, index) => `long-${index}-${'a'.repeat(108)}.txt`);
  for (const name of names) fs.writeFileSync(path.join(directory, name), 'new file\n');
  const result = await git.stage(directory, names);
  assert.equal(result.ok, true, result.error);
  assert.equal(run('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean).length, names.length);
});

test('file and total stats keep literal repository paths in subdirectory workspaces', async () => {
  const { directory, subdirectory } = fixture();
  const relative = 'packages/app/新 文件.txt';
  fs.writeFileSync(path.join(directory, relative), 'first\nsecond\n');
  fs.writeFileSync(path.join(subdirectory, 'binary.bin'), Buffer.from([0, 10, 10]));
  const files = await git.getFileStats(subdirectory);
  assert.equal(files.ok, true, files.error);
  const text = files.files.find((file) => file.path === relative);
  assert.ok(text, JSON.stringify(files.files));
  assert.equal(text.added, 2);
  assert.equal(files.files.find((file) => file.path === 'packages/app/binary.bin').added, 0);
  const totals = await git.getDiffStats(subdirectory);
  assert.equal(totals.ok, true, totals.error);
  assert.equal(totals.added, 2);
  assert.equal(totals.fileCount, 2);
});

test('file stats identify a rename by its destination rather than an arrow expression', async () => {
  const { directory, run } = fixture();
  run('mv', '--', 'peer.txt', 'renamed peer.txt');
  const result = await git.getFileStats(directory);
  const renamed = result.files.find((file) => file.path === 'renamed peer.txt');
  assert.ok(renamed, JSON.stringify(result.files));
  assert.equal(renamed.originalPath, 'peer.txt');
  assert.equal((await git.getDiffStats(directory)).fileCount, 1);
});

test('file diff keeps bracket selections literal', async () => {
  const { directory, run } = fixture();
  fs.writeFileSync(path.join(directory, 'data[1].txt'), 'literal before\n');
  fs.writeFileSync(path.join(directory, 'data1.txt'), 'peer before\n');
  run('add', '.'); run('commit', '-m', 'diff selection baseline');
  fs.writeFileSync(path.join(directory, 'data[1].txt'), 'literal after\n');
  fs.writeFileSync(path.join(directory, 'data1.txt'), 'peer after\n');
  const result = await git.getFileDiff(directory, 'data[1].txt');
  assert.equal(result.ok, true, result.error);
  assert.match(result.diff, /literal after/);
  assert.doesNotMatch(result.diff, /peer after/);
});

test('branch list reports the initial symbolic branch before any commit', async () => {
  const { directory } = fixture({ initialCommit: false });
  const result = await git.getBranches(directory);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.current, 'main');
});

test('a leading-dash filename can be staged and reviewed literally', async () => {
  const { directory } = fixture();
  fs.writeFileSync(path.join(directory, '-notes.txt'), 'new notes\n');
  assert.equal((await git.stage(directory, ['-notes.txt'])).ok, true);
  const result = await git.getFileDiff(directory, '-notes.txt', true);
  assert.equal(result.ok, true, result.error);
  assert.match(result.diff, /new notes/);
});

test('a staged rename diff preserves the rename rather than claiming a full new file', async () => {
  const { directory, run } = fixture();
  run('mv', '--', 'peer.txt', 'renamed.txt');
  const result = await git.getFileDiff(directory, 'renamed.txt', true);
  assert.equal(result.ok, true, result.error);
  assert.match(result.diff, /rename from peer.txt/);
  assert.doesNotMatch(result.diff, /^@@/m);
});

test('commit details and history diff preserve Unicode rename identity', async () => {
  const { directory, run } = fixture();
  run('mv', '--', 'peer.txt', '重命名 文档.txt');
  run('commit', '-m', 'rename review');
  const result = await git.getCommitDetail(directory, 'HEAD');
  assert.equal(result.ok, true, result.error);
  const renamed = result.commit.files.find((file) => file.path === '重命名 文档.txt');
  assert.ok(renamed, JSON.stringify(result.commit.files));
  assert.equal(renamed.originalPath, 'peer.txt');
  const diff = await git.getFileDiff(directory, '重命名 文档.txt', false, 'HEAD');
  assert.equal(diff.ok, true, diff.error);
  assert.match(diff.diff, /rename from peer.txt/);
  assert.doesNotMatch(diff.diff, /^@@/m);
});

test('inherited Git context never redirects writes into another repository', async () => {
  const selected = fixture();
  const other = fixture();
  fs.writeFileSync(path.join(selected.directory, 'peer.txt'), 'selected repository edit\n');
  fs.writeFileSync(path.join(other.directory, 'peer.txt'), 'other repository edit\n');
  const variables = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
  const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  let result;
  try {
    process.env.GIT_DIR = path.join(other.directory, '.git');
    process.env.GIT_WORK_TREE = other.directory;
    process.env.GIT_INDEX_FILE = path.join(other.directory, '.git', 'index');
    result = await git.stage(selected.directory, ['peer.txt']);
  } finally {
    for (const name of variables) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
  assert.equal(result.ok, true, result.error);
  assert.match(selected.run('diff', '--cached'), /selected repository edit/);
  assert.equal(other.run('diff', '--cached'), '');
});

test('commit rejection reports the actual hook reason without process arguments', async () => {
  const { directory, run } = fixture();
  fs.writeFileSync(path.join(directory, 'peer.txt'), 'staged for hook\n');
  run('add', '--', 'peer.txt');
  const hook = path.join(directory, '.git', 'empty-hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "review blocked" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  const result = await git.commit(directory, 'keep this description');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'review blocked');
  assert.ok(run('diff', '--cached').includes('staged for hook'));
});
