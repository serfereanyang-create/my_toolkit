/**
 * tsMigration.ts - JS -> TS 迁移进度评估
 *
 * 统计工作区里 .js/.jsx 与 .ts/.tsx 的分布，估算迁移完成度；
 * 列出最大的几个待迁移 js 文件作为起点。不执行任何代码。
 */

import { readFile } from 'node:fs/promises';
import { glob } from 'glob';

export interface MigrationFileEntry {
  file: string;
  language: 'js' | 'jsx' | 'ts' | 'tsx';
  lines: number;
  hasTypeAnnotations: boolean;
}

export interface TsMigrationReport {
  scanned: number;
  totalFiles: number;
  tsFiles: number;
  jsFiles: number;
  jsxFiles: number;
  tsxFiles: number;
  tsRatio: number;
  largestJs: Array<{ file: string; lines: number }>;
  suggestions: string[];
}

export function classifyFile(file: string): MigrationFileEntry['language'] {
  const lower = file.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts')) return 'ts';
  if (lower.endsWith('.jsx')) return 'jsx';
  return 'js';
}

function looksTyped(source: string): boolean {
  // 快速启发：含 ": Type" / interface / type 关键字 / generics
  return (
    /:\s*(string|number|boolean|unknown|void|any|Record<|Array<|Promise<)/.test(source) ||
    /\binterface\s+\w+/.test(source) ||
    /\btype\s+\w+\s*=/.test(source)
  );
}

export async function assessTsMigration(
  workspaceRoot: string,
  pattern: string,
  maxFiles: number,
): Promise<TsMigrationReport> {
  const files = await glob(pattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  const selected = files.slice(0, maxFiles);

  const entries: MigrationFileEntry[] = [];
  for (const file of selected) {
    let source: string;
    try {
      source = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    entries.push({
      file,
      language: classifyFile(file),
      lines: source.split('\n').length,
      hasTypeAnnotations: looksTyped(source),
    });
  }

  const tsFiles = entries.filter((e) => e.language === 'ts').length;
  const tsxFiles = entries.filter((e) => e.language === 'tsx').length;
  const jsFiles = entries.filter((e) => e.language === 'js').length;
  const jsxFiles = entries.filter((e) => e.language === 'jsx').length;
  const total = entries.length;
  const tsRatio = total > 0 ? (tsFiles + tsxFiles) / total : 0;

  const largestJs = entries
    .filter((e) => e.language === 'js' || e.language === 'jsx')
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 15)
    .map((e) => ({ file: e.file, lines: e.lines }));

  const suggestions: string[] = [];
  if (tsRatio >= 0.9) suggestions.push('迁移基本完成，重点放在把周边工具链迁完');
  if (tsRatio >= 0.5 && tsRatio < 0.9) suggestions.push('迁移进度过半；优先迁公共模块与网络/状态层');
  if (tsRatio < 0.5 && total > 0) suggestions.push('迁移刚起步：先在共享边（utils/api）上启用 ts，然后逐步外围');
  if (entries.some((e) => e.language === 'js' && e.hasTypeAnnotations)) {
    suggestions.push('检测到带类型注解风格的 .js 文件，可以优先把扩展名直接改为 .ts');
  }
  if (jsxFiles > 0 && tsxFiles === 0) {
    suggestions.push('有 JSX 但没有 TSX：可先为个别组件文件启用 .tsx，减少骨架改动');
  }

  return {
    scanned: selected.length,
    totalFiles: total,
    tsFiles,
    jsFiles,
    jsxFiles,
    tsxFiles,
    tsRatio: Math.round(tsRatio * 1000) / 1000,
    largestJs,
    suggestions,
  };
}
