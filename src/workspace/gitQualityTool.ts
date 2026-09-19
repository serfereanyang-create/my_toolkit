/**
 * gitQualityTool.ts - git_quality 工具注册：提交历史品质报告。
 */

import type { ToolDefinition } from '../tools/types.js';
import { collectCommits, analyzeCommits } from './gitQuality.js';

export const gitQualityTool: ToolDefinition<{ maxCount?: number }> = {
  name: 'git_quality',
  description: '分析 git 提交历史品质：作者分布、revert/hotfix 比例、平均提交规模、时间分布、主题关键词',
  inputHint: '{ "maxCount": 500 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      maxCount: typeof record.maxCount === 'number' && record.maxCount > 0 ? Math.floor(record.maxCount) : 500,
    };
  },

  async execute(input, context) {
    let report;
    try {
      const commits = await collectCommits(context.workspaceRoot, { maxCount: input.maxCount });
      report = analyzeCommits(commits);
    } catch (err) {
      return {
        ok: false,
        output: `git log 读取失败: ${err instanceof Error ? err.message : String(err)}（当前目录可能不是 git 仓库）`,
      };
    }

    if (report.commitCount === 0) {
      return { ok: true, output: '没有提交记录可分析。' };
    }

    const dowNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const lines: string[] = [
      `## Git 品质报告（最近 ${report.commitCount} 次提交）`,
      '',
      `- 时间跨度: ${report.periodStart?.slice(0, 10)} → ${report.periodEnd?.slice(0, 10)}`,
      `- 平均提交规模: ${report.averageLinesPerCommit} 行`,
      `- revert 比例: ${(report.revert.ratio * 100).toFixed(1)}%（${report.revert.count} 次）`,
      `- hotfix 风格提交: ${(report.hotfixLike.ratio * 100).toFixed(1)}%（${report.hotfixLike.count} 次）`,
      '',
      '### 作者分布（Top 10）',
    ];
    for (const a of report.topAuthors) {
      lines.push(`- **${a.author}**: ${a.commits} 次提交（+${a.insertions} / -${a.deletions}）`);
    }
    lines.push('', '### 主题关键词');
    for (const kw of report.subjectKeywords.slice(0, 8)) {
      lines.push(`- ${kw.keyword}: ${kw.count}`);
    }
    const topDow = report.dowHistogram
      .map((count, idx) => ({ name: dowNames[idx] ?? '', count }))
      .sort((a, b) => b.count - a.count)[0];
    if (topDow && topDow.count > 0) {
      lines.push('', `### 活跃分布`);
      lines.push(`- 最活跃: ${topDow.name}（${topDow.count} 次提交）`);
    }
    lines.push('', '### 最大提交（Top 5）');
    for (const c of report.largestCommits.slice(0, 5)) {
      lines.push(`- ${c.hash} ${c.subject.slice(0, 50)}（${c.total} 行）`);
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const gitQualityTools = [gitQualityTool];
