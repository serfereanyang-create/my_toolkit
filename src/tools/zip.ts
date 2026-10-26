import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { ToolDefinition } from './types.js';
import { pathScopeFor, resolveReadablePath, resolveWorkspacePath } from '../safety/policy.js';

/**
 * ZIP file creation, extraction, and inspection tools.
 * - create_zip: Bundle files into a ZIP archive
 * - list_zip: Read ZIP central directory and list contents
 * - extract_zip: Extract files from a ZIP archive
 * - zip_summary: Get aggregate statistics about a ZIP archive
 */

/** Per-member ceiling when extracting; a declared size over this is refused. */
const MAX_MEMBER_BYTES = 256 * 1024 * 1024;

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * General-purpose bit 11: "the file name is UTF-8".
 *
 * Without it a ZIP reader falls back to CP437 for names, which is the format's
 * historical default. Windows Explorer guesses UTF-8 anyway, so a Chinese
 * filename looked correct there; Python's zipfile and macOS's unzip showed
 * `µèÑσæè.md`. The flag costs nothing and is what every modern writer sets.
 */
const FLAG_UTF8 = 0x0800;

function zipFiles(files: Map<string, Buffer>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, data] of files) {
    const nameBuffer = Buffer.from(name);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
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
    header.writeUInt16LE(FLAG_UTF8, 8);
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

type ZipEntry = {
  name: string;
  uncompressedSize: number;
  compressedSize: number;
  crc32: number;
  /** Whether the archive marked the name as UTF-8 (bit 11). */
  utf8Name?: boolean;
};

/**
 * Turn one archive member name into a path inside the extraction root, or
 * refuse it.
 *
 * A ZIP member name is attacker-controlled: `../../.aicode/sessions/x.json`
 * resolves outside the target directory, and the previous code joined it
 * straight onto that directory, writing wherever the archive said. Verified
 * before the fix: extracting a two-byte fixture wrote a file two levels above
 * the workspace. Absolute paths and Windows drive prefixes are refused for the
 * same reason; backslashes are treated as separators because a Windows-built
 * archive may use them.
 *
 * `''` and `'.'` segments are dropped (a leading `./` is common), and the
 * result must not be empty — a member that names only a directory has nothing
 * to extract.
 */
export function safeArchivePath(name: string): string | null {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) return null;
  // A NUL or control character cannot appear in a real path and can truncate
  // one on some platforms.
  if (/\u0000/.test(normalized)) return null;
  return parts.join('/');
}

export function listZipEntries(buffer: Buffer): ZipEntry[] {
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Not a valid ZIP file');
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries: ZipEntry[] = [];
  let offset = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x02014b50) {
      throw new Error('Invalid central directory');
    }

    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);

    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({
      name,
      uncompressedSize,
      compressedSize,
      crc32: crc,
      utf8Name: (buffer.readUInt16LE(offset + 8) & FLAG_UTF8) !== 0,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

type ZipLocalFileHeader = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  compressionMethod: number;
  dataOffset: number;
};

function readZipLocalHeaders(buffer: Buffer): ZipLocalFileHeader[] {
  const headers: ZipLocalFileHeader[] = [];
  let offset = 0;

  while (offset < buffer.length - 4) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const crc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);

    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataOffset = offset + 30 + nameLength + extraLength;

    headers.push({
      name,
      compressedSize,
      uncompressedSize,
      crc32: crc,
      compressionMethod,
      dataOffset,
    });

    offset = dataOffset + compressedSize;
  }

  return headers;
}

export const createZipTool: ToolDefinition<{
  path: string;
  files: Array<{ path: string; content?: string }>;
  baseDir?: string;
}> = {
  name: 'create_zip',
  description:
    'Create a ZIP archive from files. Provide file paths or inline content. Useful for bundling deliverables, backups, or distributing multiple files.',
  inputHint:
    '{ "path": "archive.zip", "files": [{"path": "README.md"}, {"path": "config.json", "content": "{\\"version\\": 1}"}] }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('expected an object');
    }
    const record = input as Record<string, unknown>;

    if (typeof record.path !== 'string' || !record.path.trim()) {
      throw new Error('path is required');
    }

    if (!Array.isArray(record.files) || record.files.length === 0) {
      throw new Error('files must be a non-empty array');
    }

    return {
      path: record.path.trim(),
      files: record.files as Array<{ path: string; content?: string }>,
      baseDir: typeof record.baseDir === 'string' ? record.baseDir.trim() : undefined,
    };
  },
  async execute(input, context) {
    const targetPath = resolveWorkspacePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const finalTarget = targetPath.toLowerCase().endsWith('.zip') ? targetPath : `${targetPath}.zip`;
    const checkpoint = await context.checkpoints?.beforeWrite(finalTarget);
    await mkdir(dirname(finalTarget), { recursive: true });

    const fileMap = new Map<string, Buffer>();
    const baseDir = input.baseDir ? resolveReadablePath(context.workspaceRoot, input.baseDir, pathScopeFor(context.approval)) : context.workspaceRoot;
    const outside: string[] = [];

    for (const fileSpec of input.files) {
      if (typeof fileSpec.path !== 'string' || !fileSpec.path.trim()) {
        continue;
      }

      let content: Buffer;
      let archivePath: string;

      if (typeof fileSpec.content === 'string') {
        content = Buffer.from(fileSpec.content, 'utf8');
        archivePath = fileSpec.path.trim().replace(/\\/g, '/');
      } else {
        const sourcePath = join(baseDir, fileSpec.path);
        const stats = await stat(sourcePath);

        if (stats.isDirectory()) {
          const addDirectory = async (dir: string, prefix: string) => {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = join(dir, entry.name);
              const zipPath = prefix ? `${prefix}/${entry.name}` : entry.name;

              if (entry.isDirectory()) {
                await addDirectory(fullPath, zipPath);
              } else if (entry.isFile()) {
                const fileContent = await readFile(fullPath);
                fileMap.set(zipPath, fileContent);
              }
            }
          };

          const relPath = relative(baseDir, sourcePath).replace(/\\/g, '/');
          await addDirectory(sourcePath, relPath);
          continue;
        }

        content = await readFile(sourcePath);
        archivePath = relative(baseDir, sourcePath).replace(/\\/g, '/');
      }

      // An archive this tool writes must be one it could extract: a member
      // named `../x` is exactly what extract_zip now refuses.
      const safePath = safeArchivePath(archivePath);
      if (!safePath) {
        outside.push(archivePath);
        continue;
      }
      fileMap.set(safePath, content);
    }

    if (fileMap.size === 0) {
      return {
        ok: false,
        output: `No files could be added to ${input.path}.${outside.length > 0 ? ` These paths leave the archive root: ${outside.slice(0, 10).join(', ')}` : ''}`,
      };
    }

    const zipBuffer = zipFiles(fileMap);
    await writeFile(finalTarget, zipBuffer);
    await context.checkpoints?.confirm(checkpoint);

    const totalSize = Array.from(fileMap.values()).reduce((sum, buf) => sum + buf.length, 0);
    const saved = totalSize - zipBuffer.length;
    const status = saved > 0 ? `saved ${saved} bytes` : `${-saved} bytes overhead`;

    return {
      ok: true,
      output: `Created ZIP: ${finalTarget}\n${fileMap.size} files, ${totalSize} bytes → ${zipBuffer.length} bytes (${status})`
        + (outside.length > 0 ? `\nOmitted ${outside.length} path${outside.length === 1 ? '' : 's'} that would sit outside the archive root: ${outside.slice(0, 10).join(', ')}` : ''),
      data: {
        path: finalTarget,
        checkpointId: checkpoint?.id,
        fileCount: fileMap.size,
        uncompressedSize: totalSize,
        compressedSize: zipBuffer.length,
        // Named so a caller can tell that a source file was left out rather
        // than silently assuming everything they listed is in the archive.
        omitted: outside.length > 0 ? outside : undefined,
      },
    };
  },
};

export const listZipTool: ToolDefinition<{ path: string }> = {
  name: 'list_zip',
  description:
    'List contents of a ZIP archive without extracting. Shows file names and sizes.',
  inputHint: '{ "path": "archive.zip" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('expected an object');
    }
    const record = input as Record<string, unknown>;

    if (typeof record.path !== 'string' || !record.path.trim()) {
      throw new Error('path is required');
    }

    return { path: record.path.trim() };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const buffer = await readFile(target);
    const entries = listZipEntries(buffer);

    const totalUncompressed = entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
    const totalCompressed = entries.reduce((sum, e) => sum + e.compressedSize, 0);
    const saved = totalUncompressed - totalCompressed;
    const status = saved > 0 ? `saved ${saved} bytes` : `${-saved} bytes overhead`;

    const listing = entries
      .map(
        (e) =>
          `${e.name.padEnd(40)} ${e.uncompressedSize.toString().padStart(10)} → ${e.compressedSize.toString().padStart(10)} bytes`
      )
      .join('\n');

    return {
      ok: true,
      output: `ZIP: ${input.path}\n${entries.length} files, ${totalUncompressed} → ${totalCompressed} bytes (${status})\n\n${listing}`,
      data: {
        path: input.path,
        entries,
        totalUncompressed,
        totalCompressed,
      },
    };
  },
};

export const extractZipTool: ToolDefinition<{
  path: string;
  to?: string;
  files?: string[];
  maxFiles: number;
}> = {
  name: 'extract_zip',
  description:
    'Extract files from a ZIP archive. Optionally specify target directory and file filter.',
  inputHint: '{ "path": "archive.zip", "to": "output", "files": ["README.md"] }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('expected an object');
    }
    const record = input as Record<string, unknown>;

    if (typeof record.path !== 'string' || !record.path.trim()) {
      throw new Error('path is required');
    }

    const maxFiles = typeof record.maxFiles === 'number' ? Math.max(1, Math.min(500, record.maxFiles)) : 100;

    return {
      path: record.path.trim(),
      to: typeof record.to === 'string' ? record.to.trim() : undefined,
      files: Array.isArray(record.files) ? record.files.filter((f): f is string => typeof f === 'string') : undefined,
      maxFiles,
    };
  },
  async execute(input, context) {
    const sourcePath = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const buffer = await readFile(sourcePath);
    const headers = readZipLocalHeaders(buffer);

    const targetDir = input.to ? resolveWorkspacePath(context.workspaceRoot, input.to, pathScopeFor(context.approval)) : context.workspaceRoot;
    const checkpoint = await context.checkpoints?.beforeWrite(targetDir);

    const fileFilter = input.files ? new Set(input.files) : null;
    const extracted: string[] = [];
    const refused: string[] = [];
    let skipped = 0;

    for (const header of headers) {
      if (fileFilter && !fileFilter.has(header.name)) {
        skipped++;
        continue;
      }

      if (extracted.length >= input.maxFiles) {
        skipped = headers.length - extracted.length;
        break;
      }

      // The member name decides where the bytes go, so it is validated before
      // anything is created on disk. Members outside the target are collected
      // and reported: an archive that tries this is worth telling the user
      // about rather than silently dropping.
      const relativeName = safeArchivePath(header.name);
      if (!relativeName) {
        refused.push(header.name);
        continue;
      }

      const targetPath = join(targetDir, relativeName);
      await mkdir(dirname(targetPath), { recursive: true });

      if (header.compressionMethod === 8) {
        const compressedData = buffer.subarray(header.dataOffset, header.dataOffset + header.compressedSize);
        let decompressed: Buffer;
        try {
          // A "zip bomb" declares a small compressed member that expands to
          // gigabytes; inflating it without a ceiling would take the process
          // down. The declared size is checked first and the actual result
          // second, because the declaration itself is attacker-controlled.
          if (header.uncompressedSize > MAX_MEMBER_BYTES) {
            refused.push(`${header.name} (declares ${header.uncompressedSize} bytes, over the ${MAX_MEMBER_BYTES}-byte member limit)`);
            continue;
          }
          decompressed = inflateRawSync(compressedData, { maxOutputLength: MAX_MEMBER_BYTES });
        } catch (error) {
          refused.push(`${header.name} (${error instanceof Error ? error.message : 'could not be decompressed'})`);
          continue;
        }
        if (decompressed.length > MAX_MEMBER_BYTES) {
          refused.push(`${header.name} (expands past the member limit)`);
          continue;
        }
        await writeFile(targetPath, decompressed);
      } else if (header.compressionMethod === 0) {
        if (header.uncompressedSize > MAX_MEMBER_BYTES) {
          refused.push(`${header.name} (stored member over the ${MAX_MEMBER_BYTES}-byte limit)`);
          continue;
        }
        const rawData = buffer.subarray(header.dataOffset, header.dataOffset + header.uncompressedSize);
        await writeFile(targetPath, rawData);
      } else {
        skipped++;
        continue;
      }

      extracted.push(relativeName);
    }

    await context.checkpoints?.confirm(checkpoint);
    const summary = `Extracted ${extracted.length} file${extracted.length === 1 ? '' : 's'} from ${input.path}${skipped > 0 ? ` (${skipped} skipped)` : ''}`;
    const refusalNote = refused.length > 0
      ? `\nRefused ${refused.length} entr${refused.length === 1 ? 'y' : 'ies'} whose path leaves the target directory (this archive may be malicious):\n${refused.slice(0, 20).join('\n')}`
      : '';

    return {
      ok: true,
      output: `${summary}\nTarget: ${targetDir}\n\n${extracted.join('\n')}${refusalNote}`,
      data: {
        extracted,
        skipped,
        refused,
        targetDir,
        checkpointId: checkpoint?.id,
      },
    };
  },
};

export const zipSummaryTool: ToolDefinition<{
  path: string;
  maxEntries?: number;
}> = {
  name: 'zip_summary',
  description:
    'Get aggregate statistics about a ZIP archive: total files, compression ratio, breakdown by file type.',
  inputHint: '{ "path": "archive.zip" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('expected an object');
    }
    const record = input as Record<string, unknown>;

    if (typeof record.path !== 'string' || !record.path.trim()) {
      throw new Error('path is required');
    }

    const maxEntries = typeof record.maxEntries === 'number' ? Math.max(1, Math.min(10000, record.maxEntries)) : 1000;

    return {
      path: record.path.trim(),
      maxEntries,
    };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path, pathScopeFor(context.approval));
    const buffer = await readFile(target);
    const entries = listZipEntries(buffer);

    const totalUncompressed = entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
    const totalCompressed = entries.reduce((sum, e) => sum + e.compressedSize, 0);
    const ratio = totalUncompressed > 0 ? ((1 - totalCompressed / totalUncompressed) * 100).toFixed(1) : '0.0';

    const byExtension = new Map<string, { count: number; uncompressed: number; compressed: number }>();
    
    for (const entry of entries.slice(0, input.maxEntries)) {
      const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : '(no extension)';
      const existing = byExtension.get(ext) || { count: 0, uncompressed: 0, compressed: 0 };
      byExtension.set(ext, {
        count: existing.count + 1,
        uncompressed: existing.uncompressed + entry.uncompressedSize,
        compressed: existing.compressed + entry.compressedSize,
      });
    }

    const breakdown = Array.from(byExtension.entries())
      .sort((a, b) => b[1].uncompressed - a[1].uncompressed)
      .slice(0, 10)
      .map(([ext, stats]) => {
        const extRatio = stats.uncompressed > 0 ? ((1 - stats.compressed / stats.uncompressed) * 100).toFixed(1) : '0.0';
        return `  .${ext.padEnd(15)} ${stats.count.toString().padStart(5)} files  ${stats.uncompressed.toString().padStart(10)} → ${stats.compressed.toString().padStart(10)} bytes  (${extRatio}% saved)`;
      })
      .join('\n');

    return {
      ok: true,
      output: `ZIP Summary: ${input.path}\n\nTotal: ${entries.length} files\nSize: ${totalUncompressed} → ${totalCompressed} bytes (${ratio}% compression)\n\nBy extension:\n${breakdown}`,
      data: {
        path: input.path,
        totalFiles: entries.length,
        totalUncompressed,
        totalCompressed,
        compressionRatio: parseFloat(ratio),
        byExtension: Object.fromEntries(byExtension),
      },
    };
  },
};
