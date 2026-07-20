import type { AgentRuntime, AgentTurnResult } from '../agent.js';
import { recoveryHintForToolFailure } from '../toolStrategy.js';
import type { CommandPlan, PlannedToolStep } from './types.js';

export type CommandExecutionResult =
  | { status: 'completed'; result: AgentTurnResult }
  | { status: 'fallback'; reason: string };

export async function executeCommandPlan(runtime: AgentRuntime, plan: CommandPlan): Promise<CommandExecutionResult> {
  if (plan.mode !== 'execute' || plan.steps.length === 0) {
    return { status: 'fallback', reason: 'Plan is not executable.' };
  }

  const completed: string[] = [];
  for (const step of plan.steps) {
    const stepResult = await executeStep(runtime, step);
    if (!stepResult.ok) {
      if (stepResult.terminal) {
        return {
          status: 'completed',
          result: {
            ok: false,
            session: runtime.session,
            reason: stepResult.reason,
            finalAnswer: stepResult.reason,
            hadTerminalFailure: true,
            outcome: stepResult.outcome,
          },
        };
      }
      return { status: 'fallback', reason: stepResult.reason };
    }
    completed.push(step.tool);
  }

  const message = `Done. Executed high-confidence command chain: ${completed.join(' → ')}.`;
  runtime.ui.assistant(message);
  await runtime.sessions.appendFinalAnswer(runtime.session, message);
  return {
    status: 'completed',
    result: {
      ok: true,
      session: runtime.session,
      finalAnswer: message,
      outcome: 'done',
    },
  };
}

async function executeStep(runtime: AgentRuntime, step: PlannedToolStep) {
  runtime.ui.toolStart(step.tool, step.input);
  const result = await runtime.tools.execute(step.tool, step.input, {
    workspaceRoot: runtime.config.workspaceRoot,
    approval: runtime.config.approval,
    confirm: runtime.confirm,
    checkpoints: runtime.checkpoints,
    hooks: runtime.hooks,
    beforeConfirm: () => runtime.ui.pauseSpinnerForPrompt(),
    afterConfirm: () => runtime.ui.resumeSpinnerAfterPrompt(),
  });
  runtime.ui.toolResult(step.tool, result);
  const recoveryHint = result.ok ? undefined : recoveryHintForToolFailure(step.tool, result.output);
  const output = recoveryHint ? `${result.output}\nRecovery hint: ${recoveryHint}` : result.output;
  await runtime.sessions.appendToolCall(runtime.session, {
    tool: step.tool,
    input: step.input,
    ok: result.ok,
    output,
    data: result.data,
  });

  if (result.ok) return { ok: true as const };
  const reason = `Stopped after ${step.tool} failed: ${output}`;
  if (isTerminalToolFailure(result.output)) {
    await runtime.sessions.appendFinalAnswer(runtime.session, reason);
    return {
      ok: false as const,
      terminal: true as const,
      reason,
      outcome: classifyTerminalFailure(result.output),
    };
  }
  runtime.ui.info(recoveryHint ? `direct chain failed; recovery hint: ${recoveryHint}` : `direct chain failed; falling back to model: ${step.tool}`);
  return { ok: false as const, terminal: false as const, reason };
}

function isTerminalToolFailure(output: string) {
  return output.includes('cancelled by user') || output.includes('blocked:') || output.includes('Path escapes workspace');
}

function classifyTerminalFailure(output: string) {
  if (output.includes('cancelled by user')) return 'cancelled' as const;
  if (output.includes('blocked:') || output.includes('Path escapes workspace')) return 'blocked' as const;
  return 'failed' as const;
}
