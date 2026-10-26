import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectImports, findStronglyConnected } from '../src/prreview/importCycles.js';

test('collectImports picks up import/export-from/require', () => {
  const src = `
import { a } from './a';
import type { B } from './b';
export * from './c';
const m = require('./d');
const lazy = import('./e');
`;
  const list = collectImports('x.ts', src);
  assert.ok(list.includes('./a'));
  assert.ok(list.includes('./b'));
  assert.ok(list.includes('./c'));
  assert.ok(list.includes('./d'));
});

test('findStronglyConnected finds cycles only when size>1', () => {
  const graph = new Map<string, Set<string>>([
    ['a.ts', new Set(['b.ts'])],
    ['b.ts', new Set(['a.ts'])],
    ['c.ts', new Set(['a.ts'])],
    ['d.ts', new Set()],
  ]);
  const sccs = findStronglyConnected(graph);
  assert.equal(sccs.length, 1);
  const members = new Set(sccs[0]);
  assert.ok(members.has('a.ts'));
  assert.ok(members.has('b.ts'));
  assert.ok(!members.has('c.ts'));
});

test('findStronglyConnected no cycles => empty', () => {
  const graph = new Map<string, Set<string>>([
    ['a.ts', new Set(['b.ts'])],
    ['b.ts', new Set(['c.ts'])],
    ['c.ts', new Set()],
  ]);
  assert.deepEqual(findStronglyConnected(graph), []);
});
