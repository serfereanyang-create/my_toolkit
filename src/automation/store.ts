import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AutomationTask, ExecutionHistory, ExecutionResult } from './types.js';

/**
 * 自动化任务持久化存储
 * 存储到 .aicode/automation/tasks.json
 */
export class AutomationStore {
  private readonly tasksFilePath: string;
  private readonly historyDir: string;

  constructor(workspaceRoot: string) {
    const automationDir = resolve(workspaceRoot, '.aicode', 'automation');
    this.tasksFilePath = join(automationDir, 'tasks.json');
    this.historyDir = join(automationDir, 'history');
  }

  /**
   * 保存或更新一个自动化任务
   */
  async save(task: AutomationTask): Promise<void> {
    const tasks = await this.list();
    const index = tasks.findIndex((t) => t.id === task.id);
    
    if (index >= 0) {
      tasks[index] = task;
    } else {
      tasks.push(task);
    }
    
    await mkdir(dirname(this.tasksFilePath), { recursive: true });
    await writeFile(this.tasksFilePath, JSON.stringify(tasks, null, 2), 'utf8');
  }

  /**
   * 加载指定 ID 的任务
   */
  async load(taskId: string): Promise<AutomationTask | undefined> {
    const tasks = await this.list();
    return tasks.find((t) => t.id === taskId);
  }

  /**
   * 列出所有任务
   */
  async list(): Promise<AutomationTask[]> {
    try {
      const content = await readFile(this.tasksFilePath, 'utf8');
      return JSON.parse(content) as AutomationTask[];
    } catch (error) {
      // 文件不存在或格式错误，返回空数组
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * 删除指定任务
   */
  async delete(taskId: string): Promise<boolean> {
    const tasks = await this.list();
    const filtered = tasks.filter((t) => t.id !== taskId);
    
    if (filtered.length === tasks.length) {
      return false; // 任务不存在
    }
    
    await mkdir(dirname(this.tasksFilePath), { recursive: true });
    await writeFile(this.tasksFilePath, JSON.stringify(filtered, null, 2), 'utf8');
    return true;
  }

  /**
   * 记录任务执行结果
   */
  async recordExecution(taskId: string, result: ExecutionResult): Promise<void> {
    const historyFile = join(this.historyDir, `${taskId}.json`);
    
    let history: ExecutionHistory;
    try {
      const content = await readFile(historyFile, 'utf8');
      history = JSON.parse(content) as ExecutionHistory;
    } catch {
      history = { taskId, results: [] };
    }
    
    // 保留最近100条记录
    history.results.push(result);
    if (history.results.length > 100) {
      history.results = history.results.slice(-100);
    }
    
    await mkdir(this.historyDir, { recursive: true });
    await writeFile(historyFile, JSON.stringify(history, null, 2), 'utf8');
  }

  /**
   * 获取任务执行历史
   */
  async getHistory(taskId: string, limit = 10): Promise<ExecutionResult[]> {
    const historyFile = join(this.historyDir, `${taskId}.json`);
    
    try {
      const content = await readFile(historyFile, 'utf8');
      const history = JSON.parse(content) as ExecutionHistory;
      return history.results.slice(-limit).reverse();
    } catch {
      return [];
    }
  }
}
