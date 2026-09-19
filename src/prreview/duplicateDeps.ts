/**
 * duplicateDeps.ts — Monorepo/嵌套 node_modules 中的重复依赖检测
 *
 * 在 node_modules 下递归找同名包的多个版本（含嵌套安装），找出可提升或
 * 可能引发运行时冲突的版本不一致。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export interface DupOccurrence {
  name: string;
  version: string;
  path: string;
}

export interface DupGroup {
  name: string;
  versions: Map<string, string[]>; // version -> 各个安装路径
  versionCount: number;
  occurrenceCount: number;
}

export interface DupReport {
  scannedModulesRoots: number;
  totalPackagesSeen: number;
  groups: DupGroup[];
  multiVersionCount: number;
}

async function readVersionAt(dir: string): Promise<{ name: string; version: string } | null> {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { name?: string; version?: string };
    if (!pkg.name || !pkg.version) return null;
    return { name: pkg.name, version: pkg.version };
  } catch {
    return null;
  }
}

/**
 * 扫描 root/node_modules 下的全部包（只深一层嵌套 + scoped）。
 * 产生所有 (name@version, installPath) 记录。
 */
export async function collectOccurrences(modulesDir: string): Promise<DupOccurrence[]> {
  const out: DupOccurrence[] = [];
  if (!existsSync(modulesDir)) return out;

  async function visitScope(scopeDir: string): Promise<void> {
    const sub = await readdir(scopeDir, { withFileTypes: true });
    for (const d of sub) {
      if (!d.isDirectory()) continue;
      if (d.name.startsWith('.')) continue;
      if (d.name.startsWith('@')) {
        const scoped = join(scopeDir, d.name);
        const inner = await readdir(scoped, { withFileTypes: true });
        for (const s of inner) {
          if (s.isDirectory()) {
            const pkgDir = join(scoped, s.name);
            const rec = await readVersionAt(pkgDir);
            if (rec) {
              out.push({ name: rec.name, version: rec.version, path: pkgDir });
            }
          }
        }
      } else {
        const pkgDir = join(scopeDir, d.name);
        const rec = await readVersionAt(pkgDir);
        if (rec) {
          out.push({ name: rec.name, version: rec.version, path: pkgDir });
        }
      }
    }
  }

  await visitScope(modulesDir);
  return out;
}

/** 分组聚合，返回多版本组排序（先按版本数再按出现次数） */
export function groupDuplicates(occs: DupOccurrence[]): DupGroup[] {
  const byName = new Map<string, Map<string, string[]>>();
  for (const occ of occs) {
    let byVersion = byName.get(occ.name);
    if (!byVersion) {
      byVersion = new Map();
      byName.set(occ.name, byVersion);
    }
    const paths = byVersion.get(occ.version) ?? [];
    paths.push(occ.path);
    byVersion.set(occ.version, paths);
  }
  const groups: DupGroup[] = [];
  for (const [name, versions] of byName) {
    if (versions.size < 2) continue;
    const totalOcc = [...versions.values()].reduce((s, arr) => s + arr.length, 0);
    groups.push({
      name,
      versions,
      versionCount: versions.size,
      occurrenceCount: totalOcc,
    });
  }
  return groups.sort((a, b) => b.versionCount - a.versionCount || b.occurrenceCount - a.occurrenceCount);
}

export async function detectDuplicateDeps(root: string): Promise<DupReport> {
  const occs = await collectOccurrences(join(root, 'node_modules'));
  const groups = groupDuplicates(occs);
  const uniqueNames = new Set(occs.map((o) => o.name)).size;
  return {
    scannedModulesRoots: occs.length,
    totalPackagesSeen: uniqueNames,
    groups,
    multiVersionCount: groups.length,
  };
}
