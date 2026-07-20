import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveWorkspacePath } from '../safety/policy.js';
import { resolveDesktopPath } from './docx.js';
import type { ToolDefinition } from './types.js';

export const renameFileTool: ToolDefinition<{ from: string; to: string }> = {
  name: 'rename_file',
  description: 'Rename or move a file. Supports workspace-relative paths and desktop/... paths.',
  inputHint: '{ "from": "desktop/新建文档.docx", "to": "desktop/测试文档.docx" }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.from !== 'string' || !record.from.trim()) throw new Error('from is required');
    if (typeof record.to !== 'string' || !record.to.trim()) throw new Error('to is required');
    return { from: record.from.trim(), to: record.to.trim() };
  },
  async execute(input, context) {
    const from = resolvePath(context.workspaceRoot, input.from);
    const to = resolvePath(context.workspaceRoot, input.to);
    await context.checkpoints?.beforeRename(from, to);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    return { ok: true, output: `Renamed ${from} -> ${to}`, data: { from, to } };
  },
};

function resolvePath(workspaceRoot: string, path: string) {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith('desktop/') || normalized === 'desktop') return resolveDesktopPath(path);
  return resolveWorkspacePath(workspaceRoot, path);
}
