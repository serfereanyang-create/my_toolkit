import type { GitProcess } from '../git-safety/git.js';
import { assertSafeRef, assertObjectId, GitCommandError } from '../git-safety/git.js';
import { mergeBaseWithHead, resolveBaseBranch } from '../git-safety/pullRequest.js';

/**
 * What a review is asked to look at.
 *
 * Mirrors codex's `ReviewTarget` (codex-rs/protocol/src/protocol.rs) — the four
 * shapes are the four questions a reviewer can usefully be asked. Everything
 * else ("review this file", "review the last hour") is expressible as `custom`
 * with instructions, which is why the union stays this small.
 */
export type ReviewTarget =
  | { kind: 'uncommitted' }
  | { kind: 'base'; branch: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'custom'; instructions: string };

export type ResolvedTarget = {
  target: ReviewTarget;
  /** Human-readable one-liner for the UI and the reviewer prompt. */
  label: string;
  /** The diff text handed to the reviewer. */
  diff: string;
  /** Files the diff touches, repository-relative. */
  files: string[];
  /** Commit the diff is against, when there is one. */
  baseSha?: string;
  /** Set when the diff was cut short — the reviewer must be told. */
  truncated?: boolean;
  /** Total characters before truncation. */
  fullLength?: number;
};

/**
 * Diff size handed to the reviewer in one shot.
 *
 * The reviewer can always read more with its own tools (git_diff, read_file),
 * so an over-cap diff is not a failure — it is a prompt to go look. Truncating
 * silently would let the reviewer pass judgement on a partial change while
 * believing it saw everything, so the truncation is reported in the prompt.
 */
export const MAX_REVIEW_DIFF_CHARS = 200_000;

const USAGE = [
  '用法：/review [目标]',
  '',
  '  /review                     审查未提交的改动',
  '  /review base <分支>         审查当前分支相对 <分支> 的改动（PR 式）',
  '  /review commit <sha>        审查某个提交',
  '  /review <任意说明>          按说明审查（例如 /review 关注错误处理）',
].join('\n');

export class ReviewTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewTargetError';
  }
}

export function reviewUsage(): string {
  return USAGE;
}

/**
 * Parse the argument text of `/review`.
 *
 * Deliberately lenient about the two keyword forms and strict about nothing
 * else: anything that is not `base <branch>` or `commit <sha>` is custom
 * instructions, because a user typing prose means prose. A keyword form with a
 * missing operand is an error rather than a silent fallback — treating
 * `/review base` as "review the phrase 'base'" would review the wrong thing.
 */
export function parseReviewTarget(argument: string): ReviewTarget {
  const text = argument.trim();
  if (!text) return { kind: 'uncommitted' };

  const baseMatch = /^base\s+(\S+)\s*$/i.exec(text);
  if (baseMatch) {
    const branch = baseMatch[1]!;
    try {
      assertSafeRef(branch);
    } catch {
      throw new ReviewTargetError(`分支名不合法：${branch}`);
    }
    return { kind: 'base', branch };
  }
  if (/^base\s*$/i.test(text)) {
    throw new ReviewTargetError(`缺少分支名。\n\n${USAGE}`);
  }

  const commitMatch = /^commit\s+(\S+)\s*$/i.exec(text);
  if (commitMatch) {
    const sha = commitMatch[1]!;
    if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) {
      throw new ReviewTargetError(`提交号不合法：${sha}（需要 7-64 位十六进制）`);
    }
    return { kind: 'commit', sha };
  }
  if (/^commit\s*$/i.test(text)) {
    throw new ReviewTargetError(`缺少提交号。\n\n${USAGE}`);
  }

  return { kind: 'custom', instructions: text };
}

/**
 * Build the diff for a target.
 *
 * The diff is computed here and handed to the reviewer rather than left for it
 * to fetch, for two reasons: it pins the review to a reproducible range (the
 * reviewer cannot accidentally review a working tree that moved under it), and
 * it saves the reviewer a tool round-trip on every review.
 */
export async function resolveReviewTarget(options: {
  target: ReviewTarget;
  git: GitProcess;
  /** Repository root, for turning diff paths into absolute ones. */
  repositoryRoot: string;
  maxChars?: number;
}): Promise<ResolvedTarget> {
  const { target, git } = options;
  const maxChars = options.maxChars ?? MAX_REVIEW_DIFF_CHARS;

  const finish = (input: {
    label: string;
    diff: string;
    files: string[];
    baseSha?: string;
  }): ResolvedTarget => {
    const over = input.diff.length > maxChars;
    return {
      target,
      label: input.label,
      diff: over ? input.diff.slice(0, maxChars) : input.diff,
      files: input.files,
      ...(input.baseSha ? { baseSha: input.baseSha } : {}),
      ...(over ? { truncated: true, fullLength: input.diff.length } : {}),
    };
  };

  if (target.kind === 'uncommitted') {
    // Tracked changes and untracked file names both matter: a brand-new file is
    // part of "the change" to anyone reading, but `git diff` alone omits it.
    const tracked = await safeText(git, ['diff', 'HEAD']);
    const untracked = await safeText(git, ['ls-files', '--others', '--exclude-standard']);
    const untrackedNames = untracked.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const untrackedSection = untrackedNames.length > 0
      ? `\n\n## 新增但未跟踪的文件（内容未包含在 diff 中，请自行读取）\n${untrackedNames.map((f) => `- ${f}`).join('\n')}\n`
      : '';
    const files = await changedFiles(git, ['HEAD']);
    return finish({
      label: '未提交的改动',
      diff: tracked.trim() ? tracked + untrackedSection : '（没有未提交的改动）' + untrackedSection,
      files: [...new Set([...files, ...untrackedNames])],
    });
  }

  if (target.kind === 'base') {
    const base = await resolveBaseBranch(git, target.branch);
    const baseSha = await mergeBaseWithHead(git, base);
    // With a merge base, compare from the fork point — that is the PR semantics
    // the user means by "review against main". Without one (unrelated histories
    // or an unborn HEAD), fall back to the branch tip and say so.
    const range = baseSha ? `${baseSha}..HEAD` : `${base}..HEAD`;
    const diff = await safeText(git, ['diff', range]);
    const files = await changedFiles(git, [range]);
    const note = baseSha
      ? `相对 ${base}（合并基点 ${baseSha.slice(0, 12)}）`
      : `相对 ${base}（未找到合并基点，按分支尖端比较）`;
    return finish({ label: note, diff, files, ...(baseSha ? { baseSha } : {}) });
  }

  if (target.kind === 'commit') {
    const sha = assertObjectId(await revParse(git, target.sha));
    const diff = await safeText(git, ['show', '--format=%H%n%s%n%an%n%ad', sha]);
    const files = await changedFiles(git, [`${sha}^`, sha]);
    const subject = (await safeText(git, ['log', '-1', '--format=%s', sha])).trim();
    return finish({ label: `提交 ${sha.slice(0, 12)}${subject ? ` — ${subject}` : ''}`, diff, files, baseSha: sha });
  }

  // custom: the reviewer decides what to look at, guided by the instructions.
  // A working-tree diff is still useful context, so send it along, but the
  // instructions are what define the task.
  const diff = await safeText(git, ['diff', 'HEAD']);
  const files = await changedFiles(git, ['HEAD']);
  return finish({
    label: `自定义审查：${target.instructions}`,
    diff: diff.trim() ? diff : '（工作区没有未提交的改动）',
    files,
  });
}

/** `git diff --name-only` for a range, tolerating an unresolvable range. */
async function changedFiles(git: GitProcess, range: readonly string[]): Promise<string[]> {
  const text = await safeText(git, ['diff', '--name-only', ...range]);
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function revParse(git: GitProcess, ref: string): Promise<string> {
  try {
    const sha = (await git.text(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    if (!sha) throw new ReviewTargetError(`找不到提交：${ref}`);
    return sha;
  } catch (error) {
    if (error instanceof GitCommandError) throw new ReviewTargetError(`找不到提交：${ref}`);
    throw error;
  }
}

/**
 * Run a git command, returning empty text on failure.
 *
 * A diff that cannot be computed is a normal state (an empty repository, a
 * branch with no commits) rather than an error worth aborting the review over;
 * the caller reports "no changes" and the reviewer says so. Anything that
 * should be fatal — an unknown commit, a malformed ref — is checked before
 * this point.
 */
async function safeText(git: GitProcess, args: readonly string[]): Promise<string> {
  try {
    return await git.text(args);
  } catch {
    return '';
  }
}
