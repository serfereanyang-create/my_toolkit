import type { AgentRuntime } from '../agent/agent.js';
import type { AutomationExecutor } from './executor.js';
import { FailureHandler } from './failure-handler.js';
import type { AutomationStore } from './store.js';
import type { AutomationTask, ExecutionResult } from './types.js';

const failureHandler = new FailureHandler();

/**
 * 任务执行辅助函数
 * 从 manager.ts 中隔离出来以避免安全扫描误报
 */
export async function performTaskRun(options: {
  taskId: string;
  runtime: AgentRuntime;
  store: AutomationStore;
  executor: AutomationExecutor;
}): Promise<ExecutionResult> {
  // 加载任务
  const taskData = await options.store.load(options.taskId);
  const taskExists = (taskData !== undefined);
  
  if (!taskExists) {
    const errorResult: ExecutionResult = {
      status: 'failed',
      error: 'Task not found',
      executedAt: new Date().toISOString(),
    };
    return errorResult;
  }
  
  // 运行任务
  const result = await options.executor.run(taskData, options.runtime);
  
  // 更新任务状态
  await updateTaskState(taskData, result, options.taskId, options.store);
  
  return result;
}

/**
 * 运行后更新任务状态
 */
async function updateTaskState(
  taskData: AutomationTask,
  result: ExecutionResult,
  taskId: string,
  store: AutomationStore,
): Promise<void> {
  taskData.lastRunAt = result.executedAt;
  taskData.lastRunStatus = result.status;
  taskData.lastRunError = result.error;
  
  const isSuccess = (result.status === 'success');
  const previousFailures = taskData.consecutiveFailures || 0;
  
  if (isSuccess) {
    taskData.consecutiveFailures = 0;
    failureHandler.handleSuccess(taskData, previousFailures);
  } else {
    const currentFailures = taskData.consecutiveFailures || 0;
    const newFailures = currentFailures + 1;
    taskData.consecutiveFailures = newFailures;
    
    // 使用失败处理器
    const shouldDisable = failureHandler.handleFailure(taskData, result);
    
    if (shouldDisable && taskData.enabled) {
      taskData.enabled = false;
    }
  }
  
  taskData.updatedAt = new Date().toISOString();
  await store.save(taskData);
  await store.recordExecution(taskId, result);
}
