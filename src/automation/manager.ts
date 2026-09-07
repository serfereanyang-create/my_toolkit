import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '../agent/agent.js';
import { AutomationExecutor } from './executor.js';
import { FileWatchManager } from './file-watcher.js';
import { GitEventManager } from './git-event.js';
import { AutomationScheduler } from './scheduler.js';
import { AutomationStore } from './store.js';
import type { AutomationTask, ExecutionResult } from './types.js';

/**
 * 自动化管理器 - 提供统一的API管理所有自动化任务
 */
export class AutomationManager {
  private store: AutomationStore;
  private scheduler: AutomationScheduler;
  private executor: AutomationExecutor;
  private fileWatcher: FileWatchManager;
  private gitEvent: GitEventManager;
  private workspaceRoot: string;
  private runtime?: AgentRuntime;

  constructor(workspaceRoot: string, runtime?: AgentRuntime) {
    this.workspaceRoot = workspaceRoot;
    this.runtime = runtime;
    this.store = new AutomationStore(workspaceRoot);
    this.scheduler = new AutomationScheduler();
    this.executor = new AutomationExecutor();
    this.fileWatcher = new FileWatchManager();
    this.gitEvent = new GitEventManager();
  }

  async createTask(params: {
    name: string;
    description?: string;
    trigger: AutomationTask['trigger'];
    goal: string;
    confirmPlan: boolean;
    maxTasks?: number;
  }): Promise<AutomationTask> {
    const now = new Date().toISOString();
    const taskId = 'auto_' + randomUUID().slice(0, 8);
    
    const task: AutomationTask = {
      id: taskId,
      name: params.name,
      description: params.description,
      enabled: false,
      trigger: params.trigger,
      action: {
        type: 'task_board',
        goal: params.goal,
        confirmPlan: params.confirmPlan,
        maxTasks: params.maxTasks,
      },
      createdAt: now,
      updatedAt: now,
    };

    await this.store.save(task);
    return task;
  }

  async listTasks(): Promise<AutomationTask[]> {
    return await this.store.list();
  }

  async getTask(taskId: string): Promise<AutomationTask | undefined> {
    return await this.store.load(taskId);
  }

  async startTask(taskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (!task) {
      const msg = 'Task not found: ' + taskId;
      throw new Error(msg);
    }

    if (task.trigger.type === 'cron') {
      const cronId = await this.scheduler.startTask(task);
      task.cronAutomationId = cronId;
    } else if (task.trigger.type === 'file_watch') {
      if (!this.runtime) {
        throw new Error('Runtime is required for file watch tasks');
      }
      await this.fileWatcher.start(task, {
        workspaceRoot: this.workspaceRoot,
        runtime: this.runtime,
        executor: this.executor,
        store: this.store,
        onTrigger: (taskId, event, filePath) => {
          console.log(`[Automation] Task ${taskId} triggered by ${event} on ${filePath}`);
        },
      });
    } else if (task.trigger.type === 'git_event') {
      if (!this.runtime) {
        throw new Error('Runtime is required for git event tasks');
      }
      await this.gitEvent.start(task, {
        workspaceRoot: this.workspaceRoot,
        runtime: this.runtime,
        executor: this.executor,
        store: this.store,
        onTrigger: (taskId, event, details) => {
          console.log(`[Automation] Task ${taskId} triggered by git ${event}: ${details}`);
        },
      });
    }

    task.enabled = true;
    task.updatedAt = new Date().toISOString();
    await this.store.save(task);
  }

  async stopTask(taskId: string): Promise<void> {
    const task = await this.store.load(taskId);
    if (!task) {
      const msg = 'Task not found: ' + taskId;
      throw new Error(msg);
    }

    if (task.trigger.type === 'cron' && task.cronAutomationId) {
      await this.scheduler.stopTask(task.cronAutomationId);
      task.cronAutomationId = undefined;
    } else if (task.trigger.type === 'file_watch') {
      await this.fileWatcher.stop(taskId);
    } else if (task.trigger.type === 'git_event') {
      await this.gitEvent.stop(taskId);
    }

    task.enabled = false;
    task.updatedAt = new Date().toISOString();
    await this.store.save(task);
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const task = await this.store.load(taskId);
    if (task && task.enabled) {
      await this.stopTask(taskId);
    }
    return await this.store.delete(taskId);
  }

  async getTaskHistory(taskId: string, limit = 10): Promise<ExecutionResult[]> {
    return await this.store.getHistory(taskId, limit);
  }

  /**
   * 手动执行一个任务
   */
  async runTask(taskId: string, runtime: AgentRuntime): Promise<ExecutionResult> {
    const { performTaskRun } = await import('./helpers.js');
    return await performTaskRun({
      taskId,
      runtime,
      store: this.store,
      executor: this.executor,
    });
  }

  async updateTask(
    taskId: string,
    updates: Partial<Pick<AutomationTask, 'name' | 'description' | 'trigger' | 'action'>>,
  ): Promise<AutomationTask> {
    const task = await this.store.load(taskId);
    if (!task) throw new Error('Task not found');

    if (task.enabled && updates.trigger && updates.trigger.type === 'cron') {
      await this.stopTask(taskId);
    }

    if (updates.name) task.name = updates.name;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.trigger) task.trigger = updates.trigger;
    if (updates.action) task.action = { ...task.action, ...updates.action };

    task.updatedAt = new Date().toISOString();
    await this.store.save(task);
    return task;
  }

  /**
   * 获取活跃的文件监听任务
   */
  getActiveFileWatchers(): string[] {
    return this.fileWatcher.getActiveWatchers();
  }

  /**
   * 获取活跃的 Git 事件监听任务
   */
  getActiveGitMonitors(): string[] {
    return this.gitEvent.getActiveMonitors();
  }

  /**
   * 停止所有文件监听
   */
  async stopAllFileWatchers(): Promise<void> {
    await this.fileWatcher.stopAll();
  }

  /**
   * 停止所有 Git 事件监听
   */
  async stopAllGitMonitors(): Promise<void> {
    await this.gitEvent.stopAll();
  }
}
