'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildChangedFiles,
  kindFromStatus,
  suggestCommitMessage,
} = require('../electron/git-suggest.cjs');
const { CONVENTIONAL_SUBJECT_PATTERN } = require('../electron/commit-message.cjs');

const status = {
  staged: [{ path: 'src/agent.ts', index: 'M', working: ' ' }],
  unstaged: [{ path: 'src/agent.ts', index: ' ', working: 'M' }],
  untracked: ['src/new.ts', 'notes.md'],
};

test('buildChangedFiles dedupes staged/unstaged and maps kinds', () => {
  const numstat = new Map([['src/agent.ts', { added: 10, removed: 2 }]]);
  const files = buildChangedFiles(status, numstat);
  assert.deepEqual(files.map((f) => f.repoRelativePath), ['src/agent.ts', 'src/new.ts', 'notes.md']);
  assert.equal(files[0].kind, 'modified');
  assert.equal(files[0].added, 10);
  assert.equal(files[1].kind, 'added', 'untracked becomes added');
  assert.equal(files[2].added, 0);
});

test('kindFromStatus prefers the index code and maps R/C to renamed', () => {
  assert.equal(kindFromStatus({ index: 'A', working: ' ' }, false), 'added');
  assert.equal(kindFromStatus({ index: ' ', working: 'D' }, false), 'deleted');
  assert.equal(kindFromStatus({ index: 'R', working: ' ' }, false), 'renamed');
  assert.equal(kindFromStatus({ index: ' ', working: 'M' }, false), 'modified');
  assert.equal(kindFromStatus({ path: 'x' }, true), 'added');
});

test('suggest narrows to session files when the session touched any', () => {
  const numstat = new Map([
    ['src/agent.ts', { added: 12, removed: 3 }],
    ['src/other.ts', { added: 50, removed: 50 }],
  ]);
  const fullStatus = {
    staged: [{ path: 'src/agent.ts', index: 'M', working: ' ' }, { path: 'src/other.ts', index: 'M', working: ' ' }],
    unstaged: [],
    untracked: [],
  };
  const result = suggestCommitMessage({
    status: fullStatus,
    numstat,
    toolCalls: [{ tool: 'write_file', input: { path: 'src/agent.ts' } }],
    workspacePath: 'C:\\repo',
    repoRoot: 'C:\\repo',
    workspaceInRepoPath: '.',
  });
  assert.equal(result.changedFileCount, 2);
  assert.equal(result.scopedFileCount, 1, 'session scope keeps only src/agent.ts');
  assert.ok(result.subject.startsWith('refactor(src): update 1 file'), `subject: ${result.subject}`);
  assert.match(result.subject, CONVENTIONAL_SUBJECT_PATTERN);
});

test('no session toolCalls means the whole change set feeds the generator', () => {
  const result = suggestCommitMessage({
    status,
    numstat: new Map(),
    toolCalls: [],
    workspacePath: 'C:\\repo',
    repoRoot: 'C:\\repo',
    workspaceInRepoPath: '.',
  });
  assert.equal(result.changedFileCount, result.scopedFileCount);
  assert.equal(result.sessionFileCount, 0);
  assert.match(result.subject, CONVENTIONAL_SUBJECT_PATTERN);
});
