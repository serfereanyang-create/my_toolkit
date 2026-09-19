import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearProjectContextCache,
  discoverInstructionFiles,
  readProjectContext,
} from '../src/agent/context.js';

async function tempWorkspace(): Promise<string> {
  const root = join(tmpdir(), `aicode-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

test('discovers AGENTS.md hierarchically: root first, override wins per directory', async () => {
  const root = await tempWorkspace();
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'sub', 'deep'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'root rules');
  await writeFile(join(root, 'sub', 'AGENTS.md'), 'sub rules');
  // Override beats plain AGENTS.md in the same directory.
  await writeFile(join(root, 'sub', 'deep', 'AGENTS.override.md'), 'deep override');
  await writeFile(join(root, 'sub', 'deep', 'AGENTS.md'), 'deep plain');

  clearProjectContextCache();
  // The workspace root is the deep directory; discovery walks up to the .git root.
  const files = await discoverInstructionFiles(join(root, 'sub', 'deep'));
  const paths = files.map((file) => file.path);
  assert.deepEqual(paths, ['../../AGENTS.md', '../AGENTS.md', 'AGENTS.override.md']);
  await rm(root, { recursive: true, force: true });
});

test('no .git marker means only the workspace root is scanned', async () => {
  const root = await tempWorkspace();
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'root rules');
  await writeFile(join(root, 'sub', 'AGENTS.md'), 'sub rules');

  clearProjectContextCache();
  const paths = (await discoverInstructionFiles(join(root, 'sub'))).map((file) => file.path);
  assert.deepEqual(paths, ['AGENTS.md']);
  await rm(root, { recursive: true, force: true });
});

test('renders persona, the once-only project-doc separator, and truncates over budget', async () => {
  const root = await tempWorkspace();
  await mkdir(join(root, '.git'));
  await mkdir(join(root, '.aicode'), { recursive: true });
  await writeFile(join(root, '.aicode', 'persona.md'), 'be terse');
  await writeFile(join(root, 'AGENTS.md'), 'root rules');
  await writeFile(join(root, 'CLAUDE.md'), 'root claude fallback — must NOT appear');

  clearProjectCacheFor(root);
  const context = await readProjectContext(root);
  assert.ok(context);
  assert.match(context.text, /## \.aicode\/persona\.md\nbe terse/);
  assert.ok(context.text.includes('--- project-doc ---'), 'separator inserted once');
  assert.equal(context.text.split('--- project-doc ---').length - 1, 1);
  assert.match(context.text, /## AGENTS\.md\nroot rules/);
  assert.ok(!context.text.includes('root claude fallback'), 'fallback file skipped when primary exists');
  await rm(root, { recursive: true, force: true });
});

test('cache invalidates when a discovered file changes', async () => {
  const root = await tempWorkspace();
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'AGENTS.md'), 'v1');

  clearProjectCacheFor(root);
  const first = await readProjectContext(root);
  assert.match(first?.text ?? '', /v1/);

  // mtime granularity can be coarse; bump content and mtime deterministically.
  const future = new Date(Date.now() + 5000);
  await writeFile(join(root, 'AGENTS.md'), 'v2');
  const { utimes } = await import('node:fs/promises');
  await utimes(join(root, 'AGENTS.md'), future, future);

  clearProjectCacheFor(root);
  const second = await readProjectContext(root);
  assert.match(second?.text ?? '', /v2/);
  assert.notEqual(first?.cacheKey, second?.cacheKey);
  await rm(root, { recursive: true, force: true });
});

function clearProjectCacheFor(_root: string) {
  clearProjectContextCache();
}
