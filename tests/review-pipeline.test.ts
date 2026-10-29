import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitProcess } from '../src/git-safety/git.js';
import {
  parseReviewTarget,
  resolveReviewTarget,
  ReviewTargetError,
  truncateText,
} from '../src/review/target.js';

/*
 * The audit suite for target parsing and diff building.
 *
 * review-target.test.ts pins the four original shapes; this file pins the ones a
 * user types on a git command line (`--staged`, `HEAD~3..HEAD`, a branch), the
 * failure modes that used to degrade into "review the whole repo" or into an
 * empty diff labelled as a comparison, and the diff boundaries (rename, binary,
 * mode-only, deletion, root/merge commit, surrogate-safe truncation).
 *
 * Real repositories throughout: the resolver's job is to translate a target into
 * git commands, so a fake git would test nothing. Every temp dir is removed in
 * `finally`.
 */

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, windowsHide: true });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-review-pipeline-'));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', message]);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

function resolve(dir: string, target: Parameters<typeof resolveReviewTarget>[0]['target'], maxChars?: number) {
  return resolveReviewTarget({
    target,
    git: new GitProcess(dir),
    repositoryRoot: dir,
    ...(maxChars ? { maxChars } : {}),
  });
}

// ── 1. parseReviewTarget table ───────────────────────────────────────────────

test('parse: git command-line shapes are recognised, not treated as prose', () => {
  const table: Array<[string, ReturnType<typeof parseReviewTarget>]> = [
    ['', { kind: 'uncommitted' }],
    ['   ', { kind: 'uncommitted' }],
    ['--staged', { kind: 'staged' }],
    ['--cached', { kind: 'staged' }],
    ['--STAGED', { kind: 'staged' }],
    ['HEAD~3..HEAD', { kind: 'range', from: 'HEAD~3', to: 'HEAD' }],
    ['main..feature', { kind: 'range', from: 'main', to: 'feature' }],
    ['main...feature', { kind: 'range', from: 'main', to: 'feature', mergeBase: true }],
    ['HEAD~3', { kind: 'range', from: 'HEAD~3', to: 'HEAD' }],
    ['HEAD^', { kind: 'range', from: 'HEAD^', to: 'HEAD' }],
    ['HEAD', { kind: 'range', from: 'HEAD~1', to: 'HEAD' }],
    ['abc1234', { kind: 'commit', sha: 'abc1234' }],
    ['origin/main', { kind: 'base', branch: 'origin/main' }],
    ['feature/x', { kind: 'base', branch: 'feature/x' }],
    ['base main', { kind: 'base', branch: 'main' }],
    ['commit abc1234', { kind: 'commit', sha: 'abc1234' }],
  ];
  for (const [input, expected] of table) {
    assert.deepEqual(parseReviewTarget(input), expected, `parse(${JSON.stringify(input)})`);
  }
});

test('parse: an incomplete range is an error, never a silent fallback', () => {
  for (const input of ['HEAD~3..', '..HEAD', '...HEAD', 'main....feature']) {
    assert.throws(() => parseReviewTarget(input), ReviewTargetError, `expected an error for ${JSON.stringify(input)}`);
  }
});

test('parse: a single plain word stays prose; a ref-shaped token is a ref', () => {
  // `/review security` is indistinguishable from prose, and reviewing "the word
  // security" as a branch would fail confusingly. `/review feature/x` is not.
  assert.deepEqual(parseReviewTarget('security'), { kind: 'custom', instructions: 'security' });
  assert.deepEqual(parseReviewTarget('关注错误处理'), { kind: 'custom', instructions: '关注错误处理' });
  assert.equal(parseReviewTarget('feature/x').kind, 'base');
});

test('parse: flags and malformed refs never reach git', () => {
  const bad = ['base --all', 'base main..other', 'base -x', 'commit --staged', 'commit HEAD', 'base HEAD~1', 'HEAD~3..--output=x'];
  for (const input of bad) {
    assert.throws(() => parseReviewTarget(input), ReviewTargetError, `expected an error for ${JSON.stringify(input)}`);
  }
});

// ── 2. resolved shapes against real git ─────────────────────────────────────

test('resolve: --staged sees staged only, not the unstaged edit on top of it', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, 'a.txt'), 'one\n');
    await commitAll(dir, 'base');
    await writeFile(join(dir, 'a.txt'), 'one\nstaged line\n');
    await git(dir, ['add', 'a.txt']);
    await writeFile(join(dir, 'a.txt'), 'one\nstaged line\nunstaged line\n');

    const staged = await resolve(dir, { kind: 'staged' });
    assert.match(staged.diff, /^\+staged line$/m);
    assert.ok(!/^\+unstaged line$/m.test(staged.diff), 'the unstaged line must not be in a --staged review');
    assert.match(staged.label, /已暂存/);
    assert.deepEqual(staged.files, ['a.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve: a range covers exactly the commits named', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, 'a.txt'), 'one\n');
    await commitAll(dir, 'c1');
    await writeFile(join(dir, 'b.txt'), 'two\n');
    await commitAll(dir, 'c2');
    await writeFile(join(dir, 'c.txt'), 'three\n');
    await commitAll(dir, 'c3');

    const two = await resolve(dir, { kind: 'range', from: 'HEAD~2', to: 'HEAD' });
    assert.match(two.diff, /two/);
    assert.match(two.diff, /three/);
    assert.ok(!/one/.test(two.diff), 'the commit before the range must not be included');
    assert.deepEqual([...two.files].sort(), ['b.txt', 'c.txt']);

    // `HEAD~1` as a target means "the last commit", not "the string HEAD~1".
    const last = await resolve(dir, parseReviewTarget('HEAD~1'));
    assert.match(last.diff, /three/);
    assert.ok(!/two/.test(last.diff));

    // Three-dot is the merge-base form.
    const three = await resolve(dir, parseReviewTarget('HEAD~2...HEAD'));
    assert.equal(three.files.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve: an unknown base branch is an error, not an empty diff called a comparison', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, 'a.txt'), 'x\n');
    await commitAll(dir, 'base');
    await assert.rejects(
      () => resolve(dir, { kind: 'base', branch: 'no-such-branch' }),
      (error: unknown) => error instanceof ReviewTargetError && /找不到分支或提交/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve: a path is refused with advice instead of an empty comparison', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, 'src-file.ts'), 'x\n');
    await commitAll(dir, 'base');
    await assert.rejects(
      () => resolve(dir, { kind: 'base', branch: 'src-file.ts' }),
      (error: unknown) => error instanceof ReviewTargetError && /暂不支持按路径评审/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve: base on an unborn HEAD is a clear error, not a crash', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, 'a.txt'), 'staged\n');
    await git(dir, ['add', '.']);
    await assert.rejects(
      () => resolve(dir, { kind: 'base', branch: 'main' }),
      (error: unknown) => error instanceof ReviewTargetError && /还没有任何提交/.test(error.message),
    );
    // ...but the staged diff is still reviewable there.
    const staged = await resolve(dir, { kind: 'staged' });
    assert.match(staged.diff, /staged/);
    assert.deepEqual(staged.files, ['a.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 3. diff boundaries ──────────────────────────────────────────────────────

test('resolve: the root commit has files and content (no parent to diff)', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, 'root.txt'), 'root content\n');
    const sha = await commitAll(dir, 'root');
    const resolved = await resolve(dir, { kind: 'commit', sha });
    assert.deepEqual(resolved.files, ['root.txt'], 'a root commit has no parent but still has a diff');
    assert.match(resolved.diff, /root content/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve: a merge commit shows its first-parent content (git show alone prints none)', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, 'a.txt'), 'base\n');
    await commitAll(dir, 'base');
    await git(dir, ['checkout', '-b', 'side']);
    await writeFile(join(dir, 's.txt'), 'side work\n');
    await commitAll(dir, 'side');
    await git(dir, ['checkout', 'main']);
    await writeFile(join(dir, 'm.txt'), 'main work\n');
    await commitAll(dir, 'main');
    await git(dir, ['merge', '--no-ff', 'side', '-m', 'merge side']);
    const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();

    const resolved = await resolve(dir, { kind: 'commit', sha });
    assert.match(resolved.diff, /side work/, 'a merge review with no diff reviews nothing');
    assert.deepEqual(resolved.files, ['s.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve: mode-only and rename-only commits are visible via the summary', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, 's.sh'), '#!/bin/sh\necho hi\n');
    await writeFile(join(dir, 'old-name.txt'), 'renamed content\n');
    await commitAll(dir, 'base');
    await git(dir, ['update-index', '--chmod=+x', 's.sh']);
    await commitAll(dir, 'chmod');
    const modeSha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const modeOnly = await resolve(dir, { kind: 'commit', sha: modeSha });
    assert.match(modeOnly.diff, /old mode 100644/);
    assert.match(modeOnly.diff, /new mode 100755/);
    assert.deepEqual(modeOnly.files, ['s.sh']);

    await git(dir, ['mv', 'old-name.txt', 'new-name.txt']);
    const renameSha = await commitAll(dir, 'rename');
    const renamed = await resolve(dir, { kind: 'commit', sha: renameSha });
    assert.match(renamed.diff, /rename from old-name.txt/);
    assert.match(renamed.diff, /rename to new-name.txt/);
    assert.deepEqual(renamed.files, ['new-name.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve: a binary change is named, not silently empty', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255, 10, 0, 7]));
    await commitAll(dir, 'base');
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255, 10, 0, 9]));
    const sha = await commitAll(dir, 'binary edit');
    const resolved = await resolve(dir, { kind: 'commit', sha });
    assert.match(resolved.diff, /Binary files a\/bin\.dat and b\/bin\.dat differ/);
    assert.match(resolved.diff, /## 二进制文件/);
    assert.ok(resolved.diff.includes('- bin.dat'));
    assert.deepEqual(resolved.files, ['bin.dat']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve: a deletion is present and listed exactly once', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, 'gone.txt'), 'gone\n');
    await writeFile(join(dir, 'kept.txt'), 'kept\n');
    await commitAll(dir, 'base');
    await git(dir, ['rm', 'gone.txt']);
    const resolved = await resolve(dir, { kind: 'uncommitted' });
    assert.match(resolved.diff, /deleted file mode/);
    assert.deepEqual(resolved.files, ['gone.txt']);
    assert.equal(new Set(resolved.files).size, resolved.files.length, 'no duplicated file entries');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve: an unborn repo stages nothing into "uncommitted" once a file is staged', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, 'n.txt'), 'new project\n');
    await git(dir, ['add', '.']);
    const resolved = await resolve(dir, { kind: 'uncommitted' });
    // `git diff HEAD` fails against an unborn HEAD; the index is the change.
    assert.match(resolved.diff, /new project/);
    assert.deepEqual(resolved.files, ['n.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve: a non-git directory produces an empty diff, not a throw', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-review-nongit-'));
  try {
    await writeFile(join(dir, 'a.txt'), 'hello\n');
    const resolved = await resolve(dir, { kind: 'uncommitted' });
    assert.equal(resolved.files.length, 0);
    // A non-repository is reported as such; it used to fall into git's
    // no-index mode, where `diff --cached` is an unknown option.
    assert.match(resolved.diff, /不是 git 仓库/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 4. truncation ───────────────────────────────────────────────────────────

test('truncateText never cuts a surrogate pair in half', () => {
  const text = 'abc😀def';
  // The emoji is two code units at indexes 3..5; a cap at 4 lands between them.
  assert.equal(truncateText(text, 4).text, 'abc');
  assert.equal(truncateText(text, 5).text, 'abc😀');
  assert.equal(truncateText(text, 100).text, text);
  assert.equal(truncateText(text, 0).text, '');
});

test('resolve: a large diff is truncated at a character boundary and reports the total', async () => {
  const dir = await makeRepo();
  try {
    const padding = 'x'.repeat(5000);
    await writeFile(join(dir, 'big.txt'), `${padding}😀${padding}\n`);
    await git(dir, ['add', '.']);
    const full = await resolve(dir, { kind: 'staged' }, 1_000_000);
    const emojiIndex = full.diff.indexOf('😀');
    assert.ok(emojiIndex > 0, 'fixture: the emoji is in the diff');

    const cut = await resolve(dir, { kind: 'staged' }, emojiIndex + 1);
    assert.equal(cut.truncated, true);
    assert.ok(!/[\uD800-\uDBFF]$/.test(cut.diff), 'the truncated diff must not end in a lone high surrogate');
    assert.ok(!cut.diff.endsWith('�'), 'a lone surrogate would be encoded as U+FFFD downstream');
    assert.equal(cut.fullLength, full.diff.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 5. randomized / exhaustive parser property ──────────────────────────────

/** mulberry32 — deterministic, seed printed on failure so a case can be replayed. */
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

test('parse: randomized tokens always yield a well-formed target and never a flag as a ref', () => {
  const seed = 0x5eed_1234;
  const random = mulberry32(seed);
  const alphabet = 'ab01/..~^-_ @:?*[x';
  const kinds = new Set(['uncommitted', 'staged', 'range', 'base', 'commit', 'custom']);
  for (let caseIndex = 0; caseIndex < 500; caseIndex += 1) {
    const length = 1 + Math.floor(random() * 14);
    let token = '';
    for (let i = 0; i < length; i += 1) token += alphabet[Math.floor(random() * alphabet.length)]!;
    const input = random() < 0.5 ? token : `  ${token}  `;
    let parsed;
    try {
      parsed = parseReviewTarget(input);
    } catch (error) {
      assert.ok(
        error instanceof ReviewTargetError,
        `seed=${seed} case=${caseIndex} input=${JSON.stringify(input)} threw ${String(error)}`,
      );
      continue;
    }
    const where = `seed=${seed} case=${caseIndex} input=${JSON.stringify(input)} parsed=${JSON.stringify(parsed)}`;
    assert.ok(kinds.has(parsed.kind), `unknown kind: ${where}`);
    if (parsed.kind === 'base') {
      assert.ok(parsed.branch.length > 0, `empty branch: ${where}`);
      assert.ok(!parsed.branch.startsWith('-'), `a flag must never become a ref: ${where}`);
      assert.ok(!/\s/.test(parsed.branch), `whitespace in a ref: ${where}`);
    }
    if (parsed.kind === 'range') {
      for (const ref of [parsed.from, parsed.to]) {
        assert.ok(!ref.startsWith('-'), `a flag must never become a range endpoint: ${where}`);
        assert.ok(!/\s/.test(ref), `whitespace in a range endpoint: ${where}`);
      }
    }
    if (parsed.kind === 'commit') {
      assert.match(parsed.sha, /^[0-9a-fA-F]{7,64}$/, `bad sha: ${where}`);
    }
  }
});

test('truncateText: randomized strings and caps never end in a lone surrogate', () => {
  const seed = 0xc0ffee;
  const random = mulberry32(seed);
  const pieces = ['a', '中', '😀', '🦊', '\n', 'z'];
  for (let caseIndex = 0; caseIndex < 500; caseIndex += 1) {
    let text = '';
    const length = Math.floor(random() * 30);
    for (let i = 0; i < length; i += 1) text += pieces[Math.floor(random() * pieces.length)]!;
    const cap = Math.floor(random() * 40);
    const result = truncateText(text, cap);
    const where = `seed=${seed} case=${caseIndex} text=${JSON.stringify(text)} cap=${cap}`;
    assert.ok(result.text.length <= cap, `length exceeded the cap: ${where}`);
    assert.ok(text.startsWith(result.text), `result is not a prefix: ${where}`);
    const last = result.text.charCodeAt(result.text.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `lone high surrogate at the cut: ${where}`);
    assert.equal(result.truncated, text.length > cap, `truncated flag: ${where}`);
  }
});

test('resolve: an over-cap diff is truncated and says so', async () => {
  const dir = await makeRepo();
  try {
    const big = `${'x'.repeat(5000)}\n`;
    for (let i = 0; i < 20; i += 1) await writeFile(join(dir, `big-${i}.txt`), big.repeat(4));
    await git(dir, ['add', '.']);
    const resolved = await resolve(dir, { kind: 'uncommitted' }, 1000);
    assert.equal(resolved.truncated, true);
    assert.equal(resolved.diff.length, 1000);
    assert.ok((resolved.fullLength ?? 0) > 1000);
    assert.equal(resolved.files.length, 20, 'the file list is not truncated — it is where to look');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
