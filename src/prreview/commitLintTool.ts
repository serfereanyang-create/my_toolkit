/**
 * commitLintTool.ts — commit_lint 工具：校验提交信息或审计历史。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../tools/types.js';
import { lintCommitMessage, lintHistory, CONVENTIONAL_TYPES } from './commitLint.js';

const execFileAsync = promisify(execFile);
const SUBJECT_DELIM = '@@YOYSUBJ@@';

function buildHistoryArgs(limit: number): string[] {
  const maxCount = `--max-count=${limit}`;
  const format = `--format=${SUBJECT_DELIM}%s`;
  return ['log', maxCount, '--no-merges', format];
}

export function parseHistorySubjects(stdout: string): string[] {
  return stdout
    .split(SUBJECT_DELIM)
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderIssues(issues: Array<{ level: string; rule: string; message: string }>): string[] {
  if (issues.length === 0) return ['  ✓ 规范通过'];
  return issues.map((i) => `  [${i.level}] ${i.rule}: ${i.message}`);
}

export const commitLintTool: ToolDefinition<{ title?: string; body?: string; auditHistory?: boolean; limit?: number }> = {
  name: 'commit_lint',
  description: `校验 Conventional Commits：传 title 检查单条；auditHistory 批量审计最近提交。type 可选：${CONVENTIONAL_TYPES.join('/')}`,
  inputHint: '{ "title": "feat(auth): 支持扫码登录" } 或 { "auditHistory": true, "limit": 50 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : undefined;
    const auditHistory = r.auditHistory === true;
    if (!title && !auditHistory) throw new Error('需要 title 或 auditHistory 之一');
    return {
      title,
      body: typeof r.body === 'string' ? r.body : undefined,
      auditHistory,
      limit: typeof r.limit === 'number' && r.limit > 0 ? Math.min(200, Math.floor(r.limit)) : 30,
    };
  },

  async execute(input, context) {
    if (input.title) {
      const result = lintCommitMessage(input.title, input.body);
      const lines = [
        `## 提交信息校验`,
        '',
        `- 标题: \`${result.header}\``,
        `- 结果: ${result.ok ? '✓ 通过' : '✗ 需修改'}`,
        ...renderIssues(result.issues.map((i) => ({ level: i.level, rule: i.rule, message: i.message }))),
      ];
      return { ok: true, output: lines.join('\n'), data: result };
    }

    let stdout = '';
    try {
      const res = await execFileAsync('git', buildHistoryArgs(input.limit ?? 30), {
        cwd: context.workspaceRoot,
        maxBuffer: 4 * 1024 * 1024,
      });
      stdout = res.stdout;
    } catch (err) {
      return { ok: false, output: `git log 读取失败: ${err instanceof Error ? err.message : String(err)}` };
    }

    const titles = parseHistorySubjects(stdout);
    if (titles.length === 0) {
      return { ok: true, output: '没有可审计的非 merge 提交。' };
    }
    const audit = lintHistory(titles);
    const lines: string[] = [
      `## 提交历史规范审计（最近 ${titles.length} 条）`,
      '',
      `- 错误 ${audit.errorCount} · 警告 ${audit.warningCount} · 通过率 ${(((titles.length - audit.results.filter((r) => !r.ok).length) / titles.length) * 100).toFixed(0)}%`,
      '',
    ];
    const bad = audit.results.filter((r) => !r.ok);
    if (bad.length === 0) {
      lines.push('✓ 全部通过规范。');
    } else {
      lines.push(`### 不合格（${bad.length}，前 20）`);
      for (const r of bad.slice(0, 20)) {
        lines.push(`- \`${r.header.slice(0, 70)}\``);
        for (const i of r.issues.filter((x) => x.level === 'error')) lines.push(`    [${i.level}] ${i.rule}: ${i.message}`);
      }
    }
    return { ok: true, output: lines.join('\n'), data: audit };
  },
};

export const commitLintTools = [commitLintTool];
