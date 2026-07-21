import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { NavIndexFile, SymbolHit, SymbolKind, SymbolRecord } from './types.js';

export function findSymbols(
  index: NavIndexFile,
  query: string,
  options?: { kind?: SymbolKind; pathPrefix?: string; maxResults?: number },
): SymbolHit[] {
  const needle = query.trim();
  if (!needle) return [];
  const maxResults = options?.maxResults ?? 20;
  const lower = needle.toLowerCase();
  const hits: SymbolHit[] = [];

  for (const file of index.files) {
    if (options?.pathPrefix && !file.path.startsWith(options.pathPrefix.replace(/\\/g, '/'))) continue;
    for (const symbol of file.symbols) {
      if (options?.kind && symbol.kind !== options.kind) continue;
      const score = scoreSymbol(symbol, lower);
      if (score <= 0) continue;
      hits.push({ ...symbol, score });
    }
  }

  hits.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line);
  return hits.slice(0, maxResults);
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
    if (file.language === 'other' && !file.path.endsWith('.json') && !file.path.endsWith('.md')) {
      // still allow scanning non-code lightly only if previously indexed path exists
    }
    let content = '';
    try {
      content = await readFile(resolve(workspaceRoot, file.path), 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let indexLine = 0; indexLine < lines.length; indexLine += 1) {
      if (results.length >= maxResults) break;
      const text = lines[indexLine] ?? '';
      if (!pattern.test(text)) continue;
      const key = `${file.path}:${indexLine + 1}`;
      results.push({
        path: file.path,
        line: indexLine + 1,
        text: text.trim().slice(0, 240),
        isDefinition: definitionKeys.has(key),
      });
    }
  }

  return results;
}

function scoreSymbol(symbol: SymbolRecord, lowerQuery: string): number {
  const name = symbol.name.toLowerCase();
  let score = 0;
  if (name === lowerQuery) score += 100;
  else if (name.startsWith(lowerQuery)) score += 70;
  else if (name.includes(lowerQuery)) score += 40;
  else return 0;
  if (symbol.exported) score += 10;
  if (symbol.kind === 'function' || symbol.kind === 'class') score += 5;
  return score;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
