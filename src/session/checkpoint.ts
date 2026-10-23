import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isScratchWorkspace, recordGlobalEdit } from '../memory/global.js';
import { renameWithRetry } from '../utils/atomic.js';

const CHECKPOINT_ID = /^cp_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/**
 * How much undo history is kept. Every entry pins a full copy of the file's
 * previous contents, so this is what bounds the disk footprint of the store.
 */
const MAX_CHECKPOINT_ENTRIES = 400;
/**
 * How old a backup must be before the orphan sweep may delete it. A tool batch
 * runs its writes through Promise.all, so a sibling write's backup exists on
 * disk for a moment before its entry reaches the index; sweeping that window
 * would drop backups that the index is about to reference and leave undo with
 * nothing to restore.
 */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

export type CheckpointEntry = {
  id: string;
  action: 'write' | 'rename';
  createdAt: string;
  path?: string;
  backupPath?: string;
  existed?: boolean;
  from?: string;
  to?: string;
  /** The target was a directory: recorded, never backed up or reverted. */
  directory?: boolean;
};

export class CheckpointStore {
  private readonly indexPath: string;
  private readonly backupDir: string;
  private readonly globalMemory: { root?: string; enabled: boolean; indexThrottleMs?: number };
  /**
   * Global-memory records for checkpoints that have not been confirmed yet.
   * A checkpoint is taken *before* the write, so recording it here would claim
   * an edit that may still fail (a locked file, a permission error, a tool that
   * changes its mind). The tool calls confirm() once its write landed; an
   * unconfirmed entry is simply never remembered.
   */
  private readonly pending = new Map<string, { action: 'write' | 'rename' | 'delete'; path: string; from?: string; created?: boolean }>();
  /**
   * Index contents, loaded once. Every mutation used to re-read the file and
   * rewrite it whole, which loses entries — and on Windows fails outright —
   * when a batch of tool calls runs concurrently (agent.ts runs a step's
   * actions through Promise.all).
   */
  private cache: CheckpointEntry[] | null = null;
  /** Serialises index mutations: one writer at a time. */
  private tail: Promise<void> = Promise.resolve();
  private sweptOrphanBackups = false;

  constructor(
    private readonly root: string,
    options: { globalMemoryRoot?: string; recordGlobalMemory?: boolean; globalMemoryIndexThrottleMs?: number } = {},
  ) {
    this.indexPath = resolve(root, '.aicode', 'checkpoints', 'index.json');
    this.backupDir = resolve(root, '.aicode', 'checkpoints', 'backups');
    this.globalMemory = {
      root: options.globalMemoryRoot,
      enabled: options.recordGlobalMemory !== false,
      indexThrottleMs: options.globalMemoryIndexThrottleMs,
    };
  }

  /**
   * Snapshot a path before it is written. `action` only labels the global
   * memory record: a deletion is a write of nothing, and the record should say
   * so instead of claiming the file was edited.
   */
  async beforeWrite(path: string, options: { action?: 'write' | 'delete' } = {}): Promise<CheckpointEntry> {
    const safePath = this.assertWorkspacePath(path);
    const id = makeId();
    const backupPath = join(this.backupDir, `${id}.bak`);
    const action: 'write' | 'delete' = options.action ?? 'write';
    let existed = false;
    let content: Buffer;
    try {
      const info = await stat(safePath);
      if (info.isDirectory()) {
        // An operation that lands in a folder (extracting an archive, patching
        // several files at once) has no single file to snapshot, and restoring
        // one would mean deleting the user's directory. Record that it was
        // touched, but never index it as something undo can revert.
        this.pending.set(id, { action, path: safePath });
        const directoryEntry: CheckpointEntry = { id, action: 'write', createdAt: new Date().toISOString(), path: safePath, existed: true, directory: true };
        return directoryEntry;
      }
      existed = true;
      content = await readFile(safePath);
    } catch (error) {
      if (isMissing(error)) {
        content = Buffer.alloc(0);
      } else {
        throw error;
      }
    }
    if (existed) {
      await mkdir(dirname(backupPath), { recursive: true });
      await writeFile(backupPath, content, { encoding: undefined, flag: 'wx' });
    }
    const entry: CheckpointEntry = { id, action: 'write', createdAt: new Date().toISOString(), path: safePath, backupPath, existed };
    await this.push(entry);
    this.pending.set(id, { action, path: safePath, created: !existed && action !== 'delete' });
    return entry;
  }

  async beforeRename(from: string, to: string) {
    const safeFrom = this.assertWorkspacePath(from);
    const safeTo = this.assertWorkspacePath(to);
    const entry: CheckpointEntry = { id: makeId(), action: 'rename', createdAt: new Date().toISOString(), from: safeFrom, to: safeTo };
    await this.push(entry);
    this.pending.set(entry.id, { action: 'rename', path: safeTo, from: safeFrom });
    return entry;
  }

  /**
   * The tool's write landed: remember it in the global edit record. Call this
   * after the write succeeds — never before, or a failed write would be
   * remembered as an edit. Confirming twice (or confirming a directory entry)
   * is safe; ids this store did not hand out are ignored.
   */
  async confirm(entry: CheckpointEntry | undefined) {
    if (!entry) return;
    const record = this.pending.get(entry.id);
    if (!record) return;
    this.pending.delete(entry.id);
    await this.rememberGlobalEdit({ workspaceRoot: this.root, ...record });
  }

  /**
   * Append to the global memory ledger. Failure is swallowed on purpose: the
   * file write already succeeded and must not be rolled back by bookkeeping.
   */
  private async rememberGlobalEdit(input: { workspaceRoot: string; action: 'write' | 'rename' | 'delete'; path: string; from?: string; created?: boolean }) {
    if (!this.globalMemory.enabled) return;
    // Without an explicit root this is the real ledger: keep throwaway
    // workspaces (test fixtures, scratch dirs) out of it.
    if (this.globalMemory.root === undefined && isScratchWorkspace(input.workspaceRoot)) return;
    try {
      await recordGlobalEdit(input, { root: this.globalMemory.root, indexThrottleMs: this.globalMemory.indexThrottleMs });
    } catch {
      // ignored — see doc comment
    }
  }

  async undoLast() {
    const entry = await this.lock(async () => {
      const entries = await this.load();
      const last = entries.pop();
      if (!last) return undefined;
      await this.revert(last);
      await this.save(entries);
      return last;
    });
    if (!entry) return 'No checkpoint to undo.';
    return `Undid checkpoint ${entry.id} (${entry.action}).`;
  }

  /**
   * Revert a specific set of checkpoints (e.g. every write from one agent
   * turn), newest first so overlapping writes to the same file restore to the
   * correct pre-turn state. Reverted entries are removed from the index; ids
   * not found are ignored. Returns the count actually reverted.
   */
  async undoByIds(ids: string[]) {
    if (ids.length === 0) return { reverted: 0, files: [] as string[] };
    const wanted = new Set(ids);
    return this.lock(async () => {
      const entries = await this.load();
      // Walk newest→oldest so a later write's backup wins the final on-disk state.
      const reverted: string[] = [];
      const kept: CheckpointEntry[] = [];
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (wanted.has(entry.id)) {
          await this.revert(entry);
          if (entry.path) reverted.push(entry.path);
          else if (entry.from) reverted.push(entry.from);
        } else {
          kept.push(entry);
        }
      }
      // `kept` was built in reverse; restore chronological order before saving.
      kept.reverse();
      await this.save(kept);
      return { reverted: reverted.length, files: reverted };
    });
  }

  /** Restore a single checkpoint entry's file to its pre-write/rename state. */
  private async revert(entry: CheckpointEntry) {
    assertCheckpointId(entry.id);
    // Directory entries are informational: this store cannot restore a tree.
    if (entry.directory) return;
    if (entry.action === 'write' && entry.path) {
      const safePath = this.assertWorkspacePath(entry.path);
      if (entry.existed && entry.backupPath) {
        const backupPath = this.assertBackupPath(entry.backupPath, entry.id);
        const content = await readFile(backupPath);
        await mkdir(dirname(safePath), { recursive: true });
        await writeFile(safePath, content);
      } else {
        await rm(safePath, { force: true });
      }
    }

    if (entry.action === 'rename' && entry.from && entry.to) {
      const from = this.assertWorkspacePath(entry.from);
      const to = this.assertWorkspacePath(entry.to);
      await mkdir(dirname(from), { recursive: true });
      await rename(to, from);
    }
  }

  async list(): Promise<CheckpointEntry[]> {
    return this.lock(async () => [...(await this.load())]);
  }

  /**
   * Run `task` with exclusive access to the index. Concurrent tool calls queue
   * here instead of racing on the same file: two renames onto index.json at
   * once fail with EPERM on Windows, and two read-modify-write cycles lose one
   * of the entries.
   */
  private async lock<Result>(task: () => Promise<Result>): Promise<Result> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((done) => { release = done; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async load(): Promise<CheckpointEntry[]> {
    if (this.cache) return this.cache;
    try {
      const value = JSON.parse(await readFile(this.indexPath, 'utf8')) as unknown;
      this.cache = Array.isArray(value) ? value.filter(isCheckpointEntry) : [];
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.cache = [];
    }
    return this.cache;
  }

  private async push(entry: CheckpointEntry) {
    await this.lock(async () => {
      const entries = await this.load();
      entries.push(entry);
      await this.save(entries);
    });
  }

  private async save(entries: CheckpointEntry[]) {
    // Keep the newest MAX_CHECKPOINT_ENTRIES: the index is rewritten whole on
    // every write, so an ever-growing history makes every later write slower,
    // and the backups behind it never stop filling the disk.
    const dropped = entries.length > MAX_CHECKPOINT_ENTRIES ? entries.slice(0, entries.length - MAX_CHECKPOINT_ENTRIES) : [];
    const kept = dropped.length > 0 ? entries.slice(dropped.length) : entries;
    this.cache = kept;
    await mkdir(dirname(this.indexPath), { recursive: true });
    const temporary = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(kept, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await renameWithRetry(temporary, this.indexPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await this.discardBackups(dropped);
    await this.sweepOrphanBackups(kept);
  }

  /** Delete the backup files of entries that just fell out of the index. */
  private async discardBackups(entries: CheckpointEntry[]) {
    for (const entry of entries) {
      if (!entry.backupPath) continue;
      try {
        await unlink(this.assertBackupPath(entry.backupPath, entry.id));
      } catch {
        // A missing or hand-edited backup is not worth failing a write over.
      }
    }
  }

  /**
   * Once per store, delete backups the index no longer references (a deleted
   * or corrupted index would otherwise leave them behind forever).
   */
  private async sweepOrphanBackups(kept: CheckpointEntry[]) {
    if (this.sweptOrphanBackups) return;
    this.sweptOrphanBackups = true;
    let names: string[];
    try {
      names = await readdir(this.backupDir);
    } catch {
      return;
    }
    const referenced = new Set(kept.map((entry) => (entry.backupPath ? `${entry.id}.bak` : '')));
    for (const name of names) {
      if (!name.endsWith('.bak') || referenced.has(name)) continue;
      const candidate = join(this.backupDir, name);
      try {
        const info = await stat(candidate);
        if (Date.now() - info.mtimeMs < ORPHAN_GRACE_MS) continue;
        await unlink(candidate);
      } catch {
        // best effort
      }
    }
  }

  private assertWorkspacePath(path: string) {
    if (!path || path.includes('\0')) throw new Error('Invalid checkpoint path');
    const candidate = resolve(path);
    const workspace = resolve(this.root);
    const desktop = resolve(join(homedir(), 'Desktop'));
    const allowed = [workspace, desktop];
    if (!allowed.some((root) => isPathInside(root, candidate))) {
      throw new Error(`Checkpoint path is outside allowed roots: ${path}`);
    }
    return candidate;
  }

  private assertBackupPath(path: string, id: string) {
    const candidate = resolve(path);
    const rel = relative(this.backupDir, candidate);
    if (rel !== `${id}.bak`) throw new Error(`Invalid checkpoint backup path: ${path}`);
    return candidate;
  }
}

function makeId() {
  return `cp_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function assertCheckpointId(id: string) {
  if (!CHECKPOINT_ID.test(id)) throw new Error(`Invalid checkpoint ID: ${id}`);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isCheckpointEntry(value: unknown): value is CheckpointEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<CheckpointEntry>;
  return typeof entry.id === 'string' && CHECKPOINT_ID.test(entry.id)
    && (entry.action === 'write' || entry.action === 'rename')
    && typeof entry.createdAt === 'string';
}

function isPathInside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
