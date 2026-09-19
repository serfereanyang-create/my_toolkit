const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const git = require('../electron/git.cjs');

/*
 * Per-file stats back the 审查 list's per-row +N −M, and getGraph backs the
 * commit graph. getDiffStats already has coverage in git-diff-stats.test.cjs;
 * this file covers the per-file breakdown it cannot provide.
 */

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtx-filestats-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  run('init', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  return { dir, run };
}

function byPath(files) {
  return new Map(files.map((f) => [f.path, f]));
}

test('fileStats reports one row per file with its own counts', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x\n');
  run('add', '.');
  run('commit', '-m', 'init');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2x\nl3\n'); // +2 -1
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x\ny\nz\n');     // +2 -0

  const res = await git.getFileStats(dir);
  assert.equal(res.ok, true);
  const map = byPath(res.files);
  assert.equal(map.get('a.txt').added, 2);
  assert.equal(map.get('a.txt').removed, 1);
  assert.equal(map.get('a.txt').status, 'unstaged');
  assert.equal(map.get('b.txt').added, 2);
  assert.equal(map.get('b.txt').removed, 0);

  // The per-file totals must agree with the workspace-wide badge.
  const totals = await git.getDiffStats(dir);
  const summed = res.files.reduce((acc, f) => acc + f.added, 0);
  assert.equal(summed, totals.added);
});

test('fileStats labels staged, unstaged and untracked correctly', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'l1\n');
  run('add', '.');
  run('commit', '-m', 'init');

  fs.writeFileSync(path.join(dir, 'committed.txt'), 'l1\nl2\n');
  run('add', 'committed.txt');                          // staged
  fs.writeFileSync(path.join(dir, 'work.txt'), 'w\n');  // untracked

  const res = await git.getFileStats(dir);
  const map = byPath(res.files);
  assert.equal(map.get('committed.txt').status, 'staged');
  assert.equal(map.get('work.txt').status, 'untracked');
  assert.equal(map.get('work.txt').added, 1);
  assert.equal(map.get('work.txt').removed, 0);
});

test('a file changed both staged and unstaged is reported once, summed', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\n');
  run('add', '.');
  run('commit', '-m', 'init');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nstaged\n');
  run('add', 'a.txt');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nstaged\nunstaged\n');

  const res = await git.getFileStats(dir);
  const rows = res.files.filter((f) => f.path === 'a.txt');
  assert.equal(rows.length, 1, 'one row per path, not one per section');
  // Both halves of the delta are visible in the single row.
  assert.equal(rows[0].added, 2);
});

test('fileStats on a clean repo lists nothing', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  run('add', '.');
  run('commit', '-m', 'init');
  const res = await git.getFileStats(dir);
  assert.equal(res.ok, true);
  assert.deepEqual(res.files, []);
});

test('fileStats on a non-repo directory fails gracefully', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtx-filestats-norepo-'));
  const res = await git.getFileStats(dir);
  assert.equal(res.ok, false);
  assert.ok(typeof res.error === 'string');
});

test('graph returns commits with their parent hashes', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  run('add', '.');
  run('commit', '-m', 'first');
  fs.writeFileSync(path.join(dir, 'a.txt'), '2\n');
  run('add', '.');
  run('commit', '-m', 'second');

  const res = await git.getGraph(dir, 10);
  assert.equal(res.ok, true);
  assert.equal(res.commits.length, 2);
  // Newest first, and the tip's parent is the root commit.
  const [tip, root] = res.commits;
  assert.equal(tip.message, 'second');
  assert.equal(tip.parents.length, 1);
  assert.equal(tip.parents[0], root.hash);
  assert.deepEqual(root.parents, [], 'the root commit has no parent');
});

test('graph records both parents of a merge commit', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  run('add', '.');
  run('commit', '-m', 'base');
  run('checkout', '-b', 'side');
  fs.writeFileSync(path.join(dir, 'side.txt'), 'side\n');
  run('add', '.');
  run('commit', '-m', 'side work');
  run('checkout', 'main');
  fs.writeFileSync(path.join(dir, 'main.txt'), 'main\n');
  run('add', '.');
  run('commit', '-m', 'main work');
  run('merge', 'side', '--no-edit');

  const res = await git.getGraph(dir, 20);
  assert.equal(res.ok, true);
  const merge = res.commits.find((c) => c.message.startsWith('Merge'));
  assert.ok(merge, 'expected a merge commit in the graph');
  assert.equal(merge.parents.length, 2);
});

test('graph on a non-repo directory fails gracefully', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtx-graph-norepo-'));
  const res = await git.getGraph(dir, 10);
  assert.equal(res.ok, false);
  assert.ok(typeof res.error === 'string');
});
