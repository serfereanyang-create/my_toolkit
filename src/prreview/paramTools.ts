/**
 * paramTools.ts - Function signature / parameter analysis tool registration.
 */

import type { ToolDefinition } from '../tools/types.js';
import { analyzeWorkspaceSignatures, type FunctionSigInfo } from './paramAnalysis.js';

function fmtFn(f: FunctionSigInfo): string {
  return `- \`${f.name}\` (${f.file}:${f.line}) — ${f.paramCount} 参数${f.hasReturnType ? '' : ', 缺返回值类型'}${f.isAsync ? ', async' : ''}`;
}

export const paramReportTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
  topN: number;
}> = {
  name: 'function_signature_report',
  description: '汇总函数签名特征：参数分布直方图、参数过多、缺失返回类型',
  inputHint: '{ "pattern": "src/**/*.{ts,tsx}", "maxFiles": 500, "topN": 15 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      pattern: typeof record.pattern === 'string' && record.pattern.trim()
        ? record.pattern.trim()
        : 'src/**/*.{ts,tsx}',
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0 ? Math.floor(record.maxFiles) : 500,
      topN: typeof record.topN === 'number' && record.topN > 0 ? Math.floor(record.topN) : 15,
    };
  },

  async execute(input, context) {
    const report = await analyzeWorkspaceSignatures(context.workspaceRoot, input.pattern, input.maxFiles);
    const lines: string[] = [
      `## 函数签名分析（${report.scannedFiles} 文件 / ${report.totalFunctions} 函数）`,
      '',
      '### 参数数分布（0..6+）',
    ];
    report.paramHistogram.forEach((count, params) => {
      const label = params === 6 ? '6+' : String(params);
      lines.push(`- ${label} 参数: ${count} 个`);
    });

    if (report.manyParams.length > 0) {
      lines.push('', `### 参数 ≥5 的函数（Top ${input.topN}）`);
      for (const f of report.manyParams.slice(0, input.topN)) lines.push(fmtFn(f));
    }
    if (report.missingReturnType.length > 0) {
      lines.push('', `### 未声明返回类型（Top ${input.topN}，共 ${report.missingReturnType.length}）`);
      for (const f of report.missingReturnType.slice(0, input.topN)) lines.push(fmtFn(f));
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const paramTools = [paramReportTool];
