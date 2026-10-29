/**
 * health/tools.ts — 健康度仪表板 CLI 工具注册
 */

import { defineTool } from '../tools/define.js';
import type { ToolResult } from '../tools/types.js';
import { HealthCollector } from './collector.js';
import { HealthStore } from './store.js';

/** 采集并持久化一份额健康快照。 */
export const healthSnapshotTool = defineTool({
  name: 'health_snapshot',
  description: '采集项目健康快照（规模/复杂度/安全/异味/测试比例 + 结构/安全/测试纪律分数）并写入 .aicode/health 历史。',
  risk: 'read',
  input: {
    skipSecurity: { type: 'boolean', description: '跳过安全扫描以加速采集（安全分按 0 问题计）', optional: true },
    skipAnalyzers: { type: 'boolean', description: '只统计规模指标，不跑复杂度/异味分析', optional: true },
  },
  examples: [{ input: { skipSecurity: false, skipAnalyzers: false }, output: '返回本次快照的指标与分数' }],

  async execute(input, context): Promise<ToolResult> {
    try {
      const collector = new HealthCollector();
      const snapshot = await collector.collect(context.cwd, {
        skipSecurity: input.skipSecurity === true,
        skipAnalyzers: input.skipAnalyzers === true,
      });

      const store = new HealthStore();
      const count = await store.append(context.cwd, snapshot);

      const lines = [
        '健康快照 ' + snapshot.id + ' 已采集（历史共 ' + count + ' 份）',
        '综合: ' + snapshot.scores.overall + '/100（结构 ' + snapshot.scores.structure +
          ' · 安全 ' + snapshot.scores.security + ' · 测试纪律 ' + snapshot.scores.testDiscipline + '）',
        '指标: ' + snapshot.metrics.sourceFiles + ' 源文件, ' + snapshot.metrics.testFiles +
          ' 测试文件, ' + snapshot.metrics.linesOfCode + ' 行, 测试比 ' + snapshot.metrics.testRatio + '%',
        '质量: 平均复杂度 ' + snapshot.metrics.avgComplexity + ', 风险函数 ' + snapshot.metrics.riskyFunctions +
          ', 安全问题 ' + snapshot.metrics.securityIssues + ', 异味 ' + snapshot.metrics.codeSmells,
      ];
      // 采集不全时分数只是下界。放在同一段输出里，agent 与用户都不会把它当满分。
      if (snapshot.warnings && snapshot.warnings.length > 0) {
        lines.push('', '采集不完整（分数只代表已看到的部分）:');
        for (const warning of snapshot.warnings) lines.push('  - ' + warning);
      }

      return { ok: true, output: lines.join('\n'), data: { snapshot } };
    } catch (error) {
      return { ok: false, output: '快照采集失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

/** 查看最新快照与趋势报告。 */
export const healthReportTool = defineTool({
  name: 'health_report',
  description: '项目健康报告：最新快照分数 + 指标趋势（改善/恶化/稳定）+ 中文摘要。至少两份快照才有趋势。',
  risk: 'read',
  input: {},
  examples: [{ input: {}, output: '返回最新分数、趋势和摘要' }],

  async execute(_input, context): Promise<ToolResult> {
    try {
      const store = new HealthStore();
      const report = await store.buildReport(context.cwd);

      return {
        ok: true,
        output: report.summary.join('\n'),
        data: { report },
      };
    } catch (error) {
      return { ok: false, output: '报告生成失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

/** 清空健康历史（重新开始记录）。 */
export const healthClearTool = defineTool({
  name: 'health_clear_history',
  description: '清空项目健康快照历史（.aicode/health/history.json）。不影响源代码。',
  risk: 'write',
  input: {},
  examples: [{ input: {}, output: '历史已清空' }],

  async execute(_input, context): Promise<ToolResult> {
    const store = new HealthStore();
    await store.clear(context.cwd);
    return { ok: true, output: '健康历史已清空。' };
  },
});

export const healthTools = [healthSnapshotTool, healthReportTool, healthClearTool];
