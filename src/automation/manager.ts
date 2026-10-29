import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '../agent/agent.js';
import { AutomationExecutor } from './executor.js';
import { FileWatchManager, validateWatchPatterns } from './file-watcher.js';
import { GitEventManager } from './git-event.js';
import { AutomationScheduler, type AutomationSchedulerOptions } from './scheduler.js';
import { AutomationStore, triggerInvalidReason } from './store.js';
import { validateCronExpression } from './cron.js';
import { performTaskRun } from './helpers.js';
import type { AutomationTask, ExecutionResult } from './types.js';

/**
 * Unified lifecycle manager for automation tasks and their trigger resources.
 * A task is persisted as enabled only after its trigger has been registered.
 */
export class AutomationManager {
  private readonly store: AutomationStore;
  private readonly scheduler: AutomationScheduler;
  private readonly executor: AutomationExecutor;
  private readonly fileWatcher: FileWatchManager;
  private readonly gitEvent: GitEventManager;
  private readonly workspaceRoot: string;
  private readonly runtime?: AgentRuntime;
  private closed = false;

  constructor(workspaceRoot: string, runtime?: AgentRuntime, schedulerOptions?: AutomationSchedulerOptions) {
    this.workspaceRoot = workspaceRoot;
    this.runtime = runtime;
    this.store = new AutomationStore(workspaceRoot);
    this.scheduler = new AutomationScheduler(schedulerOptions);
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
    this.assertOpen();
    const name = params.name.trim();
    const goal = params.goal.trim();
    if (!name) throw new Error('Automation task name cannot be empty');
    if (!goal) throw new Error('Automation task goal cannot be empty');
    assertValidTrigger(params.trigger);
    const now = new Date().toISOString();
    const task: AutomationTask = {
      id: 'auto_' + randomUUID().slice(0, 8),
      name,
      description: params.description,
      enabled: false,
      trigger: params.trigger,
      action: {
        type: 'task_board',
        goal,
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
    return this.store.list();
  }

  async getTask(taskId: string): Promise<AutomationTask | undefined> {
    return this.store.load(taskId);
  }

  async startTask(taskId: string): Promise<void> {
    this.assertOpen();
    const task = await this.requireTask(taskId);
    // Listener callbacks consult this in-memory flag. Set it before
    // registration so a newly started watcher can handle its first event;
    // persistence still happens only after registration succeeds.
    task.enabled = true;

    try {
      if (task.trigger.type === 'cron') {
        task.cronAutomationId = await this.scheduler.startTask(task);
      } else if (task.trigger.type === 'file_watch') {
        if (!this.runtime) throw new Error('Runtime is required for file watch tasks');
        await this.fileWatcher.start(task, this.listenerOptions(task));
      } else if (task.trigger.type === 'git_event') {
        if (!this.runtime) throw new Error('Runtime is required for git event tasks');
        await this.gitEvent.start(task, this.listenerOptions(task));
      }

      task.enabled = true;
      task.updatedAt = new Date().toISOString();
      await this.store.save(task);
    } catch (error) {
      // Never leave a failed registration looking enabled in persistent state.
      // Also tear down a resource that was registered before persistence failed.
      try { await this.stopRegisteredTrigger(task); } catch { /* preserve the original error */ }
      task.enabled = false;
      task.cronAutomationId = undefined;
      task.updatedAt = new Date().toISOString();
      try { await this.store.save(task); } catch { /* preserve the registration error */ }
      throw error;
    }
  }

  async stopTask(taskId: string): Promise<void> {
    this.assertOpen();
    const task = await this.requireTask(taskId);
    await this.stopRegisteredTrigger(task);
    task.enabled = false;
    task.cronAutomationId = undefined;
    task.updatedAt = new Date().toISOString();
    await this.store.save(task);
  }

  async deleteTask(taskId: string): Promise<boolean> {
    this.assertOpen();
    const task = await this.store.load(taskId);
    if (!task) return false;
    if (task.enabled || this.hasActiveTrigger(task.id, task.trigger.type)) await this.stopTask(taskId);
    return this.store.delete(taskId);
  }

  async getTaskHistory(taskId: string, limit = 10): Promise<ExecutionResult[]> {
    return this.store.getHistory(taskId, limit);
  }

  /** Manually execute a task and persist the resulting state/history. */
  async runTask(taskId: string, runtime: AgentRuntime): Promise<ExecutionResult> {
    this.assertOpen();
    return performTaskRun({ taskId, runtime, store: this.store, executor: this.executor });
  }

  async updateTask(
    taskId: string,
    updates: Partial<Pick<AutomationTask, 'name' | 'description' | 'trigger' | 'action'>>,
  ): Promise<AutomationTask> {
    this.assertOpen();
    const task = await this.requireTask(taskId);
    const wasEnabled = task.enabled;

    // Stop the old resource before changing the trigger. This applies to all
    // trigger types, including file-watch/git and same-type replacements.
    if (wasEnabled && updates.trigger) await this.stopTask(taskId);

    if (updates.name !== undefined) {
      const name = updates.name.trim();
      if (!name) throw new Error('Automation task name cannot be empty');
      task.name = name;
    }
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.trigger) {
      assertValidTrigger(updates.trigger);
      task.trigger = updates.trigger;
    }
    if (updates.action) task.action = { ...task.action, ...updates.action };
    task.updatedAt = new Date().toISOString();
    task.enabled = false;
    task.cronAutomationId = undefined;
    await this.store.save(task);

    // Preserve the user's enabled intent by registering the new trigger only
    // after its definition is durable. If registration fails, task stays off.
    if (wasEnabled && updates.trigger) {
      try {
        await this.startTask(taskId);
      } catch (error) {
        // The new definition is durable but disabled; report the actionable
        // registration failure rather than pretending the update is active.
        throw new Error(
          `Automation task ${taskId} was updated but could not be re-enabled: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return (await this.requireTask(taskId));
    }
    return task;
  }

  getActiveFileWatchers(): string[] {
    return this.fileWatcher.getActiveWatchers();
  }

  getActiveGitMonitors(): string[] {
    return this.gitEvent.getActiveMonitors();
  }

  async stopAllFileWatchers(): Promise<void> {
    await this.fileWatcher.stopAll();
  }

  async stopAllGitMonitors(): Promise<void> {
    await this.gitEvent.stopAll();
  }

  /** Stop all resources owned by this manager; safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const errors: string[] = [];
    for (const stop of [
      () => this.fileWatcher.stopAll(),
      () => this.gitEvent.stopAll(),
      () => this.scheduler.close(),
    ]) {
      try { await stop(); } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (errors.length > 0) throw new Error(`Failed to close automation manager: ${errors.join('; ')}`);
  }

  private async requireTask(taskId: string): Promise<AutomationTask> {
    const task = await this.store.load(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private async stopRegisteredTrigger(task: AutomationTask): Promise<void> {
    if (task.trigger.type === 'cron' && task.cronAutomationId) {
      await this.scheduler.stopTask(task.cronAutomationId);
    } else if (task.trigger.type === 'file_watch') {
      await this.fileWatcher.stop(task.id);
    } else if (task.trigger.type === 'git_event') {
      await this.gitEvent.stop(task.id);
    }
  }

  private hasActiveTrigger(taskId: string, type: AutomationTask['trigger']['type']): boolean {
    if (type === 'file_watch') return this.fileWatcher.getActiveWatchers().includes(taskId);
    if (type === 'git_event') return this.gitEvent.getActiveMonitors().includes(taskId);
    return false;
  }

  private listenerOptions(_task: AutomationTask) {
    return {
      workspaceRoot: this.workspaceRoot,
      runtime: this.runtime!,
      executor: this.executor,
      store: this.store,
      onTrigger: (taskId: string, event: string, details: string) => {
        console.log(`[Automation] Task ${taskId} triggered by ${event}: ${details}`);
      },
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Automation manager is closed');
  }
}

/**
 * Reject a trigger the trigger managers cannot honour, at create/update time.
 *
 * Starting a task with an empty pattern list or an invalid cron expression
 * used to fail (or, for cron, succeed and never fire) only at `startTask`.
 * Failing the create instead keeps an unusable definition out of tasks.json.
 */
function assertValidTrigger(trigger: AutomationTask['trigger']): void {
  const reason = triggerInvalidReason(trigger);
  if (reason) throw new Error(`Invalid automation trigger: ${reason}`);
  if (trigger.type === 'cron') {
    const cronReason = validateCronExpression(trigger.expression);
    if (cronReason) throw new Error(`Invalid automation trigger: ${cronReason}`);
  }
  if (trigger.type === 'file_watch') {
    const patternReason = validateWatchPatterns(trigger.patterns);
    if (patternReason) throw new Error(`Invalid automation trigger: ${patternReason}`);
  }
}
