import chokidar, { FSWatcher } from 'chokidar';
import { relative, resolve } from 'node:path';
import type { AgentRuntime } from '../agent/agent.js';
import type { AutomationExecutor } from './executor.js';
import { updateTaskState } from './helpers.js';
import type { AutomationStore } from './store.js';
import type { AutomationTask, FileWatchTrigger } from './types.js';

/** File-system trigger manager. */
export class FileWatchManager {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private runningTasks = new Set<string>();

  /** Start (or replace) a task's file watcher. */
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
    if (task.trigger.patterns.length === 0) {
      throw new Error(`Cannot start file watch task ${task.id}: no patterns configured`);
    }

    // Updating a trigger must never leave the old watcher alive.
    await this.stop(task.id);

    const trigger = task.trigger as FileWatchTrigger;
    const { workspaceRoot, onTrigger } = options;
    const watcher = chokidar.watch(trigger.patterns, {
      cwd: workspaceRoot,
      ignoreInitial: true,
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/.aicode/**',
        '**/dist/**',
        '**/build/**',
      ],
      persistent: true,
    });

    const handleEvent = (event: 'add' | 'change' | 'unlink', filePath: string) => {
      if (this.watchers.get(task.id) !== watcher || !task.enabled) return;
      const eventMap: Record<'add' | 'change' | 'unlink', 'create' | 'modify' | 'delete'> = {
        add: 'create',
        change: 'modify',
        unlink: 'delete',
      };
      const mappedEvent = eventMap[event];
      if (!trigger.events.includes(mappedEvent)) return;

      const timerId = `${task.id}:${event}:${filePath}`;
      const existingTimer = this.debounceTimers.get(timerId);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        this.debounceTimers.delete(timerId);
        if (this.watchers.get(task.id) !== watcher || !task.enabled) return;
        // A trigger arriving while this task is running is intentionally
        // dropped; queuing it would allow an event storm to re-enter forever.
        if (this.runningTasks.has(task.id)) return;
        void this.runTriggeredTask(task, mappedEvent, filePath, watcher, options, onTrigger);
      }, Math.max(0, trigger.debounceMs ?? 1000));
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

  private async runTriggeredTask(
    task: AutomationTask,
    event: 'create' | 'modify' | 'delete',
    filePath: string,
    watcher: FSWatcher,
    options: {
      workspaceRoot: string;
      runtime: AgentRuntime;
      executor: AutomationExecutor;
      store: AutomationStore;
      onTrigger: (taskId: string, event: string, filePath: string) => void;
    },
    onTrigger: (taskId: string, event: string, filePath: string) => void,
  ): Promise<void> {
    if (this.runningTasks.has(task.id) || this.watchers.get(task.id) !== watcher || !task.enabled) return;
    this.runningTasks.add(task.id);
    const relativePath = relative(options.workspaceRoot, resolve(options.workspaceRoot, filePath));
    try {
      console.log(`[FileWatch] Task ${task.id} triggered by ${event}: ${relativePath}`);
      try {
        onTrigger(task.id, event, relativePath);
      } catch (error) {
        console.error(`[FileWatch] Trigger callback failed for task ${task.id}:`, error);
      }

      let result;
      try {
        result = await options.executor.run(task, options.runtime);
      } catch (error) {
        result = {
          status: 'failed' as const,
          error: error instanceof Error ? error.message : String(error),
          executedAt: new Date().toISOString(),
        };
      }
      console.log(`[FileWatch] Task ${task.id} finished: ${result.status}`);
      const disabled = await updateTaskState(task, result, task.id, options.store);
      if (disabled) await this.stop(task.id);
    } catch (error) {
      // Persistence failures must not become an unhandled timer rejection.
      console.error(`[FileWatch] Task ${task.id} state update failed:`, error);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  /** Stop a watcher and cancel all delayed events belonging to it. */
  async stop(taskId: string): Promise<void> {
    const watcher = this.watchers.get(taskId);
    for (const [key, timer] of this.debounceTimers) {
      if (key.startsWith(`${taskId}:`)) {
        clearTimeout(timer);
        this.debounceTimers.delete(key);
      }
    }
    if (!watcher) return;

    this.watchers.delete(taskId);
    try {
      await watcher.close();
    } finally {
      console.log(`[FileWatch] Stopped watching for task ${taskId}`);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.watchers.keys()].map((id) => this.stop(id)));
  }

  getActiveWatchers(): string[] {
    return [...this.watchers.keys()];
  }
}
