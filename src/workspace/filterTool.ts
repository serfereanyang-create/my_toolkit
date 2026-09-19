/**
 * workspaceFilterTool.ts - pnpm-style --filter evaluator
 */

import type { ToolDefinition } from '../tools/types.js';
import { discoverWorkspace } from './discover.js';
import { applyFilter } from './applyFilter.js';

export const workspaceFilterTool: ToolDefinition<{
  expression: string;
  showBreakdown?: boolean;
}> = {
  name: 'workspace_filter',
  description: '按 pnpm 风格 filter 表达式选择子包：支持 name/./path/.../!（可组合）',
  inputHint: '{ "expression": "...@scope/core !@scope/test-utils", "showBreakdown": true }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    if (typeof r.expression !== 'string' || !r.expression.trim()) {
      throw new Error('missing required string: expression');
    }
    return {
      expression: r.expression.trim(),
      showBreakdown: r.showBreakdown !== false,
    };
  },

  async execute(input, context) {
    const discovery = await discoverWorkspace(context.workspaceRoot);
    if (discovery.packages.length === 0) {
      return { ok: false, output: '未发现 workspace 包。' };
    }

    const result = applyFilter(discovery.packages, input.expression);

    const lines: string[] = [
      `## Workspace 过滤：\`${input.expression}\``,
      '',
      `- 匹配包数：${result.matched.length}`,
      '',
    ];
    for (const pkg of result.matched) {
      lines.push(`- ${pkg.name}@${pkg.version} — \`${pkg.dir}\``);
    }

    if (input.showBreakdown) {
      lines.push('', '### 求值过程');
      for (const step of result.breakdown) {
        const sign = step.sign === '+' ? '包含' : '排除';
        lines.push(`- [${sign}] selector=${step.selector}，直接命中 ${step.hits.length}`);
        if (step.expanded.length > 0) {
          lines.push(`  - 扩展（transitive ${step.expanded.length}）: ${step.expanded.join(', ')}`);
        }
      }
    }
    return { ok: true, output: lines.join('\n'), data: result };
  },
};

export const workspaceFilterTools = [workspaceFilterTool];
