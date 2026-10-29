import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { NavIndexFile, SymbolHit, SymbolKind } from './types.js';
import { findSymbolsBM25 } from './bm25.js';

export { findSymbolsBM25 };

/**
 * Resolve an index-relative path, refusing anything that escapes the
 * workspace. The index is cache data (`workspaceRoot` in the JSON is not
 * re-checked by the loader), so a stale/copied index — or a crafted
 * `.aicode/nav/index.json` — could otherwise make find_references read and
 * print files from outside the workspace (`../../etc/passwd`, `C:\Windows\…`,
 * `\\server\share`). Returns undefined for escaped paths.
 */
export function resolveIndexedPath(workspaceRoot: string, indexedPath: string): string | undefined {
  if (typeof indexedPath !== 'string' || !indexedPath) return undefined;
  const root = resolve(workspaceRoot);
  const absolute = resolve(root, indexedPath);
  if (absolute !== root && !absolute.startsWith(root + sep)) return undefined;
  return absolute;
}

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
  // `\b` only knows [A-Za-z0-9_]: searching `foo` matched `foo$bar` and
  // `fooé` — the JS identifier characters `$` and any (non-)ASCII letter the
  // regex engine does not treat as word chars. Match identifiers by explicit
  // neighbours instead.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegExp(needle)}(?![\\p{L}\\p{N}_$])`, 'u');

  for (const file of index.files) {
    if (results.length >= maxResults) break;
    const absolute = resolveIndexedPath(workspaceRoot, file.path);
    if (!absolute) continue;
    let content = '';
    try { content = await readFile(absolute, 'utf8'); } catch { continue; }
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
