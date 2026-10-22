import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isScratchWorkspace, recordGlobalEdit } from '../memory/global.js';

const CHECKPOINT_ID = /^cp_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type CheckpointEntry = {
  id: string;
  action: 'write' | 'rename';
  createdAt: string;
  path?: string;
  backupPath?: string;
  existed?: boolean;
  from?: string;
  to?: string;
};

export class CheckpointStore {
  private readonly indexPath: string;
  private readonly backupDir: string;
  private readonly globalMemory: { root?: string; enabled: boolean };

  constructor(
    private readonly root: string,
    options: { globalMemoryRoot?: string; recordGlobalMemory?: boolean } = {},
  ) {
    this.indexPath = resolve(root, '.aicode', 'checkpoints', 'index.json');
    this.backupDir = resolve(root, '.aicode', 'checkpoints', 'backups');
    this.globalMemory = { root: options.globalMemoryRoot, enabled: options.recordGlobalMemory !== false };
  }

  /**
   * Snapshot a path before it is written. `action` only labels the global
   * memory record: a deletion is a write of nothing, and the record should say
   * so instead of claiming the file was edited.
   */
  async beforeWrite(path: string, options: { action?: 'write' | 'delete' } = {}) {
    const safePath = this.assertWorkspacePath(path);
    const id = makeId();
    const backupPath = join(this.backupDir, `${id}.bak`);
    let existed = true;
    let content: Buffer;
    try {
      content = await readFile(safePath);
    } catch (error) {
      if (isMissing(error)) {
        existed = false;
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
    // Every write in the CLI funnels through this method, which makes it the
    // one honest place to keep the cross-project edit record.
    await this.rememberGlobalEdit({ workspaceRoot: this.root, action: options.action ?? 'write', path: safePath, created: !existed && options.action !== 'delete' });
    return entry;
  }

  async beforeRename(from: string, to: string) {
    const safeFrom = this.assertWorkspacePath(from);
    const safeTo = this.assertWorkspacePath(to);
    const entry: CheckpointEntry = { id: makeId(), action: 'rename', createdAt: new Date().toISOString(), from: safeFrom, to: safeTo };
    await this.push(entry);
    await this.rememberGlobalEdit({ workspaceRoot: this.root, action: 'rename', path: safeTo, from: safeFrom });
    return entry;
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
      await recordGlobalEdit(input, { root: this.globalMemory.root });
    } catch {
      // ignored — see doc comment
    }
  }

  async undoLast() {
    const entries = await this.list();
    const entry = entries.pop();
    if (!entry) return 'No checkpoint to undo.';

    await this.revert(entry);

    await this.save(entries);
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
    const entries = await this.list();
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
  }

  /** Restore a single checkpoint entry's file to its pre-write/rename state. */
  private async revert(entry: CheckpointEntry) {
    assertCheckpointId(entry.id);
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

  async list() {
    try {
      const value = JSON.parse(await readFile(this.indexPath, 'utf8')) as unknown;
      if (!Array.isArray(value)) return [];
      return value.filter(isCheckpointEntry);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async push(entry: CheckpointEntry) {
    const entries = await this.list();
    entries.push(entry);
    await this.save(entries);
  }

  private async save(entries: CheckpointEntry[]) {
    await mkdir(dirname(this.indexPath), { recursive: true });
    const temporary = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, this.indexPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
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
