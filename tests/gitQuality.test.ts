import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShortstat, parseGitLogOutput, analyzeCommits } from '../src/workspace/gitQuality.js';

test('parseShortstat extracts insertions and deletions', () => {
  const stats = parseShortstat(' 3 files changed, 12 insertions(+), 4 deletions(-)');
  assert.deepEqual(stats, { insertions: 12, deletions: 4 });
  assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)'), { insertions: 1, deletions: 0 });
  assert.equal(parseShortstat('unrelated line'), null);
});

test('parseGitLogOutput pairs headers with shortstats', () => {
  const stdout = [
    'abc123|Alice|2026-09-01T10:00:00+08:00|feat: add parser',
    ' 2 files changed, 10 insertions(+), 2 deletions(-)',
    'def456|Bob|2026-09-02T11:00:00+08:00|fix: handle empty input',
    '',
  ].join('\n');
  const commits = parseGitLogOutput(stdout);
  assert.equal(commits.length, 2);
  assert.equal(commits[0]!.author, 'Alice');
  assert.deepEqual(
    { ins: commits[0]!.insertions, del: commits[0]!.deletions },
    { ins: 10, del: 2 },
  );
  assert.equal(commits[1]!.insertions, 0, '无 shortstat 的提交按 0 处理');
});

test('analyzeCommits aggregates authors, revert ratio and keywords', () => {
  const commits = [
    { hash: 'a', author: 'A', dateIso: '2026-09-01T02:00:00Z', subject: 'feat: x', insertions: 10, deletions: 0 },
    { hash: 'b', author: 'A', dateIso: '2026-09-02T03:00:00Z', subject: 'revert "feat: x"', insertions: 0, deletions: 10 },
    { hash: 'c', author: 'B', dateIso: '2026-09-03T04:00:00Z', subject: 'fix: crash', insertions: 2, deletions: 1 },
  ];
  const report = analyzeCommits(commits);
  assert.equal(report.commitCount, 3);
  assert.equal(report.topAuthors[0]!.author, 'A');
  assert.equal(report.revert.count, 1);
  assert.ok(report.revert.ratio > 0.3 && report.revert.ratio < 0.34);
  assert.equal(report.hotfixLike.count, 1);
  assert.equal(report.averageLinesPerCommit, Math.round(23 / 3));
  const featKw = report.subjectKeywords.find((k) => k.keyword === 'feat');
  assert.equal(featKw?.count, 2, 'feat: x 与 revert "feat: x" 都含 feat');
});
