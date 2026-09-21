import { readFile } from 'node:fs/promises';
import { pathScopeFor, resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

function decodePdfLiteral(text: string) {
  return text
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

export function extractPdfTextFromBuffer(buffer: Buffer) {
  const source = buffer.toString('latin1');
  const parts: string[] = [];

  for (const match of source.matchAll(/\(([^()]*(?:\\.[^()]*)*)\)\s*Tj/g)) {
    parts.push(decodePdfLiteral(match[1] ?? ''));
  }
  for (const match of source.matchAll(/\[(.*?)\]\s*TJ/gs)) {
    const block = match[1] ?? '';
    const inner: string[] = [];
    for (const piece of block.matchAll(/\(([^()]*(?:\\.[^()]*)*)\)/g)) {
      inner.push(decodePdfLiteral(piece[1] ?? ''));
    }
    if (inner.length > 0) parts.push(inner.join(''));
  }

  const text = parts.join('\n').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

export const pdfToTextTool: ToolDefinition<{ path: string; maxBytes: number }> = {
  name: 'pdf_to_text',
  description: 'Extract readable text from simple text-based PDF files. Useful for quick inspection of user-provided PDFs without external OCR dependencies.',
  inputHint: '{ "path": "report.pdf", "maxBytes": 2000000 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 8_000_000) : 2_000_000;
    return { path: record.path.trim(), maxBytes };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const buffer = (await readFile(target)).subarray(0, input.maxBytes);
    const text = extractPdfTextFromBuffer(buffer);
    if (!text) {
      return {
        ok: true,
        output: `No extractable text found in ${input.path}. The PDF may be image-based or compressed beyond the lightweight extractor.`,
        data: { path: input.path, extracted: false },
      };
    }
    return {
      ok: true,
      output: text,
      data: { path: input.path, extracted: true, chars: text.length },
    };
  },
};
