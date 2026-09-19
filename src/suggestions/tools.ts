/**
 * suggestions/tools.ts — 智能建议 CLI 工具注册
 */

import { defineTool } from '../tools/define.js';
import type { ToolResult } from '../tools/types.js';
import { SuggestionEngine } from './engine.js';
import type { SuggestionCategory, SuggestionFilter, SuggestionPriority } from './types.js';

function formatSuggestion(s: {
  id: string;
  priority: string;
  category: string;
  title: string;
  file: string;
  line: number;
  effort: string;
  impact: number;
  automatable: boolean;
  suggestedTool?: string;
}): string {
  const auto = s.automatable ? '（可用 ' + s.suggestedTool + ' 自动执行）' : '';
  return '[' + s.priority + '][' + s.category + '] ' + s.title +
    '\n    ' + s.file + ':' + s.line + ' · 工作量 ' + s.effort + ' · 收益 ' + s.impact + auto;
}

/** 生成全工作区改进建议。 */
export const suggestImprovementsTool = defineTool({
  name: 'suggest_improvements',
  description: '智能代码建议：综合复杂度、代码异味、安全扫描与测试覆盖缺口，输出去重排序后的改进建议与快赢清单。',
  risk: 'read',
  input: {
    minPriority: { type: 'string', description: '最低优先级：critical / high / medium / low', optional: true },
    categories: { type: 'array', description: '限定类别：refactor / security / performance / testing / architecture', optional: true },
    filePattern: { type: 'string', description: '文件路径包含的子串过滤，如 "src/workflow"', optional: true },
    onlyAutomatable: { type: 'boolean', description: '只看可自动执行的建议', optional: true },
    maxResults: { type: 'number', description: '最多返回条数，默认 20', optional: true },
  },
  examples: [
    { input: { minPriority: 'high', maxResults: 10 }, output: '返回前 10 条高优先级建议' },
    { input: { onlyAutomatable: true }, output: '返回可由重构工具自动执行的建议' },
  ],

  async execute(input, context): Promise<ToolResult> {
    try {
      const filter: SuggestionFilter = {
        minPriority: input.minPriority as SuggestionPriority | undefined,
        categories: input.categories as SuggestionCategory[] | undefined,
        filePattern: input.filePattern,
        onlyAutomatable: input.onlyAutomatable === true,
        maxResults: input.maxResults ?? 20,
      };

      const engine = new SuggestionEngine();
      const report = await engine.generate(context.cwd, filter);

      if (report.suggestions.length === 0) {
        return { ok: true, output: '没有匹配过滤条件的建议。代码库状态良好或过滤过严。' };
      }

      const lines = [
        '改进建议（' + report.suggestions.length + ' 条，扫描 ' + report.totalFiles + ' 个文件，耗时 ' + report.durationMs + 'ms）:',
        '分类统计: ' + Object.entries(report.stats).filter(([, n]) => n > 0).map(([k, n]) => k + '=' + n).join(', '),
        '',
        ...report.suggestions.map((s, i) => (i + 1) + '. ' + formatSuggestion(s) + '\n    ID: ' + s.id),
      ];

      if (report.quickWins.length > 0) {
        lines.push('', '⚡ 快赢清单（高收益低成本）:');
        for (const s of report.quickWins) {
          lines.push('  ' + formatSuggestion(s));
        }
      }

      return { ok: true, output: lines.join('\n'), data: { report } };
    } catch (error) {
      return { ok: false, output: '建议生成失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

/** 快赢清单速查。 */
export const suggestQuickWinsTool = defineTool({
  name: 'suggest_quick_wins',
  description: '只返回快赢建议：工作量 trivial/easy 且收益 ≥40 的改进项，按收益/成本比排序。',
  risk: 'read',
  input: {},
  examples: [{ input: {}, output: '返回最多 5 条快赢建议' }],

  async execute(_input, context): Promise<ToolResult> {
    try {
      const engine = new SuggestionEngine();
      const report = await engine.generate(context.cwd, {});

      if (report.quickWins.length === 0) {
        return { ok: true, output: '当前没有明显的快赢机会。' };
      }

      const lines = ['⚡ 快赢建议 ' + report.quickWins.length + ' 条:', ''];
      for (const s of report.quickWins) {
        lines.push(formatSuggestion(s), '    ID: ' + s.id, '');
      }
      return { ok: true, output: lines.join('\n'), data: { quickWins: report.quickWins } };
    } catch (error) {
      return { ok: false, output: '快赢分析失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

export const suggestionTools = [suggestImprovementsTool, suggestQuickWinsTool];
