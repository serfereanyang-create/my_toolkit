import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// `lib/ipc` reads `window.zcodeDesktop` at module scope, so the bridge has to
// exist before the component graph is imported.
vi.stubGlobal('window', {
  zcodeDesktop: {
    git: { status: async () => ({ ok: false }), log: async () => ({ ok: false }) },
    quality: { latest: async () => null, invoke: async () => ({ ok: false, error: 'not called' }) },
  },
});

const { QualityDashboard, scoreBreakdown, riskLabel, smellTypeLabel, QUALITY_TABS } = await import('./QualityDashboard');

const complexity = {
  totalFiles: 42,
  totalFunctions: 388,
  averageCyclomatic: 3.8,
  averageCognitive: 4.2,
  distribution: { low: 300, moderate: 61, high: 20, critical: 7 },
  hotspots: [],
  files: [],
};
const smells = {
  totalSmells: 14,
  byType: { 'long-function': 5, 'deep-nesting': 4 },
  bySeverity: { info: 1, minor: 6, major: 5, critical: 2 },
  topSmells: [],
};
const dependencies = {
  totalModules: 42,
  externalDependencies: 16,
  circularDependencies: [{ cycle: ['a.ts', 'b.ts', 'a.ts'], severity: 'major' }],
  godModules: [{ module: 'src/App.tsx', dependentCount: 23 }],
  isolatedModules: [],
};

describe('scoreBreakdown', () => {
  it('keeps a normal repository out of the F bucket', () => {
    // 388 个函数里有 7 个严重函数、14 个异味、1 组循环依赖。旧公式按条数扣分，
    // 这个仓库直接是 0 分 / F / 需要重构；按出现率算才是有意义的分数。
    const result = scoreBreakdown(complexity, smells, dependencies)!;
    expect(result).not.toBeNull();
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.score).toBeLessThanOrEqual(90);
    expect(result.complexity).toBeGreaterThan(0);
    expect(result.smells).toBeGreaterThan(0);
    expect(result.dependencies).toBeGreaterThan(0);
    // 明细之和就是被扣掉的分，面板上三个数字能对上总分。
    const deducted = result.complexity + result.smells + result.dependencies;
    expect(Math.abs(100 - deducted - result.score)).toBeLessThanOrEqual(1);
  });

  it('does not punish a repository just for being larger', () => {
    const doubled = {
      ...complexity,
      totalFiles: 84,
      totalFunctions: 776,
      distribution: { low: 600, moderate: 122, high: 40, critical: 14 },
    };
    expect(scoreBreakdown(doubled, { ...smells, bySeverity: { info: 2, minor: 12, major: 10, critical: 4 } }, {
      ...dependencies,
      totalModules: 84,
      circularDependencies: [dependencies.circularDependencies[0]!, dependencies.circularDependencies[0]!],
      godModules: [dependencies.godModules[0]!, dependencies.godModules[0]!],
    })!.score).toBe(scoreBreakdown(complexity, smells, dependencies)!.score);
  });

  it('drops the score when the density really is bad', () => {
    const dire = {
      ...complexity,
      totalFunctions: 20,
      distribution: { low: 1, moderate: 2, high: 5, critical: 12 },
    };
    expect(scoreBreakdown(dire, smells, dependencies)!.score).toBeLessThan(50);
  });

  it('reports no score until all three analyses are present', () => {
    expect(scoreBreakdown(complexity, smells, null)).toBeNull();
    expect(scoreBreakdown(null, null, null)).toBeNull();
  });

  it('refuses to score a scope with no analyzable function', () => {
    // 0 个函数时“100 分 / A 优秀”是编出来的：没有分母就不给分数。
    const nothing = {
      ...complexity,
      totalFunctions: 0,
      distribution: { low: 0, moderate: 0, high: 0, critical: 0 },
    };
    expect(scoreBreakdown(nothing, { ...smells, totalSmells: 0, bySeverity: { info: 0, minor: 0, major: 0, critical: 0 } }, dependencies)).toBeNull();
  });
});

describe('label helpers', () => {
  it('localises severities instead of leaking detector ids', () => {
    expect(riskLabel('critical')).toBe('严重');
    expect(riskLabel('major')).toBe('主要');
    expect(riskLabel('low')).toBe('低');
    expect(riskLabel('something-new')).toBe('something-new');
    expect(smellTypeLabel('long-function')).toBe('超长函数');
    expect(smellTypeLabel('unknown-kind')).toBe('unknown-kind');
  });
});

describe('QualityDashboard markup', () => {
  const render = () => renderToStaticMarkup(createElement(QualityDashboard, {
    visible: true,
    onClose: () => {},
    onOpenFile: () => {},
  }));

  it('shows a real empty state instead of a bare panel', () => {
    const html = render();
    expect(html).toContain('还没有分析结果');
    // 空结果时不该出现任何指标卡或“需要立即关注”的空告警框（样式块里的
    // 选择器名字会出现，所以只查元素本身）。
    expect(html).not.toContain('class="metric-card"');
    expect(html).not.toContain('需要立即关注');
  });

  it('keeps the tab strip and the analysis scope accessible', () => {
    const html = render();
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-selected="true"');
    for (const tab of QUALITY_TABS) expect(html).toContain(tab.label);
    expect(html).toContain('aria-label="分析范围（glob 模式，回车开始分析）"');
    expect(html).toContain('分析范围');
  });

  it('uses the app icon language, not emoji', () => {
    const html = render();
    // 上一版把 🚨 ✅ 🟢🟡🟠🔴 ⚠️ 当成图标用，和 lucide 线条图标不是一个体系。
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u);
    expect(html).toContain('<svg');
  });
});
