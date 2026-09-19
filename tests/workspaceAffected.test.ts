import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNpmWorkspacesField, parsePnpmWorkspaceYaml } from '../src/workspace/discover.js';
import { computeAffected } from '../src/workspace/affected.js';
import type { WorkspacePackage } from '../src/workspace/discover.js';

function mkPkg(name: string, dir: string, deps: string[] = []): WorkspacePackage {
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

test('parseNpmWorkspacesField handles array and object forms', () => {
  assert.deepEqual(parseNpmWorkspacesField({ workspaces: ['packages/*'] }), ['packages/*']);
  assert.deepEqual(parseNpmWorkspacesField({ workspaces: { packages: ['apps/*'] } }), ['apps/*']);
  assert.deepEqual(parseNpmWorkspacesField({}), []);
});

test('parsePnpmWorkspaceYaml extracts plain list', () => {
  const yaml = `packages:
  - 'packages/*'
  - 'apps/*'
  - "!infrastructure"
`;
  assert.deepEqual(parsePnpmWorkspaceYaml(yaml), ['packages/*', 'apps/*', '!infrastructure']);
});

test('computeAffected: direct hit + dependents via reverse graph', () => {
  const core = mkPkg('@scope/core', 'packages/core', []);
  const ui = mkPkg('@scope/ui', 'packages/ui', ['@scope/core']);
  const app = mkPkg('app', 'apps/web', ['@scope/ui']);
  const all = [core, ui, app];

  const r1 = computeAffected(['packages/core/src/index.ts'], all);
  assert.deepEqual(
    r1.allAffected.sort(),
    ['@scope/core', '@scope/ui', 'app'].sort(),
    '改 core 应传染 ui 与 app',
  );

  const r2 = computeAffected(['packages/ui/src/widget.tsx'], all);
  assert.deepEqual(r2.allAffected.sort(), ['@scope/ui', 'app'].sort());

  const r3 = computeAffected(['random/unknown.ts'], all);
  assert.equal(r3.direct.length, 0);
  assert.equal(r3.allAffected.length, 0);
  assert.deepEqual(r3.unmatchedFiles, ['random/unknown.ts']);
});
