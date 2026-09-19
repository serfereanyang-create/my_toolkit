/**
 * licenseTools.ts — License 合规扫描工具注册
 */

import type { ToolDefinition } from '../tools/types.js';
import { scanLicenses, summarizeLicenses } from './licenseScan.js';

export const scanLicensesTool: ToolDefinition<{ root?: string }> = {
  name: 'scan_licenses',
  description: '扫描 node_modules 中依赖的 License，输出 permissive/copyleft/unknown 分类与商用风险清单',
  inputHint: '{ "root": "<packages root，默认 workspaceRoot>" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      root: typeof record.root === 'string' && record.root.trim() ? record.root.trim() : undefined,
    };
  },

  async execute(input, context) {
    const root = input.root ?? context.workspaceRoot;
    const entries = await scanLicenses(root);
    if (entries.length === 0) {
      return {
        ok: true,
        output: 'node_modules 不存在或为空，请先运行 npm install。',
      };
    }
    const summary = summarizeLicenses(entries);
    const lines: string[] = [
      `## License 合规报告（共 ${summary.total} 项）`,
      '',
      `- Permissive: ${summary.permissive}`,
      `- Strong Copyleft: ${summary.copyleft}`,
      `- Weak Copyleft: ${summary.weakCopyleft}`,
      `- Public Domain: ${summary.publicDomain}`,
      `- Unknown/Unlicensed: ${summary.unknown}`,
      '',
    ];
    if (summary.risk.length > 0) {
      lines.push('### 商用风险提示');
      for (const e of summary.risk.slice(0, 50)) {
        lines.push(`- **${e.name}@${e.version}** — ${e.license}: ${e.risk}`);
      }
    }
    return { ok: true, output: lines.join('\n'), data: { summary, entries } };
  },
};

export const licenseTools = [scanLicensesTool];
