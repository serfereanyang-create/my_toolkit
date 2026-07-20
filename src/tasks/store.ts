import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { TaskBoard, TaskBoardIndexEntry } from './types.js';

export class TaskBoardStore {
  private readonly root: string;
  private readonly indexPath: string;

  constructor(workspaceRoot: string) {
    this.root = resolve(workspaceRoot, '.aicode', 'tasks');
    this.indexPath = join(this.root, 'index.json');
  }

  filePath(boardId: string) {
    return join(this.root, `${boardId}.json`);
  }

  async save(board: TaskBoard) {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.filePath(board.id), `${JSON.stringify(board, null, 2)}\n`, 'utf8');
    await this.upsertIndex({
      id: board.id,
      title: board.title,
      status: board.status,
      updatedAt: board.updatedAt,
    });
  }

  async load(boardId: string): Promise<TaskBoard> {
    try {
      return JSON.parse(await readFile(this.filePath(boardId), 'utf8')) as TaskBoard;
    } catch {
      throw new Error(`Task board not found: ${boardId}`);
    }
  }

  async list(): Promise<TaskBoardIndexEntry[]> {
    await mkdir(this.root, { recursive: true });
    try {
      const index = JSON.parse(await readFile(this.indexPath, 'utf8')) as TaskBoardIndexEntry[];
      return index.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      const names = await readdir(this.root);
      const entries: TaskBoardIndexEntry[] = [];
      for (const name of names) {
        if (!name.endsWith('.json') || name === 'index.json') continue;
        try {
          const board = JSON.parse(await readFile(join(this.root, name), 'utf8')) as TaskBoard;
          entries.push({ id: board.id, title: board.title, status: board.status, updatedAt: board.updatedAt });
        } catch {
          // ignore corrupt board files
        }
      }
      return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
  }

  private async upsertIndex(entry: TaskBoardIndexEntry) {
    let entries: TaskBoardIndexEntry[] = [];
    try {
      entries = JSON.parse(await readFile(this.indexPath, 'utf8')) as TaskBoardIndexEntry[];
    } catch {
      entries = [];
    }
    const next = [entry, ...entries.filter((item) => item.id !== entry.id)];
    await mkdir(dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }
}
