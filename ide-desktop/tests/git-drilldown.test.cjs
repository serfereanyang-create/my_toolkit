const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const git = require('../electron/git.cjs');

/*
 * The inspector drills down: 更改 → one file's diff, 提交图谱 → commit → its
 * files. Those two levels need their own data, covered here against real
 * temporary repositories.
 */

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtx-drill-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  run('init', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  return { dir, run };
}

test('fileDiff returns one file diff, not the whole workspace', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x\n');
  run('add', '.');
  run('commit', '-m', 'init');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\na2\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x\nb2\n');

  const res = await git.getFileDiff(dir, 'a.txt');
  assert.equal(res.ok, true);
  assert.equal(res.file, 'a.txt');
  assert.ok(res.diff.includes('a2'), 'the requested file change must be present');
  assert.ok(!res.diff.includes('b2'), 'another file must not leak into the diff');
});

test('fileDiff separates the staged side from the working tree', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\n');
  run('add', '.');
  run('commit', '-m', 'init');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nstaged\n');
  run('add', 'a.txt');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nstaged\nwork\n');

  const staged = await git.getFileDiff(dir, 'a.txt', true);
  assert.ok(staged.diff.includes('+staged'));
  assert.ok(!staged.diff.includes('work'), 'working-tree edits must not appear in the staged diff');

  const work = await git.getFileDiff(dir, 'a.txt', false);
  assert.ok(work.diff.includes('work'));
});

test('fileDiff renders an untracked file as an all-added listing', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\n');
  run('add', '.');
  run('commit', '-m', 'init');

  fs.writeFileSync(path.join(dir, 'new.txt'), 'alpha\nbeta\n');

  const res = await git.getFileDiff(dir, 'new.txt');
  assert.equal(res.ok, true);
  assert.equal(res.untracked, true);
  // The row would otherwise open to an empty pane.
  assert.ok(res.diff.includes('+alpha'));
  assert.ok(res.diff.includes('+beta'));
});

test('fileDiff with a commit ref shows that commit change, not the working tree', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  run('add', '.');
  run('commit', '-m', 'first');
  const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, windowsHide: true }).toString().trim();

  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2\n');
  run('add', '.');
  run('commit', '-m', 'second');

  // The working tree is clean now; without the ref this would be empty.
  const res = await git.getFileDiff(dir, 'a.txt', false, first);
  assert.equal(res.ok, true);
  assert.ok(res.diff.includes('+v1'), 'must show what the first commit introduced');
  assert.ok(!res.diff.includes('+v2'), 'must not show a later commit\'s content');
});

test('fileDiff rejects a ref that could be read as an option', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  run('add', '.');
  run('commit', '-m', 'init');
  const res = await git.getFileDiff(dir, 'a.txt', false, '--upload-pack=evil');
  assert.equal(res.ok, false);
});

test('fileDiff with no path fails instead of returning the whole diff', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  run('add', '.');
  run('commit', '-m', 'init');
  const res = await git.getFileDiff(dir, '');
  assert.equal(res.ok, false);
});

test('commitDetail returns the message, body and changed files', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\n');
  run('add', '.');
  run('commit', '-m', 'init');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
  run('add', '.');
  run('commit', '-m', 'subject line', '-m', 'body paragraph');

  const res = await git.getCommitDetail(dir, 'HEAD');
  assert.equal(res.ok, true);
  const commit = res.commit;
  assert.equal(commit.message, 'subject line');
  assert.ok(commit.body.includes('body paragraph'), 'the body must be kept separate from the subject');
  assert.ok(commit.shortHash.length >= 7);
  assert.equal(commit.author, 'Test');

  const paths = commit.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['a.txt', 'b.txt']);
  const a = commit.files.find((f) => f.path === 'a.txt');
  assert.equal(a.added, 2);
  assert.equal(a.removed, 0);
});

test('commitDetail keeps a binary file row without inventing line counts', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\n');
  run('add', '.');
  run('commit', '-m', 'init');

  // NUL bytes make git treat this as binary and report "-" in numstat.
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 4]));
  run('add', '.');
  run('commit', '-m', 'add binary');

  const res = await git.getCommitDetail(dir, 'HEAD');
  const row = res.commit.files.find((f) => f.path === 'blob.bin');
  assert.ok(row, 'a binary file must still be listed');
  assert.equal(row.added, 0);
  assert.equal(row.removed, 0);
});

test('commitDetail rejects a malformed ref', async () => {
  const { dir, run } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  run('add', '.');
  run('commit', '-m', 'init');
  assert.equal((await git.getCommitDetail(dir, '')).ok, false);
  assert.equal((await git.getCommitDetail(dir, '--all')).ok, false);
  assert.equal((await git.getCommitDetail(dir, 'a b')).ok, false);
});

test('fileDiff works when the workspace is a SUBDIRECTORY of the repo', async () => {
  // Regression: `git diff --numstat` reports paths relative to the repo root.
  // When the workspace is a subdirectory, passing such a path straight back to
  // git resolved it against the cwd — `<workspace>/<repo-relative-path>` —
  // which does not exist, so every file row opened to an empty diff while the
  // list beside it showed real numbers.
  const { dir, run } = makeRepo();
  const sub = path.join(dir, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'a.txt'), 'l1\n');
  run('add', '.');
  run('commit', '-m', 'init');

  fs.writeFileSync(path.join(sub, 'a.txt'), 'l1\nl2\n');

  // The workspace root the desktop would use is the subdirectory, and the
  // path it gets from fileStats is repo-root-relative.
  const stats = await git.getFileStats(sub);
  assert.equal(stats.ok, true);
  const listed = stats.files[0].path;
  assert.ok(listed.includes('a.txt'), `unexpected listed path: ${listed}`);

  const res = await git.getFileDiff(sub, listed);
  assert.equal(res.ok, true);
  assert.ok(res.diff, 'the diff must not be empty for a subdirectory workspace');
  assert.ok(res.diff.includes('+l2'), 'the actual change must be present');
});

test('fileChangeRanges also resolves paths from a subdirectory workspace', async () => {
  const { dir, run } = makeRepo();
  const sub = path.join(dir, 'inner');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'a.txt'), 'l1\nl2\n');
  run('add', '.');
  run('commit', '-m', 'init');

  fs.writeFileSync(path.join(sub, 'a.txt'), 'l1\nl2\nl3\n');
  const res = await git.getFileChangeRanges(sub, 'inner/a.txt');
  assert.equal(res.ok, true);
  assert.ok(res.hunks.length > 0, 'editor highlights would silently disappear otherwise');
});

test('commitDetail on a non-repo directory fails gracefully', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtx-drill-norepo-'));
  const res = await git.getCommitDetail(dir, 'HEAD');
  assert.equal(res.ok, false);
  assert.ok(typeof res.error === 'string');
});
