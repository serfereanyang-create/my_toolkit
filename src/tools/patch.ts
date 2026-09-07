import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveWorkspacePath } from '../safety/policy.js';
import { lineDiff } from './lineDiff.js';
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
    const checkpoint = await context.checkpoints?.beforeWrite(target);
    await mkdir(dirname(target), { recursive: true });
    if (input.oldText === undefined) {
      await writeFile(target, input.newText, 'utf8');
      const { added, removed } = lineDiff('', input.newText);
      return { ok: true, output: `Created ${input.path} via patch (+${added} -${removed})`, data: { path: input.path, mode: 'create', added, removed, checkpointId: checkpoint?.id } };
    }

    const current = await readFile(target, 'utf8');
    const firstIndex = current.indexOf(input.oldText);
    if (firstIndex === -1) {
      return { ok: false, output: `Patch target text not found in ${input.path}` };
    }
    const lastIndex = current.lastIndexOf(input.oldText);
    if (firstIndex !== lastIndex) {
      const occurrences = current.split(input.oldText).length - 1;
      return { 
        ok: false, 
        output: `Ambiguous match: target text appears ${occurrences} times in ${input.path}. Use edit_lines for precise line-based replacement.` 
      };
    }
    const next = current.slice(0, firstIndex) + input.newText + current.slice(firstIndex + input.oldText.length);
    await writeFile(target, next, 'utf8');
    const { added, removed } = lineDiff(current, next);
    return { ok: true, output: `Patched ${input.path} (+${added} -${removed})`, data: { path: input.path, mode: 'replace', added, removed, checkpointId: checkpoint?.id } };
  },
};
