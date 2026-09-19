/**
 * parseCache.ts — 分析器共享的源码 AST 解析缓存
 *
 * 复杂度、异味等分析器对同一批文件各自 readFile + createSourceFile；连续调用
 * 多个分析工具时同一文件会被重复解析。这里按 (path, size, mtimeMs) 缓存解析
 * 结果，跨工具复用，并对单文件大小与缓存总量设上限，避免大仓库拖垮内存。
 */

import { readFile, stat } from 'node:fs/promises';
import * as ts from 'typescript';

/** 单文件解析上限：超过此大小的源文件跳过分析（调用方按不可解析处理）。 */
export const MAX_PARSE_FILE_BYTES = 2 * 1024 * 1024;

const MAX_CACHE_ENTRIES = 512;

const cache = new Map<string, { key: string; sourceFile: ts.SourceFile }>();

function stamp(size: number, mtimeMs: number): string {
  return `${size}:${Math.round(mtimeMs)}`;
}

/**
 * 读取并解析一个源文件；缓存命中时零成本复用。
 * 文件不存在、不是常规文件、超过单文件上限或读取失败时返回 null，
 * 调用方按"跳过该文件"处理。
 */
export async function parseSourceFile(
  displayPath: string,
  absolutePath: string,
): Promise<ts.SourceFile | null> {
  let statInfo;
  try {
    statInfo = await stat(absolutePath);
  } catch {
    return null;
  }
  if (!statInfo.isFile() || statInfo.size > MAX_PARSE_FILE_BYTES) return null;

  const key = stamp(statInfo.size, statInfo.mtimeMs);
  const hit = cache.get(absolutePath);
  if (hit && hit.key === key) {
    // LRU touch
    cache.delete(absolutePath);
    cache.set(absolutePath, hit);
    return hit.sourceFile;
  }

  let content: string;
  try {
    content = await readFile(absolutePath, 'utf-8');
  } catch {
    return null;
  }
  const sourceFile = ts.createSourceFile(displayPath, content, ts.ScriptTarget.Latest, true);

  cache.delete(absolutePath);
  cache.set(absolutePath, { key, sourceFile });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return sourceFile;
}

/** 诊断用：当前缓存条目数。 */
export function parseCacheSize(): number {
  return cache.size;
}
