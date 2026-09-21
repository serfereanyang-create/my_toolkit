import { runAgentTurn, type AgentRuntime } from '../agent/agent.js';
import { planBoardFromGoal } from '../tasks/planner.js';
import { confirmBoard, runTaskBoardLoop } from '../tasks/runtime.js';
import { TaskBoardStore } from '../tasks/store.js';
import type { AutomationTask, ExecutionResult } from './types.js';

/**
 * 自动化任务执行器
 * 负责创建和执行任务板
 */
export class AutomationExecutor {
  /**
   * 运行一个自动化任务
   */
  async run(task: AutomationTask, runtime: AgentRuntime): Promise<ExecutionResult> {
    const executedAt = new Date().toISOString();
    
    try {
      console.log(`[Automation] Starting task: ${task.name}`);
      console.log(`[Automation] Goal: ${task.action.goal}`);
      
      // 1. 创建任务板
      const board = planBoardFromGoal(task.action.goal);
      const store = new TaskBoardStore(runtime.config.workspaceRoot);
      await store.save(board);
      
      console.log(`[Automation] Task board created: ${board.id}`);
      console.log(`[Automation] Tasks: ${board.tasks.map((t) => t.title).join(', ')}`);
      
      // 2. 确认任务板（如果配置自动确认）
      if (task.action.confirmPlan) {
        confirmBoard(board, new Date().toISOString());
        await store.save(board);
        console.log(`[Automation] Task board confirmed`);
      } else {
        console.log(`[Automation] Task board requires manual confirmation`);
        return {
          status: 'blocked',
          boardId: board.id,
          error: 'Task board requires manual confirmation (confirmPlan=false)',
          executedAt,
        };
      }
      
      // 3. 执行任务板
      const result = await runTaskBoardLoop({
        board,
        store,
        sessions: runtime.sessions,
        session: runtime.session,
        runtime,
        runTurn: async (taskPrompt, gitSafetyUnit) => {
          const turnResult = await runAgentTurn(runtime, taskPrompt, { gitSafetyUnit });
          return {
            ok: turnResult.ok,
            reason: turnResult.reason,
            finalAnswer: turnResult.finalAnswer ?? turnResult.reason,
            hadTerminalFailure: turnResult.hadTerminalFailure,
            outcome: turnResult.outcome,
            steps: turnResult.steps,
          };
        },
        onInfo: (message) => console.log(`[Automation ${task.id}] ${message}`),
        maxTasks: task.action.maxTasks,
      });
      
      // 4. 返回执行结果
      if (result.ok) {
        console.log(`[Automation] Task completed successfully: ${task.name}`);
        return {
          status: 'success',
          boardId: board.id,
          executedAt,
        };
      } else {
        console.error(`[Automation] Task failed: ${task.name}, reason: ${result.reason}`);
        return {
          status: result.status === 'blocked' ? 'blocked' : 'failed',
          boardId: board.id,
          error: result.reason,
          executedAt,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Automation] Task execution error: ${task.name}`, error);
      return {
        status: 'failed',
        error: errorMessage,
        executedAt,
      };
    }
  }
}
