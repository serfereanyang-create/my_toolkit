import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { TaskBoard, TaskBoardIndexEntry } from './types.js';
import { inspectTaskGraph } from './graph.js';

/** 租约新鲜度窗口：超过此时长且 pid 不存活才视为崩溃遗留。 */
const LEASE_TTL_MS = 5 * 60_000;

export type TaskBoardLease = {
  boardId: string;
  taskId: string;
  pid: number;
  updatedAt: string;
};

export class TaskBoardStore {
  private readonly root: string;
  private readonly indexPath: string;
  /**
   * Board and index writes are serialized: the task runner, the REPL, and the
   * desktop bridge can all save concurrently, and interleaved read-modify-write
   * on index.json used to drop entries.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.root = resolve(workspaceRoot, '.aicode', 'tasks');
    this.indexPath = join(this.root, 'index.json');
  }

  filePath(boardId: string) {
    return join(this.root, `${boardId}.json`);
  }

  private leasePath(boardId: string) {
    return join(this.root, `${boardId}.lease.json`);
  }

  /**
   * 写入/刷新运行租约。任务板循环在每个任务开始时调用：租约让崩溃恢复
   * 能区分"另一进程正在执行"与"进程崩溃遗留的 in_progress"。
   */
  async writeLease(boardId: string, taskId: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const lease: TaskBoardLease = {
      boardId,
      taskId,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    };
    await this.writeAtomically(this.leasePath(boardId), `${JSON.stringify(lease, null, 2)}\n`);
  }

  async readLease(boardId: string): Promise<TaskBoardLease | null> {
    try {
      const lease = JSON.parse(await readFile(this.leasePath(boardId), 'utf8')) as TaskBoardLease;
      if (typeof lease?.pid !== 'number' || typeof lease?.updatedAt !== 'string') return null;
      return lease;
    } catch {
      return null;
    }
  }

  async clearLease(boardId: string): Promise<void> {
    await unlink(this.leasePath(boardId)).catch(() => { /* no lease to clear */ });
  }

  /**
   * 活租约判定：持有进程仍存活，或租约在 TTL 内刷新过。
   * process.kill(pid, 0) 只探测进程存在，不发送信号；EPERM 也说明进程存在。
   */
  async isLeaseLive(boardId: string, now = Date.now(), ttlMs = LEASE_TTL_MS): Promise<boolean> {
    const lease = await this.readLease(boardId);
    if (!lease) return false;
    const updated = Date.parse(lease.updatedAt);
    if (Number.isFinite(updated) && now - updated < ttlMs) return true;
    if (!Number.isInteger(lease.pid) || lease.pid <= 0) return false;
    try {
      process.kill(lease.pid, 0);
      return true;
    } catch (error) {
      // EPERM：进程存在但属于其他用户/权限不足 → 视为存活。
      return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  }

  async save(board: TaskBoard) {
    const run = this.writeQueue.then(() => this.saveNow(board));
    this.writeQueue = run.catch(() => { /* keep the queue alive for later saves */ });
    await run;
  }

  private async saveNow(board: TaskBoard) {
    await mkdir(this.root, { recursive: true });
    await this.writeAtomically(this.filePath(board.id), `${JSON.stringify(board, null, 2)}\n`);
    await this.upsertIndex({
      id: board.id,
      title: board.title,
      status: board.status,
      updatedAt: board.updatedAt,
    });
  }

  async load(boardId: string): Promise<TaskBoard> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(boardId), 'utf8');
    } catch {
      throw new Error(`Task board not found: ${boardId}`);
    }
    // A truncated or hand-edited file is a different failure from a missing
    // one: reporting it as "not found" hides recoverable evidence and made
    // `recoverInterrupted` spend a load on a file it could never read.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Task board is corrupt (unparseable JSON): ${boardId}`);
    }
    if (!isBoardRecord(parsed)) throw new Error(`Task board is corrupt (invalid structure): ${boardId}`);
    return parsed;
  }

  async list(): Promise<TaskBoardIndexEntry[]> {
    await mkdir(this.root, { recursive: true });
    try {
      const index: unknown = JSON.parse(await readFile(this.indexPath, 'utf8'));
      // The index is a cache, not the source of truth. Anything that is not an
      // entry array — `null` from a half-written file, an object from a manual
      // edit — falls through to the directory scan below instead of throwing
      // on `sort`. A partially valid array is treated the same way: dropping
      // the bad rows would silently hide the boards they name.
      if (Array.isArray(index) && index.every(isIndexEntry)) {
        return index.sort(byUpdatedAtDesc);
      }
    } catch {
      // fall through to the directory scan
    }
    const names = await readdir(this.root);
    const entries: TaskBoardIndexEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json' || name.endsWith('.lease.json')) continue;
      try {
        const raw = JSON.parse(await readFile(join(this.root, name), 'utf8')) as unknown;
        if (!isBoardRecord(raw)) continue;
        entries.push({ id: raw.id, title: raw.title, status: raw.status, updatedAt: raw.updatedAt });
      } catch {
        // ignore corrupt board files
      }
    }
    return entries.sort(byUpdatedAtDesc);
  }

  /**
   * 崩溃恢复：把遗留的 in_progress 任务标记为 blocked（附原因），让 UI 能
   * 提供显式重跑，而不是静默续跑半成品。两种情况跳过：
   *  - 活租约存在 → 另一个进程正在执行这个任务板；
   *  - 任务板没有 in_progress 任务 → 无需修复。
   * 只重写确实需要修复的任务板；返回被修复的 board ID 列表。
   */
  async recoverInterrupted(now = new Date().toISOString()): Promise<string[]> {
    const repaired: string[] = [];
    for (const entry of await this.list()) {
      let board: TaskBoard;
      try {
        board = await this.load(entry.id);
      } catch {
        continue; // unreadable board: leave it for the corrupt-file path
      }
      // Liveness is checked before graph validity: a board that is currently
      // executing must be left alone even if its graph does not pass the
      // semantic checks (that is the live runner's problem to report, not a
      // recovery pass's to rewrite).
      if (await this.isLeaseLive(board.id)) continue; // a live runner owns it
      if (inspectTaskGraph(board.tasks).issues.length) continue;
      const interrupted = board.tasks.filter((task) => task.status === 'in_progress');
      if (interrupted.length === 0) continue;
      for (const task of interrupted) {
        task.status = 'blocked';
        task.error = 'Interrupted by an application restart; review the workspace and re-run this task.';
        task.finishedAt = now;
      }
      board.updatedAt = now;
      await this.save(board);
      await this.clearLease(board.id);
      repaired.push(board.id);
    }
    return repaired;
  }

  private async upsertIndex(entry: TaskBoardIndexEntry) {
    let entries: TaskBoardIndexEntry[] = [];
    try {
      const parsed: unknown = JSON.parse(await readFile(this.indexPath, 'utf8'));
      entries = Array.isArray(parsed) ? parsed.filter(isIndexEntry) : [];
    } catch {
      entries = [];
    }
    const next = [entry, ...entries.filter((item) => item.id !== entry.id)];
    await mkdir(dirname(this.indexPath), { recursive: true });
    await this.writeAtomically(this.indexPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  /** temp-file + rename so a crash never leaves a truncated board or index. */
  private async writeAtomically(target: string, data: string) {
    const temp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(temp, data, 'utf8');
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => { /* best-effort temp cleanup */ });
      throw error;
    }
  }
}

const BOARD_STATUSES = new Set(['draft', 'active', 'completed', 'blocked', 'cancelled']);
const TASK_STATUSES = new Set(['pending', 'in_progress', 'done', 'blocked', 'cancelled', 'skipped']);

/**
 * Structural check for a persisted board.
 *
 * Deliberately shape-only: it does not judge legal status *transitions* (a
 * `done` task without a recorded run is the user's edit to make), because
 * refusing to load is worse than showing the state. What it refuses is data
 * that would crash a consumer — a missing id, a non-array task list, a task
 * whose `status` is not a known value. `inspectTaskGraph` remains the semantic
 * gate for the runner.
 */
function isBoardRecord(value: unknown): value is TaskBoard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const board = value as Record<string, unknown>;
  if (typeof board['id'] !== 'string' || !board['id'].trim()) return false;
  if (typeof board['title'] !== 'string' || typeof board['goal'] !== 'string') return false;
  if (typeof board['status'] !== 'string' || !BOARD_STATUSES.has(board['status'])) return false;
  if (typeof board['createdAt'] !== 'string' || typeof board['updatedAt'] !== 'string') return false;
  if (!Array.isArray(board['tasks'])) return false;
  return board['tasks'].every((task) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return false;
    const item = task as Record<string, unknown>;
    return typeof item['id'] === 'string'
      && typeof item['title'] === 'string'
      && typeof item['status'] === 'string'
      && TASK_STATUSES.has(item['status'])
      && Array.isArray(item['dependsOn'])
      && item['dependsOn'].every((dep) => typeof dep === 'string');
  });
}

function isIndexEntry(value: unknown): value is TaskBoardIndexEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry['id'] === 'string'
    && typeof entry['title'] === 'string'
    && typeof entry['status'] === 'string'
    && typeof entry['updatedAt'] === 'string';
}

function byUpdatedAtDesc(a: TaskBoardIndexEntry, b: TaskBoardIndexEntry) {
  return b.updatedAt.localeCompare(a.updatedAt);
}
