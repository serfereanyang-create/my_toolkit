import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { resolveReadablePath, resolveWorkspacePath } from '../safety/policy.js';
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
  description:
    'Read a UTF-8 text file. Supports workspace paths, desktop/... aliases, and absolute paths under Desktop/Documents/Downloads/home. .docx files return extracted plain text.',
  inputHint: '{ "path": "desktop/测试.docx", "maxBytes": 20000 }',
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
    const target = resolveReadablePath(context.workspaceRoot, input.path);
    if (extname(target).toLowerCase() === '.docx') {
      const extracted = await extractDocxText(target);
      const sliced = extracted.slice(0, input.maxBytes);
      return {
        ok: true,
        output: sliced || '(empty document)',
        data: { path: target, kind: 'docx', bytesRead: Buffer.byteLength(sliced) },
      };
    }

    const buffer = await readFile(target);
    if (looksBinary(buffer) && !isProbablyUtf8Text(buffer)) {
      return {
        ok: false,
        output: `File looks binary (${target}). Supported binary extract: .docx. Size=${buffer.byteLength} bytes.`,
        data: { path: target, kind: 'binary', bytes: buffer.byteLength },
      };
    }
    const content = buffer.toString('utf8');
    const sliced = content.slice(0, input.maxBytes);
    return { ok: true, output: sliced, data: { path: target, bytesRead: Buffer.byteLength(sliced) } };
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

function looksBinary(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let weird = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) weird += 1;
  }
  return sample.length > 0 && weird / sample.length > 0.3;
}

function isProbablyUtf8Text(buffer: Buffer) {
  try {
    const text = buffer.toString('utf8');
    return !text.includes('\uFFFD') || buffer.length < 4;
  } catch {
    return false;
  }
}

/** Minimal ZIP local-file scan + inflate to pull word/document.xml text from .docx */
export async function extractDocxText(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new Error(`Not a ZIP/docx file: ${filePath}`);
  }
  const xml = findZipEntry(data, 'word/document.xml');
  if (!xml) throw new Error(`docx missing word/document.xml: ${filePath}`);
  return docxXmlToText(xml);
}

function findZipEntry(data: Buffer, entryName: string): string | undefined {
  let offset = 0;
  while (offset + 30 < data.length) {
    if (data.readUInt32LE(offset) !== 0x04034b50) break;
    const compression = data.readUInt16LE(offset + 8);
    const compressedSize = data.readUInt32LE(offset + 18);
    const nameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = data.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    const payload = data.subarray(dataStart, dataStart + compressedSize);
    if (name === entryName) {
      if (compression === 0) return payload.toString('utf8');
      if (compression === 8) return inflateRawSync(payload).toString('utf8');
      throw new Error(`Unsupported ZIP compression ${compression} for ${entryName}`);
    }
    offset = dataStart + compressedSize;
  }
  return undefined;
}

function docxXmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n');
  const texts = [...withBreaks.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => decodeXml(match[1] ?? ''));
  if (texts.length === 0) {
    // Fallback: strip tags
    return decodeXml(withBreaks.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  // Rebuild roughly by paragraph boundaries already inserted
  const joined = withBreaks
    .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_, text: string) => decodeXml(text))
    .replace(/<[^>]+>/g, '');
  return joined.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
