/**
 * affected.ts — 公司变更文件 → 受影响 workspace 包分析
 *
 * 输入：一组变更文件路径。
 * 输出：被直接命中的包、依赖它们的包（transitive）。
 */

import type { WorkspacePackage } from './discover.js';

export interface AffectedResult {
  /** 被文件直接命中的包 */
  direct: WorkspacePackage[];
  /** 依赖 direct 包的包（reversed dep closure） */
  dependents: WorkspacePackage[];
  /** 所有受影响包名 */
  allAffected: string[];
  /** 未匹配的文件（不在任何包下） */
  unmatchedFiles: string[];
}

function isFileInPackage(file: string, pkg: WorkspacePackage): boolean {
  const fileNorm = file.replace(/\\/g, '/');
  const pkgDir = pkg.dir.endsWith('/') ? pkg.dir : pkg.dir + '/';
  return fileNorm === pkg.dir || fileNorm.startsWith(pkgDir);
}

/** 构建依赖反向图：dep -> [packages that depend on it] */
function buildReverseGraph(packages: WorkspacePackage[]): Map<string, Set<string>> {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const reverse = new Map<string, Set<string>>();

  for (const pkg of packages) {
    const allDeps = [
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    ];
    for (const dep of allDeps) {
      if (!byName.has(dep)) continue; // 外部依赖不入 workspace 图
      let bucket = reverse.get(dep);
      if (!bucket) {
        bucket = new Set();
        reverse.set(dep, bucket);
      }
      bucket.add(pkg.name);
    }
  }
  return reverse;
}

/** BFS：从 direct 出发沿反向依赖扩展到全部 dependents */
export function computeDependents(
  directNames: readonly string[],
  packages: WorkspacePackage[],
): WorkspacePackage[] {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const reverse = buildReverseGraph(packages);
  const seen = new Set(directNames);
  const queue = [...directNames];
  const result = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const dependents = reverse.get(cur);
    if (!dependents) continue;
    for (const dep of dependents) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      result.add(dep);
      queue.push(dep);
    }
  }
  return [...result]
    .map((name) => byName.get(name))
    .filter((p): p is WorkspacePackage => Boolean(p));
}

/** 把变更文件映射到包 */
export function filesToPackages(files: string[], packages: WorkspacePackage[]): { direct: WorkspacePackage[]; unmatched: string[] } {
  const matched = new Map<string, WorkspacePackage>();
  const unmatched: string[] = [];
  for (const file of files) {
    const pkg = packages.find((p) => isFileInPackage(file, p));
    if (pkg) matched.set(pkg.name, pkg);
    else unmatched.push(file);
  }
  return { direct: [...matched.values()], unmatched };
}

/** 顶层 helper：给出最终 affected 报告 */
export function computeAffected(files: string[], packages: WorkspacePackage[]): AffectedResult {
  const { direct, unmatched } = filesToPackages(files, packages);
  const dependents = computeDependents(direct.map((d) => d.name), packages);
  const all = [...new Set([...direct.map((d) => d.name), ...dependents.map((d) => d.name)])];
  return {
    direct,
    dependents,
    allAffected: all,
    unmatchedFiles: unmatched,
  };
}
