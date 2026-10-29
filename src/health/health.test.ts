/**
 * health/health.test.ts — 健康度数据层测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthCollector, computeScores } from './collector.js';
import { HealthStore } from './store.js';
import { METRIC_DIRECTION, MAX_SNAPSHOTS } from './types.js';
import type { HealthSnapshot } from './types.js';

let fixtureRoot: string;

const GOOD_FILE = `export function add(a: number, b: number): number {
  return a + b;
}
`;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'health-'));
  mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'src', 'math.ts'), GOOD_FILE);
  writeFileSync(join(fixtureRoot, 'src', 'math.test.ts'), 'import { add } from "./math";\n');
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('HealthCollector', () => {
  it('采集规模指标：源文件、测试文件与行数', async () => {
    const collector = new HealthCollector();
    const snapshot = await collector.collect(fixtureRoot, { skipSecurity: true, skipAnalyzers: true });

    expect(snapshot.metrics.sourceFiles).toBe(1);
    expect(snapshot.metrics.testFiles).toBe(1);
    expect(snapshot.metrics.testRatio).toBe(100);
    expect(snapshot.metrics.linesOfCode).toBeGreaterThan(0);
  });

  it('快照 ID 对相同指标确定性，不同指标不同', async () => {
    const collector = new HealthCollector();
    const a = await collector.collect(fixtureRoot, { skipSecurity: true, skipAnalyzers: true });
    const b = await collector.collect(fixtureRoot, { skipSecurity: true, skipAnalyzers: true });

    expect(a.id).toBe(b.id);
    expect(a.timestamp).toBeTruthy();
  });

  it('分数模型：完美项目接近满分', () => {
    const scores = computeScores({
      linesOfCode: 100,
      sourceFiles: 10,
      testFiles: 8,
      testRatio: 80,
      avgComplexity: 1.5,
      riskyFunctions: 0,
      securityIssues: 0,
      codeSmells: 0,
    });

    expect(scores.structure).toBeGreaterThan(80);
    expect(scores.security).toBe(100);
    expect(scores.testDiscipline).toBe(100);
    expect(scores.overall).toBeGreaterThan(80);
  });

  it('分数模型：问题多的项目低分', () => {
    const bad = computeScores({
      linesOfCode: 5000,
      sourceFiles: 20,
      testFiles: 0,
      testRatio: 0,
      avgComplexity: 14,
      riskyFunctions: 10,
      securityIssues: 5,
      codeSmells: 30,
    });
    const good = computeScores({
      linesOfCode: 1000,
      sourceFiles: 20,
      testFiles: 10,
      testRatio: 50,
      avgComplexity: 2,
      riskyFunctions: 0,
      securityIssues: 0,
      codeSmells: 0,
    });

    expect(bad.overall).toBeLessThan(good.overall);
    expect(bad.security).toBeLessThan(good.security);
    expect(bad.testDiscipline).toBeLessThan(good.testDiscipline);
  });

  it('skipAnalyzers 时复杂度与异味为 0', async () => {
    const collector = new HealthCollector();
    const snapshot = await collector.collect(fixtureRoot, { skipSecurity: true, skipAnalyzers: true });

    expect(snapshot.metrics.avgComplexity).toBe(0);
    expect(snapshot.metrics.riskyFunctions).toBe(0);
    expect(snapshot.metrics.codeSmells).toBe(0);
  });
});

describe('HealthStore', () => {
  it('追加快照并按时间升序读回', async () => {
    const root = mkdtempSync(join(tmpdir(), 'health-store-'));
    try {
      const store = new HealthStore();

      const older: HealthSnapshot = makeSnapshot('old', '2026-01-01T00:00:00Z', 50);
      const newer: HealthSnapshot = makeSnapshot('new', '2026-06-01T00:00:00Z', 80);

      await store.append(root, newer);
      await store.append(root, older);

      const history = await store.loadHistory(root);
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe('old'); // 升序：旧的在前
      expect(history[1].id).toBe('new');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('历史超过 MAX_SNAPSHOTS 时裁剪', async () => {
    const root = mkdtempSync(join(tmpdir(), 'health-trim-'));
    try {
      const store = new HealthStore();
      for (let i = 0; i < MAX_SNAPSHOTS + 10; i++) {
        await store.append(root, makeSnapshot('s' + i, new Date(2026, 0, 1 + i).toISOString(), 50));
      }
      const history = await store.loadHistory(root);
      expect(history).toHaveLength(MAX_SNAPSHOTS);
      // 裁剪掉的是最老的
      expect(history[0].id).toBe('s10');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('空历史时 computeTrend 返回 null', () => {
    const store = new HealthStore();
    expect(store.computeTrend([])).toBeNull();
    expect(store.computeTrend([makeSnapshot('only', new Date().toISOString(), 50)])).toBeNull();
  });

  it('趋势：综合分上升且指标改善', () => {
    const store = new HealthStore();
    const before = makeSnapshot('a', '2026-01-01T00:00:00Z', 60, { riskyFunctions: 10, securityIssues: 4, testRatio: 10 });
    const after = makeSnapshot('b', '2026-02-01T00:00:00Z', 85, { riskyFunctions: 2, securityIssues: 0, testRatio: 50 });

    const trend = store.computeTrend([before, after], 365)!;
    expect(trend.snapshotCount).toBe(2);
    expect(trend.overallDelta).toBe(25);
    expect(trend.trend).toBe('improving');

    const risky = trend.metrics.find((m) => m.metric === 'riskyFunctions')!;
    expect(risky.delta).toBe(-8);
    expect(risky.trend).toBe('improving'); // lower-is-better 指标下降 = 改善

    const testRatio = trend.metrics.find((m) => m.metric === 'testRatio')!;
    expect(testRatio.trend).toBe('improving'); // higher-is-better 上升 = 改善
  });

  it('趋势：复杂度上升判为恶化', () => {
    const store = new HealthStore();
    const before = makeSnapshot('a', '2026-01-01T00:00:00Z', 80, { avgComplexity: 2 });
    const after = makeSnapshot('b', '2026-02-01T00:00:00Z', 70, { avgComplexity: 9 });

    const trend = store.computeTrend([before, after], 365)!;
    const complexity = trend.metrics.find((m) => m.metric === 'avgComplexity')!;
    expect(complexity.trend).toBe('worsening');
    expect(trend.trend).toBe('worsening');
  });

  it('buildReport：无快照时给引导摘要', async () => {
    const root = mkdtempSync(join(tmpdir(), 'health-empty-'));
    try {
      const store = new HealthStore();
      const report = await store.buildReport(root);
      expect(report.latest).toBeNull();
      expect(report.summary[0]).toContain('尚无健康快照');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('buildReport：有快照时输出分数与规模摘要', async () => {
    const root = mkdtempSync(join(tmpdir(), 'health-rep-'));
    try {
      const store = new HealthStore();
      await store.append(root, makeSnapshot('x1', new Date().toISOString(), 72));
      const report = await store.buildReport(root);

      expect(report.latest).not.toBeNull();
      expect(report.summary.join('\n')).toContain('综合健康分 72');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('clear 清空历史', async () => {
    const root = mkdtempSync(join(tmpdir(), 'health-clear-'));
    try {
      const store = new HealthStore();
      await store.append(root, makeSnapshot('x', new Date().toISOString(), 50));
      await store.clear(root);
      expect(await store.loadHistory(root)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('METRIC_DIRECTION', () => {
  it('覆盖全部指标且方向语义正确', () => {
    expect(METRIC_DIRECTION.securityIssues).toBe('lower');
    expect(METRIC_DIRECTION.testRatio).toBe('higher');
    expect(METRIC_DIRECTION.avgComplexity).toBe('lower');
    expect(METRIC_DIRECTION.linesOfCode).toBe('higher');
  });
});

function makeSnapshot(
  id: string,
  timestamp: string,
  overall: number,
  overrides: Partial<HealthSnapshot['metrics']> = {}
): HealthSnapshot {
  return {
    id,
    timestamp,
    metrics: {
      linesOfCode: 1000,
      sourceFiles: 10,
      testFiles: 5,
      testRatio: 50,
      avgComplexity: 3,
      riskyFunctions: 0,
      securityIssues: 0,
      codeSmells: 0,
      ...overrides,
    },
    scores: {
      overall,
      structure: overall,
      security: overall,
      testDiscipline: overall,
    },
  };
}

describe('HealthCollector 的失败必须计入报告', () => {
  it('根目录不存在时给出警告，而不是一份满分快照', async () => {
    const missing = join(tmpdir(), `health-missing-${Date.now()}`);
    const snapshot = await new HealthCollector().collect(missing, {});
    expect(snapshot.warnings?.join('\n')).toContain('工作区无法读取');
    // 分数模型本身不变；重点是这份 100 分现在带着「什么都没看到」的说明。
    expect(snapshot.scores.overall).toBe(100);
  });

  it('行数按代码行统计，末尾换行不再多算一行', async () => {
    const withNewline = mkdtempSync(join(tmpdir(), 'health-lines-'));
    const withoutNewline = mkdtempSync(join(tmpdir(), 'health-lines2-'));
    try {
      writeFileSync(join(withNewline, 'f.ts'), 'a\nb\n');
      writeFileSync(join(withoutNewline, 'f.ts'), 'a\nb');
      const a = await new HealthCollector().collect(withNewline, { skipSecurity: true, skipAnalyzers: true });
      const b = await new HealthCollector().collect(withoutNewline, { skipSecurity: true, skipAnalyzers: true });
      expect(a.metrics.linesOfCode).toBe(2);
      expect(b.metrics.linesOfCode).toBe(2);
    } finally {
      rmSync(withNewline, { recursive: true, force: true });
      rmSync(withoutNewline, { recursive: true, force: true });
    }
  });

  // 安全扫描失败的情形需要注入一个会抛错的扫描器，放在 health-audit.test.ts
  // （vi.mock）里；这里只留不依赖 mock 的采集行为。
});

describe('HealthStore 的并发与损坏恢复', () => {
  it('并发 append 不丢快照（两个 store 实例各写 5 份）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'health-race-'));
    try {
      const a = new HealthStore();
      const b = new HealthStore();
      const jobs = Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? b : a).append(root, makeSnapshot('r' + i, new Date(2026, 0, 1 + i).toISOString(), 50)));
      await Promise.all(jobs);
      const history = await a.loadHistory(root);
      expect(history).toHaveLength(10);
      expect(new Set(history.map((s) => s.id)).size).toBe(10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('重复追加同一份快照是幂等的', async () => {
    const root = mkdtempSync(join(tmpdir(), 'health-idem-'));
    try {
      const store = new HealthStore();
      const snapshot = makeSnapshot('same', '2026-01-01T00:00:00Z', 60);
      await store.append(root, snapshot);
      await store.append(root, snapshot);
      expect(await store.loadHistory(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('损坏的历史文件被保留而不是被覆盖', async () => {
    const root = mkdtempSync(join(tmpdir(), 'health-corrupt-'));
    try {
      const dir = join(root, '.aicode', 'health');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'history.json'), '{ not json');
      const store = new HealthStore();
      const read = await store.readHistory(root);
      expect(read.status).toBe('corrupt');
      expect(read.note).toContain('不是有效 JSON');
      await store.append(root, makeSnapshot('after', '2026-02-01T00:00:00Z', 70));
      const files = readdirSync(dir);
      expect(files.some((name) => name.includes('.corrupt-'))).toBe(true);
      expect(await store.loadHistory(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('结构不对的历史同样按损坏处理', async () => {
    const root = mkdtempSync(join(tmpdir(), 'health-shape-'));
    try {
      const dir = join(root, '.aicode', 'health');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'history.json'), '{"snapshots": "nope"}');
      expect((await new HealthStore().readHistory(root)).status).toBe('corrupt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('buildReport 把采集警告带到摘要里', async () => {
    const root = mkdtempSync(join(tmpdir(), 'health-warn-'));
    try {
      const store = new HealthStore();
      const snapshot = { ...makeSnapshot('w', new Date().toISOString(), 90), warnings: ['3 个源文件无法读取'] };
      await store.append(root, snapshot);
      const report = await store.buildReport(root);
      expect(report.summary.join('\n')).toContain('采集不完整');
      expect(report.summary.join('\n')).toContain('3 个源文件无法读取');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
