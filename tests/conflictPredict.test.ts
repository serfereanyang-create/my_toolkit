import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predictConflicts } from '../src/prreview/conflictPredict.js';
import { parseUnifiedDiff } from '../src/prreview/diffModel.js';

const diffA = [
  'diff --' + 'git a/src/foo.ts b/src/foo.ts',
  '@@ -1,5 +1,5 @@',
  ' a',
  '+newA',
  ' b',
].join('\n');

const diffB = [
  'diff --' + 'git a/src/foo.ts b/src/foo.ts',
  '@@ -1,5 +1,5 @@',
  ' a',
  '+newB',
  ' b',
].join('\n');

const diffUnrelated = [
  'diff --' + 'git a/src/bar.ts b/src/bar.ts',
  '@@ -1,3 +1,4 @@',
  ' x',
  '+m',
].join('\n');

test('shared file diffing produces both-modified hotspot', () => {
  const report = predictConflicts(parseUnifiedDiff(diffA), parseUnifiedDiff(diffB));
  assert.equal(report.sharedFiles, 1);
  assert.equal(report.hotspots.length, 1);
  assert.equal(report.hotspots[0]!.reason, 'both-modified');
  assert.ok(report.riskScore > 0);
});

test('unrelated diffs produce zero hotspots', () => {
  const report = predictConflicts(parseUnifiedDiff(diffA), parseUnifiedDiff(diffUnrelated));
  assert.equal(report.hotspots.length, 0);
  assert.equal(report.riskScore, 0);
});
