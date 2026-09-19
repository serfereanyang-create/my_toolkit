/**
 * commentDensity.ts - Measure comment density and quality.
 *
 * 比例指标：注释行数 / 总代码行数 / 文件级平均。
 * 额外给"文档注释占比"识别被 TSDoc/JSDoc 覆盖的导出符号比例。
 */

import { readFile } from 'node:fs/promises';
import { glob } from 'glob';

export interface FileCommentStats {
  file: string;
  totalLines: number;
  commentLines: number;
  blankLines: number;
  codeLines: number;
  commentDensity: number; // 0..1
  jsdocBlocks: number;
}

export interface CommentReport {
  scannedFiles: number;
  totals: {
    lines: number;
    comments: number;
    blanks: number;
    code: number;
  };
  avgDensity: number;
  files: FileCommentStats[];
  /** 密度低（< 0.05）且有相当规模的文件 */
  underDocumented: FileCommentStats[];
  /** 注释占比过高的文件（可能注释冗余） */
  overDocumented: FileCommentStats[];
}

const BLOCK_START = '/*';
const BLOCK_END = '*/';
const LINE_COMMENT = '//';

export function analyzeFileComments(filePath: string, source: string): FileCommentStats {
  const lines = source.split('\n');
  let commentLines = 0;
  let blankLines = 0;
  let codeLines = 0;
  let jsdocBlocks = 0;
  let inBlock = false;
  let blockIsDoc = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      blankLines += 1;
      continue;
    }
    if (inBlock) {
      commentLines += 1;
      if (line.includes(BLOCK_END)) {
        inBlock = false;
        if (blockIsDoc) jsdocBlocks += 1;
        blockIsDoc = false;
      }
      continue;
    }
    if (line.startsWith(LINE_COMMENT)) {
      commentLines += 1;
      continue;
    }
    if (line.startsWith('/**')) {
      inBlock = !line.includes(BLOCK_END);
      blockIsDoc = true;
      commentLines += 1;
      if (!inBlock) jsdocBlocks += 1;
      continue;
    }
    if (line.startsWith(BLOCK_START)) {
      inBlock = !line.includes(BLOCK_END);
      blockIsDoc = false;
      commentLines += 1;
      continue;
    }
    codeLines += 1;
  }

  const total = lines.length;
  const density = total > 0 ? commentLines / total : 0;
  return {
    file: filePath,
    totalLines: total,
    commentLines,
    blankLines,
    codeLines,
    commentDensity: density,
    jsdocBlocks,
  };
}

export async function analyzeWorkspaceComments(
  workspaceRoot: string,
  pattern: string,
  maxFiles: number,
): Promise<CommentReport> {
  const files = await glob(pattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  const selected = files.slice(0, maxFiles);
  const stats: FileCommentStats[] = [];
  for (const file of selected) {
    let source: string;
    try {
      source = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    stats.push(analyzeFileComments(file, source));
  }

  const totals = stats.reduce(
    (acc, s) => ({
      lines: acc.lines + s.totalLines,
      comments: acc.comments + s.commentLines,
      blanks: acc.blanks + s.blankLines,
      code: acc.code + s.codeLines,
    }),
    { lines: 0, comments: 0, blanks: 0, code: 0 },
  );
  const avgDensity = stats.length > 0 ? stats.reduce((n, s) => n + s.commentDensity, 0) / stats.length : 0;

  const underDocumented = stats
    .filter((s) => s.commentDensity < 0.05 && s.codeLines >= 50)
    .sort((a, b) => a.commentDensity - b.commentDensity)
    .slice(0, 20);
  const overDocumented = stats
    .filter((s) => s.commentDensity > 0.6 && s.totalLines > 20)
    .sort((a, b) => b.commentDensity - a.commentDensity)
    .slice(0, 20);

  return {
    scannedFiles: selected.length,
    totals,
    avgDensity: Math.round(avgDensity * 1000) / 1000,
    files: stats,
    underDocumented,
    overDocumented,
  };
}
