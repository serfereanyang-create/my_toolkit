/**
 * gitQuality.ts - Git commit log 品质分析（只读）。
 *
 * 解析 git log shortstat，输出作者分布、revert/hotfix 比例、
 * 平均提交规模、时间直方图与主题关键词统计。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommitRecord {
  hash: string;
  author: string;
  dateIso: string;
  subject: string;
  insertions: number;
  deletions: number;
}

export interface GitQualityReport {
  commitCount: number;
  periodStart: string | null;
  periodEnd: string | null;
  topAuthors: Array<{ author: string; commits: number; insertions: number; deletions: number }>;
  revert: { count: number; ratio: number };
  hotfixLike: { count: number; ratio: number };
  averageLinesPerCommit: number;
  largestCommits: Array<{ hash: string; subject: string; total: number }>;
  hourHistogram: number[];
  dowHistogram: number[];
  subjectKeywords: Array<{ keyword: string; count: number }>;
}

const KEYWORDS = ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'style', 'perf', 'revert', 'hotfix', 'ci', 'build', 'deps'];

function isRevertSubject(subject: string): boolean {
  const lower = subject.toLowerCase();
  return lower.startsWith('revert') || lower.includes('revert "');
}

function isHotfixLike(subject: string): boolean {
  const lower = subject.toLowerCase();
  return lower.startsWith('hotfix') || lower.startsWith('fix:') || lower.startsWith('fix(') || lower.startsWith('bugfix');
}

/** 从 marker 之前提取最近的十进制数字（如 "12 insertions(+)" → 12）。 */
function numberBefore(text: string, marker: string): number {
  const idx = text.indexOf(marker);
  if (idx < 0) return 0;
  let end = idx;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '(')) end -= 1;
  let start = end;
  while (start > 0 && text[start - 1] >= '0' && text[start - 1] <= '9') start -= 1;
  const value = Number(text.slice(start, end).trim());
  return Number.isFinite(value) ? value : 0;
}

/** 解析 shortstat 行（"3 files changed, 12 insertions(+), 4 deletions(-)"）。 */
export function parseShortstat(line: string): { insertions: number; deletions: number } | null {
  const trimmed = line.trim();
  if (!trimmed.includes('changed')) return null;
  return {
    insertions: numberBefore(trimmed, 'insertion'),
    deletions: numberBefore(trimmed, 'deletion'),
  };
}

/** 把 git log 原始输出解析成结构化提交记录。 */
export function parseGitLogOutput(stdout: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  let cur: Omit<CommitRecord, 'insertions' | 'deletions'> | null = null;

  for (const line of stdout.split('\n')) {
    if (line.includes('|')) {
      const parts = line.split('|');
      if (parts.length < 4) continue;
      if (cur) records.push({ ...cur, insertions: 0, deletions: 0 });
      cur = { hash: parts[0]!, author: parts[1]!, dateIso: parts[2]!, subject: parts[3]! };
      continue;
    }
    if (!cur) continue;
    const stats = parseShortstat(line);
    if (stats) {
      records.push({ ...cur, insertions: stats.insertions, deletions: stats.deletions });
      cur = null;
    }
  }
  if (cur) records.push({ ...cur, insertions: 0, deletions: 0 });
  return records;
}

export async function collectCommits(
  workspaceRoot: string,
  options: { maxCount?: number } = {},
): Promise<CommitRecord[]> {
  const maxCount = Math.max(1, Math.min(5000, Math.floor(options.maxCount ?? 500)));
  const args = [
    'log',
    `--max-count=${maxCount}`,
    '--shortstat',
    '--date=iso-strict',
    '--pretty=format:%H|%an|%ad|%s',
  ];
  const { stdout } = await execFileAsync('git', args, {
    cwd: workspaceRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseGitLogOutput(stdout);
}

export function analyzeCommits(commits: CommitRecord[]): GitQualityReport {
  const empty: GitQualityReport = {
    commitCount: 0,
    periodStart: null,
    periodEnd: null,
    topAuthors: [],
    revert: { count: 0, ratio: 0 },
    hotfixLike: { count: 0, ratio: 0 },
    averageLinesPerCommit: 0,
    largestCommits: [],
    hourHistogram: new Array(24).fill(0),
    dowHistogram: new Array(7).fill(0),
    subjectKeywords: [],
  };
  if (commits.length === 0) return empty;

  const authorAgg = new Map<string, { commits: number; insertions: number; deletions: number }>();
  const hourHistogram = new Array(24).fill(0);
  const dowHistogram = new Array(7).fill(0);
  const keywordCount = new Map<string, number>();
  let revertCount = 0;
  let hotfixCount = 0;
  let totalLines = 0;
  let earliest = commits[0]!.dateIso;
  let latest = commits[0]!.dateIso;

  for (const commit of commits) {
    const agg = authorAgg.get(commit.author) ?? { commits: 0, insertions: 0, deletions: 0 };
    agg.commits += 1;
    agg.insertions += commit.insertions;
    agg.deletions += commit.deletions;
    authorAgg.set(commit.author, agg);

    const at = new Date(commit.dateIso);
    if (!Number.isNaN(at.getTime())) {
      hourHistogram[at.getUTCHours()]! += 1;
      dowHistogram[at.getUTCDay()]! += 1;
    }

    if (isRevertSubject(commit.subject)) revertCount += 1;
    if (isHotfixLike(commit.subject)) hotfixCount += 1;

    totalLines += commit.insertions + commit.deletions;
    if (commit.dateIso < earliest) earliest = commit.dateIso;
    if (commit.dateIso > latest) latest = commit.dateIso;

    const subjectLower = commit.subject.toLowerCase();
    for (const kw of KEYWORDS) {
      if (subjectLower.includes(kw)) keywordCount.set(kw, (keywordCount.get(kw) ?? 0) + 1);
    }
  }

  const largest = [...commits]
    .map((c) => ({ hash: c.hash.slice(0, 12), subject: c.subject, total: c.insertions + c.deletions }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const topAuthors = [...authorAgg.entries()]
    .map(([author, v]) => ({ author, commits: v.commits, insertions: v.insertions, deletions: v.deletions }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 10);

  const subjectKeywords = [...keywordCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([keyword, count]) => ({ keyword, count }));

  const n = commits.length;
  const pct = (count: number) => Math.round((count / n) * 1000) / 1000;
  return {
    commitCount: n,
    periodStart: earliest,
    periodEnd: latest,
    topAuthors,
    revert: { count: revertCount, ratio: pct(revertCount) },
    hotfixLike: { count: hotfixCount, ratio: pct(hotfixCount) },
    averageLinesPerCommit: Math.round(totalLines / n),
    largestCommits: largest,
    hourHistogram,
    dowHistogram,
    subjectKeywords,
  };
}
