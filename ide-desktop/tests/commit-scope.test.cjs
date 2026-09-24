'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterCommitMessageFilesByCurrentSession,
  extractSessionFilePaths,
} = require('../electron/commit-scope.cjs');

const files = [
  { path: 'C:\\repo\\src\\a.ts', repoRelativePath: 'src/a.ts', workspaceRelativePath: 'src/a.ts' },
  { path: 'C:\\repo\\src\\b.ts', repoRelativePath: 'src/b.ts', workspaceRelativePath: 'src/b.ts' },
  { path: 'C:\\repo\\docs\\readme.md', repoRelativePath: 'docs/readme.md', workspaceRelativePath: 'docs/readme.md' },
];

test('no session paths means no filtering (all files kept)', () => {
  const kept = filterCommitMessageFilesByCurrentSession({
    files,
    workspacePath: 'C:\\repo',
    repoRoot: 'C:\\repo',
    workspaceInRepoPath: '.',
    currentSessionFilePaths: [],
  });
  assert.equal(kept.length, 3);
});

test('absolute and relative session paths both narrow the scope', () => {
  const kept = filterCommitMessageFilesByCurrentSession({
    files,
    workspacePath: 'C:\\repo',
    repoRoot: 'C:\\repo',
    workspaceInRepoPath: '.',
    currentSessionFilePaths: ['C:\\repo\\src\\a.ts', 'src/b.ts'],
  });
  assert.deepEqual(kept.map((f) => f.repoRelativePath).sort(), ['src/a.ts', 'src/b.ts']);
});

test('relative paths are resolved against a nested workspace scope', () => {
  const kept = filterCommitMessageFilesByCurrentSession({
    files,
    workspacePath: 'C:\\repo\\packages\\app',
    repoRoot: 'C:\\repo',
    workspaceInRepoPath: 'packages/app',
    currentSessionFilePaths: ['src/a.ts'],
  });
  // Upstream adds BOTH the raw relative candidate and the workspace-prefixed
  // one, so a top-level src/a.ts also matches — that ambiguity is intended.
  assert.deepEqual(kept.map((f) => f.repoRelativePath), ['src/a.ts']);

  const kept2 = filterCommitMessageFilesByCurrentSession({
    files: [...files, { path: 'C:\\repo\\packages\\app\\src\\a.ts', repoRelativePath: 'packages/app/src/a.ts', workspaceRelativePath: 'src/a.ts' }],
    workspacePath: 'C:\\repo\\packages\\app',
    repoRoot: 'C:\\repo',
    workspaceInRepoPath: 'packages/app',
    currentSessionFilePaths: ['src/a.ts'],
  });
  assert.deepEqual(kept2.map((f) => f.repoRelativePath).sort(), ['packages/app/src/a.ts', 'src/a.ts']);
});

test('extractSessionFilePaths pulls path-shaped inputs from toolCalls', () => {
  const paths = extractSessionFilePaths([
    { tool: 'list_dir', input: { path: 'src' } },
    { tool: 'write_file', input: { path: 'src/agent.ts', content: '...' } },
    { tool: 'search', input: { query: 'find it' } },
    { tool: 'read_file', input: { file: 'docs/x.md' } },
    { tool: 'list_dir', input: { path: '.' } },
    null,
    { tool: 'no_input' },
  ]);
  assert.deepEqual(paths, ['src', 'src/agent.ts', 'docs/x.md']);
});
