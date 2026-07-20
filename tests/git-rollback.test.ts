import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { GitAuditLog } from '../src/git-safety/audit.js';
import { GitSnapshotDiff } from '../src/git-safety/diff.js';
import { GitProcess } from '../src/git-safety/git.js';
import { GitRepository } from '../src/git-safety/repository.js';
import { GitRollbackService } from '../src/git-safety/rollback.js';
import { GitSafetyService } from '../src/git-safety/service.js';
import { GitSnapshotStore } from '../src/git-safety/snapshot.js';
import { makeGitRepository, writeText } from './git-test-helpers.js';

function createStack(workspaceRoot: string) {
  const gitProcess = new GitProcess(workspaceRoot);
  const repository = new GitRepository(workspaceRoot, gitProcess);
  const snapshots = new GitSnapshotStore(gitProcess, workspaceRoot);
  const diff = new GitSnapshotDiff(gitProcess);
  const audit = new GitAuditLog(workspaceRoot);
  const safety = new GitSafetyService(workspaceRoot, repository, snapshots, diff, audit);
  const rollback = new GitRollbackService(workspaceRoot, repository, snapshots, diff, audit);
  return { safety, rollback, audit };
}

test('rollback preview lists exact add modify delete and rename actions', async () => {
  const fixture = await makeGitRepository('rollback-preview');
  try {
    await writeText(fixture.root, 'keep.txt', 'keep\n');
    await writeText(fixture.root, 'old.txt', 'rename-me\n');
    await writeText(fixture.root, 'delete-me.txt', 'gone\n');
    await fixture.git(['add', '.']);
    await fixture.git(['commit', '-m', 'seed']);

    const { safety, rollback } = createStack(fixture.workspace);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 'sess', turnId: 't1' });
    await writeText(fixture.root, 'added.txt', 'new\n');
    await writeText(fixture.root, 'keep.txt', 'changed\n');
    await writeText(fixture.root, 'new.txt', 'rename-me\n');
    await writeFile(resolve(fixture.root, 'old.txt'), '');
    await fixture.git(['rm', '-f', 'old.txt']).catch(async () => {
      const { rm } = await import('node:fs/promises');
      await rm(resolve(fixture.root, 'old.txt'), { force: true });
    });
    await fixture.git(['rm', '-f', 'delete-me.txt']).catch(async () => {
      const { rm } = await import('node:fs/promises');
      await rm(resolve(fixture.root, 'delete-me.txt'), { force: true });
    });
    const finished = await safety.finishUnit(unit, 'done');
    const preview = await rollback.preview(finished.unitId);
    assert.equal(preview.allowed, true);
    assert.ok(preview.changes.some((change) => change.path === 'added.txt' || change.path.includes('added')));
    assert.ok(preview.changes.some((change) => change.path === 'keep.txt'));
  } finally {
    await fixture.cleanup();
  }
});

test('selective rollback restores only paths changed by the selected unit', async () => {
  const fixture = await makeGitRepository('rollback-selective');
  try {
    await writeText(fixture.root, 'a.txt', 'a0\n');
    await writeText(fixture.root, 'b.txt', 'b0\n');
    await fixture.git(['add', '.']);
    await fixture.git(['commit', '-m', 'seed']);

    const { safety, rollback } = createStack(fixture.workspace);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 'sess', turnId: 't1' });
    await writeText(fixture.root, 'a.txt', 'a1\n');
    const finished = await safety.finishUnit(unit, 'done');
    await writeText(fixture.root, 'outside.txt', 'outside-after-unit\n');

    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, true, applied.reason);
    assert.equal(await readFile(resolve(fixture.root, 'a.txt'), 'utf8'), 'a0\n');
    assert.equal(await readFile(resolve(fixture.root, 'b.txt'), 'utf8'), 'b0\n');
    assert.equal(await readFile(resolve(fixture.root, 'outside.txt'), 'utf8'), 'outside-after-unit\n');
  } finally {
    await fixture.cleanup();
  }
});

test('post-result worktree edit conflicts and causes zero rollback writes', async () => {
  const fixture = await makeGitRepository('rollback-conflict');
  try {
    await writeText(fixture.root, 'file.txt', 'v0\n');
    await fixture.git(['add', '.']);
    await fixture.git(['commit', '-m', 'seed']);
    const { safety, rollback } = createStack(fixture.workspace);
    const unit = await safety.startUnit({ kind: 'turn', sessionId: 'sess', turnId: 't1' });
    await writeText(fixture.root, 'file.txt', 'v1\n');
    const finished = await safety.finishUnit(unit, 'done');
    await writeText(fixture.root, 'file.txt', 'v2\n');
    const before = await readFile(resolve(fixture.root, 'file.txt'));
    const applied = await rollback.apply(finished.unitId);
    assert.equal(applied.ok, false);
    assert.deepEqual(await readFile(resolve(fixture.root, 'file.txt')), before);
  } finally {
    await fixture.cleanup();
  }
});
