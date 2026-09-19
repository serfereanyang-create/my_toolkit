import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditStructure } from '../src/analysis/structureAudit.js';

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'struct-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(root, 'src', 'big.ts'), Array.from({ length: 900 }, () => 'const x = 1;').join('\n'), 'utf-8');
  await writeFile(join(root, 'src', 'WidgetFactory.ts'), 'export const x = 1;\n', 'utf-8');
  await writeFile(join(root, 'src', 'kebab-thing.ts'), 'export const y = 2;\n', 'utf-8');
  await writeFile(join(root, 'tests', 'orphan.test.ts'), "import { test } from 'node:test';\ntest('noop', () => {});\n", 'utf-8');
  await writeFile(join(root, 'src', 'paired.ts'), 'export const z = 3;\n', 'utf-8');
  await writeFile(join(root, 'tests', 'paired.test.ts'), "import { test } from 'node:test';\ntest('noop', () => {});\n", 'utf-8');
  return root;
}

test('auditStructure flags huge files, mixed naming and orphan tests', async () => {
  const root = await makeTree();
  try {
    const report = await auditStructure(root, { hugeFileLines: 800 });
    const kinds = new Set(report.issues.map((i) => i.kind));
    assert.ok(kinds.has('huge-file'), `期望 huge-file，实际 ${[...kinds].join(',')}`);
    assert.ok(kinds.has('mixed-naming'));
    assert.ok(kinds.has('orphan-test'));
    // paired.test.ts ↔ paired.ts 镜像存在，不应报孤儿
    const orphans = report.issues.filter((i) => i.kind === 'orphan-test');
    assert.equal(orphans.length, 1);
    assert.match(orphans[0]!.path, /orphan/);
    assert.ok(report.scannedFiles >= 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auditStructure is quiet on a clean small tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'struct-clean-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), 'export const ok = 1;\n', 'utf-8');
    const report = await auditStructure(root);
    assert.equal(report.issues.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
