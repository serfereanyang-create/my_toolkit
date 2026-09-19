/**
 * reviewers.ts — 基于 git 历史的评审人推荐
 *
 * 对每个变更文件，统计近期 log 中的作者贡献；按熟悉度给出排序建议。
 * 所有 git 调用走 execFile 参数数组，无 shell。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FileDiff } from './diffModel.js';

const execFileAsync = promisify(execFile);

export interface ReviewerSuggestion {
  author: string;
  /** 命中的文件数 */
  touchedFiles: number;
  /** 总提交次数（在涉及文件上） */
  commits: number;
  /** 覆盖的变更文件样例 */
  files: string[];
}

/**
 * 读取指定文件集合近期 git log 作者统计。
 * 非 git 仓库或读取失败时返回空数组（调用方应如实报告"无法推荐"）。
 */
export async function suggestReviewers(
  workspaceRoot: string,
  files: FileDiff[],
  options: { maxCommitsPerFile?: number; maxSuggestions?: number } = {},
): Promise<ReviewerSuggestion[]> {
  const maxCommits = options.maxCommitsPerFile ?? 50;
  const maxSuggestions = options.maxSuggestions ?? 5;

  // 按作者聚合：author -> { files:Set, commits }
  const byAuthor = new Map<string, { files: Set<string>; commits: number }>();

  const targets = files.map((f) => f.path).filter((p) => p && p !== 'unknown').slice(0, 30);

  for (const filePath of targets) {
    const args = [
      'log',
      `--max-count=${maxCommits}`,
      '--format=%an',
      '--',
      filePath,
    ];
    let stdout = '';
    try {
      const result = await execFileAsync('git', args, { cwd: workspaceRoot, maxBuffer: 1024 * 512 });
      stdout = result.stdout;
    } catch {
      continue; // 非 git 仓库 / 文件从未提交：该文件无历史
    }
    for (const raw of stdout.split('\n')) {
      const author = raw.trim();
      if (!author) continue;
      const entry = byAuthor.get(author) ?? { files: new Set<string>(), commits: 0 };
      entry.files.add(filePath);
      entry.commits += 1;
      byAuthor.set(author, entry);
    }
  }

  const ranked = [...byAuthor.entries()]
    .map(([author, v]) => ({
      author,
      touchedFiles: v.files.size,
      commits: v.commits,
      files: [...v.files].slice(0, 5),
    }))
    // 先按覆盖文件数、再按提交总数排序
    .sort((a, b) => b.touchedFiles - a.touchedFiles || b.commits - a.commits);

  return ranked.slice(0, maxSuggestions);
}
