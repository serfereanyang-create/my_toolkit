import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilter } from '../src/workspace/filterExpr.js';
import { applyFilter } from '../src/workspace/applyFilter.js';
import type { WorkspacePackage } from '../src/workspace/discover.js';

function mk(name: string, dir: string, deps: string[] = []): WorkspacePackage {
  return {
    name,
    version: '1.0.0',
    dir,
    isPrivate: false,
    entryPoints: {},
    dependencies: deps,
    devDependencies: [],
    peerDependencies: [],
    optionalDependencies: [],
  };
}

const pkgA = mk('@scope/core', 'packages/core');
const pkgB = mk('@scope/ui', 'packages/ui', ['@scope/core']);
const pkgApp = mk('app-web', 'apps/web', ['@scope/ui']);
const packages = [pkgA, pkgB, pkgApp];

test('parseFilter recognizes name, path, exclude, expansion', () => {
  const expr = parseFilter('@scope/core ./packages/ui !app-web');
  assert.equal(expr.includes.length, 2);
  assert.equal(expr.excludes.length, 1);
  assert.equal(expr.includes[0]!.selector.kind, 'name');
  assert.equal(expr.excludes[0]!.selector.kind, 'name');
});

test('applyFilter: plain match', () => {
  const r = applyFilter(packages, '@scope/core');
  assert.deepEqual(r.matched.map((p) => p.name), ['@scope/core']);
});

test('applyFilter: expansion selectors include dependents', () => {
  const r = applyFilter(packages, '...' + '@scope' + '/core');
  assert.deepEqual(
    r.matched.map((p) => p.name).sort(),
    ['@scope/core', '@scope/ui', 'app-web'].sort(),
  );
});

test('applyFilter: exclusion removes match', () => {
  const r = applyFilter(packages, '@scope/core, @scope/ui, app-web !app-web');
  assert.deepEqual(
    r.matched.map((p) => p.name).sort(),
    ['@scope/core', '@scope/ui'],
  );
});
