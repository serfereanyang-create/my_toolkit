/**
 * structureAudit.ts — 项目结构健康审计（纯静态，无执行）。
 *
 * 检查维度：
 *  - 超大文件（行数阈值）
 *  - 目录嵌套过深 / 单目录文件过多
 *  - 命名风格混用（同目录 PascalCase 与 kebab-case 并存）
 *  - 测试布局错位（tests 与 src 镜像关系断裂）
 *  - 疑似死目录（空目录链）
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep, basename, extname } from 'node:path';

export type StructureIssueKind =
  | 'huge-file'
  | 'deep-dir'
  | 'crowded-dir'
  | 'mixed-naming'
  | 'orphan-test'
  | 'empty-dir';

export interface StructureIssue {
  kind: StructureIssueKind;
  path: string;
  detail: string;
  /** 严重度 1-3 */
  severity: 1 | 2 | 3;
}

export interface StructureAuditOptions {
  /** 单文件行数阈值，默认 800 */
  hugeFileLines?: number;
  /** 目录深度阈值，默认 6 */
  maxDepth?: number;
  /** 单目录条目数阈值，默认 40 */
  crowdedDirEntries?: number;
  /** 扫描文件数上限，默认 2000 */
  maxFiles?: number;
}

export interface StructureAuditReport {
  scannedFiles: number;
  scannedDirs: number;
  issues: StructureIssue[];
  byKind: Record<string, number>;
}

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java']);
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.aicode', 'coverage', '.next', 'out', 'vendor', '__pycache__']);

function isTestFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('.test.') || lower.includes('.spec.') || lower.startsWith('test_');
}

/** 递归收集文件与目录（带忽略与上限）。 */
async function walk(
  root: string,
  dir: string,
  depth: number,
  options: StructureAuditOptions,
  files: Array<{ path: string; rel: string; depth: number }>,
  dirs: Array<{ path: string; rel: string; depth: number; entries: number }>,
): Promise<void> {
  if (files.length >= (options.maxFiles ?? 2000)) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const visible = entries.filter((e) => !e.startsWith('.') && !IGNORE_DIRS.has(e));
  dirs.push({ path: dir, rel: relative(root, dir).split(sep).join('/') || '.', depth, entries: visible.length });
  for (const entry of visible) {
    const child = join(dir, entry);
    let st;
    try {
      st = await stat(child);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await walk(root, child, depth + 1, options, files, dirs);
    } else if (CODE_EXT.has(extname(entry).toLowerCase())) {
      files.push({ path: child, rel: relative(root, child).split(sep).join('/'), depth });
    }
  }
}

/** 命名风格判定：PascalCase / kebab-case / snake_case / camelCase。 */
function namingStyle(name: string): 'pascal' | 'kebab' | 'snake' | 'camel' | 'other' {
  const stem = name.replace(/\.[^.]+$/, '');
  if (!stem) return 'other';
  if (stem.includes('-')) return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(stem) ? 'kebab' : 'other';
  if (stem.includes('_')) return /^[a-z0-9]+(_[a-z0-9]+)*$/.test(stem) ? 'snake' : 'other';
  if (/^[A-Z][A-Za-z0-9]*$/.test(stem)) return 'pascal';
  if (/^[a-z][a-zA-Z0-9]*$/.test(stem)) return 'camel';
  return 'other';
}

export async function auditStructure(
  workspaceRoot: string,
  options: StructureAuditOptions = {},
): Promise<StructureAuditReport> {
  const hugeLines = options.hugeFileLines ?? 800;
  const maxDepth = options.maxDepth ?? 6;
  const crowded = options.crowdedDirEntries ?? 40;

  const files: Array<{ path: string; rel: string; depth: number }> = [];
  const dirs: Array<{ path: string; rel: string; depth: number; entries: number }> = [];
  await walk(workspaceRoot, workspaceRoot, 0, options, files, dirs);

  const issues: StructureIssue[] = [];

  // 1) 超大文件
  for (const file of files) {
    try {
      const st = await stat(file.path);
      // 粗筛：平均每行至少 10 字节才可能超阈值，避免读小文件
      if (st.size > hugeLines * 10) {
        // 粗筛：字节数明显超阈值才数行，避免读全部文件
        const { readFile } = await import('node:fs/promises');
        const text = await readFile(file.path, 'utf-8');
        const lines = text.split('\n').length;
        if (lines > hugeLines) {
          issues.push({ kind: 'huge-file', path: file.rel, detail: `${lines} 行（阈值 ${hugeLines}）`, severity: lines > hugeLines * 2 ? 3 : 2 });
        }
      }
    } catch { /* ignore */ }
  }

  // 2) 深目录
  for (const dir of dirs) {
    if (dir.depth > maxDepth && dir.entries > 0) {
      issues.push({ kind: 'deep-dir', path: dir.rel, detail: `嵌套深度 ${dir.depth}（阈值 ${maxDepth}）`, severity: 1 });
    }
    if (dir.entries > crowded) {
      issues.push({ kind: 'crowded-dir', path: dir.rel, detail: `${dir.entries} 个条目（阈值 ${crowded}），建议分组`, severity: 2 });
    }
    if (dir.entries === 0 && dir.depth > 0) {
      issues.push({ kind: 'empty-dir', path: dir.rel, detail: '空目录', severity: 1 });
    }
  }

  // 3) 同目录命名风格混用（只看代码文件，忽略测试文件命名差异）
  const byDir = new Map<string, Set<string>>();
  for (const file of files) {
    if (isTestFile(basename(file.rel))) continue;
    const dir = file.rel.includes('/') ? file.rel.slice(0, file.rel.lastIndexOf('/')) : '.';
    const style = namingStyle(basename(file.rel));
    if (style === 'other') continue;
    let set = byDir.get(dir);
    if (!set) { set = new Set(); byDir.set(dir, set); }
    set.add(style);
  }
  for (const [dir, styles] of byDir) {
    const structural = [...styles].filter((s) => s === 'pascal' || s === 'kebab' || s === 'snake');
    if (structural.length >= 2) {
      issues.push({ kind: 'mixed-naming', path: dir, detail: `命名风格混用: ${structural.join(' + ')}`, severity: 1 });
    }
  }

  // 4) 测试镜像检查：src/x/y.test.ts 期望存在 src/x/y.ts（或同目录 index）
  for (const file of files) {
    if (!isTestFile(basename(file.rel))) continue;
    const stem = basename(file.rel).replace(/\.(test|spec)\.[^.]+$/, '');
    if (!stem || stem === 'test_') continue;
    const dir = file.rel.includes('/') ? file.rel.slice(0, file.rel.lastIndexOf('/')) : '.';
    // 测试在 tests/ 下时镜像到 src/
    const candidates = new Set<string>();
    candidates.add(`${dir}/${stem}.ts`);
    candidates.add(`${dir}/${stem}.tsx`);
    candidates.add(`${dir}/${stem}.js`);
    if (dir === 'tests' || dir.startsWith('tests/')) {
      // 镜像回 src/：tests 根 → src；tests/a/b → src/a/b
      const mirrored = dir === 'tests' ? 'src' : 'src/' + dir.slice('tests/'.length);
      candidates.add(`${mirrored}/${stem}.ts`);
      candidates.add(`${mirrored}/${stem}.tsx`);
    }
    const fileSet = new Set(files.map((f) => f.rel));
    const hit = [...candidates].some((c) => fileSet.has(c));
    if (!hit) {
      issues.push({ kind: 'orphan-test', path: file.rel, detail: `找不到被测源文件（期望 ${stem}.ts/.tsx）`, severity: 1 });
    }
  }

  const byKind: Record<string, number> = {};
  for (const issue of issues) byKind[issue.kind] = (byKind[issue.kind] ?? 0) + 1;

  issues.sort((a, b) => b.severity - a.severity || a.path.localeCompare(b.path));
  return { scannedFiles: files.length, scannedDirs: dirs.length, issues, byKind };
}
