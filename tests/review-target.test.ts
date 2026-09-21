import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitProcess } from '../src/git-safety/git.js';
import { mergeBaseWithHead, resolveBaseBranch } from '../src/git-safety/pullRequest.js';
import { parseReviewTarget, resolveReviewTarget, ReviewTargetError } from '../src/review/target.js';

const run = promisify(execFile);

/*
 * Real repositories in a temp directory. The target resolver's whole job is to
 * translate a target into git commands, and the failure modes worth testing are
 * git's own — a merge base that does not exist, an unborn HEAD, an unknown
 * commit — so a fake git would test nothing.
 *
 * Nothing here touches the developer's repository, and nothing destructive runs
 * anywhere: temp dirs are created and removed, and the only commands issued are
 * add/commit/diff/merge-base.
 */

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, windowsHide: true });
  return stdout;
}

/** A repo with one commit on `main` and a second commit on `feature`. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-review-'));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'a.txt'), 'line one\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'first']);
  await git(dir, ['checkout', '-b', 'feature']);
  await writeFile(join(dir, 'b.txt'), 'feature work\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'second']);
  return dir;
}

test('parseReviewTarget reads the four target shapes', () => {
  assert.deepEqual(parseReviewTarget(''), { kind: 'uncommitted' });
  assert.deepEqual(parseReviewTarget('   '), { kind: 'uncommitted' });
  assert.deepEqual(parseReviewTarget('base main'), { kind: 'base', branch: 'main' });
  assert.deepEqual(parseReviewTarget('BASE origin/main'), { kind: 'base', branch: 'origin/main' });
  assert.deepEqual(parseReviewTarget('commit abc1234'), { kind: 'commit', sha: 'abc1234' });
  // Anything else is instructions: a user typing prose means prose.
  assert.deepEqual(parseReviewTarget('关注错误处理'), { kind: 'custom', instructions: '关注错误处理' });
  assert.deepEqual(parseReviewTarget('the error handling in the parser'), {
    kind: 'custom',
    instructions: 'the error handling in the parser',
  });
});

test('a keyword form with a missing or invalid operand is an error, not a fallback', () => {
  // Treating `/review base` as "review the phrase 'base'" would review the
  // wrong thing and say nothing about it.
  assert.throws(() => parseReviewTarget('base'), ReviewTargetError);
  assert.throws(() => parseReviewTarget('commit'), ReviewTargetError);
  assert.throws(() => parseReviewTarget('commit not-a-sha'), ReviewTargetError);
  // A ref that git would read as a flag or a range is rejected before git sees it.
  assert.throws(() => parseReviewTarget('base --all'), ReviewTargetError);
  assert.throws(() => parseReviewTarget('base main..other'), ReviewTargetError);
});

test('uncommitted covers tracked and untracked changes', async () => {
  const dir = await makeRepo();
  try {
    const gitProcess = new GitProcess(dir);
    await writeFile(join(dir, 'a.txt'), 'line one changed\n');
    await writeFile(join(dir, 'new-file.txt'), 'brand new\n');

    const resolved = await resolveReviewTarget({
      target: { kind: 'uncommitted' },
      git: gitProcess,
      repositoryRoot: dir,
    });

    assert.match(resolved.diff, /line one changed/);
    assert.ok(resolved.files.includes('a.txt'), 'tracked change listed');
    // An untracked file has no diff hunk, so its name must still be surfaced —
    // otherwise a change consisting only of new files reviews as empty.
    assert.ok(resolved.files.includes('new-file.txt'), 'untracked file listed');
    assert.match(resolved.diff, /new-file\.txt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('base resolves the merge base and diffs from the fork point', async () => {
  const dir = await makeRepo();
  try {
    const resolved = await resolveReviewTarget({
      target: { kind: 'base', branch: 'main' },
      git: new GitProcess(dir),
      repositoryRoot: dir,
    });

    assert.match(resolved.label, /main/);
    assert.ok(resolved.baseSha, 'merge base was computed');
    // The fork point is main's tip: first commit. Diffing from there shows the
    // feature commit and nothing from main itself.
    assert.match(resolved.diff, /feature work/);
    assert.ok(!resolved.diff.includes('line one'), 'main-only content is not in the diff');
    assert.deepEqual(resolved.files, ['b.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('commit reviews that commit alone', async () => {
  const dir = await makeRepo();
  try {
    const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const resolved = await resolveReviewTarget({
      target: { kind: 'commit', sha },
      git: new GitProcess(dir),
      repositoryRoot: dir,
    });

    assert.match(resolved.label, /second/);
    assert.match(resolved.diff, /feature work/);
    assert.ok(!resolved.diff.includes('line one'), 'the parent commit is not included');
    assert.deepEqual(resolved.files, ['b.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a short sha is accepted and resolved to a full one', async () => {
  const dir = await makeRepo();
  try {
    const short = (await git(dir, ['rev-parse', '--short=8', 'HEAD'])).trim();
    const resolved = await resolveReviewTarget({
      target: { kind: 'commit', sha: short },
      git: new GitProcess(dir),
      repositoryRoot: dir,
    });
    assert.match(resolved.diff, /feature work/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown commit is a clear error, not an empty review', async () => {
  const dir = await makeRepo();
  try {
    await assert.rejects(
      () => resolveReviewTarget({
        target: { kind: 'commit', sha: 'deadbee' },
        git: new GitProcess(dir),
        repositoryRoot: dir,
      }),
      ReviewTargetError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('custom passes the instructions through and still carries the working diff', async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, 'a.txt'), 'edited\n');
    const resolved = await resolveReviewTarget({
      target: { kind: 'custom', instructions: '只看错误处理' },
      git: new GitProcess(dir),
      repositoryRoot: dir,
    });
    assert.match(resolved.label, /只看错误处理/);
    assert.match(resolved.diff, /edited/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an over-cap diff is truncated and says so', async () => {
  const dir = await makeRepo();
  try {
    // A change far larger than the cap. Truncating silently would let the
    // reviewer pass judgement on a partial change believing it saw everything.
    const big = `${'x'.repeat(5000)}\n`;
    for (let i = 0; i < 20; i += 1) {
      await writeFile(join(dir, `big-${i}.txt`), big.repeat(4));
    }
    // Staged, not committed: `git diff HEAD` covers staged changes, so this
    // exercises the same path while leaving the change "uncommitted".
    await git(dir, ['add', '.']);

    const resolved = await resolveReviewTarget({
      target: { kind: 'uncommitted' },
      git: new GitProcess(dir),
      repositoryRoot: dir,
      maxChars: 1000,
    });
    assert.equal(resolved.truncated, true);
    assert.equal(resolved.diff.length, 1000);
    assert.ok((resolved.fullLength ?? 0) > 1000);
    // The file list is NOT truncated: it is what tells the reviewer where to
    // go read the rest.
    assert.equal(resolved.files.length, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a clean tree yields an empty diff rather than an error', async () => {
  const dir = await makeRepo();
  try {
    const resolved = await resolveReviewTarget({
      target: { kind: 'uncommitted' },
      git: new GitProcess(dir),
      repositoryRoot: dir,
    });
    assert.equal(resolved.files.length, 0);
    assert.match(resolved.diff, /没有未提交的改动/);
    assert.equal(resolved.truncated, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveBaseBranch prefers an explicit branch and probes otherwise', async () => {
  const dir = await makeRepo();
  try {
    const gitProcess = new GitProcess(dir);
    assert.equal(await resolveBaseBranch(gitProcess, 'develop'), 'develop');
    // No origin, so the probe chain finds the local main.
    assert.equal(await resolveBaseBranch(gitProcess), 'main');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mergeBaseWithHead returns the fork point, and undefined when there is none', async () => {
  const dir = await makeRepo();
  try {
    const gitProcess = new GitProcess(dir);
    const expected = (await git(dir, ['merge-base', 'HEAD', 'main'])).trim();
    assert.equal(await mergeBaseWithHead(gitProcess, 'main'), expected);
    // An unrelated ref cannot be merged — the caller falls back rather than failing.
    assert.equal(await mergeBaseWithHead(gitProcess, 'does-not-exist'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a repository with no commits does not crash the resolver', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-review-empty-'));
  try {
    await git(dir, ['init', '-b', 'main']);
    const resolved = await resolveReviewTarget({
      target: { kind: 'uncommitted' },
      git: new GitProcess(dir),
      repositoryRoot: dir,
    });
    // An unborn HEAD is a normal state, not an error: there is simply nothing
    // to review yet, and the reviewer is told so.
    assert.equal(resolved.files.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
