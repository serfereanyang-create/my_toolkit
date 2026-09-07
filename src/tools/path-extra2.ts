import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.aicode']);

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveAny(workspaceRoot: string, value: string) {
  if (isAbsolute(value)) return normalize(resolve(value));
  return normalize(resolve(workspaceRoot, value));
}

export const pathExistsTool: ToolDefinition<{ path: string }> = {
  name: 'path_exists', description: 'Check whether a readable file or directory exists. Read-only.', inputHint: '{ "path": "package.json" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required'); return { path: record.path.trim() }; },
  async execute(input, context) { try { const target = resolveReadablePath(context.workspaceRoot, input.path); const info = await stat(target); return { ok: true, output: `${input.path} exists (${info.isDirectory() ? 'directory' : 'file'})`, data: { path: target, exists: true } }; } catch { return { ok: true, output: `${input.path} does not exist`, data: { path: input.path, exists: false } }; } },
};

export const pathNormalizeTool: ToolDefinition<{ path: string }> = {
  name: 'path_normalize', description: 'Normalize a path string by resolving dot segments and separator style. Pure string/path operation.', inputHint: '{ "path": "src/../README.md" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required'); return { path: record.path }; },
  async execute(input, context) { const normalized = resolveAny(context.workspaceRoot, input.path); return { ok: true, output: normalized, data: { normalized } }; },
};

export const pathJoinTool: ToolDefinition<{ parts: string[] }> = {
  name: 'path_join', description: 'Join multiple path segments into one normalized path. Pure string/path operation.', inputHint: '{ "parts": ["src", "components", "App.tsx"] }', risk: 'read',
  validate(input) { const record = asRecord(input); if (!Array.isArray(record.parts) || record.parts.length === 0) throw new Error('parts must be a non-empty array'); return { parts: record.parts.filter((p): p is string => typeof p === 'string' && p.length > 0) }; },
  async execute(input) { const output = normalize(join(...input.parts)); return { ok: true, output, data: { path: output } }; },
};

export const pathRelativeTool: ToolDefinition<{ from: string; to: string }> = {
  name: 'path_relative', description: 'Compute the relative path from one location to another. Pure string/path operation.', inputHint: '{ "from": "src", "to": "src/components/App.tsx" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.from !== 'string' || typeof record.to !== 'string') throw new Error('from and to are required'); return { from: record.from, to: record.to }; },
  async execute(input, context) { const value = relative(resolveAny(context.workspaceRoot, input.from), resolveAny(context.workspaceRoot, input.to)); return { ok: true, output: value || '.', data: { relative: value || '.' } }; },
};

export const pathDirnameTool: ToolDefinition<{ path: string }> = {
  name: 'path_dirname', description: 'Return the parent directory of a path. Pure string/path operation.', inputHint: '{ "path": "src/components/App.tsx" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required'); return { path: record.path }; },
  async execute(input) { return { ok: true, output: dirname(input.path), data: { dirname: dirname(input.path) } }; },
};

export const pathBasenameTool: ToolDefinition<{ path: string; suffix?: string }> = {
  name: 'path_basename', description: 'Return the basename of a path, optionally stripping a suffix. Pure string/path operation.', inputHint: '{ "path": "src/components/App.tsx", "suffix": ".tsx" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required'); return { path: record.path, suffix: typeof record.suffix === 'string' ? record.suffix : undefined }; },
  async execute(input) { const value = basename(input.path, input.suffix); return { ok: true, output: value, data: { basename: value } }; },
};

export const pathExtnameTool: ToolDefinition<{ path: string }> = {
  name: 'path_extname', description: 'Return the extension of a path. Pure string/path operation.', inputHint: '{ "path": "archive.tar.gz" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required'); return { path: record.path }; },
  async execute(input) { const value = extname(input.path); return { ok: true, output: value || '(no extension)', data: { extname: value } }; },
};

export const pathPartsTool: ToolDefinition<{ path: string }> = {
  name: 'path_parts', description: 'Split a path into dirname, basename, stem, and extension. Pure string/path operation.', inputHint: '{ "path": "src/components/App.tsx" }', risk: 'read',
  validate(input) { const record = asRecord(input); if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required'); return { path: record.path }; },
  async execute(input) { const dir = dirname(input.path); const base = basename(input.path); const ext = extname(input.path); const stem = ext ? base.slice(0, -ext.length) : base; return { ok: true, output: `dirname: ${dir}\nbasename: ${base}\nstem: ${stem}\nextname: ${ext || '(none)'}`, data: { dirname: dir, basename: base, stem, extname: ext } }; },
};

export const listDirsTool: ToolDefinition<{ path: string; recursive: boolean; maxResults: number }> = {
  name: 'list_dirs', description: 'List directories under a path, optionally recursively. Read-only.', inputHint: '{ "path": ".", "recursive": true, "maxResults": 200 }', risk: 'read',
  validate(input) { const record = asRecord(input); const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.'; return { path, recursive: record.recursive === true, maxResults: typeof record.maxResults === 'number' && record.maxResults > 0 ? Math.min(Math.floor(record.maxResults), 5000) : 200 }; },
  async execute(input, context) {
    const root = resolveReadablePath(context.workspaceRoot, input.path); const out: string[] = [];
    await walkDirs(root, root, out, input.maxResults, input.recursive);
    return { ok: true, output: out.length ? out.join('\n') : '(no directories)', data: { count: out.length, dirs: out } };
  },
};

export const recentFilesTool: ToolDefinition<{ path: string; maxResults: number }> = {
  name: 'recent_files', description: 'List the most recently modified files under a directory. Read-only.', inputHint: '{ "path": "src", "maxResults": 20 }', risk: 'read',
  validate(input) { const record = asRecord(input); const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.'; const maxResults = typeof record.maxResults === 'number' && record.maxResults > 0 ? Math.min(Math.floor(record.maxResults), 500) : 20; return { path, maxResults }; },
  async execute(input, context) {
    const root = resolveReadablePath(context.workspaceRoot, input.path); const out: Array<{ path: string; mtime: number }> = [];
    await walkFiles(root, async (file) => { const info = await stat(file); out.push({ path: relative(context.workspaceRoot, file).replace(/\\/g, '/'), mtime: info.mtimeMs }); });
    out.sort((a, b) => b.mtime - a.mtime);
    const picked = out.slice(0, input.maxResults);
    return { ok: true, output: picked.map((item) => `${new Date(item.mtime).toISOString()}  ${item.path}`).join('\n') || '(no files)', data: { count: picked.length, files: picked } };
  },
};

export const largestFilesTool: ToolDefinition<{ path: string; maxResults: number }> = {
  name: 'largest_files', description: 'List the largest files under a directory. Read-only.', inputHint: '{ "path": ".", "maxResults": 20 }', risk: 'read',
  validate(input) { const record = asRecord(input); const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.'; const maxResults = typeof record.maxResults === 'number' && record.maxResults > 0 ? Math.min(Math.floor(record.maxResults), 500) : 20; return { path, maxResults }; },
  async execute(input, context) {
    const root = resolveReadablePath(context.workspaceRoot, input.path); const out: Array<{ path: string; size: number }> = [];
    await walkFiles(root, async (file) => { const info = await stat(file); out.push({ path: relative(context.workspaceRoot, file).replace(/\\/g, '/'), size: info.size }); });
    out.sort((a, b) => b.size - a.size);
    const picked = out.slice(0, input.maxResults);
    return { ok: true, output: picked.map((item) => `${formatBytes(item.size).padStart(10)}  ${item.path}`).join('\n') || '(no files)', data: { count: picked.length, files: picked } };
  },
};

export const directorySummaryTool: ToolDefinition<{ path: string }> = {
  name: 'directory_summary', description: 'Summarize a directory: file count, directory count, total bytes, and top extensions. Read-only.', inputHint: '{ "path": "src" }', risk: 'read',
  validate(input) { const record = asRecord(input); const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.'; return { path }; },
  async execute(input, context) {
    const root = resolveReadablePath(context.workspaceRoot, input.path); let fileCount = 0; let dirCount = 0; let totalBytes = 0; const byExt = new Map<string, number>();
    await walkTree(root, async (fullPath, kind) => {
      if (kind === 'dir') { dirCount += 1; return; }
      const info = await stat(fullPath); fileCount += 1; totalBytes += info.size; const ext = extname(fullPath).toLowerCase() || '(none)'; byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
    });
    const topExt = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ext, count]) => `${ext}: ${count}`).join('\n');
    return { ok: true, output: `files: ${fileCount}\ndirectories: ${dirCount}\nbytes: ${totalBytes}\ntop extensions:\n${topExt || '(none)'}`, data: { fileCount, dirCount, totalBytes, byExtension: Object.fromEntries(byExt) } };
  },
};

async function walkDirs(root: string, current: string, out: string[], maxResults: number, recursive: boolean): Promise<void> {
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (IGNORED.has(entry.name)) continue;
    const full = join(current, entry.name);
    out.push(relative(root, full).replace(/\\/g, '/') || '.');
    if (out.length >= maxResults) return;
    if (recursive) await walkDirs(root, full, out, maxResults, recursive);
  }
}

async function walkFiles(current: string, onFile: (file: string) => Promise<void>): Promise<void> {
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED.has(entry.name)) continue;
      await walkFiles(full, onFile);
    } else if (entry.isFile()) {
      await onFile(full);
    }
  }
}

async function walkTree(current: string, onEntry: (fullPath: string, kind: 'file' | 'dir') => Promise<void>): Promise<void> {
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED.has(entry.name)) continue;
      await onEntry(full, 'dir');
      await walkTree(full, onEntry);
    } else if (entry.isFile()) {
      await onEntry(full, 'file');
    }
  }
}
