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
import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep, basename, extname } from 'node:path';
import { isIgnoredDirName } from '../workspace/ignored.js';

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

/**
 * 测试文件是否引用了仓库里真实存在的模块。
 *
 * 用来把「跨模块行为测试」和「孤儿测试」区分开：前者文件名对不上任何源文件，
 * 但它 require/import 的模块确实存在，是正常且必要的；后者两者皆无。只认相对
 * 路径（./ 或 ../），bare specifier 指向 node_modules，说明不了什么。
 */
function importsRealModule(absPath: string, fileSet: Set<string>, selfRel: string): boolean {
  let source: string;
  try {
    source = readFileSync(absPath, 'utf-8');
  } catch {
    return false;
  }
  const dir = selfRel.includes('/') ? selfRel.slice(0, selfRel.lastIndexOf('/')) : '.';
  for (const match of source.matchAll(/(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    const spec = match[1]!;
    const base = normalizeRelative(dir, spec);
    if (!base) continue;
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.cjs']) {
      if (fileSet.has(base + ext)) return true;
    }
  }
  return false;
}

/** 把相对 specifier 归一到仓库根相对路径（不依赖 fs，纯字符串）。 */
function normalizeRelative(dir: string, spec: string): string | undefined {
  const parts = (dir === '.' ? [] : dir.split('/')).concat(spec.split('/'));
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return undefined; // 越出仓库根
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length > 0 ? out.join('/') : undefined;
}

function isTestFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('.test.') || lower.includes('.spec.') || lower.startsWith('test_');
}

/**
 * 找出「被测源文件可能住在哪」的顶层目录。
 *
 * 依据实际目录树推断，而不是写死 src/：一个仓库的主进程代码可能在 electron/，
 * 前端在 src/，两者都该被认作源码根。只收顶层且真正含有代码文件的目录，并且
 * 排除 tests/ 自身 —— 否则「测试镜像回测试」会永远命中，检查就失去意义。
 */
function detectSourceRoots(rels: string[]): string[] {
  const roots = new Set<string>();
  for (const rel of rels) {
    const slash = rel.indexOf('/');
    if (slash <= 0) continue; // 顶层文件没有独立源码根
    const top = rel.slice(0, slash);
    if (top === 'tests' || top === 'test' || top === '__tests__') continue;
    if (isIgnoredDirName(top)) continue;
    if (isTestFile(rel.slice(slash + 1))) continue; // 测试文件不代表源码根
    roots.add(top);
  }
  return [...roots].sort();
}

/** 递归收集文件与目录（带忽略与上限）。 */
async function walk(
  root: string,
  dir: string,
  depth: number,
  options: StructureAuditOptions,
  files: Array<{ path: string; rel: string; depth: number }>,
  dirs: Array<{ path: string; rel: string; depth: number; entries: number }>,
  visitedDirs: Set<string> = new Set(),
): Promise<void> {
  if (files.length >= (options.maxFiles ?? 2000)) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  // 符号链接 / junction 可以指回祖先目录，`stat` 跟随链接后
  // 递归会沿 `pkg/loop/pkg/loop/pkg/...` 一路展开到 maxFiles 才停：实测
  // 一个小仓库因一个 `pkg/loop -> root` 的 junction 被记成 128 个文件 /
  // 128 个目录（121 个是环），结构审计报出成堆假的 deep-dir / orphan-test。
  // 记录真实路径，同一个物理目录只走一次。
  // 让「同一物理目录经链接再次到达」也能被识别：先看真实路径，再登记两者。
  let real: string | undefined;
  try { real = realpathSync(dir); } catch { /* 链接目标不可读时只按词法路径去重 */ }
  if (visitedDirs.has(dir) || (real !== undefined && visitedDirs.has(real))) return;
  visitedDirs.add(dir);
  if (real !== undefined) visitedDirs.add(real);
  const visible = entries.filter((e) => !e.startsWith('.') && !isIgnoredDirName(e));
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
      await walk(root, child, depth + 1, options, files, dirs, visitedDirs);
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

  // 4) 测试镜像检查：测试文件应当能在源码树里找到同名的被测源文件。
  //
  // 候选路径由**实际存在的源码根目录**推导，而不是写死 src/。写死会把两类
  // 完全正常的布局报成「断裂」：
  //   - Electron 主进程：tests/x.test.cjs 的被测文件是 electron/x.cjs
  //   - 项目自带 tests/ 目录：tests/x.test.ts 可能镜像 src/x.ts
  // 扩展名也要全，.cjs/.mjs 曾整个漏掉。
  const fileSet = new Set(files.map((f) => f.rel));
  const sourceRoots = detectSourceRoots(files.map((f) => f.rel));
  const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

  for (const file of files) {
    if (!isTestFile(basename(file.rel))) continue;
    const stem = basename(file.rel).replace(/\.(test|spec)\.[^.]+$/, '');
    if (!stem || stem === 'test_') continue;
    const dir = file.rel.includes('/') ? file.rel.slice(0, file.rel.lastIndexOf('/')) : '.';

    const candidates = new Set<string>();
    // 同目录同名
    for (const ext of SOURCE_EXTS) candidates.add(`${dir}/${stem}${ext}`);
    // 各源码根下的镜像：tests/ 根 → <root>；tests/a/b → <root>/a/b
    for (const root of sourceRoots) {
      for (const ext of SOURCE_EXTS) candidates.add(`${root}/${stem}${ext}`);
      if (dir === 'tests' || dir.startsWith('tests/')) {
        const inner = dir === 'tests' ? '' : dir.slice('tests/'.length);
        const mirrored = inner ? `${root}/${inner}` : root;
        for (const ext of SOURCE_EXTS) candidates.add(`${mirrored}/${stem}${ext}`);
      }
      // 测试自己就住在某个源码根下（src/a/b/x.test.ts → src/a/b/x.ts 已在同目录覆盖）
    }

    const hit = [...candidates].some((c) => fileSet.has(c));
    if (hit) continue;

    // 名字对不上不等于孤儿：跨模块的行为测试（coding-e2e、mock-smoke 这类）
    // 本来就没有同名源文件，它们 import/require 别的真实模块。真正的孤儿是
    // 谁都找不到的那种 —— 所以再看一眼它引用的相对模块是否存在。
    if (importsRealModule(file.path, fileSet, file.rel)) continue;

    issues.push({
      kind: 'orphan-test',
      path: file.rel,
      detail: `找不到被测源文件（在 ${sourceRoots.join(', ') || '同目录'} 下找 ${stem}{${SOURCE_EXTS.join(',')}}）`,
      severity: 1,
    });
  }

  const byKind: Record<string, number> = {};
  for (const issue of issues) byKind[issue.kind] = (byKind[issue.kind] ?? 0) + 1;

  issues.sort((a, b) => b.severity - a.severity || a.path.localeCompare(b.path));
  return { scannedFiles: files.length, scannedDirs: dirs.length, issues, byKind };
}
