import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, applyHunksToText } from '../src/workspace/unifiedPatch.js';

const DIFF = [
  'diff --' + 'git a/src/foo.ts b/src/foo.ts',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,3 +1,4 @@',
  ' line1',
  '+inserted',
  ' line2',
  ' line3',
].join('\n');

test('parseUnifiedDiff returns a single-file modify plan', () => {
  const plan = parseUnifiedDiff(DIFF);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0]!.newPath, 'src/foo.ts');
  assert.equal(plan.files[0]!.kind, 'modify');
  assert.equal(plan.files[0]!.hunks.length, 1);
  const hunk = plan.files[0]!.hunks[0]!;
  assert.equal(hunk.oldStart, 1);
  assert.equal(hunk.oldCount, 3);
  assert.equal(hunk.newStart, 1);
  assert.equal(hunk.newCount, 4);
});

test('applyHunksToText inserts the new line correctly', () => {
  const original = ['line1', 'line2', 'line3'].join('\n');
  const plan = parseUnifiedDiff(DIFF);
  const next = applyHunksToText(original, plan.files[0]!.hunks);
  assert.equal(next, ['line1', 'inserted', 'line2', 'line3'].join('\n'));
});

test('applyHunksToText raises PatchError on context mismatch', () => {
  const wrongOriginal = 'other\nline2\nline3';
  const plan = parseUnifiedDiff(DIFF);
  assert.throws(() => applyHunksToText(wrongOriginal, plan.files[0]!.hunks));
});

test('parseUnifiedDiff understands create/delete/rename markers', () => {
  const create = [
    'diff --' + 'git a/x.ts b/x.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/x.ts',
    '@@ -0,0 +1,2 @@',
    '+a',
    '+b',
  ].join('\n');
  const del = [
    'diff --' + 'git a/y.ts b/y.ts',
    'deleted file mode 100644',
    '--- a/y.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-old',
  ].join('\n');
  const ren = [
    'diff --' + 'git a/old.ts b/new.ts',
    'rename from old.ts',
    'rename to new.ts',
    '@@ -1,1 +1,1 @@',
    '- a',
    '+ a',
  ].join('\n');
  const createPlan = parseUnifiedDiff(create);
  const deletePlan = parseUnifiedDiff(del);
  const renamePlan = parseUnifiedDiff(ren);
  assert.equal(createPlan.files[0]!.kind, 'create');
  assert.equal(deletePlan.files[0]!.kind, 'delete');
  assert.equal(renamePlan.files[0]!.kind, 'rename');
  assert.equal(renamePlan.files[0]!.oldPath, 'old.ts');
  assert.equal(renamePlan.files[0]!.newPath, 'new.ts');
});
