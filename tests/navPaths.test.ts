/**
 * navPaths.test.ts — path containment and walker edge cases for the nav layer.
 *
 * The nav index is cache data on disk; find_references must never read outside
 * the workspace even when the index says so. Walkers must not follow
 * symlinks/junctions (a junction to the repo root used to recurse until the
 * file budget ran out, indexing the same file under dozens of fake paths).
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findReferences, resolveIndexedPath } from '../src/nav/query.js';
import { NavIndexStore } from '../src/nav/store.js';
import { buildRepositoryMap } from '../src/nav/repoMap.js';
import type { NavIndexFile } from '../src/nav/types.js';

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `aicode-navpath-${name}-`));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('resolveIndexedPath keeps in-workspace paths and rejects escapes', () => {
  const root = join(tmpdir(), 'nav-root');
  assert.equal(resolveIndexedPath(root, 'src/a.ts'), join(root, 'src', 'a.ts'));
  // A path that climbs out and comes back stays inside.
  assert.equal(resolveIndexedPath(root, 'src/../ok.ts'), join(root, 'ok.ts'));
  for (const escaped of [
    '../outside.ts',
    '../../etc/passwd',
    'src/../../outside.ts',
    'C:\\Windows\\win.ini',
    '\\\\server\\share\\x',
  ]) {
    assert.equal(resolveIndexedPath(root, escaped), undefined, `expected rejection: ${escaped}`);
  }
  assert.equal(resolveIndexedPath(root, ''), undefined);
});

test('findReferences never reads a file outside the workspace named by the index', async () => {
  const dir = await fixture('escape');
  const outside = await mkdtemp(join(tmpdir(), 'aicode-navpath-outside-'));
  try {
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'topsecretToken appears here\n', 'utf8');
    await mkdir(join(dir.root, 'src'), { recursive: true });
    await writeFile(join(dir.root, 'src', 'a.ts'), 'const topsecretToken = 1;\n', 'utf8');

    const index: NavIndexFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      workspaceRoot: dir.root,
      files: [
        { path: 'src/a.ts', mtimeMs: 0, size: 0, language: 'ts', symbols: [] },
        // A crafted / stale index entry pointing at the outside file.
        { path: secret, mtimeMs: 0, size: 0, language: 'other', symbols: [] },
        { path: `../${'..'}/outside`, mtimeMs: 0, size: 0, language: 'other', symbols: [] },
      ],
    };

    const refs = await findReferences(index, dir.root, 'topsecretToken');
    assert.deepEqual(refs.map((ref) => ref.path), ['src/a.ts']);
  } finally {
    await dir.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('findReferences treats $ as an identifier character', async () => {
  const dir = await fixture('dollar');
  try {
    await mkdir(join(dir.root, 'src'), { recursive: true });
    await writeFile(join(dir.root, 'src', 'a.ts'), [
      'const value = 1;',
      'value$helper();',
      'value.other();',
      'useValue();',
      'call(value);',
    ].join('\n'), 'utf8');
    const index: NavIndexFile = {
      version: 1,
      updatedAt: '',
      workspaceRoot: dir.root,
      files: [{ path: 'src/a.ts', mtimeMs: 0, size: 0, language: 'ts', symbols: [] }],
    };
    const refs = await findReferences(index, dir.root, 'value');
    assert.deepEqual(refs.map((ref) => ref.line), [1, 3, 5], 'must match value / value.other / call(value) only');
  } finally {
    await dir.cleanup();
  }
});

test('NavIndexStore does not descend into a junction back to the root', async () => {
  const dir = await fixture('cycle');
  try {
    await mkdir(join(dir.root, 'src'), { recursive: true });
    await writeFile(join(dir.root, 'src', 'a.ts'), 'export function alpha() {}\n', 'utf8');
    let linked = false;
    try {
      await symlink(dir.root, join(dir.root, 'src', 'loop'), 'junction');
      linked = true;
    } catch {
      // Creating junctions can be denied on locked-down Windows; the lstat
      // guard is still exercised by the assertion below when it succeeds.
    }
    const index = await new NavIndexStore(dir.root).loadOrBuild();
    const paths = index.files.map((file) => file.path);
    assert.deepEqual(paths, ['src/a.ts']);
    if (linked) {
      assert.ok(paths.every((path) => !path.includes('loop')), 'junction contents must not be indexed');
    }
  } finally {
    await dir.cleanup();
  }
});

test('repository map skips junctions and the .aicode cache directory', async () => {
  const dir = await fixture('map');
  try {
    await mkdir(join(dir.root, '.aicode', 'nav'), { recursive: true });
    await writeFile(join(dir.root, '.aicode', 'nav', 'index.json'), '{}', 'utf8');
    await writeFile(join(dir.root, 'a.ts'), 'export const shown = 1;\n', 'utf8');
    try {
      await symlink(dir.root, join(dir.root, 'loop'), 'junction');
    } catch {
      // ignore on hosts that refuse junctions
    }
    const map = await buildRepositoryMap(dir.root);
    const paths = map.modules.map((module) => module.path);
    assert.deepEqual(paths, ['a.ts']);
  } finally {
    await dir.cleanup();
  }
});
