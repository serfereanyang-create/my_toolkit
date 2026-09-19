/**
 * reviewTools.ts — PR review 工具注册
 *
 * review_pr           : 解析结构化 diff → 启发式规则评审 + 评分报告
 * suggest_reviewers   : 基于 git 历史推荐评审人
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../tools/types.js';
import { parseUnifiedDiff } from './diffModel.js';
import { reviewFiles, buildReport, formatReport } from './reviewRules.js';
import { suggestReviewers } from './reviewers.js';

const execFileAsync = promisify(execFile);

async function collectDiffText(workspaceRoot: string, base?: string, head?: string): Promise<string> {
  const args = ['diff'];
  if (base && head) {
    args.push(`${base}...${head}`);
  } else if (base) {
    args.push(base);
  }
  args.push('--');
  const { stdout } = await execFileAsync('git', args, {
    cwd: workspaceRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

export const reviewPrTool: ToolDefinition<{
  base?: string;
  head?: string;
  diff?: string;
}> = {
  name: 'review_pr',
  description: '对 git diff 做启发式评审（debugger/console/密钥/as any/TODO/函数过长），输出评分报告',
  inputHint: '{ "base": "main", "head": "feature-x" } 或 { "diff": "<raw unified diff text>" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      base: typeof record.base === 'string' ? record.base : undefined,
      head: typeof record.head === 'string' ? record.head : undefined,
      diff: typeof record.diff === 'string' ? record.diff : undefined,
    };
  },

  async execute(input, context) {
    let diffText = input.diff;
    if (!diffText) {
      try {
        diffText = await collectDiffText(context.workspaceRoot, input.base, input.head);
      } catch (err) {
        return {
          ok: false,
          output: `无法获取 git diff: ${err instanceof Error ? err.message : String(err)}（也可直接传 diff 文本）`,
        };
      }
    }
    if (!diffText.trim()) {
      return { ok: true, output: 'diff 为空，无需评审。' };
    }

    const parsed = parseUnifiedDiff(diffText);
    if (parsed.files.length === 0) {
      return { ok: true, output: 'diff 中未解析出文件变更，可能不是 unified diff 格式。' };
    }
    const findings = reviewFiles(parsed.files);
    const report = buildReport(parsed.files, findings);
    return { ok: true, output: formatReport(report), data: report };
  },
};

export const suggestReviewersTool: ToolDefinition<{
  base?: string;
  head?: string;
  diff?: string;
  max?: number;
}> = {
  name: 'suggest_reviewers',
  description: '基于 git log 对变更文件推荐评审人（按文件覆盖度+提交数排序）',
  inputHint: '{ "base": "main", "head": "feature-x", "max": 5 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      base: typeof record.base === 'string' ? record.base : undefined,
      head: typeof record.head === 'string' ? record.head : undefined,
      diff: typeof record.diff === 'string' ? record.diff : undefined,
      max: typeof record.max === 'number' && record.max > 0 ? Math.floor(record.max) : 5,
    };
  },

  async execute(input, context) {
    let diffText = input.diff;
    if (!diffText) {
      try {
        diffText = await collectDiffText(context.workspaceRoot, input.base, input.head);
      } catch (err) {
        return {
          ok: false,
          output: `无法获取 git diff: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    if (!diffText.trim()) {
      return { ok: true, output: 'diff 为空，无法推荐评审人。' };
    }

    const parsed = parseUnifiedDiff(diffText);
    if (parsed.files.length === 0) {
      return { ok: true, output: 'diff 中未解析出文件变更。' };
    }

    const suggestions = await suggestReviewers(context.workspaceRoot, parsed.files, {
      maxSuggestions: input.max,
    });
    if (suggestions.length === 0) {
      return {
        ok: true,
        output: '没有可用的 git 历史信息（可能不在 git 仓库或文件从未提交）。',
      };
    }

    const lines = ['## 推荐评审人', ''];
    for (const s of suggestions) {
      lines.push(`- **${s.author}**：覆盖 ${s.touchedFiles} 个变更文件，相关提交 ${s.commits} 次`);
      for (const file of s.files) lines.push(`  - ${file}`);
    }
    return { ok: true, output: lines.join('\n'), data: { suggestions } };
  },
};

export const reviewTools = [reviewPrTool, suggestReviewersTool];
