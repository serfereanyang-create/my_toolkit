/**
 * commitAnalyzerTool.ts — git_hotspots tool: hotspot & coupling analysis
 * over commit history (git log --numstat, fixed argv).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../tools/types.js';
import {
  hotFiles,
  couplingPairs,
  splitCandidates,
  authorStories,
  type CommitChanges,
  type FileChangeEntry,
} from './commitAnalyzer.js';

const execFileAsync = promisify(execFile);

const COMMIT_DELIM = '@@YOYCOMMIT@@';

function buildLogArgs(): string[] {
  const formatArg = `--format=${COMMIT_DELIM}%H|%an|%aI`;
  return ['log', '--max-count=500', '--numstat', '--no-merges', formatArg];
}

/** Parse one commit block (header line + numstat lines). */
export function parseCommitBlock(block: string): CommitChanges | null {
  const lines = block.split('\n');
  const header = lines[0] ?? '';
  const body = header.split('|');
  if (body.length < 3) return null;
  const commit: CommitChanges = { hash: body[0]!, author: body[1]!, date: body[2]!, files: [] };
  for (const line of lines.slice(1)) {
    const file = parseFileLine(line);
    if (file) commit.files.push(file);
  }
  return commit;
}

/** Parse a numstat line "<added>\t<removed>\t<path>"; '-' / rename rows skipped. */
export function parseFileLine(line: string): FileChangeEntry | null {
  const firstTab = line.indexOf('\t');
  if (firstTab <= 0) return null;
  const addedText = line.slice(0, firstTab);
  const rest = line.slice(firstTab + 1);
  const secondTab = rest.indexOf('\t');
  if (secondTab <= 0) return null;
  const removedText = rest.slice(0, secondTab);
  const path = rest.slice(secondTab + 1).trim();
  if (!path || path.includes('=>')) return null;
  if (!/^\d+$/.test(addedText) || !/^\d+$/.test(removedText)) return null;
  return { path, added: Number(addedText), removed: Number(removedText) };
}

export function parseCommitBlocks(stdout: string): CommitChanges[] {
  return stdout
    .split(COMMIT_DELIM)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => parseCommitBlock(block))
    .filter((c): c is CommitChanges => c !== null);
}

export const gitHotspotsTool: ToolDefinition<{ minCoCommits?: number }> = {
  name: 'git_hotspots',
  description: '提交历史热点分析：最常被改文件、共变耦合对（隐性依赖）、优先拆分候选、作者领域分布',
  inputHint: '{ "minCoCommits": 3 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    return {
      minCoCommits: typeof r.minCoCommits === 'number' && r.minCoCommits > 0 ? Math.floor(r.minCoCommits) : 3,
    };
  },

  async execute(input, context) {
    let stdout = '';
    try {
      const result = await execFileAsync('git', buildLogArgs(), {
        cwd: context.workspaceRoot,
        maxBuffer: 16 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (err) {
      return { ok: false, output: `git log 读取失败: ${err instanceof Error ? err.message : String(err)}` };
    }

    const changes = parseCommitBlocks(stdout);
    if (changes.length === 0) {
      return { ok: true, output: '没有可分析的非 merge 提交。' };
    }

    const hot = hotFiles(changes);
    const pairs = couplingPairs(changes, input.minCoCommits ?? 3);
    const splits = splitCandidates(changes);
    const stories = authorStories(changes);

    const lines: string[] = [
      `## 提交热点分析（最近 ${changes.length} 次非 merge 提交，上限 500）`,
      '',
      '### 热点文件（改动次数 × 规模，前 15）',
    ];
    for (const h of hot.slice(0, 15)) {
      lines.push(`- **${h.path}**: ${h.commits} 次改动（+${h.totalAdded} / -${h.totalRemoved}）`);
    }
    if (pairs.length > 0) {
      lines.push('', '### 共变耦合（改 A 往往要同步改 B）');
      for (const p of pairs.slice(0, 15)) {
        lines.push(`- \`${p.a}\` ↔ \`${p.b}\`：${p.coCommits} 次同 commit，跟随率 ${(p.strength * 100).toFixed(0)}%`);
      }
    }
    if (splits.length > 0) {
      lines.push('', '### 拆分候选（热度 × 体量）');
      for (const s of splits.slice(0, 10)) {
        lines.push(`- **${s.path}**（score ${s.score}）：${s.commits} 次 / ${s.churn} 行变更 — ${s.reason}`);
      }
    }
    lines.push('', '### 作者与领域');
    for (const story of stories.slice(0, 8)) {
      const areas = story.topAreas.map((a) => `${a.area}(${a.commits})`).join(', ');
      lines.push(`- ${story.author}: ${story.commits} 次 — 主要活跃 ${areas}`);
    }
    return { ok: true, output: lines.join('\n'), data: { hot, pairs, splits, stories } };
  },
};

export const commitAnalyzerTools = [gitHotspotsTool];
