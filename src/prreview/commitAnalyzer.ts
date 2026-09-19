/**
 * commitAnalyzer.ts — 基于 git log 的热点与共变分析（纯函数，不执行 git）。
 *
 * 输入：commit 文件清单（hash → 变更文件+行数），来自 git log --name-only
 * 或调用方组装。输出：
 *  - 热点文件：被改动次数 × 累计行数排序
 *  - 共变耦合：经常一起改动的文件对（隐性依赖，拆分候选）
 *  - 规模×热度：建议优先重构/拆分的文件
 */

export interface FileChangeEntry {
  path: string;
  added: number;
  removed: number;
}

export interface CommitChanges {
  hash: string;
  author: string;
  date: string;
  files: FileChangeEntry[];
}

export interface HotFile {
  path: string;
  commits: number;
  totalAdded: number;
  totalRemoved: number;
}

export interface CouplingPair {
  a: string;
  b: string;
  coCommits: number;
  aCommits: number;
  bCommits: number;
  /** coCommits / min(aCommits,bCommits) —— 一侧改动时另一侧跟动的概率 */
  strength: number;
}

export interface SplitCandidate {
  path: string;
  commits: number;
  churn: number;
  /** churn = added+removed；score 综合热度与规模 */
  score: number;
  reason: string;
}

/** 热点文件排行（改动次数 × 总量）。 */
export function hotFiles(changes: CommitChanges[], limit = 15): HotFile[] {
  const map = new Map<string, HotFile>();
  for (const commit of changes) {
    for (const file of commit.files) {
      const entry = map.get(file.path) ?? { path: file.path, commits: 0, totalAdded: 0, totalRemoved: 0 };
      entry.commits += 1;
      entry.totalAdded += file.added;
      entry.totalRemoved += file.removed;
      map.set(file.path, entry);
    }
  }
  return [...map.values()]
    .sort((a, b) => b.commits - a.commits || b.totalAdded + b.totalRemoved - (a.totalAdded + a.totalRemoved))
    .slice(0, limit);
}

/** 共变耦合对：同一 commit 中成对出现的文件，strength = 共现率。 */
export function couplingPairs(changes: CommitChanges[], minCoCommits = 3, limit = 20): CouplingPair[] {
  const fileCommits = new Map<string, number>();
  for (const commit of changes) {
    for (const file of commit.files) {
      fileCommits.set(file.path, (fileCommits.get(file.path) ?? 0) + 1);
    }
  }
  const pairCounts = new Map<string, number>();
  for (const commit of changes) {
    const paths = [...new Set(commit.files.map((f) => f.path))].sort();
    for (let i = 0; i < paths.length; i += 1) {
      for (let j = i + 1; j < paths.length; j += 1) {
        const key = `${paths[i]}|||${paths[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs: CouplingPair[] = [];
  for (const [key, co] of pairCounts) {
    if (co < minCoCommits) continue;
    const [a, b] = key.split('|||') as [string, string];
    const aCommits = fileCommits.get(a) ?? 0;
    const bCommits = fileCommits.get(b) ?? 0;
    const denom = Math.min(aCommits, bCommits);
    pairs.push({
      a,
      b,
      coCommits: co,
      aCommits,
      bCommits,
      strength: denom > 0 ? co / denom : 0,
    });
  }
  return pairs.sort((x, y) => y.strength - x.strength || y.coCommits - x.coCommits).slice(0, limit);
}

/** 拆分候选：既热又肥（高 churn）的文件。 */
export function splitCandidates(changes: CommitChanges[], limit = 10): SplitCandidate[] {
  const hot = hotFiles(changes, 100);
  const candidates: SplitCandidate[] = [];
  for (const h of hot) {
    const churn = h.totalAdded + h.totalRemoved;
    // score 综合：改动次数权重 2，churn 权重 1/100
    const score = h.commits * 2 + churn / 100;
    if (h.commits < 3 && churn < 500) continue;
    let reason = '';
    if (h.commits >= 8 && churn >= 800) reason = '高频且大改动：职责可能过多';
    else if (h.commits >= 8) reason = '改动极频繁：容易冲突，建议按职责拆分';
    else reason = '累计改动量大：单文件承载过多变更';
    candidates.push({ path: h.path, commits: h.commits, churn, score: Math.round(score * 10) / 10, reason });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 时间线叙事：每人改动节奏 + 主导领域（用于 onboarding 文档）。 */
export interface AuthorStory {
  author: string;
  commits: number;
  topAreas: Array<{ area: string; commits: number }>;
}

export function authorStories(changes: CommitChanges[], topAreas = 3): AuthorStory[] {
  const byAuthor = new Map<string, { commits: number; areas: Map<string, number> }>();
  for (const commit of changes) {
    const entry = byAuthor.get(commit.author) ?? { commits: 0, areas: new Map<string, number>() };
    entry.commits += 1;
    const seen = new Set<string>();
    for (const file of commit.files) {
      const slash = file.path.indexOf('/');
      const area = slash > 0 ? file.path.slice(0, file.path.indexOf('/', slash + 1) > 0 ? file.path.indexOf('/', slash + 1) : slash) : file.path;
      if (seen.has(area)) continue;
      seen.add(area);
      entry.areas.set(area, (entry.areas.get(area) ?? 0) + 1);
    }
    byAuthor.set(commit.author, entry);
  }
  return [...byAuthor.entries()]
    .map(([author, v]) => ({
      author,
      commits: v.commits,
      topAreas: [...v.areas.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, topAreas)
        .map(([area, commits]) => ({ area, commits })),
    }))
    .sort((a, b) => b.commits - a.commits);
}
