import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { NavIndexFile, SymbolHit, SymbolKind } from './types.js';
import { findSymbolsBM25 } from './bm25.js';

export { findSymbolsBM25 };

export function findSymbols(
  index: NavIndexFile,
  query: string,
  options?: { kind?: SymbolKind; pathPrefix?: string; maxResults?: number },
): SymbolHit[] {
  return findSymbolsBM25(index, query, options);
}

export async function findReferences(
  index: NavIndexFile,
  workspaceRoot: string,
  query: string,
  options?: { maxResults?: number },
): Promise<Array<{ path: string; line: number; text: string; isDefinition: boolean }>> {
  const needle = query.trim();
  if (!needle) return [];
  const maxResults = options?.maxResults ?? 50;
  const definitionKeys = new Set(
    index.files.flatMap((file) => file.symbols
      .filter((symbol) => symbol.name === needle)
      .map((symbol) => `${symbol.path}:${symbol.line}`)),
  );
  const results: Array<{ path: string; line: number; text: string; isDefinition: boolean }> = [];
  const pattern = new RegExp(`\\b${escapeRegExp(needle)}\\b`);

  for (const file of index.files) {
    if (results.length >= maxResults) break;
    let content = '';
    try { content = await readFile(resolve(workspaceRoot, file.path), 'utf8'); } catch { continue; }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (results.length >= maxResults) break;
      const text = lines[i] ?? '';
      if (!pattern.test(text)) continue;
      results.push({
        path: file.path, line: i + 1,
        text: text.trim().slice(0, 240),
        isDefinition: definitionKeys.has(`${file.path}:${i + 1}`),
      });
    }
  }
  return results;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
