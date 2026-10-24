import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathScopeFor, resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';
import { isIgnoredDirName } from '../workspace/ignored.js';


function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

export const filename_searchTool: ToolDefinition<{ path: string; query: string; caseSensitive: boolean; maxResults: number }> = {
  name: 'filename_search',
  description: 'Search file basenames under a directory by substring match. Read-only. Useful when you know part of a filename but not the exact path.',
  inputHint: '{ "path": ".", "query": "config", "maxResults": 100 }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.query !== 'string' || !record.query.trim()) throw new Error('query is required');
    return {
      path: typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.',
      query: record.query.trim(),
      caseSensitive: record.caseSensitive === true,
      maxResults: typeof record.maxResults === 'number' && record.maxResults > 0 ? Math.min(Math.floor(record.maxResults), 2000) : 100,
    };
  },
  async execute(input, context) {
    const root = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const out: string[] = [];
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
    await walk(root, out, input.maxResults, (name) => {
      const hay = input.caseSensitive ? name : name.toLowerCase();
      return hay.includes(needle);
    });
    return { ok: true, output: out.join('\n') || '(no matches)', data: { count: out.length, matches: out } };
  },
};

async function walk(current: string, out: string[], maxResults: number, match: (name: string) => boolean): Promise<void> {
  if (out.length >= maxResults) return;
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= maxResults) return;
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredDirName(entry.name)) continue;
      await walk(full, out, maxResults, match);
      continue;
    }
    if (entry.isFile() && match(basename(entry.name))) out.push(full);
  }
}
