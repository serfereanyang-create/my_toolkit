import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { resolveWorkspacePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

const ignoredDirs = new Set(['node_modules', 'dist', '.git', '.gradle', 'build', '.aicode', '.aicode-smoke']);

export const projectStatusTool: ToolDefinition<Record<string, never>> = {
  name: 'project_status',
  description: 'Show workspace, platform, runtime, and key project files.',
  inputHint: '{}',
  risk: 'read',
  validate(input) {
    if (input === undefined || input === null) return {};
    if (typeof input === 'object' && !Array.isArray(input)) return {};
    throw new Error('expected an object');
  },
  async execute(_input, context) {
    const files = await readdir(context.workspaceRoot).catch(() => []);
    const keyFiles = files.filter((name) => ['package.json', 'tsconfig.json', 'README.md', 'cli'].includes(name));
    return {
      ok: true,
      output: [`workspace: ${context.workspaceRoot}`, `platform: ${process.platform}`, `node: ${process.version}`, `key files: ${keyFiles.join(', ') || 'none'}`].join('\n'),
      data: { workspaceRoot: context.workspaceRoot, platform: process.platform, node: process.version, keyFiles },
    };
  },
};

export const listFilesTool: ToolDefinition<{ path: string; maxFiles: number }> = {
  name: 'list_files',
  description: 'List text-project files under a workspace-relative path.',
  inputHint: '{ "path": ".", "maxFiles": 100 }',
  risk: 'read',
  validate(input) {
    const record = expectRecord(input);
    return {
      path: typeof record.path === 'string' ? record.path : '.',
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0 ? Math.min(Math.floor(record.maxFiles), 500) : 100,
    };
  },
  async execute(input, context) {
    const root = resolveWorkspacePath(context.workspaceRoot, input.path);
    const files: string[] = [];
    await walk(root, context.workspaceRoot, files, input.maxFiles);
    return { ok: true, output: files.join('\n') || '(no files)', data: { files } };
  },
};

export const readFileTool: ToolDefinition<{ path: string; maxBytes: number }> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file inside the workspace.',
  inputHint: '{ "path": "relative/file.ts", "maxBytes": 20000 }',
  risk: 'read',
  validate(input) {
    const record = expectRecord(input);
    if (typeof record.path !== 'string' || record.path.length === 0) throw new Error('path is required');
    return {
      path: record.path,
      maxBytes: typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 200000) : 20000,
    };
  },
  async execute(input, context) {
    const target = resolveWorkspacePath(context.workspaceRoot, input.path);
    const content = await readFile(target, 'utf8');
    const sliced = content.slice(0, input.maxBytes);
    return { ok: true, output: sliced, data: { path: input.path, bytesRead: Buffer.byteLength(sliced) } };
  },
};

export const writeFileTool: ToolDefinition<{ path: string; content: string }> = {
  name: 'write_file',
  description: 'Create or replace a UTF-8 file inside the workspace.',
  inputHint: '{ "path": "cli/.smoke/result.md", "content": "..." }',
  risk: 'write',
  validate(input) {
    const record = expectRecord(input);
    if (typeof record.path !== 'string' || record.path.length === 0) throw new Error('path is required');
    if (typeof record.content !== 'string') throw new Error('content is required');
    return { path: record.path, content: record.content };
  },
  async execute(input, context) {
    const target = resolveWorkspacePath(context.workspaceRoot, input.path);
    await context.checkpoints?.beforeWrite(target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.content, 'utf8');
    return { ok: true, output: `Wrote ${input.path} (${Buffer.byteLength(input.content)} bytes)`, data: { path: input.path, bytes: Buffer.byteLength(input.content) } };
  },
};

function expectRecord(input: unknown): Record<string, unknown> {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) return input as Record<string, unknown>;
  throw new Error('expected an object');
}

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
