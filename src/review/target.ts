import { stat } from 'node:fs/promises';
import { resolve as resolvePath, sep } from 'node:path';
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
 *
 * `staged` and `range` are the two shapes a user actually types on a git
 * command line (`--staged`, `HEAD~3..HEAD`). They used to fall through to
 * `custom`: the reviewer got a working-tree diff and prose that said
 * "HEAD~3..HEAD", i.e. it reviewed something other than what was asked. A
 * target that cannot be honoured is an error, not a silent downgrade.
 */
export type ReviewTarget =
  | { kind: 'uncommitted' }
  | { kind: 'staged' }
  | { kind: 'range'; from: string; to: string; mergeBase?: boolean }
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
  '  /review                     审查未提交的改动（含未暂存、已暂存、未跟踪文件清单）',
  '  /review --staged            只审查已暂存的改动',
  '  /review <a>..<b>            审查提交区间（例如 /review HEAD~3..HEAD）',
  '  /review HEAD~3              审查最近 3 个提交',
  '  /review base <分支>         审查当前分支相对 <分支> 的改动（PR 式）',
  '  /review <分支>              同 base <分支>（分支名需含 / 或为 origin/*）',
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

const SHA_PATTERN = /^[0-9a-fA-F]{7,64}$/;
const SINGLE_TOKEN = /^\S+$/;

/**
 * Parse the argument text of `/review`.
 *
 * Deliberately lenient about prose and strict about the command-line shapes it
 * recognises. Anything with whitespace that is not `base <ref>` / `commit <sha>`
 * is custom instructions, because a user typing prose means prose. A recognised
 * shape with a bad operand is an error rather than a silent fallback — treating
 * `/review base` as "review the phrase 'base'" would review the wrong thing.
 *
 * A single plain word (`/review security`) stays custom: it is indistinguishable
 * from prose at parse time. A single token that is unambiguously ref-shaped — it
 * contains `/`, `~`, `^`, or is a hex sha — is resolved against git later, and
 * resolution failure is an error, never a whole-repository review.
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
    if (!SHA_PATTERN.test(sha)) {
      throw new ReviewTargetError(`提交号不合法：${sha}（需要 7-64 位十六进制）`);
    }
    return { kind: 'commit', sha };
  }
  if (/^commit\s*$/i.test(text)) {
    throw new ReviewTargetError(`缺少提交号。\n\n${USAGE}`);
  }

  if (/^(?:--staged|--cached)$/i.test(text)) return { kind: 'staged' };

  if (SINGLE_TOKEN.test(text)) {
    const range = parseRange(text);
    if (range) return range;
    if (SHA_PATTERN.test(text)) return { kind: 'commit', sha: text };
    // `HEAD~3` / `HEAD^` mean "the last N commits", not "the string HEAD~3".
    if (/^HEAD(?:[~^]\d*)+$/i.test(text)) {
      return { kind: 'range', from: text, to: 'HEAD' };
    }
    if (text === 'HEAD' || text === '@') {
      return { kind: 'range', from: 'HEAD~1', to: 'HEAD' };
    }
    // Ref-shaped (contains a slash): a branch such as `origin/main`, a path such
    // as `src/a.ts`. Which one it is can only be decided against the repository.
    if (text.includes('/') && isSafeRefOrPath(text)) {
      return { kind: 'base', branch: text };
    }
  }

  return { kind: 'custom', instructions: text };
}

function isSafeRefOrPath(value: string): boolean {
  try {
    assertSafeRef(value);
    return true;
  } catch {
    return false;
  }
}

function hasWhitespaceOrControl(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Is `value` a revision the shell can never re-read as something else?
 *
 * Revision syntax — `HEAD~3`, `v1.0^{commit}`, `main@{upstream}` — must stay
 * allowed: those are how git names commits, and the endpoints are passed as ONE
 * argv element (`a..b`), never to a shell. What is refused is a leading `-`
 * (git would read it as an option, which is how `--output=file` wrote a file),
 * whitespace, and control bytes.
 */
function isSafeRevision(value: string): boolean {
  return value.length > 0
    && !value.startsWith('-')
    && !hasWhitespaceOrControl(value)
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.startsWith('.')
    && !value.endsWith('.')
    // `main....feature`: the endpoints are `main.` and `.feature`, which is not
    // what the user meant and is not a revision git can resolve.
    && !value.includes('..');
}

/** `a..b` / `a...b`, both sides required. */
function parseRange(text: string): ReviewTarget | undefined {
  const three = /^(\S+)\.\.\.(\S+)$/.exec(text);
  if (three) {
    if (!isSafeRevision(three[1]!) || !isSafeRevision(three[2]!)) {
      throw new ReviewTargetError(`提交范围不合法：${text}`);
    }
    return { kind: 'range', from: three[1]!, to: three[2]!, mergeBase: true };
  }
  if (!text.includes('..')) return undefined;
  // `..HEAD` / `HEAD..` / `...HEAD`: a range needs both endpoints. Without this
  // the two-dot branch happily reads `...HEAD` as `.` .. `HEAD`.
  if (text.startsWith('..') || text.endsWith('..')) {
    throw new ReviewTargetError(`提交范围不完整：${text}（需要 <起点>..<终点>）`);
  }
  const two = /^(\S*)\.\.(\S*)$/.exec(text);
  if (!two || !two[1] || !two[2]) {
    throw new ReviewTargetError(`提交范围不完整：${text}（需要 <起点>..<终点>）`);
  }
  if (!isSafeRevision(two[1]) || !isSafeRevision(two[2])) {
    throw new ReviewTargetError(`提交范围不合法：${text}`);
  }
  return { kind: 'range', from: two[1], to: two[2] };
}

/**
 * Cut `text` to `maxChars` without leaving half a surrogate pair.
 *
 * `String.prototype.slice` cuts code units, so a cap that lands inside an emoji
 * or any astral character leaves a lone surrogate at the end of the diff. The
 * reviewer then interpolates the diff into JSON and the lone surrogate corrupts
 * the request body (providers reject or mangle it). Dropping the dangling half
 * is the only lossless choice — the next character was never going to be shown.
 */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let cut = maxChars;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return { text: text.slice(0, cut), truncated: true };
}

/**
 * Build the diff for a target.
 *
 * The diff is computed here and handed to the reviewer rather than left for it
 * to fetch, for two reasons: it pins the review to a reproducible range (the
 * reviewer cannot accidentally review a working tree that moved under it), and
 * it saves the reviewer a tool round-trip on every review.
 *
 * Every shape that names a commit or a branch validates it first: an unresolvable
 * target is a `ReviewTargetError`, never an empty diff presented as a review of
 * nothing (the old behaviour fell back to `git diff <unknown>..HEAD`, which git
 * rejects, and `safeText` turned into `''`).
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
    const cut = truncateText(input.diff, maxChars);
    return {
      target,
      label: input.label,
      diff: cut.text,
      files: input.files,
      ...(input.baseSha ? { baseSha: input.baseSha } : {}),
      ...(cut.truncated ? { truncated: true, fullLength: input.diff.length } : {}),
    };
  };

  // `git -C <dir> rev-parse --git-dir` is the one probe that succeeds inside a
  // repository. Outside one, git ignores --git-dir and falls back to external
  // diff (= no-index) mode, where `diff --cached` is an unknown option — the
  // resolver's reads then fail in a way that means "not a repository", not
  // "cannot read the change". Say that up front instead of guessing.
  const isRepo = await inRepository(git);
  if (!isRepo) {
    return finish({
      label: target.kind === 'staged' ? '已暂存的改动' : target.kind === 'custom' ? `自定义审查：${target.instructions}` : '未提交的改动',
      diff: '（当前目录不是 git 仓库：没有 diff 可提供。审查者仍可读取文件，但无法按提交或暂存区评审。）',
      files: [],
    });
  }

  const hasHead = await headExists(git);

  if (target.kind === 'uncommitted' || target.kind === 'staged') {
    // `git diff HEAD` covers staged AND unstaged tracked changes; `--cached`
    // covers staged only. An unborn HEAD has no HEAD to diff against, so the
    // index is the only thing there is — and it is exactly the change.
    const rangeArgs = target.kind === 'staged' || !hasHead ? ['--cached'] : ['HEAD'];
    const tracked = await requiredText(git, ['diff', ...rangeArgs]);
    const untracked = target.kind === 'uncommitted'
      ? await safeText(git, ['ls-files', '--others', '--exclude-standard'])
      : '';
    const untrackedNames = untracked.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const untrackedSection = untrackedNames.length > 0
      ? `\n\n## 新增但未跟踪的文件（内容未包含在 diff 中，请自行读取）\n${untrackedNames.map((f) => `- ${f}`).join('\n')}\n`
      : '';
    const files = await changedFiles(git, rangeArgs);
    const binary = binarySection(await safeText(git, ['diff', '--numstat', ...rangeArgs]));
    const emptyLabel = target.kind === 'staged' ? '（没有已暂存的改动）' : '（没有未提交的改动）';
    return finish({
      label: target.kind === 'staged' ? '已暂存的改动' : '未提交的改动',
      diff: (tracked.trim() ? tracked : emptyLabel) + untrackedSection + binary,
      files: [...new Set([...files, ...untrackedNames])],
    });
  }

  if (target.kind === 'range') {
    const fromSha = assertObjectId(await revParse(git, target.from, target.from));
    const toSha = assertObjectId(await revParse(git, target.to, target.to));
    let base = fromSha;
    if (target.mergeBase) {
      const mergeBase = await safeText(git, ['merge-base', fromSha, toSha]);
      if (mergeBase.trim()) base = mergeBase.trim();
    }
    const range = `${base}..${toSha}`;
    const diff = await requiredText(git, ['diff', range]);
    const files = await changedFiles(git, [range]);
    const binary = binarySection(await safeText(git, ['diff', '--numstat', range]));
    return finish({
      label: `提交区间 ${target.from}..${target.to}（起点 ${base.slice(0, 12)}）`,
      diff: diff + binary,
      files,
      baseSha: base,
    });
  }

  if (target.kind === 'base') {
    await assertRefOrPathError(git, target.branch, options.repositoryRoot);
    if (!hasHead) {
      throw new ReviewTargetError('当前分支还没有任何提交，无法按分支比较。可以用 /review --staged 审查已暂存的改动。');
    }
    const base = await resolveBaseBranch(git, target.branch);
    const baseSha = await mergeBaseWithHead(git, base);
    // With a merge base, compare from the fork point — that is the PR semantics
    // the user means by "review against main". Without one (unrelated histories)
    // fall back to a two-point diff of the two tips and say so.
    const range = baseSha ? `${baseSha}..HEAD` : `${base}..HEAD`;
    const diff = await requiredText(git, ['diff', range]);
    const files = await changedFiles(git, [range]);
    const binary = binarySection(await safeText(git, ['diff', '--numstat', range]));
    const note = baseSha
      ? `相对 ${base}（合并基点 ${baseSha.slice(0, 12)}）`
      : `相对 ${base}（未找到合并基点，按两个分支的尖端直接比较）`;
    return finish({ label: note, diff: diff + binary, files, ...(baseSha ? { baseSha } : {}) });
  }

  if (target.kind === 'commit') {
    const sha = assertObjectId(await revParse(git, target.sha, target.sha));
    // `--stat --summary -p` (in that order) is what makes a mode-only change or
    // a pure rename visible: the patch body for those is empty, and without the
    // summary the reviewer sees "commit X, no diff" and reviews nothing.
    // (`--stat` alone suppresses the patch, so `-p` must be explicit.)
    // `--diff-merges=first-parent` gives a merge commit its content; a plain
    // `git show` on a merge prints only the header.
    const showArgs = ['show', '--format=%H%n%s%n%an%n%ad', '--stat', '--summary', '-p'];
    const diff = await showWithFallback(git, [...showArgs, '--diff-merges=first-parent', sha], [...showArgs, sha]);
    const nameArgs = ['show', '--format=', '--name-only'];
    const nameText = await showWithFallback(git, [...nameArgs, '--diff-merges=first-parent', sha], [...nameArgs, sha]);
    const files = nameText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const numstatArgs = ['show', '--format=', '--numstat'];
    const binary = binarySection(
      await showWithFallback(git, [...numstatArgs, '--diff-merges=first-parent', sha], [...numstatArgs, sha]),
    );
    const subject = (await safeText(git, ['log', '-1', '--format=%s', sha])).trim();
    return finish({
      label: `提交 ${sha.slice(0, 12)}${subject ? ` — ${subject}` : ''}`,
      diff: diff + binary,
      files,
      baseSha: sha,
    });
  }

  // custom: the reviewer decides what to look at, guided by the instructions.
  // A working-tree diff is still useful context, so send it along, but the
  // instructions are what define the task.
  const args = hasHead ? ['HEAD'] : ['--cached'];
  const diff = await safeText(git, ['diff', ...args]);
  const files = await changedFiles(git, args);
  return finish({
    label: `自定义审查：${target.instructions}`,
    diff: diff.trim() ? diff : '（工作区没有未提交的改动）',
    files,
  });
}

/**
 * Is `base` a ref that exists? If not, say precisely why — an unknown branch and
 * a path both used to produce an empty diff labelled "compared against <x>".
 */
async function assertRefOrPathError(git: GitProcess, ref: string, repositoryRoot: string): Promise<void> {
  try {
    const sha = (await git.text(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
    if (sha) return;
  } catch {
    // fall through to the diagnosis below
  }
  if (await pathExistsInRepo(ref, repositoryRoot)) {
    throw new ReviewTargetError(
      `暂不支持按路径评审：${ref}\n`
      + '请改用 /review --staged、/review commit <sha>、/review base <分支>，'
      + '或把路径写进说明：/review base main 重点看 ' + ref,
    );
  }
  if (!(await headExists(git))) {
    // No HEAD and no resolvable ref is the unborn-repository case, not a typo.
    throw new ReviewTargetError(
      `当前分支还没有任何提交，无法按分支比较（${ref} 也不存在）。可以用 /review --staged 审查已暂存的改动。`,
    );
  }
  throw new ReviewTargetError(`找不到分支或提交：${ref}。用 git branch -a / git log 确认名称。`);
}

async function pathExistsInRepo(ref: string, repositoryRoot: string): Promise<boolean> {
  const absolute = resolvePath(repositoryRoot, ref);
  const rootWithSep = repositoryRoot.endsWith(sep) ? repositoryRoot : repositoryRoot + sep;
  if (!absolute.startsWith(rootWithSep) && absolute !== repositoryRoot) return false;
  try {
    return (await stat(absolute)).isFile();
  } catch {
    return false;
  }
}

async function headExists(git: GitProcess): Promise<boolean> {
  try {
    const sha = (await git.text(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();
    return Boolean(sha);
  } catch {
    return false;
  }
}

/** Is `git.cwd` inside a work tree? A non-repository is a normal state to report. */
async function inRepository(git: GitProcess): Promise<boolean> {
  try {
    const inside = (await git.text(['rev-parse', '--is-inside-work-tree'])).trim();
    return inside === 'true';
  } catch {
    return false;
  }
}

/** `git diff --name-only` for a range, tolerating an unresolvable range. */
async function changedFiles(git: GitProcess, range: readonly string[]): Promise<string[]> {
  const text = await safeText(git, ['diff', '--name-only', ...range]);
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/**
 * A short note listing files git calls binary for the same range.
 *
 * `git diff` prints `Binary files a/x and b/x differ` and nothing else, so the
 * reviewer has no idea what changed. Naming them at least tells it where to look
 * (read_file / git_show), which is the same contract as the untracked-file list.
 * Takes the full numstat command (diff or show form).
 */
function binarySection(numstat: string): string {
  const binary: string[] = [];
  for (const line of numstat.split(/\r?\n/)) {
    const match = /^-\t-\t(.+)$/.exec(line.trimEnd());
    if (match) binary.push(match[1]!);
  }
  if (binary.length === 0) return '';
  return `\n\n## 二进制文件（diff 不含内容，请自行读取）\n${binary.map((f) => `- ${f}`).join('\n')}\n`;
}

/**
 * `git show` with `--diff-merges=first-parent`, falling back to plain `show` on
 * an older git that does not know the option (it has been there since 2.31, but
 * a user's git is not ours to assume).
 */
async function showWithFallback(git: GitProcess, preferred: readonly string[], fallback: readonly string[]): Promise<string> {
  try {
    return await git.text(preferred);
  } catch (error) {
    if (error instanceof GitCommandError && /diff-merges|unknown option|unrecognized/i.test(error.stderr || error.message)) {
      return requiredText(git, fallback);
    }
    throw new ReviewTargetError(
      `无法读取提交：${(error instanceof GitCommandError ? error.stderr || error.message : String(error)).slice(0, 300)}`,
    );
  }
}


async function revParse(git: GitProcess, ref: string, shown: string): Promise<string> {
  try {
    const sha = (await git.text(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    if (!sha) throw new ReviewTargetError(`找不到提交：${shown}`);
    return sha;
  } catch (error) {
    if (error instanceof GitCommandError) throw new ReviewTargetError(`找不到提交：${shown}`);
    throw error;
  }
}

/**
 * Run a git command that the resolved target cannot proceed without.
 *
 * A failure here is a target that cannot be reviewed (an unknown base, an
 * unborn HEAD, a corrupt object) and must surface as an error. `safeText` is
 * only for the auxiliary reads whose absence is a normal state.
 */
async function requiredText(git: GitProcess, args: readonly string[]): Promise<string> {
  try {
    return await git.text(args);
  } catch (error) {
    const detail = error instanceof GitCommandError ? error.stderr || error.message : String(error);
    throw new ReviewTargetError(`无法读取改动：${detail.slice(0, 300)}`);
  }
}

/**
 * Run a git command, returning empty text on failure.
 *
 * Used only for the auxiliary reads — an untracked-file listing, a subject line,
 * a numstat probe — where failure means "nothing to add", not "nothing to
 * review". Anything whose absence would silently produce an empty review goes
 * through `requiredText` instead.
 */
async function safeText(git: GitProcess, args: readonly string[]): Promise<string> {
  try {
    return await git.text(args);
  } catch {
    return '';
  }
}
