/**
 * unifiedPatch.ts - Apply a unified diff text safely to the workspace.
 *
 * 与 apply_patch（单文件替换）不同，这里接收模格式 unified diff
 * (diff --git a/... b/... / @@ -a,b +c,d @@ / + / - / context)，对应多个文件
 * 批量落地。支持 dry-run 与 atomicity：失败自动全部回滚。
 */

import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { assertRestorablePath } from '../git-safety/git.js';

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
  /** `\ No newline at end of file` closed the NEW side: do not append one. */
  noNewlineAtEnd?: boolean;
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
  // `split('\n')` drops the difference between "ends with a newline" and
  // "does not". A patch body for `printf 'a'` is exactly the one-line diff
  // `... +1 @@ / +a`; splitting on '\n' cannot tell it apart from a file whose
  // last line IS newline-terminated.
  const rawLines = text.split('\n');

  for (const line of rawLines) {
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
    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
      // Our format is text hunks; silently ignoring a binary payload would
      // report success while writing nothing.
      throw new PatchError(`binary patches are not supported: ${current.newPath}`);
    }

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
        // "\ No newline at end of file" attaches to the side it follows. Track
        // the last emitted line's side; if it was an addition, the new file
        // has no trailing newline.
        const last = currentHunk.lines[currentHunk.lines.length - 1];
        if (last && last.kind !== 'del') current.noNewlineAtEnd = true;
        continue;
      }
    }
  }

  return { files };
}

/** Replace the trailing-newline marker of a line model. */
type LineModel = { lines: string[]; trailingNewline: boolean };

function parseTextModel(text: string): LineModel {
  if (text === '') return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

/** Apply hunks to a source text. Returns the new content. */
export function applyHunksToText(oldText: string, hunks: UnifiedDiffHunk[], noNewlineAtEnd = false): string {
  return serializeModel(applyHunks(parseTextModel(oldText), hunks, noNewlineAtEnd));
}

function serializeModel(model: LineModel): string {
  if (model.lines.length === 0) return '';
  return model.lines.join('\n') + (model.trailingNewline ? '\n' : '');
}

/**
 * Hunk application over an explicit line model.
 *
 * `oldStart` is a 1-based line number; 0 is the only value Git emits and it
 * means "before the first line" (used by pure-insert hunks and by
 * `new file mode` patches). Treating 0 as 1 made every `git diff`-produced
 * file creation fail with "overlapping hunks (oldStart=0 < consumed=1)".
 */
function applyHunks(source: LineModel, hunks: UnifiedDiffHunk[], noNewlineAtEnd: boolean): LineModel {
  const out: string[] = [];
  let srcCursor = 0;

  for (const hunk of hunks) {
    const copyUntil = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (copyUntil < srcCursor) {
      throw new PatchError(`overlapping hunks (oldStart=${hunk.oldStart} < consumed=${srcCursor + 1})`);
    }
    while (srcCursor < copyUntil) {
      out.push(source.lines[srcCursor]!);
      srcCursor += 1;
    }
    for (const l of hunk.lines) {
      if (l.kind === 'add') {
        out.push(l.content);
      } else if (l.kind === 'del') {
        const expected = source.lines[srcCursor];
        if (expected !== l.content) {
          throw new PatchError(
            `hunk mismatch at line ${srcCursor + 1}: expected "${l.content.slice(0, 40)}…" got "${(expected ?? '').slice(0, 40)}…"`,
          );
        }
        srcCursor += 1;
      } else {
        const expected = source.lines[srcCursor];
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
  while (srcCursor < source.lines.length) {
    out.push(source.lines[srcCursor]!);
    srcCursor += 1;
  }

  if (hunks.length === 0) return source;
  if (noNewlineAtEnd) return { lines: out, trailingNewline: false };
  if (source.lines.length === 0) {
    // Everything came from the patch body. Git terminates each diff line with
    // its own newline, so a creation without the marker ends with one (the old
    // `split('\n')` implementation produced this implicitly).
    return { lines: out, trailingNewline: true };
  }
  return { lines: out, trailingNewline: source.trailingNewline };
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

/**
 * Resolve a patch path and prove it stays inside the workspace.
 *
 * `startsWith(root)` is not a containment test: with root `C:\work` the path
 * `C:\work-evil\x` passes. It is also case-sensitive on Windows, where the
 * drive letter in the patch may not match how the caller spelled the root.
 * The check is done twice:
 *   - lexically (after normalising separators and dropping drive-letter case);
 *   - physically, via `realpath` of the nearest existing ancestor — a
 *     symlinked directory inside the workspace must not become a write hole.
 * Windows device names, trailing dots/spaces and UNC forms are rejected by
 * `assertRestorablePath` before any filesystem call.
 */
function resolvePatchTarget(workspaceRoot: string, patchPath: string): { abs: string; error?: string } {
  const normalized = patchPath.replace(/\\/g, '/');
  if (isAbsolute(normalized) || normalized.startsWith('//')) {
    return { abs: normalized, error: `path escapes workspace: ${patchPath}` };
  }
  try {
    assertRestorablePath(normalized);
  } catch (error) {
    return { abs: normalized, error: `${patchPath}: ${(error as Error).message}` };
  }
  const root = resolve(workspaceRoot);
  const abs = resolve(root, normalized);
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { abs, error: `path escapes workspace: ${patchPath}` };
  }
  if (!realPathInside(root, abs)) {
    return { abs, error: `path escapes workspace: ${patchPath}` };
  }
  return { abs };
}

/** Physical containment of `abs` under `root` through the nearest existing ancestor. */
function realPathInside(root: string, abs: string): boolean {
  let cursor = abs;
  while (true) {
    try {
      const real = realpathSync(cursor);
      const realRoot = realpathSync(root);
      const rel = relative(realRoot, real);
      return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return false;
      cursor = parent;
    }
  }
}

export async function applyUnifiedPatch(params: ApplyUnifiedPatchParams): Promise<ApplyUnifiedPatchResult> {
  const plan = parseUnifiedDiff(params.patchText);
  const errors: string[] = [];
  const summary: Array<{ file: string; action: string; bytesAdded: number; bytesRemoved: number }> = [];
  const workspaceRoot = resolve(params.workspaceRoot);

  type JournalEntry =
    | { kind: 'write'; abs: string; existed: boolean; previous: string | null }
    | { kind: 'delete'; abs: string; previous: string };
  const journal: JournalEntry[] = [];

  /**
   * Replay the journal in reverse. Every failure is reported back: the old
   * version swallowed them (`catch { /* ignore *\/ }`) and returned ok:false
   * as if the workspace were untouched.
   */
  async function undo(_reason: string): Promise<ApplyUnifiedPatchResult> {
    const failures: string[] = [];
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const entry = journal[index]!;
      try {
        if (entry.kind === 'delete') {
          await writeFile(entry.abs, entry.previous, 'utf-8');
        } else if (entry.existed && entry.previous !== null) {
          await writeFile(entry.abs, entry.previous, 'utf-8');
        } else {
          await unlink(entry.abs).catch(() => undefined);
        }
      } catch (error) {
        failures.push(`${entry.abs}: ${(error as Error).message}`);
      }
    }
    if (failures.length > 0) {
      errors.push(`atomic rollback incomplete (${failures.length} path(s) not restored): ${failures.join('; ')}`);
    }
    return { ok: false, filesAffected: 0, summary, errors };
  }

  for (const file of plan.files) {
    // `source` is what the hunks are applied to; `destination` is the path
    // written. They differ only for a rename.
    const source = file.kind === 'rename' ? file.oldPath : file.newPath;
    const destination = file.newPath;
    const sourceResolved = resolvePatchTarget(workspaceRoot, source);
    const destinationResolved = resolvePatchTarget(workspaceRoot, destination);
    if (sourceResolved.error || destinationResolved.error) {
      const message = sourceResolved.error ?? destinationResolved.error!;
      errors.push(message);
      if (params.atomic && !params.dryRun) return undo(message);
      continue;
    }
    const absPath = sourceResolved.abs;
    const oldAbsPath = destinationResolved.abs;

    try {
      if (file.kind === 'delete') {
        if (!existsSync(absPath)) throw new PatchError(`file not found: ${file.oldPath}`);
        const existing = await readFile(absPath, 'utf-8');
        summary.push({ file: file.oldPath, action: 'delete', bytesAdded: 0, bytesRemoved: existing.length });
        if (!params.dryRun) {
          journal.push({ kind: 'delete', abs: absPath, previous: existing });
          await unlink(absPath);
        }
      } else if (file.kind === 'create') {
        if (existsSync(absPath)) throw new PatchError(`file already exists: ${file.newPath}`);
        const newContent = applyHunksToText('', file.hunks, file.noNewlineAtEnd);
        summary.push({ file: file.newPath, action: 'create', bytesAdded: newContent.length, bytesRemoved: 0 });
        if (!params.dryRun) {
          journal.push({ kind: 'write', abs: absPath, existed: false, previous: null });
          await mkdir(dirname(absPath), { recursive: true });
          await writeFile(absPath, newContent, 'utf-8');
        }
      } else {
        if (!existsSync(absPath)) throw new PatchError(`file not found: ${file.oldPath}`);
        const existingText = await readFile(absPath, 'utf-8');
        const next = applyHunksToText(existingText, file.hunks, file.noNewlineAtEnd);
        summary.push({
          file: file.newPath,
          action: file.kind,
          bytesAdded: Math.max(0, next.length - existingText.length),
          bytesRemoved: Math.max(0, existingText.length - next.length),
        });
        if (!params.dryRun) {
          journal.push({ kind: 'write', abs: absPath, existed: true, previous: existingText });
          await writeFile(absPath, next, 'utf-8');
          if (file.kind === 'rename') {
            // A rename may target an existing file; that file's content must be
            // undoable too, or a later failure destroys it.
            if (existsSync(oldAbsPath)) {
              const overwritten = await readFile(oldAbsPath, 'utf-8');
              journal.push({ kind: 'write', abs: oldAbsPath, existed: true, previous: overwritten });
            } else {
              journal.push({ kind: 'write', abs: oldAbsPath, existed: false, previous: null });
            }
            await mkdir(dirname(oldAbsPath), { recursive: true });
            await writeFile(oldAbsPath, next, 'utf-8');
            await unlink(absPath);
          }
        }
      }
    } catch (err) {
      const message = err instanceof PatchError ? err.message : (err as Error).message;
      errors.push(`${file.newPath}: ${message}`);
      if (params.atomic && !params.dryRun) return undo(message);
    }
  }

  return {
    ok: errors.length === 0,
    filesAffected: summary.length,
    summary,
    errors,
  };
}
