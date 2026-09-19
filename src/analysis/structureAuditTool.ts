/**
 * structureAuditTool.ts — structure_audit 工具注册。
 */

import type { ToolDefinition } from '../tools/types.js';
import { auditStructure } from './structureAudit.js';

export const structureAuditTool: ToolDefinition<{
  hugeFileLines?: number;
  maxDepth?: number;
  maxFiles?: number;
}> = {
  name: 'structure_audit',
  description: '项目结构健康审计：超大文件、目录过深/过挤、命名混用、测试镜像断裂、空目录',
  inputHint: '{ "hugeFileLines": 800, "maxDepth": 6, "maxFiles": 2000 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    const positive = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.floor(v) : undefined);
    return {
      hugeFileLines: positive(r.hugeFileLines),
      maxDepth: positive(r.maxDepth),
      maxFiles: positive(r.maxFiles),
    };
  },

  async execute(input, context) {
    const report = await auditStructure(context.workspaceRoot, {
      hugeFileLines: input.hugeFileLines,
      maxDepth: input.maxDepth,
      maxFiles: input.maxFiles,
    });
    if (report.issues.length === 0) {
      return {
        ok: true,
        output: `结构健康：扫描 ${report.scannedFiles} 个代码文件 / ${report.scannedDirs} 个目录，未发现问题。`,
      };
    }
    const lines: string[] = [
      `## 结构审计（${report.scannedFiles} 文件 / ${report.scannedDirs} 目录，${report.issues.length} 个问题）`,
      '',
      '### 分类',
    ];
    for (const kind of Object.keys(report.byKind).sort()) {
      lines.push(`- ${kind}: ${report.byKind[kind]}`);
    }
    lines.push('', '### 明细（按严重度，前 40）');
    for (const issue of report.issues.slice(0, 40)) {
      const stars = '★'.repeat(issue.severity);
      lines.push(`- [${stars}] ${issue.kind} — ${issue.path}: ${issue.detail}`);
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const structureAuditTools = [structureAuditTool];
