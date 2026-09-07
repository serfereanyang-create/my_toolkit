import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { MAX_ATTACHMENT_BYTES, formatByteSize } from './limits.js';
import type { MessagePart } from '../providers/types.js';
import { extractDocxText } from '../tools/files.js';
import { extractPdfTextFromBuffer } from '../tools/pdf-text.js';
import { rtfToText } from '../tools/rtf.js';
import { listZipEntries } from '../tools/zip.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export type AttachmentKind = 'image' | 'file';

export type Attachment = {
  id: string;
  kind: AttachmentKind;
  originalPath: string;
  storedPath: string;
  name: string;
  mediaType?: string;
  bytes: number;
};

export type PreparedUserContent = {
  text: string;
  parts: MessagePart[];
  attachments: Attachment[];
  displaySummary: string;
};

const INLINE_PREVIEW_BYTES = 12 * 1024;
const MEDIUM_PREVIEW_BYTES = 128 * 1024;
const ATTACHMENT_CONTEXT_BUDGET_CHARS = 4200;
const SMALL_PREVIEW_CHARS = 1600;
const MEDIUM_PREVIEW_CHARS = 700;
const LARGE_PREVIEW_CHARS = 260;

function attachmentTypeLabel(name: string) {
  const ext = extname(name).toLowerCase();
  if (['.md', '.txt', '.rtf', '.docx', '.pdf'].includes(ext)) return 'document';
  if (['.json', '.jsonl', '.yaml', '.yml', '.xml', '.toml', '.ini', '.properties', '.csv', '.tsv'].includes(ext)) return 'data';
  if (['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.html', '.css'].includes(ext)) return 'code';
  if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(ext)) return 'archive';
  return 'file';
}

function attachmentIntro(item: Attachment) {
  const type = attachmentTypeLabel(item.name);
  if (item.kind === 'image') return `image ${item.name} (${formatByteSize(item.bytes)})`;
  if (type === 'document') return `document ${item.name} (${formatByteSize(item.bytes)})`;
  if (type === 'data') return `data file ${item.name} (${formatByteSize(item.bytes)})`;
  if (type === 'code') return `code file ${item.name} (${formatByteSize(item.bytes)})`;
  if (type === 'archive') return `archive ${item.name} (${formatByteSize(item.bytes)})`;
  return `file ${item.name} (${formatByteSize(item.bytes)})`;
}

function cleanPreviewText(text: string) {
  return text.replace(/\r/g, '').replace(/\u0000/g, '').trim();
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

function previewCharLimit(bytes: number) {
  if (bytes <= INLINE_PREVIEW_BYTES) return SMALL_PREVIEW_CHARS;
  if (bytes <= MEDIUM_PREVIEW_BYTES) return MEDIUM_PREVIEW_CHARS;
  return LARGE_PREVIEW_CHARS;
}

async function attachmentPreview(item: Attachment, charLimit: number): Promise<{ text: string; truncated: boolean } | null> {
  if (item.kind === 'image' || charLimit <= 0) return null;
  const ext = extname(item.name).toLowerCase();
  if (['.pdf'].includes(ext)) {
    try {
      const raw = await readFile(item.storedPath);
      const text = cleanPreviewText(extractPdfTextFromBuffer(raw));
      if (text) {
        const sliced = text.slice(0, Math.min(charLimit, LARGE_PREVIEW_CHARS * 2));
        return {
          text: sliced,
          truncated: text.length > sliced.length,
        };
      }
    } catch {
      // fall through to generic notice
    }
    return {
      text: 'PDF attached as source material. Text preview was not extractable, so inspect it further only if needed.',
      truncated: false,
    };
  }
  if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(ext)) {
    try {
      if (ext !== '.zip') {
        return {
          text: 'Archive attached. Non-ZIP archive preview is not expanded inline; inspect only if needed.',
          truncated: false,
        };
      }
      const entries = listZipEntries(await readFile(item.storedPath));
      const names = entries.slice(0, 6).map((entry) => entry.name).join(', ');
      const suffix = entries.length > 6 ? ', ...' : '';
      return {
        text: `${entries.length} entries. Top items: ${names}${suffix}`,
        truncated: entries.length > 6,
      };
    } catch {
      return {
        text: 'Archive attached. Preview unavailable, but the file is available as source material.',
        truncated: false,
      };
    }
  }
  try {
    let text = '';
    if (ext === '.docx') {
      text = await extractDocxText(item.storedPath);
    } else if (ext === '.rtf') {
      text = rtfToText(await readFile(item.storedPath, 'utf8'));
    } else {
      const raw = await readFile(item.storedPath);
      if (looksBinary(raw)) return null;
      text = raw.toString('utf8');
    }
    const cleaned = cleanPreviewText(text);
    if (!cleaned) return null;
    const sliced = cleaned.slice(0, charLimit);
    return { text: sliced, truncated: cleaned.length > sliced.length };
  } catch {
    return null;
  }
}

export async function buildAttachmentContextLines(attachments: Attachment[], budgetChars = ATTACHMENT_CONTEXT_BUDGET_CHARS) {
  const lines = ['[user provided files]'];
  let remaining = budgetChars - lines[0].length;
  for (const item of attachments) {
    const head = item.kind === 'image'
      ? `- ${attachmentIntro(item)}`
      : `- ${attachmentIntro(item)} at ${item.storedPath}`;
    lines.push(head);
    remaining -= head.length;
    if (item.kind === 'image' || remaining <= 120) continue;

    const preview = await attachmentPreview(item, Math.min(remaining, previewCharLimit(item.bytes)));
    if (!preview) continue;

    const label = preview.truncated ? '  excerpt:' : '  contents:';
    lines.push(label);
    remaining -= label.length;
    for (const line of preview.text.split('\n').slice(0, 8)) {
      const entry = `  ${line}`;
      lines.push(entry);
      remaining -= entry.length;
      if (remaining <= 80) break;
    }
    if (preview.truncated && remaining > 20) {
      lines.push('  ...(truncated)');
      remaining -= 16;
    }
    if (remaining <= 80) break;
  }
  return lines;
}

export function attachmentDir(workspaceRoot: string, sessionId: string) {
  return resolve(workspaceRoot, '.aicode', 'attachments', sessionId);
}

export function isImagePath(path: string) {
  return IMAGE_EXT.has(extname(path).toLowerCase());
}

export function mediaTypeForPath(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

export async function registerAttachment(options: {
  workspaceRoot: string;
  sessionId: string;
  sourcePath: string;
}): Promise<Attachment> {
  const absolute = isAbsolute(options.sourcePath)
    ? resolve(options.sourcePath)
    : resolve(options.workspaceRoot, options.sourcePath);
  const data = await readFile(absolute);
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment exceeds 8MB limit: ${absolute} (${data.byteLength} bytes)`);
  }
  const dir = attachmentDir(options.workspaceRoot, options.sessionId);
  await mkdir(dir, { recursive: true });
  const id = randomUUID().slice(0, 8);
  const name = basename(absolute);
  const storedPath = join(dir, `${id}_${sanitizeName(name)}`);
  await writeFile(storedPath, data);
  const kind: AttachmentKind = isImagePath(name) ? 'image' : 'file';
  return {
    id,
    kind,
    originalPath: absolute,
    storedPath,
    name,
    mediaType: kind === 'image' ? mediaTypeForPath(name) : undefined,
    bytes: data.byteLength,
  };
}

export async function registerAttachmentsFromPaths(options: {
  workspaceRoot: string;
  sessionId: string;
  paths: string[];
}): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const path of options.paths) {
    out.push(await registerAttachment({
      workspaceRoot: options.workspaceRoot,
      sessionId: options.sessionId,
      sourcePath: path,
    }));
  }
  return out;
}

export function harvestFilePaths(text: string): string[] {
  const found: string[] = [];
  // Quoted paths (drag-drop / Explorer copy)
  const quoted = text.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g);
  for (const match of quoted) {
    const value = match[1] ?? match[2];
    if (value && looksLikePath(value)) found.push(value);
  }
  // Unquoted Windows absolute paths
  const windows = text.matchAll(/(?:^|[\s])([A-Za-z]:\\[^\s"'<>|*?]+)/g);
  for (const match of windows) {
    if (match[1]) found.push(match[1]);
  }
  // Unquoted posix-ish absolute or relative with extension
  const posix = text.matchAll(/(?:^|[\s])((?:\.\.?\/|\/)[^\s"'<>|*?]+\.[A-Za-z0-9]{1,8})/g);
  for (const match of posix) {
    if (match[1]) found.push(match[1]);
  }
  return Array.from(new Set(found));
}

export async function prepareUserContent(options: {
  text: string;
  workspaceRoot: string;
  sessionId: string;
  extraPaths?: string[];
}): Promise<PreparedUserContent> {
  const pathCandidates = [
    ...harvestFilePaths(options.text),
    ...(options.extraPaths ?? []),
  ];
  const attachments: Attachment[] = [];
  for (const path of pathCandidates) {
    try {
      attachments.push(await registerAttachment({
        workspaceRoot: options.workspaceRoot,
        sessionId: options.sessionId,
        sourcePath: path,
      }));
    } catch {
      // Path not readable / too large — leave as plain text for the model
    }
  }

  const textNotes: string[] = [options.text.trimEnd()];
  if (attachments.length > 0) {
    textNotes.push('');
    textNotes.push(...await buildAttachmentContextLines(attachments));
  }
  const text = textNotes.join('\n');
  const parts: MessagePart[] = [{ type: 'text', text }];

  for (const item of attachments) {
    if (item.kind !== 'image' || !item.mediaType) continue;
    const raw = await readFile(item.storedPath);
    parts.push({
      type: 'image',
      mediaType: item.mediaType,
      data: raw.toString('base64'),
      path: item.storedPath,
    });
  }

  const displaySummary = attachments.length === 0
    ? options.text
    : `${options.text.trim()}\n(+${attachments.length} attachment(s): ${attachments.map((a) => a.name).join(', ')})`;

  return { text, parts, attachments, displaySummary };
}

export async function captureClipboardImage(options: {
  workspaceRoot: string;
  sessionId: string;
}): Promise<Attachment> {
  if (process.platform !== 'win32') {
    throw new Error('Clipboard image capture is currently implemented for Windows only. Use /attach <image-path> instead.');
  }
  const dir = attachmentDir(options.workspaceRoot, options.sessionId);
  await mkdir(dir, { recursive: true });
  const target = join(dir, `clip_${randomUUID().slice(0, 8)}.png`);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $img) { Write-Error "NO_IMAGE"; exit 2 }',
    `$img.Save('${target.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    'Write-Output "OK"',
  ].join('; ');

  await runPowerShell(script);
  return registerAttachment({
    workspaceRoot: options.workspaceRoot,
    sessionId: options.sessionId,
    sourcePath: target,
  });
}

function looksLikePath(value: string) {
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;
  if (/\.[A-Za-z0-9]{1,8}$/.test(value) && (value.includes('/') || value.includes('\\'))) return true;
  return false;
}

function sanitizeName(name: string) {
  return name.replace(/[<>:"|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
}

function runPowerShell(command: string) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else if (stderr.includes('NO_IMAGE') || code === 2) rejectPromise(new Error('Clipboard has no image. Copy a screenshot first, then /paste-image.'));
      else rejectPromise(new Error(`Clipboard capture failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

// silence unused import if copyFile unused
void copyFile;
