import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, addedLineNumbers } from '../src/prreview/diffModel.js';
import { reviewFiles, buildReport } from '../src/prreview/reviewRules.js';

const SIMPLE_DIFF = [
  'diff --' + 'git a/src/foo.ts b/src/foo.ts',
  'index 1111111..2222222 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,3 +1,5 @@',
  ' const a = 1;',
  '+',
  '+const secret' + ' = "abcdef1234567890";',
  '+debugger;',
  ' const b = 2;',
  '',
].join('\n');

test('parseUnifiedDiff parses added lines and positions', () => {
  const parsed = parseUnifiedDiff(SIMPLE_DIFF);
  assert.equal(parsed.files.length, 1);
  const f = parsed.files[0]!;
  assert.equal(f.path, 'src/foo.ts');
  assert.equal(f.addedLines, 3);
  assert.equal(parsed.totalAdded, 3);
  assert.deepEqual(addedLineNumbers(f), [2, 3, 4]);
});

test('parseUnifiedDiff handles new/deleted/rename directives', () => {
  const text = [
    'diff --' + 'git a/a.ts b/a.ts',
    'new file mode 100644',
    '@@ -0,0 +1,1 @@',
    '+x',
    'diff --' + 'git a/b.ts b/b.ts',
    'deleted file mode 100644',
    '@@ -1,1 +0,0 @@',
    '-y',
    'diff --' + 'git a/c.ts b/d.ts',
    'rename from c.ts',
    'rename to d.ts',
  ].join('\n');
  const parsed = parseUnifiedDiff(text);
  assert.equal(parsed.files.length, 3);
  assert.equal(parsed.files[0]!.kind, 'added');
  assert.equal(parsed.files[1]!.kind, 'deleted');
  assert.equal(parsed.files[2]!.kind, 'renamed');
  assert.equal(parsed.files[2]!.path, 'd.ts');
});

test('reviewFiles flags debugger and hardcoded secret, scores accordingly', () => {
  const parsed = parseUnifiedDiff(SIMPLE_DIFF);
  const findings = reviewFiles(parsed.files);
  const rules = new Set(findings.map((f) => f.rule));
  assert.ok(rules.has('no-debugger'));
  assert.ok(rules.has('no-hardcoded-secret'));
  const report = buildReport(parsed.files, findings);
  assert.equal(report.summary.critical, 2);
  assert.ok(report.score <= 70);
  assert.ok(report.findings.every((f) => typeof f.line === 'number'));
});
