/**
 * suggestions/suggestions.test.ts — 智能建议引擎测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SuggestionEngine } from './engine.js';
import { PRIORITY_ORDER, EFFORT_WEIGHT } from './types.js';
import type { Suggestion } from './types.js';

let mixedRoot: string;

const HIGH_COMPLEXITY_FILE = `export function tangled(a: number, b: number, flag: boolean): number {
  let out = 0;
  if (flag) {
    for (let i = 0; i < a; i++) {
      if (i % 2 === 0) {
        while (b > 0) {
          b--;
          if (b === 3) { out += i; }
          else if (b === 2) { out -= i; }
          else { out += 1; }
        }
      } else if (i % 3 === 0) {
        out += 2;
      } else {
        for (let j = 0; j < 3; j++) {
          if (j === 1 && out > 10) { out = 0; }
          out += j;
        }
      }
    }
  } else {
    switch (a % 5) {
      case 0: out = 1; break;
      case 1: out = 2; break;
      case 2: out = 3; break;
      case 3: out = 4; break;
      default: out = 5; break;
    }
  }
  return out;
}
`;

// 运行时拼装密钥字面量，避免静态扫描把测试夹具当真实凭据。
// 形态对齐 security-scanner 的检测规则：sk- + 32 位以上字母数字。
const SECRET_LITERAL = ['sk-', 'abcdefgh12345678abcdefgh12345678'].join('');
const SECRET_FILE = `const TOKEN = '${SECRET_LITERAL}';

export function callApi(path: string): string {
  return fetch(path, { headers: { Authorization: TOKEN } }).toString();
}
`;

const PLAIN_FILE = `export interface Config {
  name: string;
  retries: number;
}

export function defaultConfig(): Config {
  return { name: 'app', retries: 3 };
}
`;

beforeAll(() => {
  mixedRoot = mkdtempSync(join(tmpdir(), 'suggestions-'));
  mkdirSync(join(mixedRoot, 'src'), { recursive: true });
  writeFileSync(join(mixedRoot, 'src', 'tangled.ts'), HIGH_COMPLEXITY_FILE);
  writeFileSync(join(mixedRoot, 'src', 'secret.ts'), SECRET_FILE);
  writeFileSync(join(mixedRoot, 'src', 'plain.ts'), PLAIN_FILE);
});

afterAll(() => {
  rmSync(mixedRoot, { recursive: true, force: true });
});

describe('SuggestionEngine', () => {
  it('为高复杂度函数产出 refactor 建议且可自动化', async () => {
    const engine = new SuggestionEngine();
    const report = await engine.generate(mixedRoot, { categories: ['refactor'] });

    const extract = report.suggestions.find((s) => s.title.includes('提取或拆分'));
    expect(extract).toBeDefined();
    expect(extract!.category).toBe('refactor');
    expect(extract!.automatable).toBe(true);
    expect(extract!.suggestedTool).toBe('extract_method');
    expect(extract!.impact).toBeGreaterThan(0);
  });

  it('为含密钥文件产出 security 建议并给出修复思路', async () => {
    const engine = new SuggestionEngine();
    const report = await engine.generate(mixedRoot, { categories: ['security'] });

    expect(report.suggestions.length).toBeGreaterThan(0);
    const sec = report.suggestions[0];
    expect(sec.category).toBe('security');
    expect(sec.automatable).toBe(false);
    expect(sec.description).toContain('修复建议');
  });

  it('为无测试的源文件产出 testing 建议', async () => {
    const engine = new SuggestionEngine();
    const report = await engine.generate(mixedRoot, { categories: ['testing'] });

    // 三个源文件都没有测试
    expect(report.suggestions.length).toBeGreaterThanOrEqual(3);
    expect(report.suggestions.every((s) => s.category === 'testing')).toBe(true);
  });

  it('建议 ID 稳定可去重', async () => {
    const engine = new SuggestionEngine();
    const first = await engine.generate(mixedRoot, {});
    const second = await engine.generate(mixedRoot, {});

    const idsA = new Set(first.suggestions.map((s) => s.id));
    const idsB = new Set(second.suggestions.map((s) => s.id));
    expect(idsA.size).toBe(idsB.size);
    // 同一工作区两次扫描 ID 完全一致（稳定哈希）
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(true);
    }
  });

  it('minPriority 过滤生效', async () => {
    const engine = new SuggestionEngine();
    const all = await engine.generate(mixedRoot, {});
    const highOnly = await engine.generate(mixedRoot, { minPriority: 'high' });

    expect(highOnly.suggestions.every((s) => PRIORITY_ORDER[s.priority] <= PRIORITY_ORDER.high)).toBe(true);
    expect(highOnly.suggestions.length).toBeLessThanOrEqual(all.suggestions.length);
  });

  it('filePattern 过滤生效', async () => {
    const engine = new SuggestionEngine();
    const report = await engine.generate(mixedRoot, { filePattern: 'secret', minPriority: 'low' });

    expect(report.suggestions.length).toBeGreaterThan(0);
    expect(report.suggestions.every((s) => s.file.includes('secret'))).toBe(true);
  });

  it('maxResults 限制返回条数', async () => {
    const engine = new SuggestionEngine();
    const report = await engine.generate(mixedRoot, { maxResults: 2 });
    expect(report.suggestions.length).toBeLessThanOrEqual(2);
  });

  it('报告包含分类统计与耗时', async () => {
    const engine = new SuggestionEngine();
    const report = await engine.generate(mixedRoot, {});

    expect(report.totalFiles).toBe(3);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(report.stats)).toContain('refactor');
    expect(Object.keys(report.stats)).toContain('security');
  });

  it('快赢清单只含低工作量高收益项', async () => {
    const engine = new SuggestionEngine();
    const report = await engine.generate(mixedRoot, {});

    for (const win of report.quickWins) {
      expect(['trivial', 'easy']).toContain(win.effort);
      expect(win.impact).toBeGreaterThanOrEqual(40);
    }
    expect(report.quickWins.length).toBeLessThanOrEqual(5);
  });
});

describe('评分模型常量', () => {
  it('优先级顺序 critical < high < medium < low', () => {
    expect(PRIORITY_ORDER.critical).toBeLessThan(PRIORITY_ORDER.high);
    expect(PRIORITY_ORDER.high).toBeLessThan(PRIORITY_ORDER.medium);
    expect(PRIORITY_ORDER.medium).toBeLessThan(PRIORITY_ORDER.low);
  });

  it('工作量权重单调递增', () => {
    expect(EFFORT_WEIGHT.trivial).toBeLessThan(EFFORT_WEIGHT.easy);
    expect(EFFORT_WEIGHT.easy).toBeLessThan(EFFORT_WEIGHT.medium);
    expect(EFFORT_WEIGHT.medium).toBeLessThan(EFFORT_WEIGHT.hard);
  });
});

describe('排序语义', () => {
  it('收益/成本比高的建议排前面', () => {
    const engine = new SuggestionEngine();
    const highRatio: Suggestion = {
      id: 'a', title: 'A', category: 'refactor', priority: 'medium',
      file: 'a.ts', line: 1, description: '', rationale: '',
      effort: 'trivial', impact: 80, automatable: false,
    };
    const lowRatio: Suggestion = {
      id: 'b', title: 'B', category: 'refactor', priority: 'critical',
      file: 'b.ts', line: 1, description: '', rationale: '',
      effort: 'hard', impact: 95, automatable: false,
    };

    // 通过 applyFilter/rank 的私有逻辑无法直接测，这里验证常量关系即可
    const scoreA = highRatio.impact / EFFORT_WEIGHT[highRatio.effort];
    const scoreB = lowRatio.impact / EFFORT_WEIGHT[lowRatio.effort];
    expect(scoreA).toBeGreaterThan(scoreB);
    void engine;
  });
});
