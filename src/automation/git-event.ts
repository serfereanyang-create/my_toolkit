import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRuntime } from '../agent/agent.js';
import type { AutomationExecutor } from './executor.js';
import { updateTaskState } from './helpers.js';
import type { AutomationStore } from './store.js';
import type { AutomationTask, GitEventTrigger } from './types.js';

const execFileAsync = promisify(execFile);

type GitMonitorOptions = {
  workspaceRoot: string;
  runtime: AgentRuntime;
  executor: AutomationExecutor;
  store: AutomationStore;
  onTrigger: (taskId: string, event: string, details: string) => void;
};

/** Polling-based Git event manager with explicit lifecycle and re-entry guards. */
export class GitEventManager {
  private pollingIntervals = new Map<string, NodeJS.Timeout>();
  private pollingInFlight = new Set<string>();
  private runningTasks = new Set<string>();
  private lastCommitHashes = new Map<string, string>();
  private lastRemoteHashes = new Map<string, string>();
  /** Stored from the task that started the monitor, not from the closure. */
  private tasks = new Map<string, AutomationTask>();
  private readonly pollIntervalMs: number;

  constructor(pollIntervalMs = 30_000) {
    this.pollIntervalMs = Math.max(100, pollIntervalMs);
  }

  /** Start (or replace) a Git event monitor. */
  async start(task: AutomationTask, options: GitMonitorOptions): Promise<void> {
    if (task.trigger.type !== 'git_event') {
      throw new Error('Task is not a git event task');
    }

    // Updating a trigger must not leave the previous interval alive.
    await this.stop(task.id);
    const trigger = task.trigger as GitEventTrigger;
    if (trigger.events.length === 0) {
      throw new Error(`Cannot start Git event task ${task.id}: no events configured`);
    }

    try {
      const currentCommit = await this.getCurrentCommitHash(options.workspaceRoot);
      this.lastCommitHashes.set(task.id, currentCommit);
      if (trigger.events.includes('push') || trigger.events.includes('pull')) {
        try {
          this.lastRemoteHashes.set(task.id, await this.getRemoteCommitHash(options.workspaceRoot));
        } catch (error) {
          // A repository without an origin can still monitor commits.
          console.warn(`[GitEvent] Failed to initialize remote state for task ${task.id}:`, error);
        }
      }
    } catch (error) {
      throw new Error(
        `Cannot start Git event task ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const interval = setInterval(() => {
      void this.poll(task.id, options);
    }, this.pollIntervalMs);
    this.pollingIntervals.set(task.id, interval);
    this.tasks.set(task.id, task);
    console.log(`[GitEvent] Started monitoring for task ${task.id}: ${trigger.events.join(', ')}`);
  }

  /** Stop a monitor and clear all state associated with it. */
  async stop(taskId: string): Promise<void> {
    const interval = this.pollingIntervals.get(taskId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(taskId);
      console.log(`[GitEvent] Stopped monitoring for task ${taskId}`);
    }
    this.lastCommitHashes.delete(taskId);
    this.lastRemoteHashes.delete(taskId);
    this.tasks.delete(taskId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.pollingIntervals.keys()].map((id) => this.stop(id)));
  }

  getActiveMonitors(): string[] {
    return [...this.pollingIntervals.keys()];
  }

  private async poll(taskId: string, options: GitMonitorOptions): Promise<void> {
    if (!this.pollingIntervals.has(taskId) || this.pollingInFlight.has(taskId)) return;
    // Read the stored task each tick: the interval closure used to capture the
    // object passed to start(), while a manual run persists through a *copy*
    // loaded by the store, so "another process/command has this task open"
    // could only be seen via a stale copy here.
    const task = this.tasks.get(taskId);
    if (!task || !task.enabled) return;
    this.pollingInFlight.add(taskId);
    try {
      await this.checkForChanges(task, options);
    } catch (error) {
      console.error(`[GitEvent] Error checking for changes in task ${task.id}:`, error);
    } finally {
      this.pollingInFlight.delete(taskId);
    }
  }

  private async checkForChanges(task: AutomationTask, options: GitMonitorOptions): Promise<void> {
    const trigger = task.trigger as GitEventTrigger;
    const { workspaceRoot, onTrigger } = options;
    const currentBranch = await this.getCurrentBranch(workspaceRoot);
    if (trigger.branches && trigger.branches.length > 0 && !trigger.branches.includes(currentBranch)) return;

    if (trigger.events.includes('commit')) {
      const currentCommit = await this.getCurrentCommitHash(workspaceRoot);
      const lastCommit = this.lastCommitHashes.get(task.id);
      // Advance the observed state before executing. This avoids re-triggering
      // the same commit when execution takes longer than the poll interval.
      this.lastCommitHashes.set(task.id, currentCommit);
      if (lastCommit && currentCommit !== lastCommit) {
        await this.triggerTask(task, options, 'commit', `New commit: ${currentCommit.slice(0, 7)}`, onTrigger);
      }
    }

    if (trigger.events.includes('push') || trigger.events.includes('pull')) {
      try {
        await this.gitFetch(workspaceRoot);
        const localCommit = await this.getCurrentCommitHash(workspaceRoot);
        const remoteCommit = await this.getRemoteCommitHash(workspaceRoot);
        const lastRemote = this.lastRemoteHashes.get(task.id);
        this.lastRemoteHashes.set(task.id, remoteCommit);
        if (!lastRemote || remoteCommit === lastRemote) return;

        // Use merge-base ancestry to distinguish local-ahead (push) from
        // remote-ahead (pull); unrelated/diverged histories are not guessed.
        const localAhead = await this.isAncestor(workspaceRoot, remoteCommit, localCommit);
        const remoteAhead = await this.isAncestor(workspaceRoot, localCommit, remoteCommit);
        if (localAhead && trigger.events.includes('push')) {
          await this.triggerTask(task, options, 'push', `Remote updated: ${remoteCommit.slice(0, 7)}`, onTrigger);
        } else if (remoteAhead && trigger.events.includes('pull')) {
          await this.triggerTask(task, options, 'pull', `Remote ahead: ${remoteCommit.slice(0, 7)}`, onTrigger);
        }
      } catch (error) {
        console.warn(`[GitEvent] Remote check failed for task ${task.id}:`, error);
      }
    }
  }

  private async triggerTask(
    task: AutomationTask,
    options: GitMonitorOptions,
    event: 'commit' | 'push' | 'pull',
    details: string,
    onTrigger: (taskId: string, event: string, details: string) => void,
  ): Promise<void> {
    if (this.runningTasks.has(task.id) || !this.pollingIntervals.has(task.id) || !task.enabled) return;
    this.runningTasks.add(task.id);
    try {
      console.log(`[GitEvent] ${event} detected for task ${task.id}: ${details}`);
      try {
        onTrigger(task.id, event, details);
      } catch (error) {
        console.error(`[GitEvent] Trigger callback failed for task ${task.id}:`, error);
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
      console.log(`[GitEvent] Task ${task.id} finished after ${event}: ${result.status}`);
      const disabled = await updateTaskState(task, result, task.id, options.store);
      if (disabled) {
        await this.stop(task.id);
      }
    } catch (error) {
      // Timer callbacks must never leak rejected promises.
      console.error(`[GitEvent] Task ${task.id} state update failed:`, error);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  private async getCurrentCommitHash(workspaceRoot: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot });
    return stdout.trim();
  }

  private async getCurrentBranch(workspaceRoot: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspaceRoot });
    return stdout.trim();
  }

  private async getRemoteCommitHash(workspaceRoot: string): Promise<string> {
    const branch = await this.getCurrentBranch(workspaceRoot);
    const { stdout } = await execFileAsync('git', ['rev-parse', `origin/${branch}`], { cwd: workspaceRoot });
    return stdout.trim();
  }

  private async gitFetch(workspaceRoot: string): Promise<void> {
    await execFileAsync('git', ['fetch'], { cwd: workspaceRoot });
  }

  private async isAncestor(workspaceRoot: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: workspaceRoot });
      return true;
    } catch {
      return false;
    }
  }
}
