import chokidar, { FSWatcher } from 'chokidar';
import { relative, resolve } from 'node:path';
import type { AgentRuntime } from '../agent/agent.js';
import type { AutomationExecutor } from './executor.js';
import { updateTaskState } from './helpers.js';
import type { AutomationStore } from './store.js';
import type { AutomationTask, FileWatchTrigger } from './types.js';

type WatchOptions = {
  workspaceRoot: string;
  runtime: AgentRuntime;
  executor: AutomationExecutor;
  store: AutomationStore;
  onTrigger: (taskId: string, event: string, filePath: string) => void;
};



/** File-system trigger manager. */
export class FileWatchManager {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private runningTasks = new Set<string>();
  /**
   * One coalesced re-run slot per task.
   *
   * An event that arrived while the task was running used to be dropped
   * outright ("queuing it would allow an event storm to re-enter forever").
   * That bound is right, but dropping the *last* event loses real work: the
   * probe wrote `b.txt` during a long run of `a.txt` and the run for `b.txt`
   * never happened. A single trailing slot keeps the storm bound (at most one
   * extra run, whatever the event count) while guaranteeing the task sees the
   * final state after its own writes settle.
   */
  private pendingRuns = new Map<string, { event: 'create' | 'modify' | 'delete'; filePath: string; watcher: FSWatcher; options: WatchOptions }>();

  /** Start (or replace) a task's file watcher. */
  async start(task: AutomationTask, options: WatchOptions): Promise<void> {
    if (task.trigger.type !== 'file_watch') {
      throw new Error('Task is not a file watch task');
    }
    if (task.trigger.patterns.length === 0) {
      throw new Error(`Cannot start file watch task ${task.id}: no patterns configured`);
    }
    for (const pattern of task.trigger.patterns) {
      const problem = patternProblem(pattern);
      if (problem) throw new Error(`Cannot start file watch task ${task.id}: ${problem}`);
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
        if (this.runningTasks.has(task.id)) {
          // One trailing run, latest event wins. Bounded, so a storm cannot
          // re-enter forever, but the final state is still seen (see
          // pendingRuns).
          this.pendingRuns.set(task.id, { event: mappedEvent, filePath, watcher, options });
          return;
        }
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
    options: WatchOptions,
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
      // Drain the coalesced trailing run (if any). Scheduled on a macrotask so
      // a task that keeps producing events cannot grow the stack or spin
      // synchronously; the entry is removed first so a stop() during the
      // delay still wins.
      const pending = this.pendingRuns.get(task.id);
      if (pending) {
        this.pendingRuns.delete(task.id);
        setImmediate(() => {
          void this.runTriggeredTask(task, pending.event, pending.filePath, pending.watcher, pending.options, pending.options.onTrigger);
        });
      }
    }
  }

  /** Stop a watcher and cancel all delayed events belonging to it. */
  async stop(taskId: string): Promise<void> {
    const watcher = this.watchers.get(taskId);
    this.pendingRuns.delete(taskId);
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

/**
 * Reject patterns that silently watch nothing.
 *
 * chokidar resolves patterns against `cwd: workspaceRoot` below, so:
 *  - a `..` pattern (`../**`, `src/../*.ts`) describes a location that is
 *    not a descendant of the workspace and the watcher never fires for it
 *    (probed: writing the file the pattern names produced zero events);
 *  - an absolute pattern is re-anchored under cwd, so what it watches is not
 *    the path it names — whatever it matches is outside the task's definition.
 * Both used to be accepted, leaving an "enabled, watching" task that can never
 * run. Erroring at start tells the user their pattern is the problem.
 */
function patternProblem(pattern: string): string | null {
  const text = pattern.trim();
  if (!text) return 'pattern is empty';
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('\\\\')) {
    return `pattern "${pattern}" is absolute; patterns are relative to the workspace root`;
  }
  if (text.split(/[\\/]/).includes('..')) {
    return `pattern "${pattern}" escapes the workspace root and would never fire`;
  }
  return null;
}

/** Exported so create/update can refuse an unusable watch task up front. */
export function validateWatchPatterns(patterns: string[]): string | null {
  for (const pattern of patterns) {
    const problem = patternProblem(pattern);
    if (problem) return problem;
  }
  return null;
}
