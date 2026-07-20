import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveWorkspacePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

const ignoredDirs = new Set(['node_modules', 'dist', '.git', '.gradle', 'build', '.aicode', '.aicode-smoke']);

export const projectIndexTool: ToolDefinition<{ path: string; maxFiles: number }> = {
  name: 'project_index',
  description: 'Build a lightweight ignore-aware project index with file counts, extensions, and key files.',
  inputHint: '{ "path": ".", "maxFiles": 1000 }',
  risk: 'read',
  validate(input) {
    if (input === undefined || input === null) return { path: '.', maxFiles: 1000 };
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      path: typeof record.path === 'string' ? record.path : '.',
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0 ? Math.min(Math.floor(record.maxFiles), 5000) : 1000,
    };
  },
  async execute(input, context) {
    const root = resolveWorkspacePath(context.workspaceRoot, input.path);
    const files: string[] = [];
    await walk(root, context.workspaceRoot, files, input.maxFiles);
    const extensions = countExtensions(files);
    const keyFiles = files.filter((file) => /(^|\/)(package.json|tsconfig.json|README.md|AGENTS.md|CLAUDE.md|GEMINI.md)$/i.test(file));
    const output = [
      `files: ${files.length}`,
      `extensions: ${Object.entries(extensions).map(([ext, count]) => `${ext}:${count}`).join(', ') || 'none'}`,
      `key files:\n${keyFiles.map((file) => `- ${file}`).join('\n') || '- none'}`,
    ].join('\n');
    return { ok: true, output, data: { files: files.length, extensions, keyFiles } };
  },
};

async function walk(current: string, workspaceRoot: string, files: string[], maxFiles: number): Promise<void> {
  if (files.length >= maxFiles) return;
  const info = await stat(current);
  if (info.isFile()) {
    files.push(relative(workspaceRoot, current).replace(/\\/g, '/'));
    return;
  }
  if (!info.isDirectory()) return;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    await walk(join(current, entry.name), workspaceRoot, files, maxFiles);
  }
}

function countExtensions(files: string[]) {
  const counts: Record<string, number> = {};
  for (const file of files) {
    const match = file.match(/\.([^.\/]+)$/);
    const ext = match ? `.${match[1].toLowerCase()}` : '(none)';
    counts[ext] = (counts[ext] ?? 0) + 1;
  }
  return counts;
}
