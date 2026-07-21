import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitProcess } from '../src/git-safety/git.js';
import { GitRepository } from '../src/git-safety/repository.js';
import {
  boardBranchName,
  commitBoardChanges,
  ensureBoardBranch,
  previewBoardCommit,
} from '../src/git-safety/workflow.js';
import type { TaskBoard } from '../src/tasks/types.js';
import { git } from './git-test-helpers.js';

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'aicode-git-workflow-'));
  await git(root, ['init']);
  await git(root, ['config', 'user.name', 'aicode-test']);
  await git(root, ['config', 'user.email', 'aicode-test@example.invalid']);
  await writeFile(join(root, 'README.md'), 'init\n', 'utf8');
  await git(root, ['add', 'README.md']);
  await git(root, ['commit', '-m', 'init']);
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function board(id = 'board_abc123'): TaskBoard {
  return {
    id,
    title: 'Demo',
    goal: 'Ship workflow',
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    tasks: [
      {
        id: 'task_1',
        title: 'Implement feature',
        status: 'done',
        dependsOn: [],
        resultSummary: 'done [verified]',
      },
    ],
  };
}

test('boardBranchName sanitizes ids', () => {
  assert.equal(boardBranchName({ id: 'board_abc/123' }), 'aicode/board-board_abc-123');
});

test('ensureBoardBranch creates and reuses aicode board branch', async () => {
  const repo = await makeRepo();
  try {
    const gitProcess = new GitProcess(repo.root);
    const repository = new GitRepository(repo.root, gitProcess);
    const current = board('board_one');
    const first = await ensureBoardBranch({ git: gitProcess, repository, board: current });
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.branch, 'aicode/board-board_one');
    const branch = (await gitProcess.text(['branch', '--show-current'])).trim();
    assert.equal(branch, 'aicode/board-board_one');

    const second = await ensureBoardBranch({ git: gitProcess, repository, board: current });
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
  } finally {
    await repo.cleanup();
  }
});

test('preview and commit board changes with suggested message', async () => {
  const repo = await makeRepo();
  try {
    const gitProcess = new GitProcess(repo.root);
    const repository = new GitRepository(repo.root, gitProcess);
    const current = board('board_two');
    await ensureBoardBranch({ git: gitProcess, repository, board: current });
    await writeFile(join(repo.root, 'feature.txt'), 'hello\n', 'utf8');

    const preview = await previewBoardCommit({ git: gitProcess, board: current });
    assert.equal(preview.hasChanges, true);
    assert.match(preview.suggestedMessage, /Ship workflow/);
    assert.match(preview.suggestedMessage, /task_1/);

    const committed = await commitBoardChanges({ git: gitProcess, board: current });
    assert.equal(committed.ok, true);
    assert.ok(committed.sha);
    const log = (await gitProcess.text(['log', '-1', '--pretty=%s'])).trim();
    assert.match(log, /complete board board_two/);
  } finally {
    await repo.cleanup();
  }
});
