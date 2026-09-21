import { spawn } from 'node:child_process';
import type { GitProcess } from '../git-safety/git.js';
import type { TaskBoard } from '../tasks/types.js';
import type { SupervisorSnapshot } from '../supervisor/supervisor.js';

/**
 * Open a pull request for a finished board.
 *
 * Two halves, and the split matters: **preparing** (staging the work, writing a
 * description) is entirely local and always succeeds; **opening** needs a git
 * remote and the `gh` CLI, which this machine may simply not have. A failure to
 * open is reported as a specific, actionable blocker rather than as a generic
 * error, because the usual causes — no remote, no `gh`, not authenticated — each
 * have a different fix and the user is the only one who can apply it.
 *
 * The CLI never fabricates a PR: with no remote there is nowhere to open one, and
 * pretending otherwise would be worse than saying so.
 */

export type PrBlocker =
  | 'no-remote'
  | 'gh-missing'
  | 'gh-unauthenticated'
  | 'no-commits'
  | 'unknown';

export type PreparePrResult = {
  ok: boolean;
  /** Branch the work is on. */
  branch?: string;
  /** Base branch the PR would target. */
  base?: string;
  /** Commits on this branch that are not on the base. */
  commitCount: number;
  title: string;
  body: string;
  blocker?: PrBlocker;
  /** What the user has to do, when a blocker was found. */
  detail?: string;
};

export type OpenPrResult = {
  ok: boolean;
  url?: string;
  number?: number;
  blocker?: PrBlocker;
  detail?: string;
};

/** Build the PR title from a board. */
export function buildPrTitle(board: TaskBoard): string {
  const title = board.title.trim() || board.goal.trim();
  return title.length <= 72 ? title : `${title.slice(0, 69)}...`;
}

/** Build the PR body: goal, plan, and per-task outcomes. */
export function buildPrBody(board: TaskBoard, snapshot?: SupervisorSnapshot): string {
  const done = board.tasks.filter((task) => task.status === 'done' || task.status === 'skipped');
  const blocked = board.tasks.filter((task) => task.status === 'blocked');
  const lines = [
    '## 目标',
    '',
    board.goal,
    '',
    '## 完成的任务',
    '',
    ...done.map((task) => {
      const summary = task.resultSummary ? ` — ${task.resultSummary}` : '';
      return `- \`${task.id}\` ${task.title}${summary}`;
    }),
    '',
  ];

  if (blocked.length > 0) {
    lines.push('## 未完成', '');
    for (const task of blocked) {
      lines.push(`- \`${task.id}\` ${task.title}${task.error ? ` — ${task.error}` : ''}`);
    }
    lines.push('');
  }

  if (board.planMarkdown?.trim()) {
    lines.push('## 计划', '', board.planMarkdown.trim(), '');
  }

  if (snapshot && snapshot.steps > 0) {
    lines.push(
      '## 执行统计',
      '',
      `- 步骤总数：${snapshot.steps}`,
      `- 完成：${snapshot.done}，失败：${snapshot.failed}`,
      '',
    );
  }

  lines.push('Made-with: aicode');
  return lines.join('\n');
}

/** Run `gh` and capture its result without throwing. */
function runGh(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gh', args, { cwd, windowsHide: true });
    } catch {
      resolve({ ok: false, stdout: '', stderr: 'ENOENT' });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    // A missing binary surfaces as an error event, not a nonzero exit.
    child.on('error', () => resolve({ ok: false, stdout, stderr: stderr || 'ENOENT' }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

/** Classify a `gh` failure into something the user can act on. */
export function classifyGhFailure(stderr: string): { blocker: PrBlocker; detail: string } {
  const text = stderr.toLowerCase();
  if (text.includes('enoent') || text.includes('not found') || text.includes('command not found')) {
    return {
      blocker: 'gh-missing',
      detail: '未安装 GitHub CLI。安装后执行 gh auth login：https://cli.github.com',
    };
  }
  if (text.includes('not logged') || text.includes('authentication') || text.includes('gh_auth_token') || text.includes('auth')) {
    return { blocker: 'gh-unauthenticated', detail: 'GitHub CLI 未登录，请执行 gh auth login。' };
  }
  return { blocker: 'unknown', detail: stderr.trim() || 'gh pr create 失败。' };
}

/**
 * Work out whether a PR could be opened, and prepare its content.
 *
 * Everything here is local and safe: it reads the branch, counts commits, and
 * writes nothing.
 */
/**
 * Resolve the branch a change would merge into.
 *
 * Shared with code review so both answer "what is the base" the same way: the
 * remote's default branch when there is one, then the usual main/master probes.
 * A disagreement between the PR base and the review base would make the review
 * judge a different diff than the one being opened.
 */
export async function resolveBaseBranch(git: GitProcess, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    try {
      const resolved = (await git.text(['rev-parse', '--abbrev-ref', `${candidate}`])).trim();
      if (resolved && resolved !== 'HEAD') return resolved.replace(/^origin\//, '');
    } catch { /* try the next candidate */ }
  }
  return 'main';
}

/**
 * The merge base between HEAD and a base branch.
 *
 * Prefers the base's upstream when it exists: for a "PR-style" review the
 * question is what would merge, and comparing against a stale local branch
 * would include commits the remote already has. Mirrors codex's
 * `merge_base_with_head` (codex-rs/git-utils/src/branch.rs).
 *
 * Returns undefined when it cannot be computed — an unborn HEAD or an unknown
 * base — so the caller can fall back to a plain diff instead of failing.
 */
export async function mergeBaseWithHead(git: GitProcess, base: string): Promise<string | undefined> {
  try {
    const upstream = (await git.text(['rev-parse', '--abbrev-ref', `${base}@{upstream}`])).trim();
    // Only prefer the upstream when it is actually ahead, otherwise the local
    // branch is the better comparison point.
    if (upstream && upstream !== base) {
      try {
        const ahead = (await git.text(['rev-list', '--count', `${base}..${upstream}`])).trim();
        if (Number.parseInt(ahead, 10) > 0) {
          const viaUpstream = (await git.text(['merge-base', 'HEAD', upstream])).trim();
          if (viaUpstream) return viaUpstream;
        }
      } catch { /* no upstream comparison available */ }
    }
  } catch { /* no upstream configured — use the branch itself */ }

  try {
    const sha = (await git.text(['merge-base', 'HEAD', base])).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

export async function prepareBoardPr(options: {
  git: GitProcess;
  board: TaskBoard;
  base?: string;
  snapshot?: SupervisorSnapshot;
}): Promise<PreparePrResult> {
  const title = buildPrTitle(options.board);
  const body = buildPrBody(options.board, options.snapshot);

  let branch: string | undefined;
  let base = options.base;
  let commitCount = 0;
  try {
    branch = (await options.git.text(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || undefined;
  } catch {
    return {
      ok: false,
      title,
      body,
      commitCount: 0,
      blocker: 'no-commits',
      detail: '无法确定当前分支（可能不在 git 仓库里）。',
    };
  }

  // No remotes means there is nowhere to open a PR. Checked before invoking gh so
  // the message names the real cause instead of gh's "not a git repository".
  try {
    const remotes = (await options.git.text(['remote'])).trim();
    if (!remotes) {
      return {
        ok: false,
        branch,
        commitCount: 0,
        title,
        body,
        blocker: 'no-remote',
        detail: '当前仓库没有配置 git remote，无法创建 PR。请先添加远端：git remote add origin <url>',
      };
    }
  } catch {
    // A repo with no remotes configured can make `git remote` fail on some
    // versions; treat it the same as an empty list.
    return {
      ok: false,
      branch,
      commitCount: 0,
      title,
      body,
      blocker: 'no-remote',
      detail: '当前仓库没有配置 git remote，无法创建 PR。请先添加远端：git remote add origin <url>',
    };
  }

  if (!base) base = await resolveBaseBranch(options.git);

  try {
    const countText = (await options.git.text(['rev-list', '--count', `${base}..HEAD`])).trim();
    commitCount = Number.parseInt(countText, 10) || 0;
  } catch {
    commitCount = 0;
  }

  if (commitCount === 0) {
    return {
      ok: false,
      branch,
      base,
      commitCount: 0,
      title,
      body,
      blocker: 'no-commits',
      detail: `分支 ${branch ?? '(未知)'} 上没有相对 ${base} 的新提交，没有内容可以开 PR。`,
    };
  }

  return { ok: true, branch, base, commitCount, title, body };
}

/** Open the PR with `gh`. Assumes prepareBoardPr reported ok. */
export async function openBoardPr(options: {
  git: GitProcess;
  prepared: PreparePrResult;
  draft?: boolean;
}): Promise<OpenPrResult> {
  if (!options.prepared.ok) {
    return {
      ok: false,
      blocker: options.prepared.blocker ?? 'unknown',
      detail: options.prepared.detail ?? 'PR 尚未准备就绪。',
    };
  }

  const args = ['pr', 'create', '--title', options.prepared.title, '--body', options.prepared.body];
  if (options.draft) args.push('--draft');
  if (options.prepared.base) args.push('--base', options.prepared.base);

  const result = await runGh(args, options.git.cwd);
  if (!result.ok) {
    const classified = classifyGhFailure(result.stderr || result.stdout);
    return { ok: false, ...classified };
  }

  const urlMatch = result.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  const numberMatch = urlMatch ? urlMatch[0].match(/\/pull\/(\d+)$/) : null;
  return {
    ok: true,
    url: urlMatch ? urlMatch[0] : result.stdout.trim(),
    ...(numberMatch ? { number: Number.parseInt(numberMatch[1]!, 10) } : {}),
  };
}
