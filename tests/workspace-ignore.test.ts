import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectIndexTool } from '../src/tools/projectIndex.js';
import { searchTextTool } from '../src/tools/search.js';
import { IGNORED_DIR_NAMES, isIgnoredDirName } from '../src/workspace/ignored.js';

/*
 * Regression for a real bug: a hook on this machine snapshots sources into
 * `<dir>/.mimosa/hook-state/…/*.source`. `.gitignore` knew about that directory,
 * the file-walking layer did not, so the index spent its budget on baseline
 * copies of source files and `search_text` returned hits from them — the model
 * could not tell the real tree from the scanner's cache.
 *
 * The list now lives in one module. These tests pin both halves: the judgement
 * itself, and that the tools actually consult it.
 */

const fakeContext = { workspaceRoot: '', approval: 'auto' as const };

test('the ignored-directory judgement: caches yes, project dot-dirs no', () => {
  for (const name of ['node_modules', 'dist', 'build', 'coverage', '.git', '.gradle', '.mimosa', '.aicode', '.aicode-smoke']) {
    assert.equal(isIgnoredDirName(name), true, `${name} must be skipped`);
  }
  // Dot directories people legitimately read and search.
  for (const name of ['.github', '.claude', '.vscode', 'src', 'docs']) {
    assert.equal(isIgnoredDirName(name), false, `${name} must stay visible`);
  }
  // Windows and macOS filesystems are case-insensitive; so is the check.
  assert.equal(isIgnoredDirName('Node_Modules'), true);
  assert.equal(isIgnoredDirName('.MIMOSA'), true);
  // The `.aicode*` family is ours: any future sub-name is disposable too.
  assert.equal(isIgnoredDirName('.aicode-cache'), true);
  assert.ok(IGNORED_DIR_NAMES.has('node_modules'));
});

test('project_index and search_text both skip a scanner cache directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicode-ignore-'));
  try {
    const context = { ...fakeContext, workspaceRoot: root };
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'app.ts'), 'export const NEEDLE = 1;\n', 'utf8');
    // A baseline snapshot of the same file, inside the scanner cache.
    const cache = join(root, 'src', '.mimosa', 'hook-state', 'sess.baseline');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'abc123.source'), 'export const NEEDLE = 1;\n', 'utf8');
    await writeFile(join(cache, 'abc123.json'), '{"touched":[]}\n', 'utf8');

    const index = await projectIndexTool.execute(projectIndexTool.validate({ path: '.', maxFiles: 1000 }), context);
    assert.match(index.output, /files: 1\b/, `the cache must not be counted:\n${index.output}`);
    assert.doesNotMatch(index.output, /\.source|\.mimosa/);

    const search = await searchTextTool.execute(
      searchTextTool.validate({ query: 'NEEDLE', path: '.' }),
      context,
    );
    const hits = (search.data as { matches: Array<{ path: string }> }).matches;
    assert.deepEqual(hits.map((hit) => hit.path), ['src/app.ts'], 'only the real file may match');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
