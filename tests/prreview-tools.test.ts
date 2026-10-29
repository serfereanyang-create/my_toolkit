import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ToolContext } from '../src/tools/types.js';
import { reviewPrTool, suggestReviewersTool } from '../src/prreview/reviewTools.js';
import { parseUnifiedDiff } from '../src/prreview/diffModel.js';

/*
 * The pr-review tools run git themselves, and `base`/`head` come from the model.
 *
 * `execFile` stops shell injection but not OPTION injection: argv reaches git
 * verbatim and git reads a leading `-` as an option. `base: "--output=<path>"`
 * made `git diff` write the patch over a file inside the workspace — a write
 * primitive inside a tool declared `risk: 'read'`. These tests use a real
 * repository and assert the side effect does not happen.
 */

const run = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-prreview-'));
  await run('git', ['init', '-b', 'main'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir, windowsHide: true });
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: dir, windowsHide: true });
  await run('git', ['commit', '-m', 'first'], { cwd: dir, windowsHide: true });
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
  return dir;
}

function context(workspaceRoot: string): ToolContext {
  return { workspaceRoot, approval: 'auto' };
}

test('review_pr: a ref-shaped --output= is refused before git runs', async () => {
  const dir = await makeRepo();
  try {
    assert.throws(
      () => reviewPrTool.validate!({ base: '--output=src/pwned.ts' }),
      /非法的 base 引用/,
    );
    const result = await reviewPrTool.execute(
      { base: '--output=src/pwned.ts' },
      context(dir),
    );
    assert.equal(result.ok, false);
    assert.match(result.output, /非法的 base 引用/);
    assert.equal(existsSync(join(dir, 'src', 'pwned.ts')), false, 'no file may be written by a read-risk review');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('suggest_reviewers: refuses the same way', async () => {
  const dir = await makeRepo();
  try {
    assert.throws(() => suggestReviewersTool.validate!({ head: '--ext-diff' }), /非法的 head 引用/);
    // `execute` reports the refusal instead of recommending reviewers from the
    // working tree: a flag-shaped ref is never a "no history found" answer.
    const result = await suggestReviewersTool.execute({ head: '--ext-diff' }, context(dir));
    assert.equal(result.ok, false);
    assert.match(result.output, /非法的 head 引用/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('review_pr: head without base is honoured, not silently dropped', async () => {
  const dir = await makeRepo();
  try {
    const result = await reviewPrTool.execute({ base: 'HEAD', head: 'HEAD' }, context(dir));
    assert.equal(result.ok, true, result.output);

    // `head` alone used to be silently dropped: the tool reviewed the working
    // tree instead of the commit it was pointed at.
    await run('git', ['commit', '-am', 'second'], { cwd: dir, windowsHide: true });
    await writeFile(join(dir, 'untracked.ts'), 'x\n');
    const viaHead = await reviewPrTool.execute({ head: 'HEAD' }, context(dir));
    assert.equal(viaHead.ok, true, viaHead.output);
    // HEAD..HEAD is empty; the working tree has a modification and an untracked
    // file. Empty proves the ref was used; a report would prove it was dropped.
    assert.match(viaHead.output, /diff 为空/, 'a bare `head` must diff that ref, not the working tree');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseUnifiedDiff: quoted paths with spaces are not dropped', () => {
  const text = [
    'diff --' + 'git "a/my file.ts" "b/my file.ts"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/my file.ts"',
    '@@ -0,0 +1,1 @@',
    '+x',
    'diff --' + 'git a/plain.ts b/plain.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\n');
  const parsed = parseUnifiedDiff(text);
  assert.deepEqual(parsed.files.map((file) => file.path), ['my file.ts', 'plain.ts']);
  assert.equal(parsed.files[0]!.kind, 'added');
});

test('parseUnifiedDiff: an escaped (tab) path is unquoted', () => {
  const text = [
    'diff --' + 'git "a/tab\\there.ts" "b/tab\\there.ts"',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\n');
  assert.deepEqual(parseUnifiedDiff(text).files.map((file) => file.path), ['tab\there.ts']);
});
