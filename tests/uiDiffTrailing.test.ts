/**
 * uiDiffTrailing.test.ts — trailing-newline changes must be visible.
 *
 * "a\nb\n" vs "a\nb" is a real edit (add/remove the final newline). The
 * renderer used to pop the final empty line, so the two compared equal and the
 * approval prompt said "nothing to show" for a change prettier makes all the
 * time.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLineOps, NO_NEWLINE_MARKER, renderApprovalDiff } from '../src/ui/diffView.js';

const ctx = (originalContent: string, modifiedContent: string) => ({
  path: 'src/a.ts',
  originalContent,
  modifiedContent,
});

test('adding a trailing newline is a change, not a no-op', () => {
  const ops = diffLineOps('a\nb', 'a\nb\n');
  assert.ok(ops.some((op) => op.note && op.text === NO_NEWLINE_MARKER));
  const block = renderApprovalDiff(ctx('a\nb', 'a\nb\n'), { noColor: true });
  assert.notEqual(block, '');
  assert.match(block, /No newline at end of file/);
  assert.match(block, /\+1/);
  assert.match(block, /-1/);
});

test('identical content with identical newline stays empty', () => {
  assert.equal(diffLineOps('a\nb\n', 'a\nb\n').filter((op) => op.kind !== 'context').length, 0);
  assert.equal(renderApprovalDiff(ctx('a\nb\n', 'a\nb\n')), '');
  assert.equal(renderApprovalDiff(ctx('a\nb', 'a\nb')), '');
});

test('trailing newline on an otherwise empty file does not crash', () => {
  assert.doesNotThrow(() => diffLineOps('', '\n'));
  assert.doesNotThrow(() => diffLineOps('\n', ''));
  assert.doesNotThrow(() => renderApprovalDiff(ctx('', '\n'), { noColor: true }));
});

test('line ops still compare only real content differences', () => {
  const ops = diffLineOps('a\nb\nc\n', 'a\nB\nc\n');
  assert.deepEqual(ops.filter((op) => op.kind !== 'context').map((op) => `${op.kind}:${op.text}`), ['del:b', 'add:B']);
});
