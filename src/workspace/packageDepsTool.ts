/**
 * packageDepsTool.ts - Cross-package dependency consistency check tool.
 */

import type { ToolDefinition } from '../tools/types.js';
import { discoverWorkspace } from './discover.js';
import { analyzeWorkspaceDeps } from './packageDeps.js';

export const packageDepsTool: ToolDefinition<Record<string, never>> = {
  name: 'workspace_deps_check',
  description: '校验 workspace 中每个包的 import 是否与 package.json 声明一致（missing/undeclared/unused/dev-only）',
  inputHint: '{}',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    return {};
  },

  async execute(_input, context) {
    const discovery = await discoverWorkspace(context.workspaceRoot);
    if (discovery.packages.length === 0) {
      return { ok: true, output: '未检测到 workspace 包。' };
    }

    const report = await analyzeWorkspaceDeps(discovery.packages, context.workspaceRoot);
    const lines: string[] = [
      `## Workspace 依赖一致性（${report.packagesScanned} 包 / ${report.filesScanned} 个 import）`,
      '',
      '### 违规分类',
    ];
    if (report.violations.length === 0) {
      lines.push('- 未发现违规 ✓');
    } else {
      for (const kind of Object.keys(report.byKind).sort()) {
        lines.push(`- ${kind}: ${report.byKind[kind]}`);
      }
      lines.push('', '### 违规明细');
      for (const v of report.violations.slice(0, 50)) {
        lines.push(`- **[${v.kind}]** ${v.packageName} — ${v.depName}: ${v.message}`);
      }
      if (report.violations.length > 50) {
        lines.push(`- ... 还有 ${report.violations.length - 50} 条`);
      }
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const packageDepsTools = [packageDepsTool];
