/**
 * envContractTool.ts — env_contract 工具注册。
 */

import type { ToolDefinition } from '../tools/types.js';
import { checkEnvContract } from './envContract.js';

export const envContractTool: ToolDefinition<{ pattern?: string }> = {
  name: 'env_contract',
  description: '核对 .env.example / 源码读取 / 本地 .env 三方键一致性（只看键名，绝不输出值）',
  inputHint: '{ "pattern": "src/**/*.{ts,tsx}" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    return { pattern: typeof r.pattern === 'string' && r.pattern.trim() ? r.pattern.trim() : undefined };
  },

  async execute(input, context) {
    const report = await checkEnvContract(context.workspaceRoot, input.pattern ?? 'src/**/*.{ts,tsx,js,mjs,cjs}');
    if (!report.exampleFile && report.codeKeys.length === 0) {
      return { ok: true, output: '没有 .env.example，源码也未读取任何环境变量——无需核对。' };
    }
    const lines: string[] = [
      `## 环境变量契约核对`,
      '',
      `- .env.example: ${report.exampleFile ?? '（缺失）'}（${report.exampleKeys.length} 个键）`,
      `- 源码读取: ${report.codeKeys.length} 个键`,
      `- 本地 .env: ${report.localKeys.length > 0 ? `${report.localKeys.length} 个键` : '（无此文件）'}`,
    ];
    if (report.dynamicReads.length > 0) {
      // Only key families / shapes — never a value. These cannot be checked
      // against .env.example because no concrete key name exists at scan time.
      lines.push(`- 动态读取（无法静态核对）: ${report.dynamicReads.length} 处`);
    }
    if (report.issues.length === 0) {
      lines.push('', '✓ 三方一致，没有契约问题。');
    } else {
      const byKind = new Map<string, typeof report.issues>();
      for (const issue of report.issues) {
        const bucket = byKind.get(issue.kind) ?? [];
        bucket.push(issue);
        byKind.set(issue.kind, bucket);
      }
      const label: Record<string, string> = {
        undocumented: '⚠ 代码使用但未在 example 声明',
        unused: 'example 声明但源码未读取',
        'missing-local': '本地 .env 缺少',
        'bad-name': '键名不符合 UPPER_SNAKE',
      };
      for (const [kind, items] of byKind) {
        lines.push('', `### ${label[kind] ?? kind}（${items.length}）`);
        for (const item of items.slice(0, 20)) {
          const where = item.sources && item.sources.length > 0 ? `（${item.sources.slice(0, 3).join(', ')}）` : '';
          lines.push(`- \`${item.key}\` — ${item.detail}${where}`);
        }
      }
    }
    if (report.dynamicReads.length > 0) {
      lines.push('', `### 动态读取（${report.dynamicReads.length}，只列形态）`);
      for (const entry of report.dynamicReads.slice(0, 20)) lines.push(`- ${entry}`);
    }
    return { ok: report.ok, output: lines.join('\n'), data: report };
  },
};

export const envContractTools = [envContractTool];
