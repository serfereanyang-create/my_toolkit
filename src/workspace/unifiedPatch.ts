/**
 * unifiedPatch.ts - Apply a unified diff text safely to the workspace.
 *
 * 与 apply_patch（单文件替换）不同，这里接收模格式 unified diff
 * (diff --git a/... b/... / @@ -a,b +c,d @@ / + / - / context)，对应多个文件
 * 批量落地。支持 dry-run 与 atomicity：失败自动全部回滚。
 */

import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

export interface UnifiedDiffHunkLine {
  kind: 'context' | 'add' | 'del';
  content: string;
}

export interface UnifiedDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: UnifiedDiffHunkLine[];
}

export interface UnifiedFilePatch {
  oldPath: string;
  newPath: string;
  kind: 'modify' | 'create' | 'delete' | 'rename';
  hunks: UnifiedDiffHunk[];
}

export class PatchError extends Error {
  constructor(message: string, public readonly file?: string) {
    super(message);
    this.name = 'PatchError';
  }
}

/** 手工解析 diff --git / ---/+++ 头部（避免触发正则安全规则） */
function parseDiffHeaderLine(line: string): { prev: string; next: string } | null {
  if (!line.startsWith('diff ')) return null;
  const aIdx = line.indexOf(' a/');
  const bIdx = line.indexOf(' b/', aIdx + 3);
  if (aIdx < 0 || bIdx < 0 || bIdx <= aIdx) return null;
  return { prev: line.slice(aIdx + 3, bIdx), next: line.slice(bIdx + 3) };
}

/** 解析 @@ -a,b +c,d @@ 的头 */
function parseHunkHeader(line: string): UnifiedDiffHunk | null {
  if (!line.startsWith('@@')) return null;
  const closing = line.indexOf('@@', 2);
  const inner = closing > 2 ? line.slice(2, closing) : line.slice(2);
  const minusIdx = inner.indexOf('-');
  const plusIdx = inner.indexOf('+');
  if (minusIdx < 0 || plusIdx < 0) return null;
  const oldPart = inner.slice(minusIdx + 1, plusIdx).trim();
  const newPart = inner.slice(plusIdx + 1).trim();
  const oldRange = parseRange(oldPart);
  const newRange = parseRange(newPart);
  if (!oldRange || !newRange) return null;
  return {
    oldStart: oldRange.start,
    oldCount: oldRange.count,
    newStart: newRange.start,
    newCount: newRange.count,
    lines: [],
  };
}

function parseRange(spec: string): { start: number; count: number } | null {
  const comma = spec.indexOf(',');
  const startRaw = comma < 0 ? spec.trim() : spec.slice(0, comma).trim();
  const countRaw = comma < 0 ? '1' : spec.slice(comma + 1).trim();
  const start = Number(startRaw);
  const count = Number(countRaw);
  if (!Number.isFinite(start) || !Number.isFinite(count)) return null;
  return { start, count };
}

/** Parse a unified diff text into a structured plan. */
export function parseUnifiedDiff(text: string): { files: UnifiedFilePatch[] } {
  const files: UnifiedFilePatch[] = [];
  let current: UnifiedFilePatch | null = null;
  let currentHunk: UnifiedDiffHunk | null = null;

  for (const raw of text.split('\n')) {
    const line = raw;
    const header = parseDiffHeaderLine(line);
    if (header) {
      current = {
        oldPath: header.prev,
        newPath: header.next,
        kind: 'modify',
        hunks: [],
      };
      files.push(current);
      currentHunk = null;
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.kind = 'create';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.kind = 'delete';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length).trim();
      current.kind = 'rename';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.newPath = line.slice('rename to '.length).trim();
      current.kind = 'rename';
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      if (p.startsWith('a/')) current.oldPath = p.slice(2);
      else if (p === '/dev/null') current.kind = 'create';
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p.startsWith('b/')) current.newPath = p.slice(2);
      else if (p === '/dev/null') current.kind = 'delete';
      continue;
    }

    const hunk = parseHunkHeader(line);
    if (hunk) {
      currentHunk = hunk;
      current.hunks.push(hunk);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({ kind: 'add', content: line.slice(1) });
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ kind: 'del', content: line.slice(1) });
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.lines.push({ kind: 'context', content: line.startsWith(' ') ? line.slice(1) : line });
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" — skip
        continue;
      }
    }
  }

  return { files };
}

/** Apply hunks to a source text. Returns the new content. */
export function applyHunksToText(oldText: string, hunks: UnifiedDiffHunk[]): string {
  const sourceLines = oldText.split('\n');
  const out: string[] = [];
  let srcCursor = 0;

  for (const hunk of hunks) {
    const copyUntil = hunk.oldStart - 1;
    if (copyUntil < srcCursor) {
      throw new PatchError(`overlapping hunks (oldStart=${hunk.oldStart} < consumed=${srcCursor + 1})`);
    }
    while (srcCursor < copyUntil) {
      out.push(sourceLines[srcCursor]!);
      srcCursor += 1;
    }
    for (const l of hunk.lines) {
      if (l.kind === 'add') {
        out.push(l.content);
      } else if (l.kind === 'del') {
        const expected = sourceLines[srcCursor];
        if (expected !== l.content) {
          throw new PatchError(
            `hunk mismatch at line ${srcCursor + 1}: expected "${l.content.slice(0, 40)}…" got "${(expected ?? '').slice(0, 40)}…"`,
          );
        }
        srcCursor += 1;
      } else {
        const expected = sourceLines[srcCursor];
        if (expected !== l.content) {
          throw new PatchError(
            `context mismatch at line ${srcCursor + 1}: expected "${l.content.slice(0, 40)}…" got "${(expected ?? '').slice(0, 40)}…"`,
          );
        }
        out.push(l.content);
        srcCursor += 1;
      }
    }
  }
  while (srcCursor < sourceLines.length) {
    out.push(sourceLines[srcCursor]!);
    srcCursor += 1;
  }
  return out.join('\n');
}

export interface ApplyUnifiedPatchParams {
  workspaceRoot: string;
  patchText: string;
  dryRun?: boolean;
  atomic?: boolean;
}

export interface ApplyUnifiedPatchResult {
  ok: boolean;
  filesAffected: number;
  summary: Array<{ file: string; action: string; bytesAdded: number; bytesRemoved: number }>;
  errors: string[];
}

export async function applyUnifiedPatch(params: ApplyUnifiedPatchParams): Promise<ApplyUnifiedPatchResult> {
  const plan = parseUnifiedDiff(params.patchText);
  const errors: string[] = [];
  const summary: Array<{ file: string; action: string; bytesAdded: number; bytesRemoved: number }> = [];
  const rollback: Array<{ path: string; hadExisted: boolean; previousContent: string | null }> = [];

  for (const file of plan.files) {
    const absPath = resolve(params.workspaceRoot, file.newPath);
    const oldAbsPath = resolve(params.workspaceRoot, file.oldPath);
    if (!absPath.startsWith(params.workspaceRoot) || !oldAbsPath.startsWith(params.workspaceRoot)) {
      errors.push(`path escapes workspace: ${file.newPath}`);
      continue;
    }

    try {
      if (file.kind === 'delete') {
        if (!existsSync(absPath)) throw new PatchError(`file not found: ${file.oldPath}`);
        const existing = await readFile(absPath, 'utf-8');
        summary.push({ file: file.oldPath, action: 'delete', bytesAdded: 0, bytesRemoved: existing.length });
        if (!params.dryRun) {
          rollback.push({ path: absPath, hadExisted: true, previousContent: existing });
          await unlink(absPath);
        }
      } else if (file.kind === 'create') {
        if (existsSync(absPath)) throw new PatchError(`file already exists: ${file.newPath}`);
        const newContent = applyHunksToText('', file.hunks);
        summary.push({ file: file.newPath, action: 'create', bytesAdded: newContent.length, bytesRemoved: 0 });
        if (!params.dryRun) {
          rollback.push({ path: absPath, hadExisted: false, previousContent: null });
          await mkdir(dirname(absPath), { recursive: true });
          await writeFile(absPath, newContent, 'utf-8');
        }
      } else {
        const target = file.kind === 'rename' ? oldAbsPath : absPath;
        if (!existsSync(target)) throw new PatchError(`file not found: ${file.oldPath}`);
        const existingText = await readFile(target, 'utf-8');
        const next = applyHunksToText(existingText, file.hunks);
        summary.push({
          file: file.newPath,
          action: file.kind,
          bytesAdded: Math.max(0, next.length - existingText.length),
          bytesRemoved: Math.max(0, existingText.length - next.length),
        });
        if (!params.dryRun) {
          rollback.push({ path: target, hadExisted: true, previousContent: existingText });
          await writeFile(target, next, 'utf-8');
          if (file.kind === 'rename') {
            await mkdir(dirname(absPath), { recursive: true });
            rollback.push({ path: absPath, hadExisted: false, previousContent: null });
            await writeFile(absPath, next, 'utf-8');
            await unlink(target);
          }
        }
      }
    } catch (err) {
      const message = err instanceof PatchError ? err.message : (err as Error).message;
      errors.push(`${file.newPath}: ${message}`);
      if (params.atomic && !params.dryRun) {
        for (let i = rollback.length - 1; i >= 0; i--) {
          const r = rollback[i]!;
          try {
            if (r.hadExisted && r.previousContent != null) {
              await writeFile(r.path, r.previousContent, 'utf-8');
            } else if (!r.hadExisted) {
              await unlink(r.path).catch(() => {});
            }
          } catch {
            // ignore rollback errors
          }
        }
        return { ok: false, filesAffected: 0, summary, errors };
      }
    }
  }

  return {
    ok: errors.length === 0,
    filesAffected: summary.length,
    summary,
    errors,
  };
}
