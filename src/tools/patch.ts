import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveWorkspacePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

export const applyPatchTool: ToolDefinition<{ path: string; oldText?: string; newText: string }> = {
  name: 'apply_patch',
  description: 'Apply a simple text replacement or create a file if oldText is omitted.',
  inputHint: '{ "path": "file.ts", "oldText": "before", "newText": "after" }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || record.path.length === 0) throw new Error('path is required');
    if (record.oldText !== undefined && typeof record.oldText !== 'string') throw new Error('oldText must be a string');
    if (typeof record.newText !== 'string') throw new Error('newText is required');
    return { path: record.path, oldText: record.oldText, newText: record.newText };
  },
  async execute(input, context) {
    const target = resolveWorkspacePath(context.workspaceRoot, input.path);
    await context.checkpoints?.beforeWrite(target);
    await mkdir(dirname(target), { recursive: true });
    if (input.oldText === undefined) {
      await writeFile(target, input.newText, 'utf8');
      return { ok: true, output: `Created ${input.path} via patch`, data: { path: input.path, mode: 'create' } };
    }

    const current = await readFile(target, 'utf8');
    if (!current.includes(input.oldText)) {
      return { ok: false, output: `Patch target text not found in ${input.path}` };
    }
    const next = current.replace(input.oldText, input.newText);
    await writeFile(target, next, 'utf8');
    return { ok: true, output: `Patched ${input.path}`, data: { path: input.path, mode: 'replace' } };
  },
};
