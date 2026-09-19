/**
 * collectScripts.ts - Per-package script discovery for workspace_run.
 *
 * 读取每个 workspace 包的 package.json 提取 scripts 字段。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { WorkspacePackage } from './discover.js';

/**
 * 收集每个包的 scripts 字段名集合；同时统计各脚本可用率。
 */
export async function collectScriptsByDir(
  packages: WorkspacePackage[],
  workspaceRoot: string,
): Promise<{ byDir: Map<string, Set<string>>; scriptCoverage: Map<string, number> }> {
  const byDir = new Map<string, Set<string>>();
  const scriptCoverage = new Map<string, number>();

  for (const pkg of packages) {
    const pkgJsonPath = join(workspaceRoot, pkg.dir, 'package.json');
    const scripts = new Set<string>();
    if (existsSync(pkgJsonPath)) {
      try {
        const raw = await readFile(pkgJsonPath, 'utf-8');
        const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
        for (const k of Object.keys(parsed.scripts ?? {})) {
          scripts.add(k);
          scriptCoverage.set(k, (scriptCoverage.get(k) ?? 0) + 1);
        }
      } catch {
        // ignore broken package.json
      }
    }
    byDir.set(pkg.dir, scripts);
  }

  return { byDir, scriptCoverage };
}

/** 推荐可跨包执行的常用脚本（按覆盖率倒序） */
export function topSharedScripts(byDir: Map<string, Set<string>>, limit: number): Array<{ name: string; coverage: number }> {
  const counts = new Map<string, number>();
  for (const set of byDir.values()) {
    for (const script of set) {
      counts.set(script, (counts.get(script) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, coverage]) => ({ name, coverage }));
}
