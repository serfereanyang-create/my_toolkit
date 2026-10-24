import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { pathScopeFor, resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';
import { isIgnoredDirName } from '../workspace/ignored.js';


function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

function resolveAny(workspaceRoot: string, value: string) {
  if (isAbsolute(value)) return normalize(resolve(value));
  return normalize(resolve(workspaceRoot, value));
}

function commonPrefix(items: string[]) {
  if (items.length === 0) return '';
  let prefix = items[0]!;
  for (let i = 1; i < items.length; i += 1) {
    const value = items[i]!;
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index += 1;
    prefix = prefix.slice(0, index);
    if (!prefix) break;
  }
  return prefix;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export const pathIsAbsoluteTool: ToolDefinition<{ path: string }> = {
  name: 'path_is_absolute', description: 'Check whether a path string is absolute. Pure path operation.', inputHint: '{ "path": "C:/work/a.txt" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string') throw new Error('path is required'); return { path: record.path }; },
  async execute(input) { return { ok: true, output: isAbsolute(input.path) ? 'true' : 'false', data: { absolute: isAbsolute(input.path) } }; },
};

export const pathChangeExtTool: ToolDefinition<{ path: string; ext: string }> = {
  name: 'path_change_ext', description: 'Replace a path extension with a new one. Pure path operation.', inputHint: '{ "path": "src/app.ts", "ext": ".js" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string' || typeof record.ext !== 'string') throw new Error('path and ext are required'); return { path: record.path, ext: record.ext.startsWith('.') ? record.ext : `.${record.ext}` }; },
  async execute(input) { const oldExt = extname(input.path); const output = oldExt ? input.path.slice(0, -oldExt.length) + input.ext : input.path + input.ext; return { ok: true, output, data: { path: output } }; },
};

export const pathAncestorsTool: ToolDefinition<{ path: string; maxDepth: number }> = {
  name: 'path_ancestors', description: 'List ancestor directories of a path, nearest first. Pure path operation.', inputHint: '{ "path": "src/components/App.tsx" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string') throw new Error('path is required'); return { path: record.path, maxDepth: typeof record.maxDepth === 'number' && record.maxDepth > 0 ? Math.min(Math.floor(record.maxDepth), 100) : 20 }; },
  async execute(input) { const out: string[] = []; let current = normalize(input.path); for (let i = 0; i < input.maxDepth; i += 1) { const parent = dirname(current); if (parent === current) break; out.push(parent); current = parent; } return { ok: true, output: out.join('\n') || '(root only)', data: { ancestors: out } }; },
};

export const pathDepthTool: ToolDefinition<{ path: string }> = {
  name: 'path_depth', description: 'Count how many path segments a path contains. Pure path operation.', inputHint: '{ "path": "src/components/App.tsx" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string') throw new Error('path is required'); return { path: record.path }; },
  async execute(input) { const depth = normalize(input.path).split(/[\\/]+/).filter(Boolean).length; return { ok: true, output: String(depth), data: { depth } }; },
};

export const pathCommonPrefixTool: ToolDefinition<{ paths: string[] }> = {
  name: 'path_common_prefix', description: 'Find the common string prefix of multiple paths. Useful for grouping similar paths quickly.', inputHint: '{ "paths": ["src/a.ts", "src/b.ts"] }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.paths) || record.paths.length === 0) throw new Error('paths must be a non-empty array'); return { paths: record.paths.filter((item): item is string => typeof item === 'string' && item.length > 0) }; },
  async execute(input) { const output = commonPrefix(input.paths); return { ok: true, output, data: { prefix: output } }; },
};

export const pathMatchesGlobTool: ToolDefinition<{ path: string; pattern: string }> = {
  name: 'path_matches_glob', description: 'Check whether a basename matches a simple glob (* and ?). Pure path operation.', inputHint: '{ "path": "src/app.test.ts", "pattern": "*.test.ts" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string' || typeof record.pattern !== 'string') throw new Error('path and pattern are required'); return { path: record.path, pattern: record.pattern }; },
  async execute(input) { const matched = globToRegExp(input.pattern).test(basename(input.path)); return { ok: true, output: matched ? 'true' : 'false', data: { matched } }; },
};

export const fileExtensionsInDirTool: ToolDefinition<{ path: string }> = {
  name: 'file_extensions_in_dir', description: 'List file extensions present under a directory with counts. Read-only.', inputHint: '{ "path": "src" }', risk: 'read',
  validate(input) { const record = asRecord(input); return { path: typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.' }; },
  async execute(input, context) {
    const root = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval)); const counts = new Map<string, number>();
    await walk(root, async (file) => { const ext = extname(file).toLowerCase() || '(none)'; counts.set(ext, (counts.get(ext) ?? 0) + 1); });
    return { ok: true, output: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([ext, count]) => `${ext}: ${count}`).join('\n') || '(no files)', data: { byExtension: Object.fromEntries(counts) } };
  },
};

export const emptyDirsTool: ToolDefinition<{ path: string; maxResults: number }> = {
  name: 'empty_dirs', description: 'List empty directories under a path. Read-only.', inputHint: '{ "path": ".", "maxResults": 100 }', risk: 'read',
  validate(input) { const record = asRecord(input); return { path: typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.', maxResults: typeof record.maxResults === 'number' && record.maxResults > 0 ? Math.min(Math.floor(record.maxResults), 2000) : 100 }; },
  async execute(input, context) { const root = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval)); const out: string[] = []; await walkDirs(root, root, out, input.maxResults); return { ok: true, output: out.join('\n') || '(no empty dirs)', data: { count: out.length, dirs: out } }; },
};

export const siblingFilesTool: ToolDefinition<{ path: string }> = {
  name: 'sibling_files', description: 'List files that share the same directory as a given file. Read-only.', inputHint: '{ "path": "src/index.ts" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required'); return { path: record.path.trim() }; },
  async execute(input, context) { const target = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval)); const dir = dirname(target); const entries = await readdir(dir, { withFileTypes: true }); const siblings = entries.filter((entry) => entry.isFile()).map((entry) => entry.name); return { ok: true, output: siblings.join('\n') || '(no sibling files)', data: { count: siblings.length, siblings } }; },
};

export const duplicateFilenamesTool: ToolDefinition<{ path: string; maxResults: number }> = {
  name: 'duplicate_filenames', description: 'Find files under a directory that share the same basename. Read-only.', inputHint: '{ "path": ".", "maxResults": 100 }', risk: 'read',
  validate(input) { const record = asRecord(input); return { path: typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.', maxResults: typeof record.maxResults === 'number' && record.maxResults > 0 ? Math.min(Math.floor(record.maxResults), 1000) : 100 }; },
  async execute(input, context) { const root = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval)); const byName = new Map<string, string[]>(); await walk(root, async (file) => { const key = basename(file); const list = byName.get(key) ?? []; list.push(relative(context.workspaceRoot, file).replace(/\\/g, '/')); byName.set(key, list); }); const duplicates = [...byName.entries()].filter(([, files]) => files.length > 1).slice(0, input.maxResults); return { ok: true, output: duplicates.length ? duplicates.map(([name, files]) => `${name}\n  ${files.join('\n  ')}`).join('\n') : '(no duplicates)', data: { count: duplicates.length } }; },
};

export const pathCompareTool: ToolDefinition<{ left: string; right: string }> = {
  name: 'path_compare', description: 'Compare two paths after normalization and report equality. Pure path operation.', inputHint: '{ "left": "src/../src/app.ts", "right": "src/app.ts" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.left !== 'string' || typeof record.right !== 'string') throw new Error('left and right are required'); return { left: record.left, right: record.right }; },
  async execute(input) { const equal = normalize(input.left) === normalize(input.right); return { ok: true, output: equal ? 'equal' : 'different', data: { equal } }; },
};

export const pathStemTool: ToolDefinition<{ path: string }> = {
  name: 'path_stem', description: 'Return the file stem (basename without extension). Pure path operation.', inputHint: '{ "path": "report.final.pdf" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string') throw new Error('path is required'); return { path: record.path }; },
  async execute(input) { const base = basename(input.path); const ext = extname(base); return { ok: true, output: ext ? base.slice(0, -ext.length) : base }; },
};

export const pathParentTool: ToolDefinition<{ path: string }> = {
  name: 'path_parent', description: 'Return the immediate parent directory of a path. Pure path operation.', inputHint: '{ "path": "src/components/App.tsx" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string') throw new Error('path is required'); return { path: record.path }; },
  async execute(input) { return { ok: true, output: dirname(input.path) }; },
};

export const hiddenFilesTool: ToolDefinition<{ path: string; maxResults: number }> = {
  name: 'hidden_files', description: 'List dot-prefixed hidden files under a directory. Read-only.', inputHint: '{ "path": ".", "maxResults": 200 }', risk: 'read',
  validate(input) { const record = asRecord(input); return { path: typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.', maxResults: typeof record.maxResults === 'number' && record.maxResults > 0 ? Math.min(Math.floor(record.maxResults), 2000) : 200 }; },
  async execute(input, context) { const root = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval)); const out: string[] = []; await walk(root, async (file) => { const name = basename(file); if (name.startsWith('.')) out.push(relative(context.workspaceRoot, file).replace(/\\/g, '/')); }); return { ok: true, output: out.slice(0, input.maxResults).join('\n') || '(no hidden files)', data: { count: Math.min(out.length, input.maxResults) } }; },
};

export const directoryDepthSummaryTool: ToolDefinition<{ path: string }> = {
  name: 'directory_depth_summary', description: 'Count files by relative depth under a directory. Read-only.', inputHint: '{ "path": "." }', risk: 'read',
  validate(input) { const record = asRecord(input); return { path: typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.' }; },
  async execute(input, context) { const root = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval)); const counts = new Map<number, number>(); await walk(root, async (file) => { const depth = relative(root, file).split(/[\\/]+/).filter(Boolean).length; counts.set(depth, (counts.get(depth) ?? 0) + 1); }); return { ok: true, output: [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([depth, count]) => `${depth}: ${count}`).join('\n') || '(no files)', data: { byDepth: Object.fromEntries(counts) } }; },
};

export const nearestAncestorWithTool: ToolDefinition<{ path: string; targetName: string }> = {
  name: 'nearest_ancestor_with', description: 'Walk up parent directories from a starting path and return the nearest ancestor containing a named file or directory. Read-only.', inputHint: '{ "path": "src/components/App.tsx", "targetName": "package.json" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string' || typeof record.targetName !== 'string' || !record.targetName.trim()) throw new Error('path and targetName are required'); return { path: record.path, targetName: record.targetName.trim() }; },
  async execute(input, context) { let current = dirname(resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval))); while (true) { const candidate = join(current, input.targetName); try { await stat(candidate); return { ok: true, output: candidate, data: { path: candidate } }; } catch {} const parent = dirname(current); if (parent === current) break; current = parent; } return { ok: false, output: `${input.targetName} not found in ancestors of ${input.path}` }; },
};

async function walk(root: string, onFile: (file: string) => Promise<void>): Promise<void> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredDirName(entry.name)) continue;
      await walk(full, onFile);
    } else if (entry.isFile()) {
      await onFile(full);
    }
  }
}

async function walkDirs(baseRoot: string, current: string, out: string[], maxResults: number): Promise<void> {
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
  const visible = entries.filter((entry) => !isIgnoredDirName(entry.name));
  if (visible.length === 0 && current !== baseRoot) {
    out.push(relative(baseRoot, current).replace(/\\/g, '/'));
    if (out.length >= maxResults) return;
  }
  for (const entry of visible) {
    if (!entry.isDirectory()) continue;
    await walkDirs(baseRoot, join(current, entry.name), out, maxResults);
    if (out.length >= maxResults) return;
  }
}
