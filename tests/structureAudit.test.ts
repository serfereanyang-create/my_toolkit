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

/*
 * A test whose source is an Electron main-process .cjs was reported as a broken
 * mirror, because the candidate list only ever tried .ts/.tsx/.js and only ever
 * looked under src/. On a real repo that produced 23 false orphans out of 36 —
 * a report that buries the 13 genuine ones.
 */
test('a test whose source is a .cjs module is not an orphan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'struct-cjs-'));
  try {
    await mkdir(join(root, 'electron'), { recursive: true });
    await mkdir(join(root, 'tests'), { recursive: true });
    await writeFile(join(root, 'electron', 'agent-bridge.cjs'), 'module.exports = {};\n', 'utf-8');
    await writeFile(join(root, 'tests', 'agent-bridge.test.cjs'), "const { test } = require('node:test');\ntest('x', () => {});\n", 'utf-8');

    const report = await auditStructure(root);
    assert.deepEqual(report.issues.filter((i) => i.kind === 'orphan-test'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a test mirrors to a non-src source root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'struct-root-'));
  try {
    await mkdir(join(root, 'electron', 'nested'), { recursive: true });
    await mkdir(join(root, 'tests', 'nested'), { recursive: true });
    await writeFile(join(root, 'electron', 'nested', 'store.ts'), 'export const s = 1;\n', 'utf-8');
    await writeFile(join(root, 'tests', 'nested', 'store.test.ts'), "import { test } from 'node:test';\ntest('x', () => {});\n", 'utf-8');

    const report = await auditStructure(root);
    assert.deepEqual(report.issues.filter((i) => i.kind === 'orphan-test'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a genuinely orphaned test is still reported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'struct-real-'));
  try {
    await mkdir(join(root, 'electron'), { recursive: true });
    await mkdir(join(root, 'tests'), { recursive: true });
    // Source root exists, but nothing matches this stem anywhere.
    await writeFile(join(root, 'electron', 'workspace.cjs'), 'module.exports = {};\n', 'utf-8');
    await writeFile(join(root, 'tests', 'no-such-module.test.cjs'), "const { test } = require('node:test');\ntest('x', () => {});\n", 'utf-8');

    const report = await auditStructure(root);
    const orphans = report.issues.filter((i) => i.kind === 'orphan-test');
    assert.equal(orphans.length, 1);
    assert.match(orphans[0]!.path, /no-such-module/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
 * A cross-module behavioural test has no same-named source by design — it drives
 * a real module under a scenario name. Treating every stem mismatch as a broken
 * mirror flagged 12 such suites on this repo, burying the one real finding.
 */
test('a cross-module behavioural test is not an orphan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'struct-behaviour-'));
  try {
    await mkdir(join(root, 'electron'), { recursive: true });
    await mkdir(join(root, 'tests'), { recursive: true });
    await writeFile(join(root, 'electron', 'agent-bridge.cjs'), 'module.exports = { AgentBridge: class {} };\n', 'utf-8');
    // Name matches no source file, but it requires a real one.
    await writeFile(
      join(root, 'tests', 'coding-e2e.test.cjs'),
      "const { test } = require('node:test');\nconst { AgentBridge } = require('../electron/agent-bridge.cjs');\ntest('x', () => {});\n",
      'utf-8',
    );

    const report = await auditStructure(root);
    assert.deepEqual(report.issues.filter((i) => i.kind === 'orphan-test'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a test importing only builtins and a missing relative path is still an orphan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'struct-missing-'));
  try {
    await mkdir(join(root, 'tests'), { recursive: true });
    // The relative import points at a file that does not exist, so this is not
    // rescued by the behavioural-test rule.
    await writeFile(
      join(root, 'tests', 'ghost.test.cjs'),
      "const { test } = require('node:test');\nrequire('../electron/gone.cjs');\ntest('x', () => {});\n",
      'utf-8',
    );

    const report = await auditStructure(root);
    const orphans = report.issues.filter((i) => i.kind === 'orphan-test');
    assert.equal(orphans.length, 1);
    assert.match(orphans[0]!.path, /ghost/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
