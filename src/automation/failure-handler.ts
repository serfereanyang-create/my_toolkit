import type { AutomationTask, ExecutionResult } from './types.js';

/**
 * 失败通知器
 * 负责处理任务失败后的通知和告警
 */
export class FailureNotifier {
  /**
   * 通知任务失败
   */
  notifyFailure(task: AutomationTask, result: ExecutionResult): void {
    const failures = task.consecutiveFailures || 0;
    
    console.error(`[Automation] Task "${task.name}" (${task.id}) failed`);
    console.error(`  Status: ${result.status}`);
    console.error(`  Error: ${result.error || 'Unknown error'}`);
    console.error(`  Consecutive failures: ${failures}`);
    
    if (failures >= 2) {
      console.warn(`[Automation] ⚠️  Task "${task.name}" has failed ${failures} times consecutively`);
    }
    
    if (failures >= 3) {
      console.error(`[Automation] 🚨 Task "${task.name}" has been disabled after 3 consecutive failures`);
      console.error(`[Automation] Please check the task configuration and error logs`);
    }
  }

  /**
   * 通知任务恢复
   */
  notifyRecovery(task: AutomationTask, previousFailures: number): void {
    if (previousFailures > 0) {
      console.log(`[Automation] ✅ Task "${task.name}" (${task.id}) recovered after ${previousFailures} failures`);
    }
  }

  /**
   * 通知任务阻塞
   */
  notifyBlocked(task: AutomationTask, reason: string): void {
    console.warn(`[Automation] 🔒 Task "${task.name}" (${task.id}) blocked: ${reason}`);
    console.warn(`[Automation] Manual intervention may be required`);
  }
}

/**
 * 失败处理策略
 */
export interface FailureHandlingStrategy {
  /**
   * 应该禁用任务吗？
   */
  shouldDisable(task: AutomationTask): boolean;

  /**
   * 获取重试延迟（毫秒）
   */
  getRetryDelay(task: AutomationTask): number | null;

  /**
   * 应该发送通知吗？
   */
  shouldNotify(task: AutomationTask): boolean;
}

/**
 * 默认失败处理策略
 * - 3次连续失败后禁用
 * - 不自动重试
 * - 每次失败都通知
 */
export class DefaultFailureStrategy implements FailureHandlingStrategy {
  constructor(
    private maxConsecutiveFailures: number = 3,
  ) {}

  shouldDisable(task: AutomationTask): boolean {
    return (task.consecutiveFailures || 0) >= this.maxConsecutiveFailures;
  }

  getRetryDelay(_task: AutomationTask): number | null {
    // 不自动重试，由调度器控制
    return null;
  }

  shouldNotify(_task: AutomationTask): boolean {
    return true;
  }
}

/**
 * 渐进式退避策略
 * - 5次连续失败后禁用
 * - 使用指数退避重试
 * - 失败2次后才通知
 */
export class ExponentialBackoffStrategy implements FailureHandlingStrategy {
  constructor(
    private maxConsecutiveFailures: number = 5,
    private baseDelayMs: number = 60000, // 1分钟
  ) {}

  shouldDisable(task: AutomationTask): boolean {
    return (task.consecutiveFailures || 0) >= this.maxConsecutiveFailures;
  }

  getRetryDelay(task: AutomationTask): number | null {
    const failures = task.consecutiveFailures || 0;
    if (failures === 0) return null;
    
    // 指数退避: 1分钟, 2分钟, 4分钟, 8分钟, 16分钟
    return this.baseDelayMs * Math.pow(2, Math.min(failures - 1, 4));
  }

  shouldNotify(task: AutomationTask): boolean {
    return (task.consecutiveFailures || 0) >= 2;
  }
}

/**
 * 失败处理器
 */
export class FailureHandler {
  private notifier = new FailureNotifier();
  private strategy: FailureHandlingStrategy;

  constructor(strategy?: FailureHandlingStrategy) {
    this.strategy = strategy || new DefaultFailureStrategy();
  }

  /**
   * 处理任务失败
   * @returns 是否应该禁用任务
   */
  handleFailure(task: AutomationTask, result: ExecutionResult): boolean {
    // 通知失败
    if (this.strategy.shouldNotify(task)) {
      if (result.status === 'blocked') {
        this.notifier.notifyBlocked(task, result.error || 'Unknown reason');
      } else {
        this.notifier.notifyFailure(task, result);
      }
    }

    // 检查是否应该禁用
    return this.strategy.shouldDisable(task);
  }

  /**
   * 处理任务成功（恢复）
   */
  handleSuccess(task: AutomationTask, previousFailures: number): void {
    this.notifier.notifyRecovery(task, previousFailures);
  }

  /**
   * 获取重试延迟
   */
  getRetryDelay(task: AutomationTask): number | null {
    return this.strategy.getRetryDelay(task);
  }
}
