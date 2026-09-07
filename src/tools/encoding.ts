import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

/*
 * Encoding, hashing, and id-generation utilities. All read-only (no file
 * writes): they transform inline text or hash a readable file.
 */

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

export const base64EncodeTool: ToolDefinition<{ text: string }> = {
  name: 'base64_encode',
  description: 'Encode inline UTF-8 text to Base64. Read-only.',
  inputHint: '{ "text": "hello" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.text !== 'string') throw new Error('text is required');
    return { text: record.text };
  },
  async execute(input) {
    const encoded = Buffer.from(input.text, 'utf8').toString('base64');
    return { ok: true, output: encoded, data: { bytes: encoded.length } };
  },
};

export const base64DecodeTool: ToolDefinition<{ data: string }> = {
  name: 'base64_decode',
  description: 'Decode a Base64 string back to UTF-8 text. Read-only.',
  inputHint: '{ "data": "aGVsbG8=" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.data !== 'string') throw new Error('data is required');
    return { data: record.data };
  },
  async execute(input) {
    const decoded = Buffer.from(input.data, 'base64').toString('utf8');
    return { ok: true, output: decoded, data: { length: decoded.length } };
  },
};

export const hashTextTool: ToolDefinition<{ text?: string; path?: string; algorithm: string }> = {
  name: 'hash_text',
  description: 'Compute a cryptographic hash (md5/sha1/sha256/sha512) of inline text or a file. Read-only.',
  inputHint: '{ "text": "hello", "algorithm": "sha256" }  or  { "path": "file.bin", "algorithm": "sha256" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    const algorithm = typeof record.algorithm === 'string' && ['md5', 'sha1', 'sha256', 'sha512'].includes(record.algorithm)
      ? record.algorithm
      : 'sha256';
    const text = typeof record.text === 'string' ? record.text : undefined;
    const path = typeof record.path === 'string' ? record.path : undefined;
    if (text === undefined && !path) throw new Error('provide either text or path');
    return { text, path, algorithm };
  },
  async execute(input, context) {
    const buffer = input.path
      ? await readFile(resolveReadablePath(context.workspaceRoot, input.path))
      : Buffer.from(input.text ?? '', 'utf8');
    const digest = createHash(input.algorithm).update(buffer).digest('hex');
    return { ok: true, output: digest, data: { algorithm: input.algorithm, bytes: buffer.length } };
  },
};

export const urlEncodeTool: ToolDefinition<{ text: string; component: boolean }> = {
  name: 'url_encode',
  description: 'Percent-encode text for use in a URL (component encoding by default). Read-only.',
  inputHint: '{ "text": "a b&c" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.text !== 'string') throw new Error('text is required');
    return { text: record.text, component: record.component !== false };
  },
  async execute(input) {
    const encoded = input.component ? encodeURIComponent(input.text) : encodeURI(input.text);
    return { ok: true, output: encoded };
  },
};

export const urlDecodeTool: ToolDefinition<{ text: string }> = {
  name: 'url_decode',
  description: 'Decode a percent-encoded URL string. Read-only.',
  inputHint: '{ "text": "a%20b%26c" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.text !== 'string') throw new Error('text is required');
    return { text: record.text };
  },
  async execute(input) {
    return { ok: true, output: decodeURIComponent(input.text) };
  },
};

export const uuidGenerateTool: ToolDefinition<{ count: number }> = {
  name: 'uuid_generate',
  description: 'Generate one or more random UUID v4 identifiers. Read-only.',
  inputHint: '{ "count": 1 }',
  risk: 'read',
  validate(input) {
    if (input === undefined || input === null) return { count: 1 };
    const record = asRecord(input);
    const count = typeof record.count === 'number' && record.count > 0 ? Math.min(Math.floor(record.count), 100) : 1;
    return { count };
  },
  async execute(input) {
    const ids = Array.from({ length: input.count }, () => randomUUID());
    return { ok: true, output: ids.join('\n'), data: { count: ids.length, ids } };
  },
};
