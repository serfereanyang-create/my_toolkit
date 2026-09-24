'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateHeuristicCommitMessage,
  classifyKind,
  commonScopeOf,
  CONVENTIONAL_SUBJECT_PATTERN,
} = require('../electron/commit-message.cjs');

test('subjects always satisfy the upstream conventional-commit regex', () => {
  const samples = [
    { files: [{ kind: 'modified', repoRelativePath: 'src/a.ts', added: 5, removed: 2 }] },
    { files: [{ kind: 'added', repoRelativePath: 'docs/guide.md', added: 100, removed: 0 }] },
    { files: Array.from({ length: 30 }, (_, i) => ({ kind: 'modified', repoRelativePath: `very/deep/path/segment/number/${i}/file.ts`, added: 1, removed: 1 })) },
    { files: [{ kind: 'deleted', repoRelativePath: 'legacy/x.js', added: 0, removed: 40 }] },
    { files: [] },
  ];
  for (const sample of samples) {
    const message = generateHeuristicCommitMessage(sample);
    assert.match(message.subject, CONVENTIONAL_SUBJECT_PATTERN, `subject: ${message.subject}`);
  }
});

test('type follows the dominant change kind (tests beat source edits)', () => {
  assert.equal(classifyKind({ kind: 'added', repoRelativePath: 'tests/new.test.ts' }), 'test');
  assert.equal(classifyKind({ kind: 'modified', repoRelativePath: 'README.md' }), 'docs');
  assert.equal(classifyKind({ kind: 'modified', repoRelativePath: '.github/workflows/ci.yml' }), 'ci');
  assert.equal(classifyKind({ kind: 'modified', repoRelativePath: 'package.json' }), 'build');
  assert.equal(classifyKind({ kind: 'added', repoRelativePath: 'src/new.ts' }), 'feat');
  assert.equal(classifyKind({ kind: 'deleted', repoRelativePath: 'src/old.ts' }), 'chore');
  assert.equal(classifyKind({ kind: 'modified', repoRelativePath: 'src/touched.ts', added: 4, removed: 4 }), 'refactor');

  const message = generateHeuristicCommitMessage({
    files: [
      { kind: 'modified', repoRelativePath: 'src/a.test.ts', added: 10, removed: 2 },
      { kind: 'modified', repoRelativePath: 'src/b.test.ts', added: 8, removed: 1 },
      { kind: 'modified', repoRelativePath: 'src/main.ts', added: 30, removed: 3 },
    ],
  });
  assert.equal(message.type, 'test', 'the most common kind wins the mixed set');
});

test('scope is the common top-level directory of the changed files', () => {
  assert.equal(commonScopeOf([
    { repoRelativePath: 'src/a.ts' },
    { repoRelativePath: 'src/deep/b.ts' },
  ]), 'src');
  assert.equal(commonScopeOf([
    { repoRelativePath: 'src/a.ts' },
    { repoRelativePath: 'docs/b.md' },
  ]), null);

  const message = generateHeuristicCommitMessage({
    files: [
      { kind: 'modified', repoRelativePath: 'src/agent/a.ts', workspaceRelativePath: 'agent/a.ts', added: 2, removed: 0 },
      { kind: 'modified', repoRelativePath: 'src/agent/b.ts', workspaceRelativePath: 'agent/b.ts', added: 0, removed: 5 },
    ],
  });
  assert.equal(message.scope, 'src/agent');
  // feat vs fix tie (one added-only file, one removed-only file): first kind wins.
  assert.match(message.subject, /^feat\(src\/agent\): update 2 files$/);
});

test('body lists files with stats and the caller can override the type', () => {
  const message = generateHeuristicCommitMessage({
    type: 'fix',
    files: [
      { kind: 'modified', repoRelativePath: 'src/a.ts', added: 3, removed: 1 },
      { kind: 'modified', repoRelativePath: 'src/b.ts', added: 1, removed: 0 },
    ],
  });
  assert.ok(message.subject.startsWith('fix(src): '));
  assert.ok(message.body.includes('- src/a.ts (+3/-1)'));
  assert.ok(message.body.includes('Total: +4/-1 across 2 files.'));
});
