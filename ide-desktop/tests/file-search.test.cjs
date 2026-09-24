'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const {
  mapEntriesToCandidates,
  getCandidateScore,
  filterCandidates,
  walkWorkspace,
  createFileSearchService,
} = require('../electron/file-search.cjs');

const entries = mapEntriesToCandidates([
  { name: 'policy.ts', path: '/w/src/safety/policy.ts', relativePath: 'src/safety/policy.ts', type: 'file' },
  { name: 'policy.test.ts', path: '/w/src/safety/policy.test.ts', relativePath: 'src/safety/policy.test.ts', type: 'file' },
  { name: 'polar.ts', path: '/w/src/polar.ts', relativePath: 'src/polar.ts', type: 'file' },
  { name: 'README.md', path: '/w/README.md', relativePath: 'README.md', type: 'file' },
  { name: 'safety', path: '/w/src/safety', relativePath: 'src/safety', type: 'directory' },
]);

test('scoring: prefix beats substring beats subsequence; no-match is null', () => {
  const score = (text, query) => getCandidateScore({ ...entries[0], lowercaseName: text.toLowerCase(), lowercaseRelativePath: text.toLowerCase(), lowercasePath: text.toLowerCase() }, query);
  const prefix = score('policy.ts', 'pol');
  const substring = score('policy.ts', 'lic');
  const subsequence = score('policy.ts', 'plt');
  const noMatch = score('policy.ts', 'zzz');
  assert.ok(prefix < substring, `prefix ${prefix} beats substring ${substring}`);
  assert.ok(substring < subsequence, `substring ${substring} beats subsequence ${subsequence}`);
  assert.equal(noMatch, null);
  const ranked = filterCandidates(entries, 'pol', { limit: 10 });
  assert.deepEqual(ranked.map((c) => c.name), ['polar.ts', 'policy.ts', 'policy.test.ts']);
  const none = filterCandidates(entries, 'zzz', { limit: 10 });
  assert.deepEqual(none, []);
});

test('scoring: substring in relative path ranks above plain name noise', () => {
  // "safety" is a directory segment; the directory itself and its child both match.
  const ranked = filterCandidates(entries, 'safety', { limit: 10 });
  assert.ok(ranked.length >= 2);
  assert.equal(ranked[0].relativePath, 'src/safety');
});

test('empty query with requireQuery returns nothing; otherwise files before dirs', () => {
  assert.deepEqual(filterCandidates(entries, '   ', { requireQuery: true }), []);
  const ranked = filterCandidates(entries, '', { limit: 10 });
  assert.equal(ranked[ranked.length - 1].type, 'directory');
});

test('limit keeps the best K with stable index tie-breaking', () => {
  const ranked = filterCandidates(entries, 'pol', { limit: 2 });
  assert.equal(ranked.length, 2);
  assert.deepEqual(ranked.map((c) => c.name), ['polar.ts', 'policy.ts']);
});

test('walker skips ignored dirs and dotfiles at the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fsearch-'));
  try {
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'junk.js'), '');
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    await writeFile(join(root, 'src', 'deep', 'a.ts'), '');
    await writeFile(join(root, '.secret'), '');
    await writeFile(join(root, 'top.ts'), '');

    const walked = await walkWorkspace(root);
    const rels = walked.map((e) => e.relativePath);
    assert.ok(!rels.some((r) => r.startsWith('node_modules')), 'node_modules ignored');
    assert.ok(!rels.includes('.secret'), 'root dotfiles ignored');
    assert.ok(rels.includes('top.ts'));
    assert.ok(rels.includes('src/deep/a.ts'));
    assert.ok(rels.includes('src'), 'directories included as candidates');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('service caches the index and picks up new files after invalidation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fsearch-svc-'));
  try {
    const service = createFileSearchService();
    await writeFile(join(root, 'alpha.txt'), '');
    const first = await service.search({ rootPath: root, query: 'alpha' });
    assert.equal(first.length, 1);

    await writeFile(join(root, 'alpha-beta.txt'), '');
    const cached = await service.search({ rootPath: root, query: 'alpha' });
    assert.equal(cached.length, 1, 'cached index does not see new files');

    service.invalidate();
    const fresh = await service.search({ rootPath: root, query: 'alpha' });
    assert.equal(fresh.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
