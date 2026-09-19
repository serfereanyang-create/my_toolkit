/**
 * applyFilter.ts - Apply a parsed filter expression to workspace packages.
 */

import type { WorkspacePackage } from './discover.js';
import type { FilterExpr, FilterSelector } from './filterExpr.js';
import { parseFilter, selectorMatches } from './filterExpr.js';

export interface FilterResult {
  /** 最终命中的包 */
  matched: WorkspacePackage[];
  /** 调试：每条 selector 命中多少（含扩展） */
  breakdown: Array<{
    selector: string;
    sign: '+' | '-';
    hits: string[];
    expanded: string[];
  }>;
}

function buildDepMap(packages: WorkspacePackage[]): Map<string, Set<string>> {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const deps = new Map<string, Set<string>>();
  for (const pkg of packages) {
    const all = [
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    ];
    deps.set(pkg.name, new Set(all.filter((d) => byName.has(d))));
  }
  return deps;
}

function buildDependentsMap(packages: WorkspacePackage[]): Map<string, Set<string>> {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const reverse = new Map<string, Set<string>>();
  for (const pkg of packages) {
    const all = [
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    ];
    for (const dep of all) {
      if (!byName.has(dep)) continue;
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

function expand(
  startNames: string[],
  direction: 'none' | 'deps' | 'dependents' | 'both',
  deps: Map<string, Set<string>>,
  dependents: Map<string, Set<string>>,
): Set<string> {
  if (direction === 'none') return new Set(startNames);
  const result = new Set(startNames);
  const queue = [...startNames];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const nextSets: Array<Set<string> | undefined> = [];
    if (direction === 'deps' || direction === 'both') nextSets.push(deps.get(cur));
    if (direction === 'dependents' || direction === 'both') nextSets.push(dependents.get(cur));
    for (const set of nextSets) {
      if (!set) continue;
      for (const name of set) {
        if (!result.has(name)) {
          result.add(name);
          queue.push(name);
        }
      }
    }
  }
  return result;
}

function selectorToString(s: FilterSelector): string {
  switch (s.kind) {
    case 'name':
      return s.name;
    case 'path':
      return `path:${s.prefix}`;
    case 'regex':
      return `regex:${s.pattern}`;
    case 'since':
      return `since:${s.ref}`;
  }
}

export function applyFilter(packages: WorkspacePackage[], input: string): FilterResult {
  const expr: FilterExpr = parseFilter(input);
  const byName = new Map(packages.map((p) => [p.name, p]));
  const deps = buildDepMap(packages);
  const dependents = buildDependentsMap(packages);

  const acc = new Set<string>();
  const excluded = new Set<string>();
  const breakdown: FilterResult['breakdown'] = [];

  // 若只给 excludes 而无 includes，默认包含全部（pnpm 行为）
  const implicitAll = expr.includes.length === 0 && expr.excludes.length > 0;

  for (const clause of expr.includes) {
    const direct = new Set<string>();
    for (const pkg of packages) {
      if (selectorMatches(clause.selector, pkg)) direct.add(pkg.name);
    }
    const expanded = expand([...direct], clause.expand, deps, dependents);
    breakdown.push({
      selector: selectorToString(clause.selector),
      sign: '+',
      hits: [...direct],
      expanded: [...expanded].filter((n) => !direct.has(n)),
    });
    for (const name of expanded) acc.add(name);
  }

  if (implicitAll) {
    for (const pkg of packages) acc.add(pkg.name);
  }

  for (const clause of expr.excludes) {
    const direct = new Set<string>();
    for (const pkg of packages) {
      if (selectorMatches(clause.selector, pkg)) direct.add(pkg.name);
    }
    const expanded = expand([...direct], clause.expand, deps, dependents);
    breakdown.push({
      selector: selectorToString(clause.selector),
      sign: '-',
      hits: [...direct],
      expanded: [...expanded].filter((n) => !direct.has(n)),
    });
    for (const name of expanded) excluded.add(name);
  }

  const matchedNames = [...acc].filter((n) => !excluded.has(n));
  const matched = matchedNames
    .map((name) => byName.get(name))
    .filter((p): p is WorkspacePackage => Boolean(p));

  return { matched, breakdown };
}
