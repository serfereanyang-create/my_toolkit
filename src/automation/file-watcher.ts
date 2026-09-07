import chokidar, { FSWatcher } from 'chokidar';
import { relative } from 'node:path';
import type { AgentRuntime } from '../agent/agent.js';
import type { AutomationExecutor } from './executor.js';
import type { AutomationStore } from './store.js';
import type { AutomationTask, FileWatchTrigger } from './types.js';

/**
 * 文件监听管理器
 * 负责监听文件系统变化并触发自动化任务
 */
export class FileWatchManager {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  /**
   * 启动文件监听任务
   */
  async start(
    task: AutomationTask,
    options: {
      workspaceRoot: string;
      runtime: AgentRuntime;
      executor: AutomationExecutor;
      store: AutomationStore;
      onTrigger: (taskId: string, event: string, filePath: string) => void;
    },
  ): Promise<void> {
    if (task.trigger.type !== 'file_watch') {
      throw new Error('Task is not a file watch task');
    }

    const trigger = task.trigger as FileWatchTrigger;
    const { workspaceRoot, onTrigger } = options;

    // 创建文件监听器
    const watcher = chokidar.watch(trigger.patterns, {
      cwd: workspaceRoot,
      ignoreInitial: true, // 不触发初始扫描事件
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/.aicode/**',
        '**/dist/**',
        '**/build/**',
      ],
      persistent: true,
    });

    // 处理文件事件
    const handleEvent = (event: 'add' | 'change' | 'unlink', filePath: string) => {
      // 检查事件类型是否匹配
      const eventMap: Record<'add' | 'change' | 'unlink', 'create' | 'modify' | 'delete'> = {
        add: 'create',
        change: 'modify',
        unlink: 'delete',
      };
      const mappedEvent = eventMap[event];

      if (!trigger.events.includes(mappedEvent)) {
        return;
      }

      // 防抖处理
      const debounceMs = trigger.debounceMs || 1000;
      const timerId = `${task.id}:${event}:${filePath}`;
      
      const existingTimer = this.debounceTimers.get(timerId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(async () => {
        this.debounceTimers.delete(timerId);
        
        const relativePath = relative(workspaceRoot, filePath);
        console.log(`[FileWatch] Task ${task.id} triggered by ${event}: ${relativePath}`);
        
        onTrigger(task.id, mappedEvent, relativePath);
        
        // 执行任务
        try {
          const result = await options.executor.run(task, options.runtime);
          console.log(`[FileWatch] Task ${task.id} completed: ${result.status}`);
          
          // 记录执行结果
          await options.store.recordExecution(task.id, result);
          
          // 更新任务状态
          task.lastRunAt = result.executedAt;
          task.lastRunStatus = result.status;
          task.lastRunError = result.error;
          
          if (result.status === 'success') {
            task.consecutiveFailures = 0;
          } else {
            task.consecutiveFailures = (task.consecutiveFailures || 0) + 1;
            
            if (task.consecutiveFailures >= 3) {
              console.warn(`[FileWatch] Task ${task.id} disabled after 3 failures`);
              task.enabled = false;
              await this.stop(task.id);
            }
          }
          
          task.updatedAt = new Date().toISOString();
          await options.store.save(task);
        } catch (error) {
          console.error(`[FileWatch] Task ${task.id} execution error:`, error);
        }
      }, debounceMs);

      this.debounceTimers.set(timerId, timer);
    };

    watcher.on('add', (path) => handleEvent('add', path));
    watcher.on('change', (path) => handleEvent('change', path));
    watcher.on('unlink', (path) => handleEvent('unlink', path));

    watcher.on('error', (error) => {
      console.error(`[FileWatch] Watcher error for task ${task.id}:`, error);
    });

    this.watchers.set(task.id, watcher);
    console.log(`[FileWatch] Started watching for task ${task.id}: ${trigger.patterns.join(', ')}`);
  }

  /**
   * 停止文件监听任务
   */
  async stop(taskId: string): Promise<void> {
    const watcher = this.watchers.get(taskId);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(taskId);
      
      // 清理所有相关的防抖定时器
      for (const [key, timer] of this.debounceTimers.entries()) {
        if (key.startsWith(`${taskId}:`)) {
          clearTimeout(timer);
          this.debounceTimers.delete(key);
        }
      }
      
      console.log(`[FileWatch] Stopped watching for task ${taskId}`);
    }
  }

  /**
   * 停止所有文件监听
   */
  async stopAll(): Promise<void> {
    const taskIds = Array.from(this.watchers.keys());
    await Promise.all(taskIds.map((id) => this.stop(id)));
  }

  /**
   * 获取正在监听的任务列表
   */
  getActiveWatchers(): string[] {
    return Array.from(this.watchers.keys());
  }
}
