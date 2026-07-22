import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { MAX_ATTACHMENT_BYTES } from './limits.js';
import type { MessagePart } from '../providers/types.js';

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
    textNotes.push('[attachments]');
    for (const item of attachments) {
      if (item.kind === 'image') {
        textNotes.push(`- image: ${item.name} (${item.bytes} bytes) stored at ${item.storedPath}`);
      } else {
        textNotes.push(`- file: ${item.name} path=${item.storedPath} (use read_file/list_files/search_text as needed)`);
      }
    }
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
