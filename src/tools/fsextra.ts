import { mkdir, readdir, stat, copyFile, rm } from 'node:fs/promises';
import { dirname, join, relative, basename } from 'node:path';
import { pathScopeFor, resolveReadablePath, resolveWorkspacePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

/*
 * Extra filesystem tools. Reads use resolveReadablePath (workspace + Desktop/
 * Documents/Downloads/home); writes use resolveWorkspacePath so they cannot
 * escape the workspace. Destructive ops carry risk 'write' so the approval
 * policy gates them.
 */

export const fileInfoTool: ToolDefinition<{ path: string }> = {
  name: 'file_info',
  description: 'Report a file or directory: type, byte size, and last-modified time. Read-only.',
  inputHint: '{ "path": "package.json" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    return { path: record.path.trim() };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const info = await stat(target);
    const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    return {
      ok: true,
      output: `${kind} · ${info.size} bytes · modified ${info.mtime.toISOString()}`,
      data: { path: target, kind, bytes: info.size, modified: info.mtime.toISOString() },
    };
  },
};

export const makeDirTool: ToolDefinition<{ path: string }> = {
  name: 'make_dir',
  description: 'Create a directory (and any missing parents) inside the workspace.',
  inputHint: '{ "path": "src/newmodule" }',
  risk: 'write',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    return { path: record.path.trim() };
  },
  async execute(input, context) {
    const target = resolveWorkspacePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    await mkdir(target, { recursive: true });
    return { ok: true, output: `Created directory ${relative(context.workspaceRoot, target) || '.'}`, data: { path: target } };
  },
};

export const copyFileTool: ToolDefinition<{ from: string; to: string }> = {
  name: 'copy_file',
  description: 'Copy a file to a new path inside the workspace. Source may be anywhere readable; destination stays in the workspace.',
  inputHint: '{ "from": "template.txt", "to": "src/out.txt" }',
  risk: 'write',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.from !== 'string' || !record.from.trim()) throw new Error('from is required');
    if (typeof record.to !== 'string' || !record.to.trim()) throw new Error('to is required');
    return { from: record.from.trim(), to: record.to.trim() };
  },
  async execute(input, context) {
    const source = resolveReadablePath(context.workspaceRoot, input.from, pathScopeFor(context.approval));
    const dest = resolveWorkspacePath(context.workspaceRoot, input.to, pathScopeFor(context.approval));
    await mkdir(dirname(dest), { recursive: true });
    const checkpoint = await context.checkpoints?.beforeWrite(dest);
    await copyFile(source, dest);
    return {
      ok: true,
      output: `Copied ${basename(source)} → ${relative(context.workspaceRoot, dest)}`,
      data: { from: source, to: dest, checkpointId: checkpoint?.id },
    };
  },
};

export const deletePathTool: ToolDefinition<{ path: string }> = {
  name: 'delete_path',
  description: 'Delete a file or directory inside the workspace. Destructive: gated by the approval policy. Backed up first so it can be undone.',
  inputHint: '{ "path": "tmp/scratch.txt" }',
  risk: 'write',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    return { path: record.path.trim() };
  },
  async execute(input, context) {
    const target = resolveWorkspacePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const checkpoint = await context.checkpoints?.beforeWrite(target, { action: 'delete' });
    await rm(target, { recursive: true, force: true });
    return {
      ok: true,
      output: `Deleted ${relative(context.workspaceRoot, target)}`,
      data: { path: target, checkpointId: checkpoint?.id },
    };
  },
};

export const findFilesTool: ToolDefinition<{ pattern: string; path: string; maxResults: number }> = {
  name: 'find_files',
  description: 'Find files whose name matches a glob-like pattern (* and ? wildcards) under a directory. Read-only.',
  inputHint: '{ "pattern": "*.test.ts", "path": ".", "maxResults": 100 }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.pattern !== 'string' || !record.pattern.trim()) throw new Error('pattern is required');
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.';
    const maxResults = clampInt(record.maxResults, 100, 1, 2000);
    return { pattern: record.pattern.trim(), path, maxResults };
  },
  async execute(input, context) {
    const root = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const regex = globToRegExp(input.pattern);
    const matches: string[] = [];
    await walk(root, regex, matches, input.maxResults);
    return {
      ok: true,
      output: matches.length ? matches.map((m) => relative(context.workspaceRoot, m) || m).join('\n') : '(no matches)',
      data: { count: matches.length, matches },
    };
  },
};

export const countFilesTool: ToolDefinition<{ path: string }> = {
  name: 'count_files',
  description: 'Count files by extension under a directory (skips node_modules/.git/dist). Read-only.',
  inputHint: '{ "path": "src" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.';
    return { path };
  },
  async execute(input, context) {
    const root = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const counts = new Map<string, number>();
    let total = 0;
    await walkCount(root, (name) => {
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 ? name.slice(dot).toLowerCase() : '(none)';
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
      total += 1;
    });
    const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([ext, n]) => `${ext}: ${n}`);
    return { ok: true, output: `total: ${total}\n${lines.join('\n')}`, data: { total, byExtension: Object.fromEntries(counts) } };
  },
};

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.gradle', '.aicode']);

async function walk(dir: string, regex: RegExp, out: string[], max: number): Promise<void> {
  if (out.length >= max) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= max) return;
    if (entry.isDirectory()) {
      if (IGNORED.has(entry.name)) continue;
      await walk(join(dir, entry.name), regex, out, max);
    } else if (regex.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}

async function walkCount(dir: string, onFile: (name: string) => void): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED.has(entry.name)) continue;
      await walkCount(join(dir, entry.name), onFile);
    } else {
      onFile(entry.name);
    }
  }
}

// Convert a simple glob (* and ?) to an anchored, case-insensitive RegExp.
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
