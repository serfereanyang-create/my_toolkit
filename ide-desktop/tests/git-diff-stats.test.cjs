const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const git = require('../electron/git.cjs');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtx-diffstats-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  run('init', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  return { dir, run };
}

test('diffStats on a clean repo reports zeros', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  run('add', '.');
  run('commit', '-m', 'init');
  const res = await git.getDiffStats(dir);
  assert.equal(res.ok, true);
  assert.equal(res.added, 0);
  assert.equal(res.removed, 0);
  assert.equal(res.fileCount, 0);
});

test('diffStats counts unstaged modifications', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
  run('add', '.');
  run('commit', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2x\nl3\nl4\n'); // +2 -1
  const res = await git.getDiffStats(dir);
  assert.equal(res.added, 2);
  assert.equal(res.removed, 1);
  assert.equal(res.fileCount, 1);
});

test('diffStats includes untracked file contents as additions', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  run('add', '.');
  run('commit', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'new.ts'), 'a\nb\nc\nd'); // 4 lines, no trailing NL
  const res = await git.getDiffStats(dir);
  assert.equal(res.added, 4);
  assert.equal(res.removed, 0);
  assert.equal(res.fileCount, 1);
});

test('diffStats combines staged + unstaged + untracked and dedupes files', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n2\n');
  run('add', '.');
  run('commit', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n2\n3\n'); // staged +1
  run('add', 'a.txt');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\nX\n3\n'); // then unstaged -1 +1 on same file
  fs.writeFileSync(path.join(dir, 'b.txt'), 'u1\nu2\n');   // untracked +2
  const res = await git.getDiffStats(dir);
  assert.equal(res.added, 1 + 1 + 2);
  assert.equal(res.removed, 1);
  assert.equal(res.fileCount, 2); // a.txt counted once even though in both diffs
});

test('diffStats skips binary files (numstat dash) without crashing', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  run('add', '.');
  run('commit', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  run('add', 'blob.bin');
  const res = await git.getDiffStats(dir);
  assert.equal(res.ok, true);
  // binary → "-" in numstat, contributes 0 lines but 1 file
  assert.equal(res.fileCount, 1);
});

test('diffStats on a non-repo directory fails gracefully', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtx-norepo-'));
  const res = await git.getDiffStats(dir);
  assert.equal(res.ok, false);
  assert.ok(typeof res.error === 'string');
});

test('diffStats with no workspace root returns error object', async () => {
  const res = await git.getDiffStats('');
  assert.equal(res.ok, false);
});
