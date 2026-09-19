import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFreshness, summarize, type DepAudit } from '../src/prreview/dependencyAudit.js';

test('classifyFreshness detects each bucket', () => {
  assert.equal(classifyFreshness('^1.2.3', '1.2.3'), 'up-to-date');
  assert.equal(classifyFreshness('1.2.3', '1.2.10'), 'patch-behind');
  assert.equal(classifyFreshness('~1.2.0', '1.5.0'), 'minor-behind');
  assert.equal(classifyFreshness('^1.0.0', '2.0.0'), 'major-behind');
  assert.equal(classifyFreshness('>=1.0.0', '1.0.0'), 'up-to-date');
  assert.equal(classifyFreshness('1.0.0', null), 'unknown');
});

test('summarize tallies all buckets', () => {
  const fake: DepAudit[] = [
    { name: 'a', declaredRange: '1.0.0', current: '1.0.0', latest: '1.0.0', risk: 'up-to-date' },
    { name: 'b', declaredRange: '1.0.0', current: '1.0.0', latest: '1.0.1', risk: 'patch-behind' },
    { name: 'c', declaredRange: '1.0.0', current: '1.0.0', latest: '1.1.0', risk: 'minor-behind' },
    { name: 'd', declaredRange: '1.0.0', current: '1.0.0', latest: '2.0.0', risk: 'major-behind' },
    { name: 'e', declaredRange: '1.0.0', current: '1.0.0', latest: null, risk: 'unknown' },
  ];
  const s = summarize(fake);
  assert.equal(s.total, 5);
  assert.equal(s.upToDate, 1);
  assert.equal(s.patchBehind, 1);
  assert.equal(s.minorBehind, 1);
  assert.equal(s.majorBehind, 1);
  assert.equal(s.unknown, 1);
  assert.equal(s.deprecated, 0);
});
