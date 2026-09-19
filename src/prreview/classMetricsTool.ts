import type { ToolDefinition } from '../tools/types.js';
import { analyzeWorkspaceClasses, type ClassMetric } from './classMetrics.js';

function fmtClass(c: ClassMetric): string {
  const labels = [
    `${c.methodCount} 方法`,
    `${c.propertyCount} 属性`,
    `${c.getterCount} getter`,
    `${c.setterCount} setter`,
    `${c.linesOfCode} 行`,
  ];
  const vis = `pub=${c.publicMembers} priv=${c.privateMembers} prot=${c.protectedMembers}`;
  const ext = c.extends ? ` extends ${c.extends}` : '';
  const impl = c.implementsCount > 0 ? ` implements ${c.implementsCount}` : '';
  return `- \`${c.className}\` (${c.file}:${c.line}) — ${labels.join(', ')}; ${vis}${ext}${impl}`;
}

export const classMetricsTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
  topN: number;
}> = {
  name: 'class_metrics',
  description: '类级质量度量：方法/属性/getter/setter 数量、可见性分布、implements 数、大类清单',
  inputHint: '{ "pattern": "src/**/*.{ts,tsx}", "maxFiles": 400, "topN": 15 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    return {
      pattern: typeof r.pattern === 'string' && r.pattern.trim() ? r.pattern.trim() : 'src/**/*.{ts,tsx}',
      maxFiles: typeof r.maxFiles === 'number' && r.maxFiles > 0 ? Math.floor(r.maxFiles) : 400,
      topN: typeof r.topN === 'number' && r.topN > 0 ? Math.floor(r.topN) : 15,
    };
  },

  async execute(input, context) {
    const report = await analyzeWorkspaceClasses(context.workspaceRoot, input.pattern, input.maxFiles);
    const lines: string[] = [
      `## 类级度量报告（${report.scannedFiles} 个文件 / ${report.totalClasses} 个类）`,
      '',
      `### 方法+属性最多的 Top ${input.topN}`,
      ...report.largest.slice(0, input.topN).map(fmtClass),
    ];
    if (report.mostImplemented.length > 0 && report.mostImplemented[0]!.implementsCount > 0) {
      lines.push('', `### 实现接口最多的 Top ${input.topN}`);
      for (const c of report.mostImplemented.slice(0, input.topN)) {
        if (c.implementsCount > 0) lines.push(fmtClass(c));
      }
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const classMetricsTools = [classMetricsTool];
