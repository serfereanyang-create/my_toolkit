import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRuntime } from '../agent/agent.js';
import type { AutomationExecutor } from './executor.js';
import type { AutomationStore } from './store.js';
import type { AutomationTask, GitEventTrigger } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Git 事件管理器
 * 通过轮询 git log 检测 Git 事件（commit、push、pull）
 */
export class GitEventManager {
  private pollingIntervals = new Map<string, NodeJS.Timeout>();
  private lastCommitHashes = new Map<string, string>();
  private lastRemoteHashes = new Map<string, string>();

  /**
   * 启动 Git 事件监听
   */
  async start(
    task: AutomationTask,
    options: {
      workspaceRoot: string;
      runtime: AgentRuntime;
      executor: AutomationExecutor;
      store: AutomationStore;
      onTrigger: (taskId: string, event: string, details: string) => void;
    },
  ): Promise<void> {
    if (task.trigger.type !== 'git_event') {
      throw new Error('Task is not a git event task');
    }

    const trigger = task.trigger as GitEventTrigger;
    const { workspaceRoot, onTrigger } = options;

    // 初始化：获取当前状态
    try {
      const currentCommit = await this.getCurrentCommitHash(workspaceRoot);
      this.lastCommitHashes.set(task.id, currentCommit);

      if (trigger.events.includes('push') || trigger.events.includes('pull')) {
        const remoteCommit = await this.getRemoteCommitHash(workspaceRoot);
        this.lastRemoteHashes.set(task.id, remoteCommit);
      }
    } catch (error) {
      console.warn(`[GitEvent] Failed to initialize for task ${task.id}:`, error);
    }

    // 启动轮询（每30秒检查一次）
    const interval = setInterval(async () => {
      try {
        await this.checkForChanges(task, options);
      } catch (error) {
        console.error(`[GitEvent] Error checking for changes in task ${task.id}:`, error);
      }
    }, 30000); // 30秒轮询间隔

    this.pollingIntervals.set(task.id, interval);
    console.log(`[GitEvent] Started monitoring for task ${task.id}: ${trigger.events.join(', ')}`);
  }

  /**
   * 停止 Git 事件监听
   */
  async stop(taskId: string): Promise<void> {
    const interval = this.pollingIntervals.get(taskId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(taskId);
      this.lastCommitHashes.delete(taskId);
      this.lastRemoteHashes.delete(taskId);
      console.log(`[GitEvent] Stopped monitoring for task ${taskId}`);
    }
  }

  /**
   * 停止所有 Git 事件监听
   */
  async stopAll(): Promise<void> {
    const taskIds = Array.from(this.pollingIntervals.keys());
    await Promise.all(taskIds.map((id) => this.stop(id)));
  }

  /**
   * 获取活跃的 Git 事件监听器
   */
  getActiveMonitors(): string[] {
    return Array.from(this.pollingIntervals.keys());
  }

  /**
   * 检查 Git 变化
   */
  private async checkForChanges(
    task: AutomationTask,
    options: {
      workspaceRoot: string;
      runtime: AgentRuntime;
      executor: AutomationExecutor;
      store: AutomationStore;
      onTrigger: (taskId: string, event: string, details: string) => void;
    },
  ): Promise<void> {
    const trigger = task.trigger as GitEventTrigger;
    const { workspaceRoot, onTrigger } = options;

    // 检查分支过滤
    const currentBranch = await this.getCurrentBranch(workspaceRoot);
    if (trigger.branches && trigger.branches.length > 0) {
      if (!trigger.branches.includes(currentBranch)) {
        return; // 当前分支不在监听列表中
      }
    }

    // 检查 commit 事件
    if (trigger.events.includes('commit')) {
      const currentCommit = await this.getCurrentCommitHash(workspaceRoot);
      const lastCommit = this.lastCommitHashes.get(task.id);

      if (lastCommit && currentCommit !== lastCommit) {
        console.log(`[GitEvent] New commit detected for task ${task.id}: ${currentCommit}`);
        onTrigger(task.id, 'commit', `New commit: ${currentCommit.slice(0, 7)}`);
        
        await this.executeTask(task, options, 'commit');
        this.lastCommitHashes.set(task.id, currentCommit);
      }
    }

    // 检查 push/pull 事件（通过比较本地和远程）
    if (trigger.events.includes('push') || trigger.events.includes('pull')) {
      try {
        // 先 fetch 获取最新的远程状态
        await this.gitFetch(workspaceRoot);

        const localCommit = await this.getCurrentCommitHash(workspaceRoot);
        const remoteCommit = await this.getRemoteCommitHash(workspaceRoot);
        const lastRemote = this.lastRemoteHashes.get(task.id);

        if (lastRemote && remoteCommit !== lastRemote) {
          if (trigger.events.includes('push')) {
            // 简单判断：如果本地提前于远程，可能是 push（不完美但实用）
            console.log(`[GitEvent] Potential push detected for task ${task.id}`);
            onTrigger(task.id, 'push', `Remote updated: ${remoteCommit.slice(0, 7)}`);
            await this.executeTask(task, options, 'push');
          }
          
          if (trigger.events.includes('pull')) {
            // 简单判断：如果远程提前于本地，可能是 pull
            console.log(`[GitEvent] Potential pull detected for task ${task.id}`);
            onTrigger(task.id, 'pull', `Remote ahead: ${remoteCommit.slice(0, 7)}`);
            await this.executeTask(task, options, 'pull');
          }

          this.lastRemoteHashes.set(task.id, remoteCommit);
        }
      } catch (error) {
        // 忽略远程检查错误（可能没有远程或网络问题）
      }
    }
  }

  /**
   * 执行任务
   */
  private async executeTask(
    task: AutomationTask,
    options: {
      runtime: AgentRuntime;
      executor: AutomationExecutor;
      store: AutomationStore;
    },
    event: string,
  ): Promise<void> {
    try {
      const result = await options.executor.run(task, options.runtime);
      console.log(`[GitEvent] Task ${task.id} completed after ${event}: ${result.status}`);

      await options.store.recordExecution(task.id, result);

      task.lastRunAt = result.executedAt;
      task.lastRunStatus = result.status;
      task.lastRunError = result.error;

      if (result.status === 'success') {
        task.consecutiveFailures = 0;
      } else {
        task.consecutiveFailures = (task.consecutiveFailures || 0) + 1;
        
        if (task.consecutiveFailures >= 3) {
          console.warn(`[GitEvent] Task ${task.id} disabled after 3 failures`);
          task.enabled = false;
          await this.stop(task.id);
        }
      }

      task.updatedAt = new Date().toISOString();
      await options.store.save(task);
    } catch (error) {
      console.error(`[GitEvent] Task ${task.id} execution error:`, error);
    }
  }

  /**
   * 获取当前提交哈希
   */
  private async getCurrentCommitHash(workspaceRoot: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot });
    return stdout.trim();
  }

  /**
   * 获取当前分支
   */
  private async getCurrentBranch(workspaceRoot: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspaceRoot });
    return stdout.trim();
  }

  /**
   * 获取远程提交哈希
   */
  private async getRemoteCommitHash(workspaceRoot: string): Promise<string> {
    const branch = await this.getCurrentBranch(workspaceRoot);
    const { stdout } = await execFileAsync('git', ['rev-parse', `origin/${branch}`], { cwd: workspaceRoot });
    return stdout.trim();
  }

  /**
   * 执行 git fetch
   */
  private async gitFetch(workspaceRoot: string): Promise<void> {
    await execFileAsync('git', ['fetch'], { cwd: workspaceRoot });
  }
}
