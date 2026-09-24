'use strict';

// Integration tests for the checkpoint backend (ported from zcode's
// gitCheckpointService). These run real git commands against a scratch repo —
// the semantics under test (hidden refs, temp index, three-way restore with
// blob-hash conflict detection) only exist in git itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const {
  REF_PREFIX,
  createCheckpointBackend,
  getCheckpointRefName,
  getWorkspaceHash,
  parseNameStatus,
  parseNumstat,
} = require('../electron/checkpoints.cjs');

function runGit(cwd, args) {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.code !== 1) reject(new Error(`git ${args.join(' ')}: ${stderr || error.message}`));
      else resolvePromise({ exitCode: error ? error.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'ckpt-test-'));
  await runGit(root, ['init', '-b', 'main']);
  await runGit(root, ['config', 'user.email', 'test@example.com']);
  await runGit(root, ['config', 'user.name', 'Test']);
  await writeFile(join(root, 'base.txt'), 'line1\nline2\n');
  await runGit(root, ['add', '.']);
  await runGit(root, ['commit', '-m', 'base']);
  return root;
}

test('parseNameStatus handles rename records and simple kinds', () => {
  const entries = parseNameStatus('R\0old.txt\0new.txt\0M\0a.txt\0A\0b.txt\0D\0c.txt\0');
  assert.deepEqual(entries, [
    { kind: 'renamed', originalPath: 'old.txt', path: 'new.txt' },
    { kind: 'modified', originalPath: null, path: 'a.txt' },
    { kind: 'added', originalPath: null, path: 'b.txt' },
    { kind: 'deleted', originalPath: null, path: 'c.txt' },
  ]);
});

test('parseNumstat reads plain and rename records', () => {
  // With -z, a rename numstat record has an empty path slot; the original and
  // new paths follow as separate NUL records.
  const stats = parseNumstat('3\t1\ta.txt\0-\t-\t\0orig.txt\0renamed.txt\0');
  assert.equal(stats.get('a.txt').added, 3);
  assert.equal(stats.get('a.txt').removed, 1);
  assert.equal(stats.get('renamed.txt').added, 0);
  assert.equal(stats.get('orig.txt').removed, 0);
});

test('checkpoint create, diff, restore, conflict, force, delete', async () => {
  const repo = await makeRepo();
  const storeRoot = await mkdtemp(join(tmpdir(), 'ckpt-store-'));
  const backend = createCheckpointBackend({ storeRootDir: storeRoot });

  try {
    const a = await backend.createCheckpoint({ workspacePath: repo });
    assert.equal(a.scope, 'workspace');
    assert.equal(a.refName, `${REF_PREFIX}/${getWorkspaceHash(repo)}/${a.checkpointId}`);

    // Hidden ref pins the snapshot; the user's index stays clean.
    const refs = await runGit(repo, ['for-each-ref', '--format=%(refname)', REF_PREFIX]);
    assert.ok(refs.stdout.includes(a.checkpointId), 'hidden ref exists');
    const status = await runGit(repo, ['status', '--porcelain']);
    assert.equal(status.stdout, '', 'checkpoint must not touch the worktree or index');

    // Agent turn: edit + add, then snapshot again.
    await writeFile(join(repo, 'base.txt'), 'line1\nCHANGED\n');
    await writeFile(join(repo, 'extra.txt'), 'new\n');
    const b = await backend.createCheckpoint({ workspacePath: repo });

    const diff = await backend.diffCheckpoints({
      workspacePath: repo,
      fromCheckpointId: a.checkpointId,
      toCheckpointId: b.checkpointId,
    });
    const kinds = Object.fromEntries(diff.files.map((f) => [f.workspaceRelativePath, f.kind]));
    assert.equal(kinds['base.txt'], 'modified');
    assert.equal(kinds['extra.txt'], 'added');
    const baseDiff = diff.files.find((f) => f.workspaceRelativePath === 'base.txt');
    assert.equal(baseDiff.added, 1);
    assert.equal(baseDiff.removed, 1);

    // Undo the turn: worktree currently matches B, target is A. The added file
    // must disappear and base.txt must revert.
    const restore = await backend.restoreBetweenCheckpoints({
      workspacePath: repo,
      fromCheckpointId: b.checkpointId,
      toCheckpointId: a.checkpointId,
    });
    assert.equal(restore.success, true);
    assert.deepEqual(
      restore.restoredPaths.map((p) => p.replace(/\\/g, '/')).sort(),
      [
        join(repo, 'base.txt').replace(/\\/g, '/'),
        join(repo, 'extra.txt').replace(/\\/g, '/'),
      ],
    );
    assert.equal((await readFile(join(repo, 'base.txt'), 'utf-8')).replace(/\r\n/g, '\n'), 'line1\nline2\n');
    await assert.rejects(() => readFile(join(repo, 'extra.txt'), 'utf-8'), /ENOENT/);

    // Deviate from the declared baseline: restore must refuse without force.
    await writeFile(join(repo, 'base.txt'), 'USER EDIT\n');
    const refused = await backend.restoreBetweenCheckpoints({
      workspacePath: repo,
      fromCheckpointId: a.checkpointId,
      toCheckpointId: b.checkpointId,
    });
    assert.equal(refused.success, false);
    assert.equal(refused.conflicts.length, 1);
    assert.equal(refused.conflicts[0].reason, 'content-mismatch');
    assert.equal(refused.conflicts[0].workspaceRelativePath, 'base.txt');

    const forced = await backend.restoreBetweenCheckpoints({
      workspacePath: repo,
      fromCheckpointId: a.checkpointId,
      toCheckpointId: b.checkpointId,
      force: true,
    });
    assert.equal(forced.success, true);
    assert.equal((await readFile(join(repo, 'base.txt'), 'utf-8')).replace(/\r\n/g, '\n'), 'line1\nCHANGED\n');
    assert.equal((await readFile(join(repo, 'extra.txt'), 'utf-8')).replace(/\r\n/g, '\n'), 'new\n');

    // Workspace-scoped listing and deletion.
    const listed = await backend.listCheckpoints({ workspacePath: repo });
    assert.deepEqual(listed.map((m) => m.checkpointId), [a.checkpointId, b.checkpointId]);

    await backend.deleteCheckpoint({ workspacePath: repo, checkpointId: b.checkpointId });
    const refsAfter = await runGit(repo, ['for-each-ref', '--format=%(refname)', REF_PREFIX]);
    assert.ok(!refsAfter.stdout.includes(b.checkpointId), 'ref removed');
    await assert.rejects(() => backend.diffCheckpoints({
      workspacePath: repo,
      fromCheckpointId: a.checkpointId,
      toCheckpointId: b.checkpointId,
    }), /does not exist/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
  }
});

test('refuse checkpoint outside a git repository', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'ckpt-nogit-'));
  const storeRoot = await mkdtemp(join(tmpdir(), 'ckpt-store-'));
  const backend = createCheckpointBackend({ storeRootDir: storeRoot });
  try {
    await assert.rejects(() => backend.createCheckpoint({ workspacePath: plain }), /not inside a Git repository/);
  } finally {
    await rm(plain, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
  }
});

test('nested workspace scope only snapshots the subdirectory', async () => {
  const repo = await makeRepo();
  const storeRoot = await mkdtemp(join(tmpdir(), 'ckpt-store-'));
  const backend = createCheckpointBackend({ storeRootDir: storeRoot });
  try {
    const sub = join(repo, 'packages', 'app');
    await mkdir(sub, { recursive: true });
    await writeFile(join(repo, 'outside.txt'), 'root\n');
    await writeFile(join(sub, 'inside.txt'), 'sub\n');
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'structure']);

    const meta = await backend.createCheckpoint({ workspacePath: sub });
    assert.equal(meta.workspaceInRepoPath, 'packages/app');

    // A change outside the workspace scope must not appear in the diff.
    await writeFile(join(repo, 'outside.txt'), 'EDITED\n');
    await writeFile(join(repo, 'untracked-outside.txt'), 'temp\n');
    const next = await backend.createCheckpoint({ workspacePath: sub });
    const diff = await backend.diffCheckpoints({
      workspacePath: sub,
      fromCheckpointId: meta.checkpointId,
      toCheckpointId: next.checkpointId,
    });
    assert.equal(diff.files.length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
  }
});
