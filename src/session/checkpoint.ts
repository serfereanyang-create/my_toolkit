import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

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

  constructor(private readonly root: string) {
    this.indexPath = resolve(root, '.aicode', 'checkpoints', 'index.json');
    this.backupDir = resolve(root, '.aicode', 'checkpoints', 'backups');
  }

  async beforeWrite(path: string) {
    const id = makeId();
    const backupPath = join(this.backupDir, `${id}.bak`);
    let existed = true;
    try {
      const content = await readFile(path);
      await mkdir(dirname(backupPath), { recursive: true });
      await writeFile(backupPath, content);
    } catch {
      existed = false;
    }
    const entry: CheckpointEntry = { id, action: 'write', createdAt: new Date().toISOString(), path, backupPath, existed };
    await this.push(entry);
    return entry;
  }

  async beforeRename(from: string, to: string) {
    const entry: CheckpointEntry = { id: makeId(), action: 'rename', createdAt: new Date().toISOString(), from, to };
    await this.push(entry);
    return entry;
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
    if (entry.action === 'write' && entry.path) {
      if (entry.existed && entry.backupPath) {
        const content = await readFile(entry.backupPath);
        await mkdir(dirname(entry.path), { recursive: true });
        await writeFile(entry.path, content);
      } else {
        await rm(entry.path, { force: true });
      }
    }

    if (entry.action === 'rename' && entry.from && entry.to) {
      await mkdir(dirname(entry.from), { recursive: true });
      await rename(entry.to, entry.from);
    }
  }

  async list() {
    try {
      return JSON.parse(await readFile(this.indexPath, 'utf8')) as CheckpointEntry[];
    } catch {
      return [];
    }
  }

  private async push(entry: CheckpointEntry) {
    const entries = await this.list();
    entries.push(entry);
    await this.save(entries);
  }

  private async save(entries: CheckpointEntry[]) {
    await mkdir(dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  }
}

function makeId() {
  return `cp_${Date.now()}_${randomUUID().slice(0, 8)}`;
}
