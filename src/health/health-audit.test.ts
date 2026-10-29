/**
 * health/health-audit.test.ts — 分析器失败必须进 warnings
 *
 * 旧实现把复杂度/异味/安全扫描的异常一律 catch 成 0，于是「分析器全挂」与
 * 「项目零问题」在报告里长得一模一样（分数都是 100）。这里把三个分析器
 * 分别替换成抛错的桩，断言 collector 既不崩、也不假装一切正常。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../analysis/complexity.js', () => ({
  DEFAULT_THRESHOLDS: {},
  analyzeProject: async () => { throw new Error('complexity exploded'); },
}));
vi.mock('../analysis/smells.js', () => ({
  DEFAULT_SMELL_THRESHOLDS: {},
  analyzeProject: async () => { throw new Error('smells exploded'); },
}));
vi.mock('../audit/security-scanner.js', () => ({
  scanSecurity: async (file: string) => {
    if (file.endsWith('boom.ts')) throw new Error('scanner exploded');
    return { issues: [], summary: { critical: 0, high: 0, medium: 0, low: 0 } };
  },
}));

const { HealthCollector } = await import('./collector.js');

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'health-audit-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'ok.ts'), 'export const ok = 1;\n');
  writeFileSync(join(root, 'src', 'boom.ts'), 'export const boom = 1;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('analyzer failures become warnings', () => {
  it('complexity/smells failures are reported, not scored as zero problems', async () => {
    const snapshot = await new HealthCollector().collect(root, { skipSecurity: true });
    const text = (snapshot.warnings ?? []).join('\n');
    expect(text).toContain('复杂度分析失败');
    expect(text).toContain('complexity exploded');
    expect(text).toContain('异味分析失败');
    expect(text).toContain('smells exploded');
    // 指标仍是 0（没有更好的数据），但快照明确标注了它不代表真实情况。
    expect(snapshot.metrics.avgComplexity).toBe(0);
    expect(snapshot.metrics.codeSmells).toBe(0);
  });

  it('a security scan failure on one file is counted and named', async () => {
    const snapshot = await new HealthCollector().collect(root, { skipAnalyzers: true });
    const text = (snapshot.warnings ?? []).join('\n');
    expect(text).toContain('1 个文件安全扫描失败');
  });

  it('a clean run has no warnings at all', async () => {
    const clean = mkdtempSync(join(tmpdir(), 'health-audit-clean-'));
    try {
      writeFileSync(join(clean, 'ok.ts'), 'export const ok = 1;\n');
      const snapshot = await new HealthCollector().collect(clean, { skipAnalyzers: true });
      expect(snapshot.warnings).toBeUndefined();
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
});
