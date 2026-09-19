import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topoOrder } from '../src/workspace/runner.js';
import type { WorkspacePackage } from '../src/workspace/discover.js';

function mk(name: string, deps: string[] = []): WorkspacePackage {
  return {
    name,
    version: '1.0.0',
    dir: 'packages/' + name,
    isPrivate: false,
    entryPoints: {},
    dependencies: deps,
    devDependencies: [],
    peerDependencies: [],
    optionalDependencies: [],
  };
}

test('topoOrder: dependencies first', () => {
  const a = mk('a');
  const b = mk('b', ['a']);
  const c = mk('c', ['b']);
  const { sorted, cyclic } = topoOrder([c, b, a]); // shuffle input
  assert.deepEqual(sorted.map((p) => p.name), ['a', 'b', 'c']);
  assert.equal(cyclic.length, 0);
});

test('topoOrder: detects cycles', () => {
  const a = mk('a', ['b']);
  const b = mk('b', ['a']);
  const { sorted, cyclic } = topoOrder([a, b]);
  assert.equal(sorted.length, 0);
  assert.equal(cyclic.length, 2);
});

test('topoOrder: ignores external (non-workspace) deps', () => {
  const a = mk('a');
  const b = mk('b', ['lodash', 'a']);
  const { sorted } = topoOrder([a, b]);
  assert.deepEqual(sorted.map((p) => p.name), ['a', 'b']);
});
