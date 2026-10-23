import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from '../utils/atomic.js';
import type { AutomationTask, ExecutionHistory, ExecutionResult } from './types.js';

/**
 * Durable automation persistence. Operations are serialized because trigger
 * callbacks and manual commands can update the same JSON files concurrently.
 */
export class AutomationStore {
  private readonly tasksFilePath: string;
  private readonly historyDir: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    const automationDir = resolve(workspaceRoot, '.aicode', 'automation');
    this.tasksFilePath = join(automationDir, 'tasks.json');
    this.historyDir = join(automationDir, 'history');
  }

  async save(task: AutomationTask): Promise<void> {
    await this.withLock(async () => {
      const tasks = await this.readTasks();
      const index = tasks.findIndex((item) => item.id === task.id);
      if (index >= 0) tasks[index] = task;
      else tasks.push(task);
      await this.writeTasks(tasks);
    });
  }

  async load(taskId: string): Promise<AutomationTask | undefined> {
    const tasks = await this.list();
    return tasks.find((task) => task.id === taskId);
  }

  async list(): Promise<AutomationTask[]> {
    return this.withLock(() => this.readTasks());
  }

  async delete(taskId: string): Promise<boolean> {
    return this.withLock(async () => {
      const tasks = await this.readTasks();
      const filtered = tasks.filter((task) => task.id !== taskId);
      if (filtered.length === tasks.length) return false;
      await this.writeTasks(filtered);
      return true;
    });
  }

  async recordExecution(taskId: string, result: ExecutionResult): Promise<void> {
    await this.withLock(async () => {
      const historyFile = join(this.historyDir, `${taskId}.json`);
      let history = await this.readHistory(historyFile, taskId);
      history.results.push(result);
      if (history.results.length > 100) history.results = history.results.slice(-100);
      await writeFileAtomic(historyFile, JSON.stringify(history, null, 2));
    });
  }

  async getHistory(taskId: string, limit = 10): Promise<ExecutionResult[]> {
    return this.withLock(async () => {
      const history = await this.readHistory(join(this.historyDir, `${taskId}.json`), taskId);
      return history.results.slice(-Math.max(0, limit)).reverse();
    });
  }

  private async readTasks(): Promise<AutomationTask[]> {
    try {
      const content = await readFile(this.tasksFilePath, 'utf8');
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) throw new Error('Automation task store must contain an array');
      return parsed as AutomationTask[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Failed to read automation task store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async readHistory(filePath: string, taskId: string): Promise<ExecutionHistory> {
    try {
      const content = await readFile(filePath, 'utf8');
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as ExecutionHistory).results)) {
        throw new Error('Automation history must contain a results array');
      }
      return parsed as ExecutionHistory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { taskId, results: [] };
      throw new Error(`Failed to read automation history for ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeTasks(tasks: AutomationTask[]): Promise<void> {
    // Replaced whole: an in-place rewrite leaves a torn file if the process
    // dies mid-write, and readTasks() then refuses to read the store at all.
    await writeFileAtomic(this.tasksFilePath, JSON.stringify(tasks, null, 2));
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
