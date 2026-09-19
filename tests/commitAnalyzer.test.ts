import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotFiles, couplingPairs, splitCandidates, authorStories, type CommitChanges } from '../src/prreview/commitAnalyzer.js';

const changes: CommitChanges[] = [
  { hash: 'c1', author: 'Ann', date: '2026-09-01', files: [
    { path: 'src/a.ts', added: 5, removed: 2 },
    { path: 'src/b.ts', added: 3, removed: 0 },
  ] },
  { hash: 'c2', author: 'Ann', date: '2026-09-02', files: [
    { path: 'src/a.ts', added: 4, removed: 2 },
    { path: 'src/b.ts', added: 1, removed: 1 },
  ] },
  { hash: 'c3', author: 'Ben', date: '2026-09-03', files: [
    { path: 'src/a.ts', added: 1, removed: 1 },
    { path: 'docs/readme.md', added: 9, removed: 0 },
  ] },
  { hash: 'c4', author: 'Ben', date: '2026-09-04', files: [
    { path: 'src/c.ts', added: 50, removed: 10 },
  ] },
];

test('hotFiles ranks by commit count then churn', () => {
  const hot = hotFiles(changes);
  assert.equal(hot[0]!.path, 'src/a.ts');
  assert.equal(hot[0]!.commits, 3);
  assert.equal(hot[0]!.totalAdded, 10);
  assert.equal(hot[0]!.totalRemoved, 5);
});

test('couplingPairs finds a↔b with strength 1.0 at minCoCommits=2', () => {
  const pairs = couplingPairs(changes, 2);
  const ab = pairs.find((p) => (p.a === 'src/a.ts' && p.b === 'src/b.ts'))!;
  assert.ok(ab);
  assert.equal(ab.coCommits, 2);
  assert.equal(ab.strength, 1, 'b 的全部 2 次 commit 都包含 a');
});

test('splitCandidates includes frequent hot file', () => {
  const splits = splitCandidates(changes);
  const a = splits.find((s) => s.path === 'src/a.ts');
  assert.ok(a);
  assert.equal(a.commits, 3);
  assert.equal(a.churn, 15);
  assert.match(a.reason, /冲突|拆分|职责|累计/);
});

test('authorStories summarizes per-author areas', () => {
  const stories = authorStories(changes);
  const ann = stories.find((s) => s.author === 'Ann')!;
  assert.ok(ann);
  assert.equal(ann.commits, 2);
  assert.equal(ann.topAreas[0]!.area, 'src');
  const ben = stories.find((s) => s.author === 'Ben')!;
  assert.ok(ben.topAreas.some((a) => a.area === 'docs'));
});
