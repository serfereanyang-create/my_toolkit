import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathScopeFor, resolveWorkspacePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';
import { isIgnoredDirName } from '../workspace/ignored.js';


export const searchTextTool: ToolDefinition<{ query: string; path: string; maxMatches: number }> = {
  name: 'search_text',
  description: 'Search text files under the workspace for a literal query.',
  inputHint: '{ "query": "needle", "path": ".", "maxMatches": 20 }',
  risk: 'read',
  parallelSafe: true,
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.query !== 'string' || record.query.length === 0) throw new Error('query is required');
    return {
      query: record.query,
      path: typeof record.path === 'string' ? record.path : '.',
      maxMatches: typeof record.maxMatches === 'number' && record.maxMatches > 0 ? Math.min(Math.floor(record.maxMatches), 100) : 20,
    };
  },
  async execute(input, context) {
    const start = resolveWorkspacePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const matches: Array<{ path: string; line: number; text: string }> = [];
    await search(start, context.workspaceRoot, input.query, input.maxMatches, matches);
    const output = matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n') || '(no matches)';
    return { ok: true, output, data: { matches } };
  },
};

async function search(current: string, workspaceRoot: string, query: string, maxMatches: number, matches: Array<{ path: string; line: number; text: string }>) {
  if (matches.length >= maxMatches) return;
  const info = await stat(current);
  if (info.isDirectory()) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= maxMatches) return;
      if (entry.isDirectory() && isIgnoredDirName(entry.name)) continue;
      await search(join(current, entry.name), workspaceRoot, query, maxMatches, matches);
    }
    return;
  }
  if (!info.isFile() || info.size > 500_000) return;

  let content = '';
  try {
    content = await readFile(current, 'utf8');
  } catch {
    return;
  }
  const rel = relative(workspaceRoot, current).replace(/\\/g, '/');
  content.split(/\r?\n/).forEach((line, index) => {
    if (matches.length < maxMatches && line.includes(query)) {
      matches.push({ path: rel, line: index + 1, text: line.trim().slice(0, 240) });
    }
  });
}
