'use strict';
/*
 * Global memory reader: the cross-session, cross-project edit record the CLI
 * writes. The panel must show a real history and must not invent one.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readGlobalMemory } = require('../electron/memory-global.cjs');

function fixture(lines, { index = '# 全局记忆\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yoy-memglobal-'));
  if (index !== null) fs.writeFileSync(path.join(root, 'MEMORY.md'), index, 'utf8');
  if (lines !== null) fs.writeFileSync(path.join(root, 'edits.jsonl'), lines.join('\n'), 'utf8');
  return root;
}

function record(overrides = {}) {
  return JSON.stringify({
    at: '2026-10-22T10:00:00.000Z',
    project: 'work',
    workspace: 'C:/work',
    action: 'write',
    path: 'src/app.ts',
    created: false,
    ...overrides,
  });
}

test('a fresh machine reports an empty history instead of an error', async () => {
  const root = fixture(null, { index: null });
  const snapshot = await readGlobalMemory({ root });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.totalEdits, 0);
  assert.deepEqual(snapshot.projects, []);
  assert.equal(snapshot.markdown, '');
});

test('edits are grouped per project, newest project first', async () => {
  const root = fixture([
    record({ at: '2026-10-22T09:00:00.000Z' }),
    record({ at: '2026-10-22T09:30:00.000Z', path: 'src/app.ts' }),
    record({ at: '2026-10-22T11:00:00.000Z', project: 'other', workspace: 'C:/other', path: 'lib/x.ts', created: true }),
  ]);
  const snapshot = await readGlobalMemory({ root });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.totalEdits, 3);
  assert.equal(snapshot.projects.length, 2);
  assert.equal(snapshot.projects[0].project, 'other', 'the most recently edited project comes first');
  const work = snapshot.projects.find((project) => project.workspace === 'C:/work');
  assert.equal(work.edits, 2);
  assert.equal(work.files.length, 1, 'the same file twice is one row');
  assert.equal(work.files[0].count, 2);
  assert.equal(work.files[0].at, '2026-10-22T09:30:00.000Z');
  assert.equal(snapshot.projects[0].files[0].created, true);
});

test('a half-written ledger line is skipped, not fatal', async () => {
  const root = fixture([record(), '{"at":"2026-10-22T1', 'not json']);
  const snapshot = await readGlobalMemory({ root });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.totalEdits, 1);
  assert.equal(snapshot.records.length, 1);
});

test('renames keep their source path', async () => {
  const root = fixture([record({ action: 'rename', from: 'src/old.ts', path: 'src/new.ts' })]);
  const snapshot = await readGlobalMemory({ root });
  assert.equal(snapshot.records[0].action, 'rename');
  assert.equal(snapshot.records[0].from, 'src/old.ts');
  assert.equal(snapshot.projects[0].files[0].renamed, true);
});

test('a deleted path is marked deleted and loses its created flag', async () => {
  const root = fixture([
    record({ at: '2026-10-22T09:00:00.000Z', created: true }),
    record({ at: '2026-10-22T10:00:00.000Z', action: 'delete', created: false }),
  ]);
  const snapshot = await readGlobalMemory({ root });
  assert.equal(snapshot.records[1].action, 'delete');
  const file = snapshot.projects[0].files[0];
  assert.equal(file.deleted, true);
  assert.equal(file.count, 2);
  assert.equal(file.at, '2026-10-22T10:00:00.000Z', 'the last action decides the row');
});

test('MEMORY.md is passed through untouched and its mtime is reported', async () => {
  const markdown = '# 全局记忆\n\n## work\n- src/app.ts\n';
  const root = fixture([record()], { index: markdown });
  const snapshot = await readGlobalMemory({ root });
  assert.equal(snapshot.markdown, markdown);
  assert.ok(snapshot.updatedAt > 0);
  assert.equal(snapshot.indexPath, path.join(root, 'MEMORY.md'));
});

test('AICODE_GLOBAL_MEMORY_ROOT points the reader at an alternate root', async () => {
  const root = fixture([record()]);
  const previous = process.env.AICODE_GLOBAL_MEMORY_ROOT;
  process.env.AICODE_GLOBAL_MEMORY_ROOT = root;
  try {
    const snapshot = await readGlobalMemory();
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.root, root);
    assert.equal(snapshot.totalEdits, 1);
  } finally {
    if (previous === undefined) delete process.env.AICODE_GLOBAL_MEMORY_ROOT;
    else process.env.AICODE_GLOBAL_MEMORY_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the headline counts the whole ledger, not the page the panel renders', async () => {
  const lines = [];
  for (let i = 0; i < 2100; i += 1) lines.push(record({ at: `2026-10-22T10:00:00.${String(i).padStart(3, '0')}Z` }));
  const root = fixture(lines);
  const snapshot = await readGlobalMemory({ root });
  assert.equal(snapshot.totalEdits, 2100, 'every edit counts even though only the tail is returned');
  assert.ok(snapshot.records.length <= 2000);
});

test('a project reports how many files it really touched, beyond the row cap', async () => {
  const lines = [];
  for (let i = 0; i < 45; i += 1) lines.push(record({ path: `src/file-${i}.ts` }));
  const root = fixture(lines);
  const snapshot = await readGlobalMemory({ root });
  const project = snapshot.projects[0];
  assert.equal(project.files.length, 40, 'the panel only renders a slice');
  assert.equal(project.fileTotal, 45, 'but the count is the real one');
  assert.equal(snapshot.totalFiles, 45);
});

test('two spellings of one workspace are one project', async () => {
  const root = fixture([
    record({ workspace: 'C:/work', path: 'a.ts' }),
    record({ workspace: 'C:/work/', path: 'b.ts' }),
    record({ workspace: process.platform === 'win32' ? 'c:/WORK' : 'C:/WORK', path: 'c.ts' }),
  ]);
  const snapshot = await readGlobalMemory({ root });
  assert.equal(snapshot.projects.length, 1, 'trailing separator (and drive-letter case on Windows) must not split a project');
  assert.equal(snapshot.projects[0].edits, 3);
  assert.equal(snapshot.projects[0].fileTotal, 3);
});
