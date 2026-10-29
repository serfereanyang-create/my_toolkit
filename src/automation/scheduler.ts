import { validateCronExpression } from './cron.js';
import type { AutomationTask, CronTrigger } from './types.js';

/**
 * Host integration used by the scheduler. The CLI does not expose CronCreate
 * as a local API, so callers must inject a real provider before cron tasks can
 * be started. This prevents a schedule from being reported as enabled when no
 * scheduler exists.
 */
export type CronAutomationProvider = {
  create: (input: { title: string; cron: string; prompt: string }) => Promise<string>;
  delete: (id: string) => Promise<void>;
  list: () => Promise<Array<{ id: string; title: string; cron: string }>>;
};

export type AutomationSchedulerOptions = {
  cronProvider?: CronAutomationProvider;
};

/** Cron scheduler with an explicit host integration boundary. */
export class AutomationScheduler {
  private readonly cronProvider?: CronAutomationProvider;
  private readonly cronIds = new Map<string, string>();

  constructor(options: AutomationSchedulerOptions = {}) {
    this.cronProvider = options.cronProvider;
  }

  /** Register a cron task and return the host scheduler's ID. */
  async startTask(task: AutomationTask): Promise<string> {
    if (task.trigger.type !== 'cron') {
      throw new Error(`Task ${task.id} is not a cron task`);
    }

    const existing = this.cronIds.get(task.id);
    if (existing) return existing;

    const trigger = task.trigger as CronTrigger;
    // `trigger.expression` is typed as a string but arrives from hand-editable
    // tasks.json (the probe fed it `12345`), so the type check is real: without
    // it, `.trim()` threw `expression.trim is not a function`.
    if (typeof trigger.expression !== 'string') {
      throw new Error(`Cannot start cron task ${task.id}: cron expression must be a string, got ${typeof trigger.expression}`);
    }
    const expression = trigger.expression.trim();
    if (!expression) {
      throw new Error(`Cannot start cron task ${task.id}: cron expression is empty`);
    }
    // Validate before the host call: an expression the host cannot fire used to
    // be registered and persisted as enabled, so the task looked live and never
    // ran.
    const invalid = validateCronExpression(expression);
    if (invalid) {
      throw new Error(`Cannot start cron task ${task.id}: invalid cron expression "${expression}" — ${invalid}`);
    }
    if (!this.cronProvider) {
      throw new Error(
        `Cannot start cron task ${task.id}: no CronCreate integration is available. ` +
        'Run it manually with /automate run <task-id> or provide a cron scheduler integration.',
      );
    }

    const cronId = (await this.cronProvider.create({
      title: task.name,
      cron: expression,
      prompt: this.buildExecutionPrompt(task),
    })).trim();
    if (!cronId) {
      throw new Error(`CronCreate returned no automation ID for task ${task.id}`);
    }

    this.cronIds.set(task.id, cronId);
    return cronId;
  }

  /** Remove a cron task from the host scheduler. */
  async stopTask(cronAutomationId: string): Promise<void> {
    if (!cronAutomationId) return;
    if (!this.cronProvider) {
      throw new Error(
        `Cannot stop cron automation ${cronAutomationId}: no CronDelete integration is available. ` +
        'Provide the scheduler integration before stopping this task.',
      );
    }
    await this.cronProvider.delete(cronAutomationId);
    for (const [taskId, id] of this.cronIds) {
      if (id === cronAutomationId) this.cronIds.delete(taskId);
    }
  }

  /** List host cron tasks. */
  async listCronAutomations(): Promise<Array<{ id: string; title: string; cron: string }>> {
    if (!this.cronProvider) {
      throw new Error(
        'Cannot list cron automations: no CronList integration is available. ' +
        'Provide the scheduler integration before listing scheduled tasks.',
      );
    }
    return this.cronProvider.list();
  }

  /** Stop all schedules owned by this scheduler instance. */
  async close(): Promise<void> {
    const ids = [...this.cronIds.values()];
    if (ids.length === 0) return;
    if (!this.cronProvider) {
      this.cronIds.clear();
      throw new Error('Cannot close cron scheduler: no CronDelete integration is available.');
    }

    const results = await Promise.allSettled(ids.map((id) => this.cronProvider!.delete(id)));
    this.cronIds.clear();
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (failures.length > 0) {
      throw new Error(`Failed to stop ${failures.length} cron automation(s): ${failures.join('; ')}`);
    }
  }

  private buildExecutionPrompt(task: AutomationTask): string {
    return `Execute automation task: ${task.name}

Task ID: ${task.id}
Goal: ${task.action.goal}
Auto-confirm plan: ${task.action.confirmPlan}

This is an automated task execution. Create and execute a task board for the goal above.`;
  }
}
