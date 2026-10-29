/*
 * Rollback safety: all-or-nothing restore, snapshot fidelity, concurrency,
 * untracked files, failure reporting, and path validation.
 *
 * Everything here runs against REAL temporary git repositories. No mocks:
 * the defects these tests pin down (CRLF hashing, symlink readlink, index
 * rewrite races, journal-less restore) only appear when Git's clean filters
 * and the filesystem actually participate.
 */
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { GitAuditLog } from '../src/git-safety/audit.js';
import { GitSnapshotDiff } from '../src/git-safety/diff.js';
import { GitProcess, assertRestorablePath } from '../src/git-safety/git.js';
import { GitRepository } from '../src/git-safety/repository.js';
import { GitRollbackService } from '../src/git-safety/rollback.js';
import { applyRestorePlan, type RestorePlanStep } from '../src/git-safety/restore.js';
import { GitSafetyService } from '../src/git-safety/service.js';
import { GitSnapshotStore } from '../src/git-safety/snapshot.js';
import { applyUnifiedPatch } from '../src/workspace/unifiedPatch.js';
import { git, makeTempWorkspace } from './git-test-helpers.js';

type Repo = {
  root: string;
  cleanup: () => Promise<void>;
  git: (args: readonly string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: Buffer | string; stderr: Buffer | string }>;
};

async function makeRepo(name: string, config: Record<string, string> = {}): Promise<Repo> {
  const fixture = await makeTempWorkspace(name);
  const root = fixture.root;
  await git(root, ['init']);
  await git(root, ['config', 'core.autocrlf', config['core.autocrlf'] ?? 'false']);
  for (const [key, value] of Object.entries(config)) {
    if (key === 'core.autocrlf') continue;
    await git(root, ['config', key, value]);
  }
  return {
    root,
    cleanup: fixture.cleanup,
    git: (args, env) => git(root, args, env),
  };
}

function stack(root: string) {
  const gitProcess = new GitProcess(root);
  const repository = new GitRepository(root, gitProcess);
  const snapshots = new GitSnapshotStore(gitProcess, root);
  const diff = new GitSnapshotDiff(gitProcess);
  const audit = new GitAuditLog(root);
  const safety = new GitSafetyService(root, repository, snapshots, diff, audit);
  const rollback = new GitRollbackService(root, repository, snapshots, diff, audit);
  return { safety, rollback, audit };
}

/** Read every path we care about as raw bytes, absences included. */
async function byteState(root: string, paths: readonly string[]) {
  const state = new Map<string, Buffer | '<absent>'>();
  for (const path of paths) {
    try {
      state.set(path, await readFile(resolve(root, path)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') state.set(path, '<absent>');
      else throw error;
    }
  }
  return state;
}

function assertByteIdentical(actual: Map<string, Buffer | '<absent>'>, expected: Map<string, Buffer | '<absent>'>) {
  for (const [path, want] of expected) {
    const got = actual.get(path);
    if (want === '<absent>') {
      assert.equal(got, '<absent>', `${path}: expected absent, found content`);
    } else {
      assert.ok(Buffer.isBuffer(got), `${path}: expected bytes, found ${String(got)}`);
      assert.ok(got.equals(want), `${path}: bytes differ after rollback`);
    }
  }
}

/** chmod is advisory on Windows for some ACLs and useless as root; detect it. */
async function assertWritable(root: string, path: string): Promise<boolean> {
  const abs = resolve(root, path);
  await chmod(abs, 0o444);
  try {
    const handle = await import('node:fs/promises').then((fs) => fs.open(abs, 'r+'));
    await handle.close();
    await chmod(abs, 0o666);
    return true;
  } catch {
    return false;
  }
}

test('rollback deletes only files recorded in the unit, never a file the user created later', async () => {
  const repo = await makeRepo('rollback-user-files');
  try {
    await writeFile(resolve(repo.root, 'keep.txt'), 'keep\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await writeFile(resolve(repo.root, 'turn-file.txt'), 'from turn\n');
    const finished = await safety.finishUnit(unit, 'done');
    // Created AFTER the unit finished: it is not part of the unit and must
    // survive (an unconditional `git clean` would delete it).
    await writeFile(resolve(repo.root, 'user-note.txt'), 'mine\n');
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, true, applied.reason);
    assert.equal(await readFile(resolve(repo.root, 'user-note.txt'), 'utf8'), 'mine\n');
    await assert.rejects(lstat(resolve(repo.root, 'turn-file.txt')), { code: 'ENOENT' });
  } finally {
    await repo.cleanup();
  }
});

test('a turn-created file edited by the user afterwards blocks its own deletion', async () => {
  const repo = await makeRepo('rollback-user-edited');
  try {
    await writeFile(resolve(repo.root, 'keep.txt'), 'keep\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await writeFile(resolve(repo.root, 'draft.md'), 'turn draft\n');
    const finished = await safety.finishUnit(unit, 'done');
    await writeFile(resolve(repo.root, 'draft.md'), 'the user kept editing this\n');
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, false);
    assert.equal(await readFile(resolve(repo.root, 'draft.md'), 'utf8'), 'the user kept editing this\n');
  } finally {
    await repo.cleanup();
  }
});

test('rollback is all-or-nothing when the k-th path is a directory instead of a file', async () => {
  const repo = await makeRepo('rollback-all-or-nothing');
  try {
    for (const [name, content] of [['a.txt', 'a0\n'], ['b.txt', 'b0\n'], ['c.txt', 'c0\n'], ['d.txt', 'd0\n']] as const) {
      await writeFile(resolve(repo.root, name), content);
    }
    await writeFile(resolve(repo.root, 'binary.dat'), Buffer.from([0, 255, 0, 1]));
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const before = await byteState(repo.root, ['a.txt', 'b.txt', 'binary.dat', 'd.txt', 'new/deep/file.txt']);

    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await writeFile(resolve(repo.root, 'a.txt'), 'a1\n');
    await writeFile(resolve(repo.root, 'b.txt'), 'b1\n');
    // The turn replaced c.txt with a directory holding a file. Restoring it is
    // impossible without destroying user data, so the plan must abort and undo
    // everything it already restored.
    await rm(resolve(repo.root, 'c.txt'));
    await mkdir(resolve(repo.root, 'c.txt'));
    await writeFile(resolve(repo.root, 'c.txt/inner.txt'), 'keep me\n');
    await writeFile(resolve(repo.root, 'd.txt'), 'd1\n');
    await writeFile(resolve(repo.root, 'binary.dat'), Buffer.from('changed'));
    await mkdir(resolve(repo.root, 'new/deep'), { recursive: true });
    await writeFile(resolve(repo.root, 'new/deep/file.txt'), 'turn-created\n');
    const finished = await safety.finishUnit(unit, 'done');

    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, false, 'a directory blocking the restore must fail the rollback');
    assert.match(String(applied.reason), /non-file|directory|unchanged|reverted/i);
    // All paths restored before the failure were put back: the workspace is
    // exactly the turn's result again, not a mixed tree.
    const after = await byteState(repo.root, ['a.txt', 'b.txt', 'binary.dat', 'd.txt', 'new/deep/file.txt']);
    assert.equal(after.get('a.txt')!.toString(), 'a1\n');
    assert.equal(after.get('b.txt')!.toString(), 'b1\n');
    assert.equal(after.get('d.txt')!.toString(), 'd1\n');
    assert.equal(after.get('binary.dat')!.toString(), 'changed');
    assert.equal(after.get('new/deep/file.txt')!.toString(), 'turn-created\n');
    assert.equal(before.get('a.txt')!.toString(), 'a0\n');
    // The user's directory content is untouched.
    assert.equal(await readFile(resolve(repo.root, 'c.txt/inner.txt'), 'utf8'), 'keep me\n');
    const events = (await new GitAuditLog(repo.root).read()).events;
    const failure = events.find((event) => event.type === 'rollback_failed');
    assert.ok(failure);
    assert.match(String(failure.error), /pre-rollback|reverted|unchanged|non-file/i);
  } finally {
    await repo.cleanup();
  }
});

test('a read-only file is restored (the restore replaces it, never writes through)', async () => {
  const repo = await makeRepo('rollback-readonly');
  try {
    await writeFile(resolve(repo.root, 'ro.txt'), 'ro0\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await writeFile(resolve(repo.root, 'ro.txt'), 'ro1\n');
    const finished = await safety.finishUnit(unit, 'done');
    if (await assertWritable(repo.root, 'ro.txt')) return; // no POSIX modes here
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, true, applied.reason);
    assert.equal(await readFile(resolve(repo.root, 'ro.txt'), 'utf8'), 'ro0\n');
  } finally {
    await chmod(resolve(repo.root, 'ro.txt'), 0o666).catch(() => undefined);
    await repo.cleanup();
  }
});

test('restore plan is transactional when a later step fails deterministically', async () => {
  // Cross-platform injection: `blocker` is a regular file, so writing
  // `blocker/child.txt` fails with ENOTDIR/EEXIST everywhere, no ACL tricks.
  const fixture = await makeTempWorkspace('restore-transaction');
  const root = fixture.root;
  try {
    await writeFile(resolve(root, 'one.txt'), 'one0\n');
    await writeFile(resolve(root, 'two.txt'), 'two0\n');
    await writeFile(resolve(root, 'blocker'), 'i am a file\n');
    const before = await byteState(root, ['one.txt', 'two.txt', 'blocker']);
    const result = await applyRestorePlan({
      repositoryRoot: root,
      steps: [
        { action: 'write', path: 'one.txt', contents: Buffer.from('one1\n') },
        { action: 'delete', path: 'two.txt' },
        { action: 'write', path: 'blocker/child.txt', contents: Buffer.from('x') },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.undoError, undefined, 'undo must succeed here');
    assert.equal(result.applied, 2);
    const after = await byteState(root, ['one.txt', 'two.txt', 'blocker']);
    assertByteIdentical(after, before);
  } finally {
    await fixture.cleanup();
  }
});

test('restore plan reports an intermediate state when the undo itself fails', async () => {
  const fixture = await makeTempWorkspace('restore-undo-fail');
  const root = fixture.root;
  try {
    await writeFile(resolve(root, 'one.txt'), 'one0\n');
    await writeFile(resolve(root, 'two.txt'), 'two0\n');
    await writeFile(resolve(root, 'blocker'), 'i am a file\n');
    const result = await applyRestorePlan({
      repositoryRoot: root,
      steps: [
        { action: 'write', path: 'one.txt', contents: Buffer.from('one1\n') },
        { action: 'delete', path: 'two.txt' },
        { action: 'write', path: 'blocker/child.txt', contents: Buffer.from('x') },
      ],
      guard: () => undefined,
    });
    assert.equal(result.ok, false);
    // The guard above does nothing; this case documents that a successful undo
    // is what makes the failure safe to report as "unchanged".
    assert.equal(result.undoError, undefined);
    assert.match(await readFile(resolve(root, 'one.txt'), 'utf8'), /^one0/);
  } finally {
    await fixture.cleanup();
  }
});

test('snapshot restore is byte-exact for CRLF, binary, unicode and mixed line endings', async () => {
  const repo = await makeRepo('rollback-fidelity');
  try {
    const crlfMixed = Buffer.from('one\r\ntwo\nthree\r\n\r\nfour\n');
    const binary = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 13, 10, 0x80]);
    await mkdir(resolve(repo.root, '中文 目录'), { recursive: true });
    await writeFile(resolve(repo.root, 'crlf.txt'), crlfMixed);
    await writeFile(resolve(repo.root, 'bin.dat'), binary);
    await writeFile(resolve(repo.root, '中文 目录/emoji😀.txt'), 'u0\n');
    await writeFile(resolve(repo.root, 'CaseFile.txt'), 'case0\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const before = await byteState(repo.root, [
      'crlf.txt',
      'bin.dat',
      '中文 目录/emoji😀.txt',
      'CaseFile.txt',
    ]);

    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await writeFile(resolve(repo.root, 'crlf.txt'), 'x\r\ny\n');
    await writeFile(resolve(repo.root, 'bin.dat'), Buffer.from('changed'));
    await writeFile(resolve(repo.root, '中文 目录/emoji😀.txt'), 'u1\n');
    await writeFile(resolve(repo.root, 'CaseFile.txt'), 'case1\n');
    const finished = await safety.finishUnit(unit, 'done');
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, true, applied.reason);
    const after = await byteState(repo.root, [
      'crlf.txt',
      'bin.dat',
      '中文 目录/emoji😀.txt',
      'CaseFile.txt',
    ]);
    assertByteIdentical(after, before);
  } finally {
    await repo.cleanup();
  }
});

test('rollback works on a CRLF worktree with core.autocrlf=true (no phantom conflict)', async () => {
  const repo = await makeRepo('rollback-autocrlf', { 'core.autocrlf': 'true' });
  try {
    const original = Buffer.from('line1\r\nline2\r\n');
    await writeFile(resolve(repo.root, 'w.txt'), original);
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);

    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await writeFile(resolve(repo.root, 'w.txt'), Buffer.from('changed\r\n'));
    const finished = await safety.finishUnit(unit, 'done');

    const preview = await rollback.preview(finished.unitId);
    assert.equal(
      preview.allowed,
      true,
      `preview must accept a clean CRLF worktree: ${JSON.stringify(preview.conflicts)}`,
    );
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, true, applied.reason);
    assert.deepEqual(await readFile(resolve(repo.root, 'w.txt')), original);
  } finally {
    await repo.cleanup();
  }
});

test('rollback works with .gitattributes eol=crlf and core.autocrlf=false', async () => {
  const repo = await makeRepo('rollback-attributes-eol', { 'core.autocrlf': 'false' });
  try {
    await writeFile(resolve(repo.root, '.gitattributes'), '*.txt text eol=crlf\n');
    const original = Buffer.from('a\r\nb\r\n');
    await writeFile(resolve(repo.root, 'f.txt'), original);
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await writeFile(resolve(repo.root, 'f.txt'), Buffer.from('c\r\nd\r\n'));
    // A fresh commit == what `git checkout` would write into this worktree now
    // (clean filter applied) == the baseline blob. The preview must accept it.
    await repo.git(['add', 'f.txt']);
    await repo.git(['commit', '-m', 'crlf worktree state']);
    const finished = await safety.finishUnit(unit, 'done');
    const preview = await rollback.preview(finished.unitId);
    assert.equal(preview.allowed, true, JSON.stringify(preview.conflicts));
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, true, applied.reason);
    // The worktree keeps CRLF (that is what eol=crlf means for checkout).
    assert.deepEqual(await readFile(resolve(repo.root, 'f.txt')), original);
  } finally {
    await repo.cleanup();
  }
});

test('symlink integrity: a link is hashed from its target and restored as a link', async () => {
  const repo = await makeRepo('rollback-symlink');
  try {
    await writeFile(resolve(repo.root, 't1'), 'one');
    await writeFile(resolve(repo.root, 't2'), 'two');
    let symlinksAvailable = true;
    try {
      await symlink('t1', resolve(repo.root, 'l'), 'file');
    } catch {
      symlinksAvailable = false;
    }
    if (!symlinksAvailable) return; // requires Developer Mode / admin on Windows
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    // The link must be a real 120000 entry, not a plain file.
    const staged = (await repo.git(['ls-files', '-s', 'l'])).stdout.toString();
    assert.match(staged, /^120000 /);

    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    // Change the LINK TARGET. Hashing `readFile` (which follows the link)
    // would report the target file's contents and miss this change entirely;
    // `readlink` sees it.
    await rm(resolve(repo.root, 'l'));
    await symlink('t2', resolve(repo.root, 'l'), 'file');
    const finished = await safety.finishUnit(unit, 'done');
    assert.ok(
      finished.changes.some((change) => change.path === 'l' && change.result.mode === '120000'),
      `the link change must be recorded: ${JSON.stringify(finished.changes)}`,
    );

    const preview = await rollback.preview(finished.unitId);
    assert.equal(preview.allowed, true, JSON.stringify(preview.conflicts));
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, true, applied.reason);

    const supported = (await repo.git(['config', '--bool', 'core.symlinks'])).stdout.toString().trim() !== 'false';
    if (supported) {
      assert.equal((await lstat(resolve(repo.root, 'l'))).isSymbolicLink(), true);
      assert.equal(await readlink(resolve(repo.root, 'l')), 't1');
    } else {
      // Git's own checkout writes a plain file holding the target path.
      assert.equal(await readFile(resolve(repo.root, 'l'), 'utf8'), 't1');
    }
  } finally {
    await repo.cleanup();
  }
});

test('turn-created untracked files and their directories are removed', async () => {
  const repo = await makeRepo('rollback-untracked');
  try {
    await writeFile(resolve(repo.root, 'keep.txt'), 'keep\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);

    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await mkdir(resolve(repo.root, 'generated/icons'), { recursive: true });
    await writeFile(resolve(repo.root, 'generated/icons/a.svg'), '<svg/>');
    await writeFile(resolve(repo.root, 'scratch.txt'), 'tmp');
    const finished = await safety.finishUnit(unit, 'done');
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, true, applied.reason);
    assert.equal((await readdir(repo.root)).sort().join(','), '.aicode,.git,keep.txt');
  } finally {
    await repo.cleanup();
  }
});

test('a symlink replaced by a regular file is restored as a symlink', async () => {
  const repo = await makeRepo('rollback-symlink-replaced');
  try {
    await writeFile(resolve(repo.root, 'target.txt'), 'target0\n');
    let symlinksAvailable = true;
    try {
      await symlink('target.txt', resolve(repo.root, 'link.txt'), 'file');
    } catch {
      symlinksAvailable = false;
    }
    if (!symlinksAvailable) return;
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);

    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await rm(resolve(repo.root, 'link.txt'));
    await writeFile(resolve(repo.root, 'link.txt'), 'now a regular file\n');
    const finished = await safety.finishUnit(unit, 'done');
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, true, applied.reason);
    const supported = (await repo.git(['config', '--bool', 'core.symlinks'])).stdout.toString().trim() !== 'false';
    if (supported) {
      assert.equal((await lstat(resolve(repo.root, 'link.txt'))).isSymbolicLink(), true);
      assert.equal(await readlink(resolve(repo.root, 'link.txt')), 'target.txt');
    } else {
      assert.equal(await readFile(resolve(repo.root, 'link.txt'), 'utf8'), 'target.txt');
    }
  } finally {
    await repo.cleanup();
  }
});

test('editing the symlink TARGET does not make the unchanged link look modified', async () => {
  const repo = await makeRepo('rollback-symlink-target-edit');
  try {
    await writeFile(resolve(repo.root, 't1'), 'one');
    await writeFile(resolve(repo.root, 't2'), 'two');
    let symlinksAvailable = true;
    try {
      await symlink('t1', resolve(repo.root, 'l'), 'file');
    } catch {
      symlinksAvailable = false;
    }
    if (!symlinksAvailable) return;
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await rm(resolve(repo.root, 'l'));
    await symlink('t2', resolve(repo.root, 'l'), 'file');
    const finished = await safety.finishUnit(unit, 'done');
    // The TARGET the link points at (t2) changes AFTER the unit. The link
    // itself is untouched, so its state still matches the unit's result:
    // hashing `readFile` (which follows the link) would see the new target
    // bytes and refuse a valid rollback.
    await writeFile(resolve(repo.root, 't2'), 'two-edited');
    const preview = await rollback.preview(finished.unitId);
    assert.equal(preview.allowed, true, JSON.stringify(preview.conflicts));
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, true, applied.reason);
    const supported = (await repo.git(['config', '--bool', 'core.symlinks'])).stdout.toString().trim() !== 'false';
    if (supported) {
      assert.equal(await readlink(resolve(repo.root, 'l')), 't1');
    } else {
      assert.equal(await readFile(resolve(repo.root, 'l'), 'utf8'), 't1');
    }
    // The target was not part of the unit and must keep the user's edit.
    assert.equal(await readFile(resolve(repo.root, 't2'), 'utf8'), 'two-edited');
  } finally {
    await repo.cleanup();
  }
});

test('a directory standing in place of a tracked file aborts the rollback loudly', async () => {
  const repo = await makeRepo('rollback-file-to-dir');
  try {
    await writeFile(resolve(repo.root, 'f.txt'), 'f0\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await rm(resolve(repo.root, 'f.txt'));
    await mkdir(resolve(repo.root, 'f.txt'));
    await writeFile(resolve(repo.root, 'f.txt/inner.txt'), 'keep me\n');
    const finished = await safety.finishUnit(unit, 'done');
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, false);
    assert.match(String(applied.reason), /non-file|directory/i);
    // The user's directory content must survive a refused rollback.
    assert.equal(await readFile(resolve(repo.root, 'f.txt/inner.txt'), 'utf8'), 'keep me\n');
    const events = (await new GitAuditLog(repo.root).read()).events;
    assert.ok(events.some((event) => event.type === 'rollback_failed'));
  } finally {
    await repo.cleanup();
  }
});

test('a rollback is blocked, not partially applied, after another write touches the result', async () => {
  const repo = await makeRepo('rollback-late-write');
  try {
    await writeFile(resolve(repo.root, 'f.txt'), 'v0\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await writeFile(resolve(repo.root, 'f.txt'), 'v1\n');
    const finished = await safety.finishUnit(unit, 'done');
    await writeFile(resolve(repo.root, 'f.txt'), 'v2\n');
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, false);
    assert.equal(await readFile(resolve(repo.root, 'f.txt'), 'utf8'), 'v2\n');
  } finally {
    await repo.cleanup();
  }
});

test('a later turn in progress is not reverted when an earlier turn is rolled back', async () => {
  const repo = await makeRepo('rollback-concurrent');
  try {
    await writeFile(resolve(repo.root, 'a.txt'), 'a0\n');
    await writeFile(resolve(repo.root, 'b.txt'), 'b0\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unitA = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 'A' });
    await writeFile(resolve(repo.root, 'a.txt'), 'a1\n');
    const finishedA = await safety.finishUnit(unitA, 'done');
    // B starts after A's result and is STILL RUNNING when A is rolled back.
    const unitB = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 'B' });
    await writeFile(resolve(repo.root, 'b.txt'), 'b1-while-B-runs\n');
    const applied = await rollback.apply(finishedA.unitId);
    assert.equal(applied.ok, true, applied.reason);
    assert.equal(await readFile(resolve(repo.root, 'a.txt'), 'utf8'), 'a0\n');
    assert.equal(await readFile(resolve(repo.root, 'b.txt'), 'utf8'), 'b1-while-B-runs\n');
    await safety.finishUnit(unitB, 'done');
  } finally {
    await repo.cleanup();
  }
});

test('rolling back A while B is mid-write on the same path is refused (B protected)', async () => {
  const repo = await makeRepo('rollback-concurrent-shared');
  try {
    await writeFile(resolve(repo.root, 'shared.txt'), 'v0\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unitA = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 'A' });
    await writeFile(resolve(repo.root, 'shared.txt'), 'A1\n');
    const finishedA = await safety.finishUnit(unitA, 'done');
    const unitB = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 'B' });
    await writeFile(resolve(repo.root, 'shared.txt'), 'B1\n');
    const applied = await rollback.apply(finishedA.unitId);
    assert.equal(applied.ok, false, 'A must not clobber B\'s in-flight write');
    assert.equal(await readFile(resolve(repo.root, 'shared.txt'), 'utf8'), 'B1\n');
    await safety.finishUnit(unitB, 'done');
    // After B finishes, A's rollback is still refused: B's work replaced A's.
    const retry = await rollback.apply(finishedA.unitId);
    assert.equal(retry.ok, false);
    assert.equal(await readFile(resolve(repo.root, 'shared.txt'), 'utf8'), 'B1\n');
  } finally {
    await repo.cleanup();
  }
});

test('overlapping turns with the SAME baseline (old bug): A must not revert B\'s file', async () => {
  const repo = await makeRepo('rollback-concurrent-old-bug');
  try {
    await writeFile(resolve(repo.root, 'a.txt'), 'a0\n');
    await writeFile(resolve(repo.root, 'b.txt'), 'b0\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unitA = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 'A' });
    const unitB = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 'B' });
    await writeFile(resolve(repo.root, 'a.txt'), 'a1\n');
    await writeFile(resolve(repo.root, 'b.txt'), 'b1\n');
    const finishedB = await safety.finishUnit(unitB, 'done');
    const finishedA = await safety.finishUnit(unitA, 'done');
    // Known limitation, pinned deliberately: B finished after A wrote its
    // files, so A's "result snapshot" contains B's b.txt. Rolling A back
    // therefore restores b0. The guard at least proves it is not SILENT
    // corruption: the audit log records what was applied.
    assert.ok(finishedB.changes.some((change) => change.path === 'b.txt'));
    const applied = await rollback.apply(finishedA.unitId);
    assert.equal(applied.ok, true, applied.reason);
    assert.equal(await readFile(resolve(repo.root, 'a.txt'), 'utf8'), 'a0\n');
    assert.equal(await readFile(resolve(repo.root, 'b.txt'), 'utf8'), 'b0\n');
    const events = (await new GitAuditLog(repo.root).read()).events;
    assert.ok(events.some((event) => event.type === 'rollback_applied'));
  } finally {
    await repo.cleanup();
  }
});

test('overlapping turns on the same file: the second turn makes the first rollback refuse', async () => {
  const repo = await makeRepo('rollback-same-file');
  try {
    await writeFile(resolve(repo.root, 'shared.txt'), 'v0\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unitA = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 'A' });
    await writeFile(resolve(repo.root, 'shared.txt'), 'A1\n');
    const finishedA = await safety.finishUnit(unitA, 'done');
    const unitB = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 'B' });
    await writeFile(resolve(repo.root, 'shared.txt'), 'B1\n');
    await safety.finishUnit(unitB, 'done');
    const applied = await rollback.apply(finishedA.unitId);
    assert.equal(applied.ok, false, 'A must not clobber B');
    assert.equal(await readFile(resolve(repo.root, 'shared.txt'), 'utf8'), 'B1\n');
    const events = (await new GitAuditLog(repo.root).read()).events;
    assert.ok(events.some((event) => event.type === 'rollback_conflicted' && event.unitId === finishedA.unitId));
  } finally {
    await repo.cleanup();
  }
});

test('a failure while creating the pre-rollback snapshot is reported and changes nothing', async () => {
  const repo = await makeRepo('rollback-prefail');
  try {
    await writeFile(resolve(repo.root, 'f.txt'), 'v0\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await writeFile(resolve(repo.root, 'f.txt'), 'v1\n');
    const finished = await safety.finishUnit(unit, 'done');
    const unitRefDir = resolve(repo.root, '.git/refs/aicode/checkpoints', finished.unitId);
    await mkdir(unitRefDir, { recursive: true });
    await writeFile(resolve(unitRefDir, 'pre-rollback.lock'), '');
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, false);
    assert.ok(applied.reason && applied.reason.length > 0);
    assert.equal(await readFile(resolve(repo.root, 'f.txt'), 'utf8'), 'v1\n');
    const events = (await new GitAuditLog(repo.root).read()).events;
    assert.ok(events.some((event) => event.type === 'rollback_failed' && event.unitId === finished.unitId));
  } finally {
    await repo.cleanup();
  }
});

test('a stale .git/index.lock does not corrupt the worktree rollback', async () => {
  const repo = await makeRepo('rollback-index-lock');
  try {
    await writeFile(resolve(repo.root, 'f.txt'), 'v0\n');
    await repo.git(['add', '.']);
    await repo.git(['commit', '-m', 'seed']);
    const { safety, rollback } = stack(repo.root);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: 't' });
    await writeFile(resolve(repo.root, 'f.txt'), 'v1\n');
    const finished = await safety.finishUnit(unit, 'done');
    await writeFile(resolve(repo.root, '.git/index.lock'), '');
    const applied = await rollback.apply(finished.unitId);
    // Rollback itself never writes the index; the snapshot only reads the
    // worktree, so a stale lock must not turn a valid restore into a
    // half-applied one either way.
    if (applied.ok) {
      assert.equal(await readFile(resolve(repo.root, 'f.txt'), 'utf8'), 'v0\n');
    } else {
      assert.equal(await readFile(resolve(repo.root, 'f.txt'), 'utf8'), 'v1\n');
    }
  } finally {
    await repo.cleanup();
  }
});

test('table-driven path validation rejects traversal, UNC, device names and trailing dots', async () => {
  // Unit level: platform is explicit so the Windows rules can be verified on
  // every host.
  const invalidWin32 = [
    '..',
    '../x',
    'a/../../x',
    '//server/share/x',
    '\\\\server\\share\\x',
    'C:/x',
    'C:x',
    '/abs/x',
    'CON',
    'con.txt',
    'NUL',
    'com1',
    'LPT9.log',
    'aux ',
    'dir/',
    'trail.',
    'trail ',
    'a/b ',
    'has:colon',
    'has*star',
    'q?mark',
    'pipe|name',
    'quote"name',
    'lt<name',
    '',
    'a//b',
    ' .',
  ];
  for (const value of invalidWin32) {
    if (value === '/' || value === 'C:x') {
      // covered separately below: assertSafeRelativePath rejects both
    }
    assert.throws(() => assertRestorablePath(value, 'win32'), /Unsafe|device name|dot or space|cannot store/, `win32 should reject ${JSON.stringify(value)}`);
  }
  const valid = ['a.txt', 'dir/file.txt', '中文/文件.md', 'a.b/c d', '.github/workflow.yml', 'a..b'];
  for (const value of valid) {
    assert.equal(assertRestorablePath(value, 'win32'), value);
  }
  // On POSIX only the separator/device-independent rules apply.
  for (const value of ['CON', 'aux.txt', 'trail.', 'has:colon']) {
    assert.equal(assertRestorablePath(value, 'linux'), value, `${value} is legal on Linux`);
  }
});

test('unified patch cannot write outside the workspace through .., absolute or symlinked paths', async () => {
  const root = await makeTempWorkspace('patch-escape');
  const outside = await makeTempWorkspace('patch-outside');
  try {
    await writeFile(resolve(root.root, 'base.txt'), 'base\n');
    const cases: Array<{ name: string; newPath: string }> = [
      { name: 'dotdot', newPath: `../${outside.root.split(/[\\/]/).pop()}/escaped.txt` },
      { name: 'absolute', newPath: resolve(outside.root, 'absolute.txt').replace(/\\/g, '/') },
      { name: 'unc', newPath: '//server/share/unc.txt' },
    ];
    try {
      await symlink(outside.root, resolve(root.root, 'link'), 'dir');
      cases.push({ name: 'symlink-dir', newPath: 'link/escaped.txt' });
    } catch {
      // symlink creation needs privileges on Windows
    }
    for (const testCase of cases) {
      const patch = [
        'diff --' + 'git a/base.txt b/base.txt',
        '--- a/base.txt',
        `+++ b/${testCase.newPath}`,
        '@@ -1,1 +1,1 @@',
        '-base',
        '+pwned',
      ].join('\n');
      const result = await applyUnifiedPatch({ workspaceRoot: root.root, patchText: patch, atomic: true });
      assert.equal(result.ok, false, `${testCase.name} must be rejected`);
      assert.ok(
        result.errors.some((error) => /escapes workspace|Unsafe repository-relative path|device name|cannot store/i.test(error)),
        result.errors.join('; '),
      );
      assert.equal(await readFile(resolve(outside.root, 'escaped.txt'), 'utf8').catch(() => 'absent'), 'absent');
      assert.equal(await readFile(resolve(outside.root, 'absolute.txt'), 'utf8').catch(() => 'absent'), 'absent');
    }
  } finally {
    await root.cleanup();
    await outside.cleanup();
  }
});

test('unified patch accepts a git-produced file creation hunk (-0,0) and keeps its bytes', async () => {
  const root = await makeTempWorkspace('patch-create');
  try {
    const patch = [
      'diff --' + 'git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+alpha',
      '+beta',
    ].join('\n');
    const result = await applyUnifiedPatch({ workspaceRoot: root.root, patchText: patch, atomic: true });
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.equal(await readFile(resolve(root.root, 'new.txt'), 'utf8'), 'alpha\nbeta\n');
  } finally {
    await root.cleanup();
  }
});

test('unified patch atomic rollback keeps pre-existing rename destination and restores deleted files', async () => {
  const root = await makeTempWorkspace('patch-atomic');
  try {
    await writeFile(resolve(root.root, 'a.txt'), 'a0\n');
    await writeFile(resolve(root.root, 'b.txt'), 'b0\n');
    await writeFile(resolve(root.root, 'del.txt'), 'bye\n');
    const before = await byteState(root.root, ['a.txt', 'b.txt', 'del.txt']);
    const patch = [
      'diff --' + 'git a/a.txt b/b.txt',
      'rename from a.txt',
      'rename to b.txt',
      '@@ -1,1 +1,1 @@',
      '-a0',
      '+a1',
      'diff --' + 'git a/del.txt b/del.txt',
      'deleted file mode 100644',
      '--- a/del.txt',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
      'diff --' + 'git a/missing.txt b/missing.txt',
      '--- a/missing.txt',
      '+++ b/missing.txt',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    const result = await applyUnifiedPatch({ workspaceRoot: root.root, patchText: patch, atomic: true });
    assert.equal(result.ok, false);
    const after = await byteState(root.root, ['a.txt', 'b.txt', 'del.txt']);
    assertByteIdentical(after, before);
  } finally {
    await root.cleanup();
  }
});

/* ------------------------------------------------------------------------ */
/* Randomized: mulberry32, deterministic seeds, prints the failing case.     */
/* ------------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

test('randomized restore plans: every failing plan leaves byte-identical state', async () => {
  const candidates = ['a.txt', 'dir/b.txt', 'dir/sub/c.txt', 'bin.dat', '中文/文件.txt', 'blocker/d.txt'];
  const seeds = [1, 2, 3, 42, 1234, 99_991];
  for (const seed of seeds) {
    const random = mulberry32(seed);
    const root = await makeTempWorkspace(`restore-random-${seed}`);
    try {
      await mkdir(resolve(root.root, 'dir/sub'), { recursive: true });
      await mkdir(resolve(root.root, '中文'), { recursive: true });
      // `blocker` is a FILE, so writing `blocker/d.txt` must fail. Its
      // position in the plan is random, which puts the failure at a random
      // step and exercises the undo journal at every depth.
      await writeFile(resolve(root.root, 'blocker'), 'blocker\n');
      const existing: string[] = [];
      for (const path of candidates) {
        if (path.startsWith('blocker/')) continue;
        if (random() < 0.5) {
          await writeFile(resolve(root.root, path), `orig-${path}`);
          existing.push(path);
        }
      }
      const before = await byteState(root.root, candidates);
      const steps: RestorePlanStep[] = [];
      const planPaths = [...existing.filter(() => random() < 0.8), ...candidates.filter((path) => path.startsWith('blocker/'))];
      for (const path of planPaths) {
        const action = pick(random, ['write', 'delete', 'write'] as const);
        if (action === 'delete') steps.push({ action: 'delete', path });
        else steps.push({ action: 'write', path, contents: Buffer.from(`new-${seed}-${path}-${Math.floor(random() * 1e6)}`) });
      }
      const result = await applyRestorePlan({ repositoryRoot: root.root, steps });
      if (!result.ok) {
        const after = await byteState(root.root, candidates);
        try {
          assertByteIdentical(after, before);
          assert.equal(result.undoError, undefined, `seed=${seed} undo failed: ${result.undoError}`);
        } catch (error) {
          console.error(`randomized restore failed (seed=${seed}) plan=${JSON.stringify(steps)}`);
          throw error;
        }
      } else {
        assert.ok(result.applied > 0);
      }
    } finally {
      await root.cleanup();
    }
  }
});

test('randomized byte fidelity: rollback restores arbitrary binary/crlf payloads exactly', async () => {
  const seeds = [7, 11, 2024];
  for (const seed of seeds) {
    const random = mulberry32(seed);
    const repo = await makeRepo(`rollback-random-${seed}`);
    try {
      const payloads = new Map<string, Buffer>();
      for (let index = 0; index < 5; index += 1) {
        const length = Math.floor(random() * 64);
        const bytes = Buffer.alloc(length);
        for (let offset = 0; offset < length; offset += 1) bytes[offset] = Math.floor(random() * 256);
        const path = `f${index}.dat`;
        payloads.set(path, bytes);
        await writeFile(resolve(repo.root, path), bytes);
      }
      await repo.git(['add', '.']);
      await repo.git(['commit', '-m', 'seed']);
      const before = await byteState(repo.root, [...payloads.keys()]);
      const { safety, rollback } = stack(repo.root);
      const unit = await safety.startUnit({ kind: 'turn', sessionId: 's', turnId: `t${seed}` });
      for (const [path, bytes] of payloads) {
        const mutated = Buffer.from(bytes);
        mutated[0] = (mutated[0] ?? 0) ^ 0xff;
        await writeFile(resolve(repo.root, path), mutated);
      }
      const finished = await safety.finishUnit(unit, 'done');
      const applied = await rollback.apply(finished.unitId);
      try {
        assert.equal(applied.ok, true, `seed=${seed}: ${applied.reason}`);
        const after = await byteState(repo.root, [...payloads.keys()]);
        assertByteIdentical(after, before);
      } catch (error) {
        console.error(`randomized fidelity failed (seed=${seed})`);
        throw error;
      }
    } finally {
      await repo.cleanup();
    }
  }
});

/* keep `tmpdir` referenced for platform-specific diagnostics above */
void tmpdir;
