import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLineOps, renderApprovalDiff, selectVisibleOps } from '../src/ui/diffView.js';

const ctx = (before: string, after: string) => ({ path: 'src/a.ts', originalContent: before, modifiedContent: after });

test('diffLineOps trims common prefix/suffix and emits add/del in the middle', () => {
  const ops = diffLineOps('a\nb\nc\nd', 'a\nB\nc\nd');
  const changed = ops.filter((op) => op.kind !== 'context');
  assert.equal(changed.length, 2);
  assert.deepEqual(
    changed.map((op) => [op.kind, op.text]),
    [['del', 'b'], ['add', 'B']],
  );
  assert.equal(changed[0].beforeLine, 2);
  assert.equal(changed[1].afterLine, 2);
});

test('diffLineOps handles pure insert and pure delete', () => {
  const insert = diffLineOps('a\nb', 'a\nx\nb').filter((op) => op.kind !== 'context');
  assert.deepEqual(insert.map((op) => [op.kind, op.text]), [['add', 'x']]);
  const remove = diffLineOps('a\nx\nb', 'a\nb').filter((op) => op.kind !== 'context');
  assert.deepEqual(remove.map((op) => [op.kind, op.text]), [['del', 'x']]);
});

test('renderApprovalDiff shows bullet header with counts and tinted +/- rows', () => {
  const block = renderApprovalDiff(ctx('one\ntwo\nthree', 'one\n2\nthree'));
  assert.ok(block.includes('\u001b[48;2;33;58;43m'), 'add rows carry the upstream dark add tint #213A2B');
  assert.ok(block.includes('\u001b[48;2;74;34;29m'), 'delete rows carry the upstream dark delete tint #4A221D');
  assert.ok(block.includes('\u001b[32m2 +2'), 'added row: NEW-file gutter 2, green + sign');
  assert.ok(block.includes('\u001b[31m2 -two'), 'deleted row: OLD-file gutter 2, red - sign');
});

test('renderApprovalDiff noColor keeps plain gutter+sign lines', () => {
  const block = renderApprovalDiff(ctx('a\nb', 'a\nc'), { noColor: true });
  assert.ok(!block.includes('\u001b'), 'no ANSI when noColor');
  assert.ok(block.startsWith('• src/a.ts (+1 -1)'), 'summary chrome: bullet header + counts');
  assert.ok(block.includes('2 +c'), 'add row shows the new-file line number');
  assert.ok(block.includes('2 -b'), 'delete row shows the old-file line number');
});

test('renderApprovalDiff returns empty string for no textual change', () => {
  assert.equal(renderApprovalDiff(ctx('same\nfile', 'same\nfile')), '');
});

test('long unchanged runs fold away and the changed budget truncates', () => {
  const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const afterLines = before.split('\n');
  afterLines[100] = 'CHANGED';
  // Plus 100 more changes past the default budget of 40.
  for (let i = 0; i < 100; i += 1) afterLines.push(`extra ${i}`);
  const after = afterLines.join('\n');
  const block = renderApprovalDiff(ctx(before, after), { noColor: true, maxChangedLines: 40 });
  const rendered = block.split('\n');
  assert.ok(rendered.some((line) => line.includes('unchanged')), 'fold marker present');
  assert.ok(rendered.length < 200, `rendered block is bounded (${rendered.length})`);
  assert.ok(block.includes('more change(s) hidden'), 'truncation note for budget overflow');
});

test('selectVisibleOps keeps context lines around changes only', () => {
  const before = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n');
  const afterLines = before.split('\n');
  afterLines[25] = 'l25*';
  const ops = diffLineOps(before, afterLines.join('\n'));
  const visible = selectVisibleOps(ops, { noColor: true, maxChangedLines: 40, contextLines: 3 });
  assert.ok(visible.length <= 7 + 1, 'three before + change + three after (plus fold row)');
});
