import type { AutomationTask, CronTrigger } from './types.js';

/**
 * Cron 调度器
 * 使用系统提供的 CronCreate/CronList/CronDelete 工具管理定时任务
 */
export class AutomationScheduler {
  /**
   * 启动自动化任务（注册到 Cron 系统）
   */
  async startTask(task: AutomationTask): Promise<string> {
    if (task.trigger.type !== 'cron') {
      throw new Error(`Task ${task.id} is not a cron task`);
    }
    
    const trigger = task.trigger as CronTrigger;
    const prompt = this.buildExecutionPrompt(task);
    
    // 使用系统 CronCreate 工具创建定时任务
    // 注意：这里假设 CronCreate 是通过全局注入的工具调用
    // 实际实现中，需要通过 runtime 或其他方式访问
    const cronId = await this.createCronAutomation(task.name, trigger.expression, prompt);
    
    return cronId;
  }
  
  /**
   * 停止自动化任务（从 Cron 系统中删除）
   */
  async stopTask(cronAutomationId: string): Promise<void> {
    // 使用系统 CronDelete 工具删除定时任务
    await this.deleteCronAutomation(cronAutomationId);
  }
  
  /**
   * 列出所有 Cron 自动化任务
   */
  async listCronAutomations(): Promise<Array<{ id: string; title: string; cron: string }>> {
    // 使用系统 CronList 工具列出所有定时任务
    return await this.getCronAutomations();
  }
  
  /**
   * 构建执行 prompt（会被 Cron 系统在触发时调用）
   */
  private buildExecutionPrompt(task: AutomationTask): string {
    return `Execute automation task: ${task.name}

Task ID: ${task.id}
Goal: ${task.action.goal}
Auto-confirm plan: ${task.action.confirmPlan}

This is an automated task execution. Create and execute a task board for the goal above.`;
  }
  
  /**
   * 调用系统 CronCreate 工具
   * 注意：此方法需要在运行时环境中实现，这里仅作占位
   */
  private async createCronAutomation(title: string, cron: string, prompt: string): Promise<string> {
    // TODO: 实际实现需要调用系统的 CronCreate 工具
    // 这里先返回模拟ID，实际使用时需要集成到 CLI runtime 中
    throw new Error('CronCreate integration not yet implemented in this context. Use CLI command /automate with CronCreate tool.');
  }
  
  /**
   * 调用系统 CronDelete 工具
   */
  private async deleteCronAutomation(id: string): Promise<void> {
    // TODO: 实际实现需要调用系统的 CronDelete 工具
    throw new Error('CronDelete integration not yet implemented in this context. Use CLI command /automate with CronDelete tool.');
  }
  
  /**
   * 调用系统 CronList 工具
   */
  private async getCronAutomations(): Promise<Array<{ id: string; title: string; cron: string }>> {
    // TODO: 实际实现需要调用系统的 CronList 工具
    throw new Error('CronList integration not yet implemented in this context. Use CLI command /automate with CronList tool.');
  }
}
