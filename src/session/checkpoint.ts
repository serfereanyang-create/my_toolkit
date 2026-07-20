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

    await this.save(entries);
    return `Undid checkpoint ${entry.id} (${entry.action}).`;
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
