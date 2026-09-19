/**
 * langStats.ts - Multi-language code distribution statistics.
 *
 * 扫描 workspace 全部源码文件，按扩展名归类，统计：
 *  - 文件数 / 总行数 / 字节数 / 注释行数 / 空行数 / 代码行数
 *  - 平均每文件行数
 *  - 占比（按 LOC 与按文件数）
 *  - 重复行比例（连续相同非空白行）
 */

import { readFile } from 'node:fs/promises';
import { glob } from 'glob';
import { basename } from 'node:path';

export interface LanguageBucket {
  language: string;
  extensions: string[];
  fileCount: number;
  totalLines: number;
  bytes: number;
  commentLines: number;
  blankLines: number;
  codeLines: number;
  /** 简单哈希重复的连续行数 */
  repeatedLines: number;
}

export interface LanguageStatsReport {
  scannedFiles: number;
  totalLines: number;
  totalBytes: number;
  buckets: LanguageBucket[];
}

export const LANG_TABLE: Record<string, { language: string; language2?: undefined }> = {
  ts: { language: 'TypeScript' },
  tsx: { language: 'TypeScript' },
  mts: { language: 'TypeScript' },
  cts: { language: 'TypeScript' },
  js: { language: 'JavaScript' },
  jsx: { language: 'JavaScript' },
  mjs: { language: 'JavaScript' },
  cjs: { language: 'JavaScript' },
  py: { language: 'Python' },
  go: { language: 'Go' },
  rs: { language: 'Rust' },
  java: { language: 'Java' },
  c: { language: 'C' },
  h: { language: 'C' },
  cc: { language: 'C++' },
  cpp: { language: 'C++' },
  cxx: { language: 'C++' },
  hpp: { language: 'C++' },
  cs: { language: 'C#' },
  fs: { language: 'F#' },
  kt: { language: 'Kotlin' },
  kts: { language: 'Kotlin' },
  swift: { language: 'Swift' },
  rb: { language: 'Ruby' },
  php: { language: 'PHP' },
  lua: { language: 'Lua' },
  sh: { language: 'Shell' },
  bash: { language: 'Shell' },
  zsh: { language: 'Shell' },
  ps1: { language: 'PowerShell' },
  sql: { language: 'SQL' },
  html: { language: 'HTML' },
  htm: { language: 'HTML' },
  css: { language: 'CSS' },
  scss: { language: 'SCSS' },
  sass: { language: 'SCSS' },
  less: { language: 'LESS' },
  xml: { language: 'XML' },
  svg: { language: 'SVG' },
  json: { language: 'JSON' },
  yaml: { language: 'YAML' },
  yml: { language: 'YAML' },
  toml: { language: 'TOML' },
  ini: { language: 'INI' },
  md: { language: 'Markdown' },
  mdx: { language: 'Markdown' },
  vue: { language: 'Vue SFC' },
  svelte: { language: 'Svelte' },
  astro: { language: 'Astro' },
  dart: { language: 'Dart' },
  scala: { language: 'Scala' },
  ex: { language: 'Elixir' },
  exs: { language: 'Elixir' },
  erl: { language: 'Erlang' },
  hrl: { language: 'Erlang' },
  elm: { language: 'Elm' },
  hs: { language: 'Haskell' },
  ml: { language: 'OCaml' },
  r: { language: 'R' },
  pl: { language: 'Perl' },
  pm: { language: 'Perl' },
  groovy: { language: 'Groovy' },
  gradle: { language: 'Gradle' },
};

/** 识别扩展名 → 语言 */
export function classify(path: string): string | null {
  const filename = basename(path).toLowerCase();
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const ext = filename.slice(dotIdx + 1);
  return LANG_TABLE[ext]?.language ?? null;
}

/** 计算单文件的行统计 */
export function analyzeFileText(source: string): {
  total: number;
  blank: number;
  comment: number;
  code: number;
  repeated: number;
} {
  const lines = source.split('\n');
  let blank = 0;
  let comment = 0;
  let code = 0;
  let inBlock = false;
  let repeated = 0;
  let prevNonBlank = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      blank += 1;
      continue;
    }
    if (line === prevNonBlank) repeated += 1;
    prevNonBlank = line;

    if (inBlock) {
      comment += 1;
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (
      line.startsWith('//') ||
      line.startsWith('#') ||
      line.startsWith('--') ||
      line.startsWith(';') ||
      line.startsWith('<!--')
    ) {
      comment += 1;
      continue;
    }
    if (line.startsWith('/*')) {
      comment += 1;
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    code += 1;
  }

  return { total: lines.length, blank, comment, code, repeated };
}

/** 扫描整个 workspace */
export async function analyzeLanguages(
  workspaceRoot: string,
  pattern: string,
  maxFiles: number,
): Promise<LanguageStatsReport> {
  const files = await glob(pattern, { cwd: workspaceRoot, nodir: true, absolute: true });
  const selected = files.slice(0, maxFiles);
  const buckets = new Map<string, LanguageBucket>();

  let totalBytes = 0;
  let totalLines = 0;

  for (const file of selected) {
    const language = classify(file);
    if (!language) continue;
    let source: string;
    let bytes: number;
    try {
      const buf = await readFile(file);
      source = buf.toString('utf-8');
      bytes = buf.length;
    } catch {
      continue;
    }
    const stats = analyzeFileText(source);
    const bucket = buckets.get(language) ?? {
      language,
      extensions: [],
      fileCount: 0,
      totalLines: 0,
      bytes: 0,
      commentLines: 0,
      blankLines: 0,
      codeLines: 0,
      repeatedLines: 0,
    };
    bucket.fileCount += 1;
    bucket.totalLines += stats.total;
    bucket.bytes += bytes;
    bucket.commentLines += stats.comment;
    bucket.blankLines += stats.blank;
    bucket.codeLines += stats.code;
    bucket.repeatedLines += stats.repeated;
    buckets.set(language, bucket);

    totalBytes += bytes;
    totalLines += stats.total;
  }

  // 记录扩展名分布（排序后）
  const byLangExtensions = new Map<string, Set<string>>();
  for (const file of selected) {
    const lang = classify(file);
    if (!lang) continue;
    const filename = basename(file).toLowerCase();
    const dot = filename.lastIndexOf('.');
    const ext = dot >= 0 ? filename.slice(dot + 1) : '';
    if (!byLangExtensions.has(lang)) byLangExtensions.set(lang, new Set());
    if (ext) byLangExtensions.get(lang)!.add(ext);
  }
  for (const [lang, bucket] of buckets) {
    bucket.extensions = [...(byLangExtensions.get(lang) ?? new Set())].sort();
  }

  const sorted = [...buckets.values()].sort((a, b) => b.codeLines - a.codeLines);
  return {
    scannedFiles: selected.length,
    totalLines,
    totalBytes,
    buckets: sorted,
  };
}
