import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineDiff } from '../src/tools/lineDiff.js';

test('counts every line as added when creating from empty', () => {
  assert.deepEqual(lineDiff('', 'a\nb\nc'), { added: 3, removed: 0 });
});

test('counts every line as removed when clearing a file', () => {
  assert.deepEqual(lineDiff('a\nb\nc', ''), { added: 0, removed: 3 });
});

test('no change yields zero added and removed', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nb\nc'), { added: 0, removed: 0 });
});

test('a single replaced line counts one added and one removed', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nX\nc'), { added: 1, removed: 1 });
});

test('inserting lines between unchanged context counts only additions', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nx\ny\nb'), { added: 2, removed: 0 });
});

test('deleting lines from the middle counts only removals', () => {
  assert.deepEqual(lineDiff('a\nx\ny\nb', 'a\nb'), { added: 0, removed: 2 });
});

test('CRLF versus LF alone is not counted as a change', () => {
  assert.deepEqual(lineDiff('a\r\nb\r\nc', 'a\nb\nc'), { added: 0, removed: 0 });
});

test('trailing newline does not create a phantom line', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nb\n'), { added: 0, removed: 0 });
});
