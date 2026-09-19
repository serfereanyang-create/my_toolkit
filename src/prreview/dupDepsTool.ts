import type { ToolDefinition } from '../tools/types.js';
import { detectDuplicateDeps } from './duplicateDeps.js';

export const dedupDepsTool: ToolDefinition<Record<string, never>> = {
  name: 'detect_duplicate_deps',
  description: '扫描 node_modules，检出被多次安装且版本不一致的依赖（可用于 dedupe/hoist 决策）',
  inputHint: '{} 直接运行',
  risk: 'read',

  validate(_input) {
    return {};
  },

  async execute(_input, context) {
    const report = await detectDuplicateDeps(context.workspaceRoot);
    if (report.groups.length === 0) {
      return {
        ok: true,
        output: `扫描 ${report.totalPackagesSeen} 个不同的包名，未发现多版本重复。`,
      };
    }
    const lines: string[] = [
      `## 重复依赖报告`,
      '',
      `- 包总数（unique names）: ${report.totalPackagesSeen}`,
      `- 出现多版本的包: ${report.multiVersionCount}`,
      '',
      '### 明细',
    ];
    for (const g of report.groups.slice(0, 30)) {
      lines.push(`- **${g.name}** (${g.versionCount} 个版本, ${g.occurrenceCount} 处安装)`);
      for (const [version, paths] of g.versions) {
        lines.push(`  - ${version}: ${paths.length} path`);
        for (const p of paths.slice(0, 3)) lines.push(`    - ${p}`);
      }
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const dupDepsTools = [dedupDepsTool];
