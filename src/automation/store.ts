import { readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from '../utils/atomic.js';
import { withFileLock } from '../utils/lockfile.js';
import type { AutomationTask, ExecutionHistory, ExecutionResult, Trigger } from './types.js';

/**
 * Durable automation persistence.
 *
 * Three failure modes shaped this file:
 *  - a torn write (process killed mid-write) used to make every later read and
 *    every later save throw, i.e. the whole automation feature stayed dead
 *    until a human deleted the file. The file is now written with
 *    `writeFileAtomic`, and a file that still cannot be parsed is quarantined
 *    (`tasks.json.corrupt-<ts>`) so the original bytes survive for inspection
 *    while the store starts empty.
 *  - one malformed entry (cron expression stored as a number, a `null` left by
 *    a hand edit) used to crash `list()`/`load()` on the first field access —
 *    `manager.startTask` then threw `trigger.expression.trim is not a function`
 *    from inside the scheduler. Entries are validated one by one now: the bad
 *    one is dropped and reported, the rest are kept.
 *  - two AutomationStore instances (REPL + desktop bridge, or two CLI
 *    processes) each held only an in-process queue, so concurrent read-modify-
 *    write lost one side's entries (probe: 20 + 20 saves → 20 tasks). The write
 *    side now also takes the cross-process file lock from `utils/lockfile`.
 *
 * Reads stay lock-free: `writeFileAtomic` renames a complete file into place,
 * so a reader sees either the old or the new content, never a torn one.
 */
export class AutomationStore {
  private readonly tasksFilePath: string;
  private readonly historyDir: string;
  private readonly lockPath: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    const automationDir = resolve(workspaceRoot, '.aicode', 'automation');
    this.tasksFilePath = join(automationDir, 'tasks.json');
    this.historyDir = join(automationDir, 'history');
    this.lockPath = join(automationDir, 'tasks.lock');
  }

  async save(task: AutomationTask): Promise<void> {
    await this.mutate(async () => {
      const tasks = (await this.readTasks()).tasks;
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
    return this.withLock(() => this.readTasks().then((outcome) => outcome.tasks));
  }

  async delete(taskId: string): Promise<boolean> {
    return this.mutate(async () => {
      const tasks = (await this.readTasks()).tasks;
      const filtered = tasks.filter((task) => task.id !== taskId);
      if (filtered.length === tasks.length) return false;
      await this.writeTasks(filtered);
      return true;
    });
  }

  async recordExecution(taskId: string, result: ExecutionResult): Promise<void> {
    await this.mutate(async () => {
      const historyFile = join(this.historyDir, `${taskId}.json`);
      const history = await this.readHistory(historyFile, taskId);
      history.results.push(result);
      if (history.results.length > 100) history.results = history.results.slice(-100);
      await writeFileAtomic(historyFile, JSON.stringify(history, null, 2));
    });
  }

  async getHistory(taskId: string, limit = 10): Promise<ExecutionResult[]> {
    return this.withLock(async () => {
      // A caller asking for zero results gets zero. `slice(-0)` is `slice(0)`,
      // i.e. the whole history, which made `/automate status --limit 0` print
      // everything instead of nothing.
      if (!Number.isFinite(limit) || limit <= 0) return [];
      const history = await this.readHistory(join(this.historyDir, `${taskId}.json`), taskId);
      return history.results.slice(-Math.max(0, Math.floor(limit))).reverse();
    });
  }

  /**
   * Read and validate the task file. A file that is not JSON, and entries that
   * do not match the persisted schema, are dropped individually; neither takes
   * the surviving tasks down with it.
   */
  private async readTasks(): Promise<{ tasks: AutomationTask[]; issues: string[] }> {
    let content: string;
    try {
      content = await readFile(this.tasksFilePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: [], issues: [] };
      throw new Error(`Failed to read automation task store: ${error instanceof Error ? error.message : String(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return this.quarantineTasksFile('not valid JSON');
    }
    if (!Array.isArray(parsed)) return this.quarantineTasksFile('root is not an array');

    const tasks: AutomationTask[] = [];
    const issues: string[] = [];
    parsed.forEach((entry, index) => {
      const verdict = validateTaskEntry(entry);
      if (verdict.ok) tasks.push(verdict.task);
      else issues.push(`entry ${index} dropped: ${verdict.reason}`);
    });
    if (issues.length > 0) {
      console.warn(`[AutomationStore] ${issues.length} malformed task entr${issues.length === 1 ? 'y' : 'ies'} ignored: ${issues.join('; ')}`);
    }
    return { tasks, issues };
  }

  /**
   * Keep the unreadable bytes under a side name and start from an empty store.
   * Best effort: a concurrent reader may have quarantined it first (ENOENT) or
   * Windows may hold the file open (EPERM); either way the caller still gets an
   * empty store instead of an exception on every command.
   */
  private async quarantineTasksFile(reason: string): Promise<{ tasks: AutomationTask[]; issues: string[] }> {
    const target = `${this.tasksFilePath}.corrupt-${Date.now()}`;
    let quarantined = false;
    try {
      await rename(this.tasksFilePath, target);
      quarantined = true;
    } catch {
      // Leave the file where it is; the next successful save replaces it.
    }
    const message = `automation task store ${reason}; starting empty${quarantined ? ` (original kept at ${target})` : ''}`;
    console.warn(`[AutomationStore] ${message}`);
    return { tasks: [], issues: [message] };
  }

  private async readHistory(filePath: string, taskId: string): Promise<ExecutionHistory> {
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { taskId, results: [] };
      throw new Error(`Failed to read automation history for ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return this.quarantineHistoryFile(filePath, taskId, 'not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as ExecutionHistory).results)) {
      return this.quarantineHistoryFile(filePath, taskId, 'results is not an array');
    }
    const results = (parsed as ExecutionHistory).results.filter(isExecutionResult);
    return { taskId, results };
  }

  private async quarantineHistoryFile(filePath: string, taskId: string, reason: string): Promise<ExecutionHistory> {
    const target = `${filePath}.corrupt-${Date.now()}`;
    let quarantined = false;
    try {
      await rename(filePath, target);
      quarantined = true;
    } catch {
      // See quarantineTasksFile.
    }
    console.warn(
      `[AutomationStore] history for ${taskId} is unusable (${reason}); starting empty` +
        (quarantined ? ` (original kept at ${target})` : ''),
    );
    return { taskId, results: [] };
  }

  private async writeTasks(tasks: AutomationTask[]): Promise<void> {
    // Replaced whole: an in-place rewrite leaves a torn file if the process
    // dies mid-write, and readTasks() then refuses to read the store at all.
    await writeFileAtomic(this.tasksFilePath, JSON.stringify(tasks, null, 2));
  }

  /** Read-modify-write of the whole store under both locks (see class comment). */
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.withLock(() => withFileLock(this.lockPath, operation));
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

// ── persisted-schema validation ─────────────────────────────────────────────
// Exported so the manager can validate a trigger before registering it instead
// of discovering a wrong shape only when the store is read back.

const FILE_EVENTS = new Set(['create', 'modify', 'delete']);
const GIT_EVENTS = new Set(['commit', 'push', 'pull']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Structural check for a trigger object. Returns null when valid, else why not. */
export function triggerInvalidReason(trigger: unknown): string | null {
  if (!isRecord(trigger)) return 'trigger must be an object';
  switch (trigger.type) {
    case 'cron':
      if (!nonEmptyString(trigger.expression)) return 'cron trigger requires a non-empty string expression';
      return null;
    case 'file_watch': {
      if (!Array.isArray(trigger.patterns) || trigger.patterns.length === 0) return 'file_watch trigger requires a non-empty patterns array';
      if (!trigger.patterns.every(nonEmptyString)) return 'file_watch patterns must be non-empty strings';
      if (!Array.isArray(trigger.events) || trigger.events.length === 0) return 'file_watch trigger requires a non-empty events array';
      if (!trigger.events.every((event) => typeof event === 'string' && FILE_EVENTS.has(event))) {
        return `file_watch events must be one of ${[...FILE_EVENTS].join('/')}`;
      }
      if (trigger.debounceMs !== undefined && (!Number.isFinite(trigger.debounceMs) || (trigger.debounceMs as number) < 0)) {
        return 'file_watch debounceMs must be a non-negative number';
      }
      return null;
    }
    case 'git_event': {
      if (!Array.isArray(trigger.events) || trigger.events.length === 0) return 'git_event trigger requires a non-empty events array';
      if (!trigger.events.every((event) => typeof event === 'string' && GIT_EVENTS.has(event))) {
        return `git_event events must be one of ${[...GIT_EVENTS].join('/')}`;
      }
      if (trigger.branches !== undefined && (!Array.isArray(trigger.branches) || !trigger.branches.every(nonEmptyString))) {
        return 'git_event branches must be an array of non-empty strings';
      }
      return null;
    }
    case 'manual':
      return null;
    default:
      return `unknown trigger type: ${String(trigger.type)}`;
  }
}

type TaskVerdict = { ok: true; task: AutomationTask } | { ok: false; reason: string };

/** Validate one persisted entry, normalizing the fields read elsewhere. */
export function validateTaskEntry(value: unknown): TaskVerdict {
  if (!isRecord(value)) return { ok: false, reason: 'entry is not an object' };
  if (!nonEmptyString(value.id)) return { ok: false, reason: 'id must be a non-empty string' };
  if (!nonEmptyString(value.name)) return { ok: false, reason: `task ${value.id}: name must be a non-empty string` };
  const triggerReason = triggerInvalidReason(value.trigger);
  if (triggerReason) return { ok: false, reason: `task ${value.id}: ${triggerReason}` };
  if (!isRecord(value.action)) return { ok: false, reason: `task ${value.id}: action must be an object` };
  if (value.action.type !== 'task_board') return { ok: false, reason: `task ${value.id}: action.type must be task_board` };
  if (!nonEmptyString(value.action.goal)) return { ok: false, reason: `task ${value.id}: action.goal must be a non-empty string` };

  const raw = value as Record<string, unknown>;
  const task: AutomationTask = {
    id: raw.id as string,
    name: raw.name as string,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    // A truthy string ("false") from a hand edit must not read as enabled:
    // enabled state decides whether a watcher/monitor exists.
    enabled: raw.enabled === true,
    trigger: raw.trigger as Trigger,
    action: {
      type: 'task_board',
      goal: value.action.goal,
      // Same reasoning: an unreadable confirmPlan must require a human, not
      // auto-confirm a task board.
      confirmPlan: value.action.confirmPlan === true,
      maxTasks: typeof value.action.maxTasks === 'number' && Number.isFinite(value.action.maxTasks) && value.action.maxTasks > 0
        ? Math.floor(value.action.maxTasks)
        : undefined,
    },
    cronAutomationId: typeof raw.cronAutomationId === 'string' && raw.cronAutomationId.trim() ? raw.cronAutomationId : undefined,
    lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : undefined,
    lastRunStatus: raw.lastRunStatus === 'success' || raw.lastRunStatus === 'failed' || raw.lastRunStatus === 'blocked'
      ? raw.lastRunStatus
      : undefined,
    lastRunError: typeof raw.lastRunError === 'string' ? raw.lastRunError : undefined,
    consecutiveFailures: typeof raw.consecutiveFailures === 'number' && Number.isInteger(raw.consecutiveFailures) && raw.consecutiveFailures >= 0
      ? raw.consecutiveFailures
      : 0,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  };
  return { ok: true, task };
}

function isExecutionResult(value: unknown): value is ExecutionResult {
  if (!isRecord(value)) return false;
  return value.status === 'success' || value.status === 'failed' || value.status === 'blocked';
}
