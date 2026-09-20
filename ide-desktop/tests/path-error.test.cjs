const assert = require('node:assert/strict');
const { test } = require('node:test');
const { describePathError } = require('../electron/path-error.cjs');

/*
 * These messages cross into the renderer and land in the UI. Passing
 * `error.message` through verbatim put the machine's layout on screen: opening
 * a stale path showed
 *   ENOENT: no such file or directory, realpath 'C:\Users\<name>\...\nope.docx'
 */

test('a missing file becomes a plain sentence, not a raw ENOENT', () => {
  const err = new Error(
    "ENOENT: no such file or directory, realpath 'C:\\Users\\someone\\proj\\nope.docx'",
  );
  err.code = 'ENOENT';
  assert.equal(describePathError(err), 'File not found');
});

test('an ENOENT from any syscall is still a missing file', () => {
  const err = new Error("ENOENT: no such file or directory, open 'C:\\x\\y.txt'");
  err.code = 'ENOENT';
  assert.equal(describePathError(err), 'File not found');
});

test('other errors keep their wording but lose the absolute path', () => {
  const err = new Error("EACCES: permission denied, open 'C:\\Users\\someone\\secret.txt'");
  err.code = 'EACCES';
  const message = describePathError(err);
  assert.match(message, /permission denied/);
  assert.doesNotMatch(message, /C:\\Users/);
  assert.doesNotMatch(message, /someone/);
});

test('a posix absolute path is redacted too', () => {
  const err = new Error('EISDIR: illegal operation on a directory, read /home/someone/proj/src');
  err.code = 'EISDIR';
  const message = describePathError(err);
  assert.doesNotMatch(message, /home\/someone/);
  assert.match(message, /illegal operation/);
});

test('a policy rejection written for the user passes through unchanged', () => {
  // assertInsideRoot throws these; they are already user-facing prose and must
  // not be rewritten or redacted.
  const err = new Error('Path escapes workspace: ../other-pkg/README.md');
  assert.equal(describePathError(err), 'Path escapes workspace: ../other-pkg/README.md');
});

test('a non-Error value does not crash the handler', () => {
  assert.equal(describePathError('plain string failure'), 'plain string failure');
  assert.equal(describePathError(undefined), 'undefined');
});
