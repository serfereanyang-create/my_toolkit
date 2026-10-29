import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  GitCommandError,
  assertObjectId,
  assertSafeRelativePath,
  topAnchoredLiteralPathspec,
  topAnchoredPathspec,
  type GitProcess,
} from './git.js';
import type {
  GitIndexEntry,
  GitMode,
  GitPathChange,
  GitPathState,
  GitRepositoryInfo,
  GitSnapshot,
} from './types.js';

/**
 * Worktree state of one path plus every object id that could legitimately
 * describe it.
 *
 * The snapshot tree stores CLEAN content (clean filters applied: CRLF -> LF
 * when `core.autocrlf` or `eol=` attributes say so). Hashing the raw
 * worktree bytes with `hash-object --stdin` therefore never matches for a
 * CRLF file; the preview then reported a phantom "worktree no longer matches"
 * conflict and rollback could not be applied at all on a stock Git for
 * Windows install (`core.autocrlf=true`) or on a repo with
 * `.gitattributes: * text eol=crlf`. `candidateOids` carries both the raw hash
 * and the `--path`-filtered hash so the comparison follows what
 * `git status` would say.
 */
export type GitWorktreeState = GitPathState & { candidateOids: string[] };

export class GitSnapshotDiff {
  private filtersAvailable = true;

  constructor(private readonly git: GitProcess) {}

  async manifest(repository: GitRepositoryInfo, baseline: GitSnapshot, result: GitSnapshot): Promise<GitPathChange[]> {
    const output = await this.git.buffer([
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      baseline.commit,
      result.commit,
      '--',
      topAnchoredPathspec(repository.workspacePathspec),
    ]);
    const entries = parseNameStatus(output);
    const changes: GitPathChange[] = [];
    for (const entry of entries) {
      const path = assertSafeRelativePath(entry.path);
      const sourcePath = entry.sourcePath ? assertSafeRelativePath(entry.sourcePath) : undefined;
      const baselineState = await this.treeState(baseline.commit, sourcePath ?? path);
      const resultState = await this.treeState(result.commit, path);
      const resultIndex = await this.indexState(repository, path);
      // Record the raw worktree hash alongside the clean blob id so a later
      // preview can tell "unchanged since the unit" for CRLF files.
      const worktree = await this.worktreeState(repository, path).catch(() => undefined);
      const resultOids = [...new Set([
        ...(resultState?.oid ? [resultState.oid] : []),
        ...(worktree?.candidateOids ?? []),
      ])];
      changes.push({
        kind: classifyChange(entry.status, baselineState, resultState),
        path,
        sourcePath,
        baseline: baselineState ?? { path: sourcePath ?? path },
        result: resultState ?? { path },
        resultIndex,
        ...(resultOids.length > 0 ? { resultOids } : {}),
      });
    }
    return changes;
  }

  async currentState(repository: GitRepositoryInfo, path: string): Promise<GitPathState> {
    const { candidateOids: _ignored, ...state } = await this.worktreeState(repository, path);
    return state;
  }

  /**
   * Worktree state with filtered and unfiltered object ids.
   *
   * A symbolic link is hashed from `readlink`, NOT from `readFile`: on Windows
   * (`core.symlinks=false`) `readlink` returns the target path — the same
   * bytes Git stored in the blob — while `readFile` follows the link and hashes
   * the target's content. That mismatch made every symlink look modified.
   */
  async worktreeState(repository: GitRepositoryInfo, path: string): Promise<GitWorktreeState> {
    const safePath = assertSafeRelativePath(path);
    const absolute = resolve(repository.root, safePath);
    try {
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        const target = await readlink(absolute);
        const bytes = Buffer.from(target, 'utf8');
        const oid = await this.hashBlob(bytes);
        // With `core.symlinks=false` (Windows default) Git checks a 120000 tree
        // entry out as a REGULAR FILE holding the target path. Its clean-filtered
        // hash is what the tree will then contain, so accept it too.
        const filtered = await this.filteredOid(safePath, bytes);
        const candidateOids = filtered && filtered !== oid ? [oid, filtered] : [oid];
        return { path: safePath, oid, mode: '120000', candidateOids };
      }
      if (!stats.isFile()) return { path: safePath, candidateOids: [] };
      const contents = await readFile(absolute);
      const oid = await this.hashBlob(contents);
      const mode: GitMode = (stats.mode & 0o111) ? '100755' : '100644';
      return { path: safePath, oid, mode, candidateOids: await this.candidateOids(repository, safePath, contents, oid) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOTDIR: a parent component is a file, so the target cannot exist.
      if (code === 'ENOENT' || code === 'ENOTDIR') return { path: safePath, candidateOids: [] };
      throw error;
    }
  }

  /** Raw (unfiltered) blob hash, i.e. exactly what `cat-file blob` will yield. */
  private async hashBlob(contents: Buffer): Promise<string> {
    return assertObjectId((await this.git.text(['hash-object', '--stdin'], { stdin: contents })).trim());
  }

  /**
   * Object ids that may equal the tree entry for this worktree file.
   *
   * `git hash-object --path=<p> --stdin` applies the same clean filters
   * (`core.autocrlf`, `.gitattributes` eol/text) that produced the snapshot
   * blob. It is the only reliable comparison for CRLF worktrees, and it is
   * cheap enough (one process per changed path) for a rollback preview.
   *
   * The decision to run it is NOT `core.autocrlf` alone: a repository with
   * `core.autocrlf=false` and `.gitattributes: *.txt text eol=crlf` also
   * stores LF while the worktree holds CRLF. Run the filtered hash whenever
   * the filter machinery is usable and keep both ids; the cost is one process
   * per changed path.
   */
  private async candidateOids(
    _repository: GitRepositoryInfo,
    path: string,
    contents: Buffer,
    rawOid: string,
  ): Promise<string[]> {
    if (!this.filtersAvailable) return [rawOid];
    const filtered = await this.filteredOid(path, contents);
    if (!filtered || filtered === rawOid) return [rawOid];
    return [rawOid, filtered];
  }

  private async filteredOid(path: string, contents: Buffer): Promise<string | undefined> {
    try {
      // `--path` runs the clean side of the same conversion `--filters` runs
      // on checkout; a broken .gitattributes must not turn a readable file
      // into a hard error, so failures fall back to the raw hash.
      return assertObjectId(
        (await this.git.text(['hash-object', `--path=${path}`, '--stdin'], { stdin: contents })).trim(),
      );
    } catch (error) {
      // Only a missing Git binary disables the filtered hash for good; a
      // per-file failure (bad attributes file) just falls back to the raw id.
      if (error instanceof GitCommandError && error.kind === 'spawn') this.filtersAvailable = false;
      return undefined;
    }
  }

  /**
   * Whether the worktree can hold real symlinks. When `core.symlinks=false`
   * (Windows without Developer Mode) Git's own checkout writes a plain file
   * containing the target; rollback must do the same or describe what it will
   * actually create.
   */
  async symlinksSupported(): Promise<boolean> {
    try {
      return (await this.git.text(['config', '--bool', 'core.symlinks'])).trim() !== 'false';
    } catch {
      return true;
    }
  }

  async indexState(repository: GitRepositoryInfo, path: string): Promise<GitIndexEntry[]> {
    const safePath = assertSafeRelativePath(path);
    // `--full-name` makes the OUTPUT paths repository-root-relative, matching
    // the caller's `path`; without it Git prints CWD-relative paths and the
    // comparison below silently finds nothing when the workspace is nested.
    const output = await this.git.buffer(['ls-files', '--stage', '--full-name', '-z', '--', topAnchoredLiteralPathspec(safePath)]);
    return parseIndexEntries(output).filter((entry) => entry.path === safePath);
  }

  async blob(oid: string): Promise<Buffer> {
    return this.git.buffer(['cat-file', 'blob', assertObjectId(oid)]);
  }

  /**
   * Blob content as the WORKTREE would hold it.
   *
   * `cat-file blob` returns the clean (stored) bytes. For a CRLF worktree on
   * `core.autocrlf=true` those are LF bytes, so writing them back changes the
   * file the user had before the turn. `cat-file --filters --path=<p>` runs
   * the same smudge conversion `git checkout` would, which is exactly what a
   * rollback must reproduce. Falls back to the raw blob when the platform's
   * Git is too old (or has no filter machinery) so rollback still works.
   */
  async worktreeBlob(repository: GitRepositoryInfo, path: string, oid: string): Promise<Buffer> {
    const safePath = assertSafeRelativePath(path);
    void repository;
    try {
      return await this.git.buffer(['cat-file', '--filters', `--path=${safePath}`, assertObjectId(oid)]);
    } catch {
      return this.blob(oid);
    }
  }

  private async treeState(commit: string, path: string): Promise<GitPathState | undefined> {
    const safePath = assertSafeRelativePath(path);
    const output = await this.git.buffer(['ls-tree', '--full-name', '-z', commit, '--', topAnchoredLiteralPathspec(safePath)]);
    const entries = parseTreeEntries(output);
    const entry = entries.find((item) => item.path === safePath);
    if (!entry) return undefined;
    return {
      path: safePath,
      oid: entry.oid,
      mode: entry.mode,
    };
  }
}

function classifyChange(
  status: string,
  baseline: GitPathState | undefined,
  result: GitPathState | undefined,
): GitPathChange['kind'] {
  if (status.startsWith('R') || status.startsWith('C')) return 'rename';
  if (status === 'A' || (!baseline?.oid && result?.oid)) return 'add';
  if (status === 'D' || (baseline?.oid && !result?.oid)) return 'delete';
  if (baseline?.mode && result?.mode && baseline.mode !== result.mode && baseline.oid === result.oid) return 'mode-change';
  if (baseline?.mode && result?.mode && baseline.mode !== result.mode) return 'type-change';
  return 'modify';
}

function parseNameStatus(buffer: Buffer): Array<{ status: string; path: string; sourcePath?: string }> {
  const parts = splitNul(buffer);
  const entries: Array<{ status: string; path: string; sourcePath?: string }> = [];
  for (let index = 0; index < parts.length; ) {
    const status = parts[index++] ?? '';
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const sourcePath = parts[index++] ?? '';
      const path = parts[index++] ?? '';
      if (sourcePath && path) entries.push({ status, path, sourcePath });
      continue;
    }
    const path = parts[index++] ?? '';
    if (path) entries.push({ status, path });
  }
  return entries;
}

function parseTreeEntries(buffer: Buffer): Array<{ mode: GitMode; oid: string; path: string }> {
  const parts = splitNul(buffer);
  const entries: Array<{ mode: GitMode; oid: string; path: string }> = [];
  for (const part of parts) {
    if (!part) continue;
    // format: <mode> <type> <oid>\t<path>
    const tab = part.indexOf('\t');
    if (tab < 0) continue;
    const meta = part.slice(0, tab);
    const path = part.slice(tab + 1);
    const [mode, , oid] = meta.split(/\s+/);
    if (!mode || !oid || !path) continue;
    if (mode !== '100644' && mode !== '100755' && mode !== '120000') continue;
    entries.push({ mode, oid: assertObjectId(oid), path });
  }
  return entries;
}

function parseIndexEntries(buffer: Buffer): GitIndexEntry[] {
  const parts = splitNul(buffer);
  const entries: GitIndexEntry[] = [];
  for (const part of parts) {
    if (!part) continue;
    // format: <mode> <oid> <stage>\t<path>
    const tab = part.indexOf('\t');
    if (tab < 0) continue;
    const meta = part.slice(0, tab);
    const path = part.slice(tab + 1);
    const [mode, oid, stageText] = meta.split(/\s+/);
    if (!mode || !oid || stageText === undefined || !path) continue;
    if (mode !== '100644' && mode !== '100755' && mode !== '120000') continue;
    const stage = Number(stageText);
    if (!Number.isInteger(stage) || stage < 0 || stage > 3) continue;
    entries.push({
      path,
      mode,
      oid: assertObjectId(oid),
      stage,
    });
  }
  return entries;
}

function splitNul(buffer: Buffer): string[] {
  if (buffer.length === 0) return [];
  return buffer.toString('utf8').split('\0').filter((part, index, all) => part.length > 0 || index < all.length - 1);
}

export async function ensureInsideWorkspace(workspaceRoot: string, absolutePath: string) {
  const realWorkspace = await realpath(workspaceRoot);
  const realTargetParent = await realpath(dirname(absolutePath)).catch(async () => realpath(workspaceRoot));
  const candidate = resolve(realTargetParent, absolutePath.slice(dirname(absolutePath).length + 1) || '.');
  // Compare path segments, not string prefixes: `startsWith` lets a sibling
  // named `work-evil` pass as inside `work`. Also handles the workspace being
  // the ancestor root itself (relative() === '').
  const relativeToRoot = relative(realWorkspace, candidate);
  const inside = relativeToRoot === ''
    || (!relativeToRoot.startsWith(`..${sep}`) && relativeToRoot !== '..' && !isAbsolute(relativeToRoot));
  if (!inside) throw new Error(`Path escapes workspace: ${absolutePath}`);
}
