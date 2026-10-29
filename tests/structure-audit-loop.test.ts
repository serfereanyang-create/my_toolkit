/**
 * structure-audit-loop.test.ts — 结构审计的目录遍历必须终止
 *
 * Windows 上 `pkg/loop -> 仓库根` 这类 junction 会让跟随链接的递归无限展开：
 * 实测一个小仓库被记成 128 个文件 / 128 个目录（121 个是环），并报出成堆
 * 假的 deep-dir。现在按真实路径（realpath）去重，同一物理目录只走一次。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditStructure } from '../src/analysis/structureAudit.js';

/**
 * 符号链接只有部分平台/权限允许；不允许时跳过（Windows 上 junction 通常可用）。
 */
async function tryCreateLoop(root: string): Promise<boolean> {
  try {
    await symlink(root, join(root, 'pkg', 'loop'), 'junction');
    return true;
  } catch {
    return false;
  }
}

test('junction loop pointing back at the root is visited once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'audit-loop-'));
  try {
    await writeFile(join(root, 'real.ts'), 'export const a = 1;\n');
    await mkdir(join(root, 'pkg'));
    await writeFile(join(root, 'pkg', 'x.ts'), 'export const b = 1;\n');

    const created = await tryCreateLoop(root);
    if (!created) {
      t.skip('当前环境不允许创建符号链接/junction');
      return;
    }

    const report = await auditStructure(root, { maxFiles: 5000 });

    assert.equal(report.scannedFiles, 2, `应只扫到 2 个源文件，实际 ${report.scannedFiles}`);
    assert.ok(report.scannedDirs <= 3, `目录数应 <= 3（根 + pkg + loop 本身），实际 ${report.scannedDirs}`);
    assert.equal(
      report.issues.filter((issue) => issue.path.includes('loop')).length,
      0,
      `不应出现 loop 下的伪目录问题：${JSON.stringify(report.issues.filter((i) => i.path.includes('loop')))}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nested real directories are still fully scanned (loop guard is not over-eager)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'audit-nest-'));
    await mkdir(join(root, 'pkg'));
  try {
    await mkdir(join(root, 'a', 'b', 'c'), { recursive: true });
    await writeFile(join(root, 'a', 'one.ts'), 'export const one = 1;\n');
    await writeFile(join(root, 'a', 'b', 'two.ts'), 'export const two = 2;\n');
    await writeFile(join(root, 'a', 'b', 'c', 'three.ts'), 'export const three = 3;\n');

    const created = await tryCreateLoop(root);
    if (!created) {
      t.skip('当前环境不允许创建符号链接/junction');
      return;
    }

    const report = await auditStructure(root, { maxFiles: 5000 });
    assert.equal(report.scannedFiles, 3, `应扫到 3 个源文件，实际 ${report.scannedFiles}`);
    assert.equal(
      report.issues.filter((issue) => issue.kind === 'deep-dir').length,
      0,
      `正常 3 层目录不应被判为 deep-dir：${JSON.stringify(report.issues)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** 保证 readFile 被用到（防止打包器把 import 当作无用而误删 fixture 校验）。 */
test('fixtures are readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'audit-read-'));
  try {
    await writeFile(join(root, 'x.ts'), 'export {};\n');
    assert.equal((await readFile(join(root, 'x.ts'), 'utf8')).trim(), 'export {};');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
