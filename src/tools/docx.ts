import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { ToolDefinition } from './types.js';

export const createDocxTool: ToolDefinition<{ path?: string; title: string; body: string }> = {
  name: 'create_docx',
  description: 'Create a simple Microsoft Word .docx document. Use this instead of shell commands when the user asks to create a Word document, especially on the Desktop.',
  inputHint: '{ "path": "desktop/新建文档.docx", "title": "", "body": "" }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : 'desktop/新建文档.docx';
    return {
      path,
      title: typeof record.title === 'string' ? record.title : '',
      body: typeof record.body === 'string' ? record.body : '',
    };
  },
  async execute(input, context) {
    const target = resolveDocxPath(input.path ?? 'desktop/新建文档.docx');
    await context.checkpoints?.beforeWrite(target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buildDocx(input.title, input.body));
    return { ok: true, output: `Created Word document: ${target}`, data: { path: target } };
  },
};

export function resolveDesktopPath(path: string, defaultName = '新建文档.docx') {
  const normalized = path.replace(/\\/g, '/');
  const desktop = join(homedir(), 'Desktop');
  if (normalized.toLowerCase().startsWith('desktop/')) {
    return join(desktop, normalized.slice('desktop/'.length));
  }
  if (normalized.toLowerCase() === 'desktop') {
    return join(desktop, defaultName);
  }
  if (normalized.includes('/') || normalized.includes(':')) {
    return resolve(path);
  }
  return join(desktop, basename(path));
}

function resolveDocxPath(path: string) {
  return withDocxExtension(resolveDesktopPath(path));
}

function withDocxExtension(path: string) {
  return path.toLowerCase().endsWith('.docx') ? path : `${path}.docx`;
}

function buildDocx(title: string, body: string) {
  const documentText = [title, body].filter(Boolean).join('\n') || '';
  const files = new Map<string, string>([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs(documentText)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    ],
  ]);
  return zip(files);
}

function paragraphs(text: string) {
  if (!text) return '<w:p/>';
  return text
    .split(/\r?\n/)
    .map((line) => `<w:p><w:r><w:t>${escapeXml(line)}</w:t></w:r></w:p>`)
    .join('');
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function zip(files: Map<string, string>) {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(local, nameBuffer, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
