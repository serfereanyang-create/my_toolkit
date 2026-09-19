/**
 * reviewRules.ts — 启发式 PR 评审规则
 *
 * 每个规则接收结构化 FileDiff，产出按严重度分级的发现项。
 * 规则全部为纯字符串/结构匹配，不执行任何代码。
 */

import type { FileDiff } from './diffModel.js';
import { addedLineNumbers } from './diffModel.js';

export type ReviewSeverity = 'info' | 'warning' | 'critical';

export interface ReviewFinding {
  file: string;
  line?: number;
  severity: ReviewSeverity;
  rule: string;
  message: string;
}

export interface ReviewReport {
  findings: ReviewFinding[];
  summary: {
    files: number;
    added: number;
    removed: number;
    critical: number;
    warning: number;
    info: number;
  };
  score: number;
}

interface RuleContext {
  file: FileDiff;
  added: string[];
  lineFor: (addedIndex: number) => number | undefined;
}

interface Rule {
  id: string;
  severity: ReviewSeverity;
  check: (ctx: RuleContext) => Array<{ addedIndex: number; message: string }>;
}

function has(added: string[], needle: string): number[] {
  const hits: number[] = [];
  for (let idx = 0; idx < added.length; idx++) {
    if (added[idx]!.includes(needle)) hits.push(idx);
  }
  return hits;
}

const RULES: Rule[] = [
  {
    id: 'no-debugger',
    severity: 'critical',
    check: ({ added }) =>
      has(added, 'debugger;').map((addedIndex) => ({
        addedIndex,
        message: '遗留 debugger 语句，提交前必须移除',
      })),
  },
  {
    id: 'no-console-log',
    severity: 'warning',
    check: ({ added, ...rest }) =>
      rest.file.path.endsWith('.ts') || rest.file.path.endsWith('.tsx') || rest.file.path.endsWith('.js')
        ? added
            .map((line, idx) => ({ line, idx }))
            .filter(({ line }) => /\bconsole\.log\(/.test(line) && !line.trim().startsWith('//'))
            .map(({ idx }) => ({ addedIndex: idx, message: '新增 console.log，生产代码建议改用结构化日志' }))
        : [],
  },
  {
    id: 'no-todo-fixme',
    severity: 'info',
    check: ({ added }) =>
      added
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => /\b(TODO|FIXME|HACK)\b/.test(line))
        .map(({ idx, line }) => ({
          addedIndex: idx,
          message: `新增待办标记：${line.trim().slice(0, 60)}`,
        })),
  },
  {
    id: 'no-hardcoded-secret',
    severity: 'critical',
    check: ({ added }) =>
      added
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) =>
          /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{12,}['"]/i.test(line),
        )
        .map(({ idx }) => ({
          addedIndex: idx,
          message: '疑似硬编码密钥/口令，必须从环境变量读取',
        })),
  },
  {
    id: 'no-any-cast',
    severity: 'warning',
    check: ({ added, file }) =>
      file.path.endsWith('.ts') || file.path.endsWith('.tsx')
        ? added
            .map((line, idx) => ({ line, idx }))
            .filter(({ line }) => /\bas any\b/.test(line))
            .map(({ idx }) => ({ addedIndex: idx, message: '新增 as any 断言，弱化类型安全' }))
        : [],
  },
  {
    id: 'large-new-function',
    severity: 'info',
    check: ({ added }) => {
      // 简单启发：连续 40+ 行新增且无空行分隔，提示拆分
      const findings: Array<{ addedIndex: number; message: string }> = [];
      let run = 0;
      let runStart = 0;
      for (let idx = 0; idx < added.length; idx++) {
        const body = added[idx]!.slice(1);
        if (body.trim() === '' || body.trim() === '}' || body.trim() === '};') {
          if (run >= 40) {
            findings.push({ addedIndex: runStart, message: `连续新增约 ${run} 行，建议拆分为更小的函数` });
          }
          run = 0;
          runStart = idx + 1;
        } else {
          run += 1;
        }
      }
      return findings;
    },
  },
];

export function reviewFiles(files: FileDiff[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const file of files) {
    const added = file.hunks.flatMap((h) => h.changes.filter((c) => c[0] === '+'));
    const lineNos = addedLineNumbers(file);
    const ctx: RuleContext = {
      file,
      added,
      lineFor: (idx) => lineNos[idx],
    };
    for (const rule of RULES) {
      for (const hit of rule.check(ctx)) {
        findings.push({
          file: file.path,
          line: ctx.lineFor(hit.addedIndex),
          severity: rule.severity,
          rule: rule.id,
          message: hit.message,
        });
      }
    }
  }
  return findings;
}

/** 评分：100 起扣，critical -15 / warning -5 / info -1，下限 0 */
export function buildReport(files: FileDiff[], findings: ReviewFinding[]): ReviewReport {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  const score = Math.max(0, 100 - counts.critical * 15 - counts.warning * 5 - counts.info * 1);
  return {
    findings,
    summary: {
      files: files.length,
      added: files.reduce((n, f) => n + f.addedLines, 0),
      removed: files.reduce((n, f) => n + f.removedLines, 0),
      ...counts,
    },
    score,
  };
}

export function formatReport(report: ReviewReport): string {
  const { summary } = report;
  const lines = [
    `## PR 评审报告（评分 ${report.score}/100）`,
    '',
    `- 变更文件：${summary.files}，新增 ${summary.added} 行，删除 ${summary.removed} 行`,
    `- 发现：critical ${summary.critical} / warning ${summary.warning} / info ${summary.info}`,
    '',
  ];
  const bySeverity: ReviewSeverity[] = ['critical', 'warning', 'info'];
  for (const sev of bySeverity) {
    const group = report.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`### ${sev.toUpperCase()}（${group.length}）`);
    for (const f of group) {
      const loc = f.line != null ? `${f.file}:${f.line}` : f.file;
      lines.push(`- [${f.rule}] ${loc} — ${f.message}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
