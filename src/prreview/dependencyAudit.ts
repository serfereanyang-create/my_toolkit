/**
 * dependencyAudit.ts — 依赖新鲜度与风险审计
 *
 * 读 package.json 提取依赖，查询 registry 最新版本，
 * 输出 outdated / major-behind / deprecated 风险报告。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DepEntry {
  name: string;
  declaredRange: string;
  isDev: boolean;
}

export type DepRisk = 'major-behind' | 'minor-behind' | 'patch-behind' | 'up-to-date' | 'unknown' | 'deprecated';

export interface DepAudit {
  name: string;
  declaredRange: string;
  current: string | null;
  latest: string | null;
  risk: DepRisk;
  message?: string;
}

export interface AuditSummary {
  total: number;
  upToDate: number;
  patchBehind: number;
  minorBehind: number;
  majorBehind: number;
  deprecated: number;
  unknown: number;
}

/** 从 package.json 提取依赖清单 */
export async function readDependencies(root: string): Promise<DepEntry[]> {
  const raw = await readFile(join(root, 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const out: DepEntry[] = [];
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    out.push({ name, declaredRange: range, isDev: false });
  }
  for (const [name, range] of Object.entries(pkg.devDependencies ?? {})) {
    out.push({ name, declaredRange: range, isDev: true });
  }
  return out;
}

const LEADING_PREFIXES = ['^', '~', '>=', '<=', '>', '<', '=', 'v', ' '];

function stripPrefix(version: string): string {
  let s = version.trim();
  let changed = true;
  while (changed && s.length > 0) {
    changed = false;
    for (const p of LEADING_PREFIXES) {
      if (s.startsWith(p)) {
        s = s.slice(p.length);
        changed = true;
        break;
      }
    }
  }
  return s;
}

/** 提取 N 段数字版本号；不足补 0 */
function numericParts(version: string): [number, number, number] {
  const stripped = stripPrefix(version);
  const segs = stripped.split('.');
  const a = Number.parseInt(segs[0] ?? '', 10);
  const b = Number.parseInt(segs[1] ?? '', 10);
  const c = Number.parseInt(segs[2] ?? '', 10);
  return [
    Number.isFinite(a) ? a : 0,
    Number.isFinite(b) ? b : 0,
    Number.isFinite(c) ? c : 0,
  ];
}

/** 计算 declared 相对 latest 的落后程度 */
export function classifyFreshness(declared: string, latest: string | null): DepRisk {
  if (!latest) return 'unknown';
  const [dMaj, dMin, dPat] = numericParts(declared);
  const [lMaj, lMin, lPat] = numericParts(latest);
  if (dMaj < lMaj) return 'major-behind';
  if (dMaj > lMaj) return 'up-to-date';
  if (dMin < lMin) return 'minor-behind';
  if (dMin > lMin) return 'up-to-date';
  if (dPat < lPat) return 'patch-behind';
  return 'up-to-date';
}

/** 通过 npm view 查询 latest 版本与 deprecated。registry 参数需为合法 URL。 */
export async function queryRegistry(name: string, registry?: string): Promise<{ latest: string | null; deprecated: boolean }> {
  const args: string[] = ['view', name, 'version', 'deprecated', '--json'];
  if (registry) {
    args.push('--registry');
    args.push(registry);
  }
  try {
    const { stdout } = await execFileAsync('npm', args, { maxBuffer: 512 * 1024 });
    const data = JSON.parse(stdout) as { version?: string; deprecated?: string | null };
    return {
      latest: typeof data.version === 'string' ? data.version : null,
      deprecated: typeof data.deprecated === 'string' && data.deprecated.length > 0,
    };
  } catch {
    return { latest: null, deprecated: false };
  }
}

/** 并行审计（默认 8 并发），顺序结果与输入对齐 */
export async function auditDependencies(
  entries: DepEntry[],
  options: { registry?: string; concurrency?: number } = {},
): Promise<DepAudit[]> {
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const results: DepAudit[] = new Array(entries.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= entries.length) return;
      const dep = entries[idx]!;
      const info = await queryRegistry(dep.name, options.registry);
      let risk: DepRisk = classifyFreshness(dep.declaredRange, info.latest);
      let message: string | undefined;
      if (info.deprecated) {
        risk = 'deprecated';
        message = '官方已弃用，建议尽快迁移';
      }
      results[idx] = {
        name: dep.name,
        declaredRange: dep.declaredRange,
        current: stripPrefix(dep.declaredRange),
        latest: info.latest,
        risk,
        message,
      };
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

export function summarize(audits: DepAudit[]): AuditSummary {
  return {
    total: audits.length,
    upToDate: audits.filter((a) => a.risk === 'up-to-date').length,
    patchBehind: audits.filter((a) => a.risk === 'patch-behind').length,
    minorBehind: audits.filter((a) => a.risk === 'minor-behind').length,
    majorBehind: audits.filter((a) => a.risk === 'major-behind').length,
    deprecated: audits.filter((a) => a.risk === 'deprecated').length,
    unknown: audits.filter((a) => a.risk === 'unknown').length,
  };
}
