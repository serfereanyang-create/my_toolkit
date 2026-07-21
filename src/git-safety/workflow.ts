import type { TaskBoard } from '../tasks/types.js';
import { GitCommandError, type GitProcess } from './git.js';
import type { GitRepository } from './repository.js';

export type BranchEnsureResult = {
  ok: boolean;
  branch?: string;
  created: boolean;
  message: string;
};

export type CommitPreview = {
  branch: string;
  hasChanges: boolean;
  status: string;
  diffStat: string;
  suggestedMessage: string;
};

export type CommitResult = {
  ok: boolean;
  sha?: string;
  message: string;
};

export function boardBranchName(board: Pick<TaskBoard, 'id'>): string {
  const id = board.id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const short = id.length > 48 ? id.slice(0, 48) : id;
  return `aicode/board-${short || 'task'}`;
}

export async function ensureBoardBranch(options: {
  git: GitProcess;
  repository: GitRepository;
  board: TaskBoard;
  confirm?: (message: string) => Promise<boolean>;
}): Promise<BranchEnsureResult> {
  const branch = boardBranchName(options.board);
  let repo = await options.repository.discover();
  if (!repo) {
    const ensured = await options.repository.ensure(options.confirm);
    if (!ensured) {
      return {
        ok: false,
        created: false,
        message: 'Git repository unavailable; skipped board branch creation.',
      };
    }
    repo = ensured;
  }

  try {
    const current = (await options.git.text(['branch', '--show-current'])).trim();
    if (current === branch) {
      return { ok: true, branch, created: false, message: `Already on board branch ${branch}.` };
    }

    const localBranches = (await options.git.text(['branch', '--list', branch])).trim();
    if (localBranches) {
      await options.git.text(['checkout', branch]);
      return { ok: true, branch, created: false, message: `Checked out existing board branch ${branch}.` };
    }

    await options.git.text(['checkout', '-b', branch]);
    return { ok: true, branch, created: true, message: `Created and checked out board branch ${branch}.` };
  } catch (error) {
    const detail = error instanceof GitCommandError ? error.stderr || error.message : String(error);
    return {
      ok: false,
      branch,
      created: false,
      message: `Failed to ensure board branch ${branch}: ${detail}`,
    };
  }
}

export async function previewBoardCommit(options: {
  git: GitProcess;
  board: TaskBoard;
}): Promise<CommitPreview> {
  const branch = (await options.git.text(['branch', '--show-current'])).trim() || boardBranchName(options.board);
  let status = '';
  let diffStat = '';
  try {
    status = (await options.git.text(['status', '--short'])).trim();
  } catch {
    status = '';
  }
  try {
    diffStat = (await options.git.text(['diff', '--stat', 'HEAD'])).trim();
    const cached = (await options.git.text(['diff', '--cached', '--stat'])).trim();
    if (cached) diffStat = [diffStat, cached].filter(Boolean).join('\n');
  } catch {
    // unborn HEAD may fail diff against HEAD
    try {
      diffStat = (await options.git.text(['status', '--short'])).trim();
    } catch {
      diffStat = '';
    }
  }

  return {
    branch,
    hasChanges: status.length > 0,
    status: status || '(clean)',
    diffStat: diffStat || '(no diff stat)',
    suggestedMessage: buildCommitMessage(options.board),
  };
}

export async function commitBoardChanges(options: {
  git: GitProcess;
  board: TaskBoard;
  message?: string;
}): Promise<CommitResult> {
  const preview = await previewBoardCommit({ git: options.git, board: options.board });
  if (!preview.hasChanges) {
    return { ok: false, message: 'No changes to commit.' };
  }

  try {
    await options.git.text(['add', '-A', '--', '.']);
    const message = options.message?.trim() || preview.suggestedMessage;
    await options.git.text(['commit', '-m', message], {
      env: {
        GIT_AUTHOR_NAME: 'aicode',
        GIT_AUTHOR_EMAIL: 'aicode@local.invalid',
        GIT_COMMITTER_NAME: 'aicode',
        GIT_COMMITTER_EMAIL: 'aicode@local.invalid',
      },
    });
    const sha = (await options.git.text(['rev-parse', 'HEAD'])).trim();
    return { ok: true, sha, message: `Committed ${sha.slice(0, 12)} on ${preview.branch}.` };
  } catch (error) {
    const detail = error instanceof GitCommandError ? error.stderr || error.message : String(error);
    return { ok: false, message: `Commit failed: ${detail}` };
  }
}

export function buildCommitMessage(board: TaskBoard): string {
  const done = board.tasks.filter((task) => task.status === 'done' || task.status === 'skipped');
  const lines = [
    `feat: complete board ${board.id}`,
    '',
    `Goal: ${board.goal}`,
    '',
    'Tasks:',
    ...done.map((task) => `- ${task.id} ${task.title}${task.resultSummary ? ` (${task.resultSummary})` : ''}`),
    '',
    'Made-with: aicode',
  ];
  return lines.join('\n');
}
