/**
 * generate.ts — 从 preset 生成项目文件。
 *
 * 安全约束：
 *  - 目标目录必须位于 workspaceRoot 之内（逐段校验，拒绝逃逸）
 *  - 已存在的文件一律跳过（绝不覆盖用户内容），并如实报告 skipped 列表
 *  - 纯 fs.writeFile，无命令执行、无网络
 */

import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, dirname, relative, resolve, sep } from 'node:path';
import { SCAFFOLD_PRESETS, type ScaffoldFile, type ScaffoldVars } from './presets.js';

export interface GenerateOptions {
  workspaceRoot: string;
  /** 目标目录（相对 workspaceRoot；'.' 表示直接生成在根） */
  targetDir: string;
  presetId: string;
  projectName: string;
}

export interface GenerateResult {
  ok: boolean;
  presetId: string;
  target: string;
  created: string[];
  skipped: string[];
  errors: string[];
}

/** 把项目名清洗成安全的目录/包名片段。 */
export function sanitizeProjectName(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  // `.` 和 `..` 通过了字符过滤，但作为包名/目录名分别表示"当前目录"和"上一级"：
  // 探针 `projectName: "."` 写出了 `"name": "."`，配 `targetDir: "."` 就直接在
  // 工作区根上生成骨架。这类纯点名字回退到默认值。
  if (!cleaned || /^\.+$/.test(cleaned)) return 'my-project';
  return cleaned;
}

/** 解析并校验目标目录：必须在 workspaceRoot 内。 */
export function resolveTargetInsideRoot(workspaceRoot: string, targetDir: string): { abs: string; rel: string } | null {
  const rootAbs = resolve(workspaceRoot);
  const targetAbs = resolve(rootAbs, targetDir || '.');
  // 用 relative() 判定包含关系：Windows 路径大小写不敏感，`startsWith` 会把
  // `D:\WORK` 当成 `D:\work` 之外；跨盘时 relative() 返回绝对路径，也要拒绝。
  const rel = relative(rootAbs, targetAbs);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) return null;
  return { abs: targetAbs, rel: targetDir || '.' };
}

/**
 * True when `path` still resolves inside `root` after following symlinks and
 * Windows junctions.
 *
 * The textual containment check in `resolveTargetInsideRoot` only reasons about
 * the path string. A junction (`mklink /J demo\src <outside>`) is a directory
 * the string check cannot see, so generated files were written outside the
 * workspace through it (probe: 6 files created in a temp dir outside the
 * workspace). `realpath` is only consulted for the part of the path that
 * exists; a not-yet-created tail cannot contain links.
 */
async function realPathInsideRoot(rootAbs: string, path: string): Promise<boolean> {
  let root: string;
  try {
    root = await realpath(rootAbs);
  } catch {
    return true; // root itself is gone/renamed: nothing meaningful to compare.
  }
  let probe = path;
  for (;;) {
    try {
      const resolved = await realpath(probe);
      const rel = relative(root, resolved);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return true;
      probe = parent;
    }
  }
}

export async function generateProject(options: GenerateOptions): Promise<GenerateResult> {
  const result: GenerateResult = {
    ok: false,
    presetId: options.presetId,
    target: options.targetDir,
    created: [],
    skipped: [],
    errors: [],
  };

  const preset = SCAFFOLD_PRESETS[options.presetId];
  if (!preset) {
    result.errors.push(`未知模板: ${options.presetId}（可用: ${Object.keys(SCAFFOLD_PRESETS).join(', ')}）`);
    return result;
  }

  const target = resolveTargetInsideRoot(options.workspaceRoot, options.targetDir);
  if (!target) {
    result.errors.push('目标目录越出工作区，已拒绝。');
    return result;
  }

  const vars: ScaffoldVars = { projectName: sanitizeProjectName(options.projectName) };
  const files: ScaffoldFile[] = preset.files(vars);

  for (const file of files) {
    // 文件路径同样不得逃逸目标目录（../ 检查）
    const fileAbs = resolve(target.abs, file.path);
    if (!fileAbs.startsWith(target.abs + sep) && fileAbs !== target.abs) {
      result.errors.push(`模板路径越界: ${file.path}`);
      continue;
    }
    // 符号链接/junction：字符串检查看不见，写入前按真实路径再判一次。
    if (!(await realPathInsideRoot(target.abs, dirname(fileAbs)))) {
      result.errors.push(`模板路径经符号链接越出目标目录: ${file.path}`);
      continue;
    }
    if (existsSync(fileAbs)) {
      result.skipped.push(file.path);
      continue;
    }
    try {
      await mkdir(dirname(fileAbs), { recursive: true });
      await writeFile(fileAbs, file.content, 'utf-8');
      result.created.push(file.path);
    } catch (err) {
      result.errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

/** 读取生成后的 README 首段（用于报告预览）。失败返回空串。 */
export async function readGeneratedReadme(workspaceRoot: string, targetDir: string): Promise<string> {
  const target = resolveTargetInsideRoot(workspaceRoot, targetDir);
  if (!target) return '';
  const readmePath = join(target.abs, 'README.md');
  try {
    const text = await readFile(readmePath, 'utf-8');
    return text.split('\n').slice(0, 6).join('\n');
  } catch {
    return '';
  }
}
