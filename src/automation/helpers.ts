import type { AgentRuntime } from '../agent/agent.js';
import type { AutomationExecutor } from './executor.js';
import { FailureHandler } from './failure-handler.js';
import type { AutomationStore } from './store.js';
import type { AutomationTask, ExecutionResult } from './types.js';

const failureHandler = new FailureHandler();

/**
 * Apply the common automation result policy to a task and persist both the
 * latest status and execution history. All trigger types use this function so
 * failures, blocked runs, recovery, and automatic disabling behave the same.
 *
 * @returns true when the failure policy disabled the task.
 */
export async function updateTaskState(
  task: AutomationTask,
  result: ExecutionResult,
  taskId: string,
  store: AutomationStore,
): Promise<boolean> {
  task.lastRunAt = result.executedAt;
  task.lastRunStatus = result.status;
  task.lastRunError = result.error;

  let shouldDisable = false;
  if (result.status === 'success') {
    const previousFailures = task.consecutiveFailures || 0;
    task.consecutiveFailures = 0;
    failureHandler.handleSuccess(task, previousFailures);
  } else {
    task.consecutiveFailures = (task.consecutiveFailures || 0) + 1;
    shouldDisable = failureHandler.handleFailure(task, result);
    if (shouldDisable) task.enabled = false;
  }

  task.updatedAt = new Date().toISOString();
  await store.save(task);
  await store.recordExecution(taskId, result);
  return shouldDisable;
}

/**
 * Run a manually requested automation task. Execution errors are converted to
 * a failed result instead of escaping without history or a task-state update.
 */
export async function performTaskRun(options: {
  taskId: string;
  runtime: AgentRuntime;
  store: AutomationStore;
  executor: AutomationExecutor;
}): Promise<ExecutionResult> {
  const taskData = await options.store.load(options.taskId);
  if (!taskData) {
    return {
      status: 'failed',
      error: `Task not found: ${options.taskId}`,
      executedAt: new Date().toISOString(),
    };
  }

  let result: ExecutionResult;
  try {
    result = await options.executor.run(taskData, options.runtime);
  } catch (error) {
    result = {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      executedAt: new Date().toISOString(),
    };
  }

  try {
    await updateTaskState(taskData, result, options.taskId, options.store);
    return result;
  } catch (error) {
    // A successful execution whose result cannot be persisted is not safe to
    // report as success: callers need an actionable failure instead.
    const persistenceError = error instanceof Error ? error.message : String(error);
    const failedResult: ExecutionResult = {
      status: 'failed',
      boardId: result.boardId,
      error: `Automation result could not be persisted: ${persistenceError}`,
      executedAt: new Date().toISOString(),
    };

    // Best effort: persist the failure state as well. This keeps task status
    // honest even when the original execution result could not be recorded.
    try {
      await updateTaskState(taskData, failedResult, options.taskId, options.store);
    } catch {
      // The original persistence error is the useful actionable result.
    }
    return failedResult;
  }
}
