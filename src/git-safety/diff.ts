import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  assertObjectId,
  assertSafeRelativePath,
  literalPathspec,
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

export class GitSnapshotDiff {
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
      repository.workspacePathspec,
    ]);
    const entries = parseNameStatus(output);
    const changes: GitPathChange[] = [];
    for (const entry of entries) {
      const path = assertSafeRelativePath(entry.path);
      const sourcePath = entry.sourcePath ? assertSafeRelativePath(entry.sourcePath) : undefined;
      const baselineState = await this.treeState(baseline.commit, sourcePath ?? path);
      const resultState = await this.treeState(result.commit, path);
      const resultIndex = await this.indexState(repository, path);
      changes.push({
        kind: classifyChange(entry.status, baselineState, resultState),
        path,
        sourcePath,
        baseline: baselineState ?? { path: sourcePath ?? path },
        result: resultState ?? { path },
        resultIndex,
      });
    }
    return changes;
  }

  async currentState(repository: GitRepositoryInfo, path: string): Promise<GitPathState> {
    const safePath = assertSafeRelativePath(path);
    const absolute = resolve(repository.root, safePath);
    try {
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        const target = await readFile(absolute);
        const oid = assertObjectId((await this.git.text(['hash-object', '--stdin'], { stdin: target })).trim());
        return { path: safePath, oid, mode: '120000' };
      }
      if (!stats.isFile()) return { path: safePath };
      const contents = await readFile(absolute);
      const oid = assertObjectId((await this.git.text(['hash-object', '--stdin'], { stdin: contents })).trim());
      const mode: GitMode = (stats.mode & 0o111) ? '100755' : '100644';
      return { path: safePath, oid, mode };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: safePath };
      throw error;
    }
  }

  async indexState(repository: GitRepositoryInfo, path: string): Promise<GitIndexEntry[]> {
    const safePath = assertSafeRelativePath(path);
    const output = await this.git.buffer(['ls-files', '--stage', '-z', '--', literalPathspec(safePath)]);
    return parseIndexEntries(output).filter((entry) => entry.path === safePath);
  }

  async blob(oid: string): Promise<Buffer> {
    return this.git.buffer(['cat-file', 'blob', assertObjectId(oid)]);
  }

  private async treeState(commit: string, path: string): Promise<GitPathState | undefined> {
    const safePath = assertSafeRelativePath(path);
    const output = await this.git.buffer(['ls-tree', '-z', commit, '--', literalPathspec(safePath)]);
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
  const rel = resolve(candidate).toLowerCase().startsWith(realWorkspace.toLowerCase());
  if (!rel) throw new Error(`Path escapes workspace: ${absolutePath}`);
}
