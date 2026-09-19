/**
 * analysisBudget.test.ts — 分析预算与阈值深合并
 *
 * 直接测试 applyFileBudget / mergeThresholds 的确定性语义，避免工具注册
 * 动态调用路径干扰；同时验证复杂度分析器仍能处理预算后的文件列表。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyFileBudget, mergeThresholds } from '../src/analysis/tools.js';
import { analyzeProject, DEFAULT_THRESHOLDS } from '../src/analysis/complexity.js';

const SAMPLE = `export function tangled(a: number, b: number): number {
  let out = 0;
  for (let i = 0; i < a; i++) {
    if (i % 2 === 0) { out += b; } else if (i % 3 === 0) { out -= b; } else { out += 1; }
  }
  switch (out % 4) {
    case 0: out += 2; break;
    case 1: out -= 2; break;
    case 2: out *= 2; break;
    default: out = out && out ? out : 1;
  }
  return out ? out : (a && b ? a + b : 0);
}
`;

test('file budget sorts deterministically and reports truncation', () => {
  const budget = applyFileBudget(['z.ts', 'a.ts', 'a.ts', 'm.ts', 'b.ts'], 3);
  assert.deepEqual(budget.files, ['a.ts', 'b.ts', 'm.ts']);
  assert.equal(budget.total, 4);
  assert.equal(budget.truncated, true);

  const untruncated = applyFileBudget(['b.ts', 'a.ts'], 10);
  assert.deepEqual(untruncated.files, ['a.ts', 'b.ts']);
  assert.equal(untruncated.total, 2);
  assert.equal(untruncated.truncated, false);
});

test('threshold merge keeps default sibling keys while applying nested overrides', () => {
  const mergedResult = mergeThresholds(
    DEFAULT_THRESHOLDS as unknown as Record<string, unknown>,
    { cyclomatic: { high: 8, bogus: 1 }, notAKey: 5, nesting: 'bad' },
  );
  const merged = mergedResult.merged as unknown as typeof DEFAULT_THRESHOLDS;

  assert.equal(merged.cyclomatic.high, 8);
  // 深合并而不是用部分对象覆盖整个 cyclomatic
  assert.equal(merged.cyclomatic.moderate, DEFAULT_THRESHOLDS.cyclomatic.moderate);
  assert.equal(merged.cyclomatic.critical, DEFAULT_THRESHOLDS.cyclomatic.critical);
  assert.equal(merged.nesting.high, DEFAULT_THRESHOLDS.nesting.high);
  assert.deepEqual(mergedResult.ignored.sort(), ['cyclomatic.bogus', 'nesting', 'notAKey']);
});

test('budgeted complexity analysis processes the selected source files', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'analysis-budget-test-'));
  try {
    await mkdir(join(ws, 'src'), { recursive: true });
    for (const name of ['one.ts', 'two.ts', 'three.ts']) {
      await writeFile(join(ws, 'src', name), SAMPLE);
    }

    const budget = applyFileBudget(['src/three.ts', 'src/one.ts', 'src/two.ts'], 2);
    const result = await analyzeProject(budget.files, ws, DEFAULT_THRESHOLDS);
    assert.equal(budget.truncated, true);
    assert.equal(result.totalFiles, 2);
    assert.equal(result.totalFunctions, 2);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
