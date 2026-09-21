import { readFile } from 'node:fs/promises';
import { pathScopeFor, resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

export function rtfToText(rtf: string) {
  const withParagraphs = rtf
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\line/g, '\n')
    .replace(/\\tab/g, '\t');

  const withoutHex = withParagraphs.replace(/\\'[0-9a-fA-F]{2}/g, '');
  const withoutControls = withoutHex.replace(/\\[A-Za-z]+-?\d* ?/g, '');
  const withoutGroups = withoutControls.replace(/[{}]/g, '');
  return withoutGroups.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const rtfToTextTool: ToolDefinition<{ path?: string; rtf?: string; maxBytes: number }> = {
  name: 'rtf_to_text',
  description: 'Convert RTF documents into plain text. Useful for legacy rich-text notes and exported office documents.',
  inputHint: '{ "path": "notes.rtf" } or { "rtf": "{\\rtf1...}" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    const rtf = typeof record.rtf === 'string' ? record.rtf : undefined;
    if (!path && !rtf) throw new Error('either path or rtf is required');
    if (path && rtf) throw new Error('provide either path or rtf, not both');
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 5_000_000) : 1_000_000;
    return { path, rtf, maxBytes };
  },
  async execute(input, context) {
    const rtf = input.path
      ? (await readFile(resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval)), 'utf8')).slice(0, input.maxBytes)
      : input.rtf!.slice(0, input.maxBytes);
    const text = rtfToText(rtf);
    return {
      ok: true,
      output: text || '(empty RTF text)',
      data: { source: input.path ?? 'inline RTF', textLength: text.length },
    };
  },
};
