import type { AgentRuntime, AgentTurnResult } from '../agent.js';
import { recoveryHintForToolFailure } from '../toolStrategy.js';
import type { Locale } from '../../i18n/locale.js';
import { isBlockedOutput, isCancelledOutput } from '../../i18n/messages.js';
import type { CommandPlan, PlannedToolStep } from './types.js';

export type CommandExecutionResult =
  | { status: 'completed'; result: AgentTurnResult }
  | { status: 'fallback'; reason: string };

export async function executeCommandPlan(
  runtime: AgentRuntime,
  plan: CommandPlan,
  locale: Locale = 'en',
): Promise<CommandExecutionResult> {
  if (plan.mode !== 'execute' || plan.steps.length === 0) {
    return { status: 'fallback', reason: 'Plan is not executable.' };
  }

  const completed: string[] = [];
  for (const step of plan.steps) {
    const stepResult = await executeStep(runtime, step, locale);
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

  // Prefer showing the actual tool output for single-step reads instead of a meta "Done." line.
  const lastOutput = lastSuccessfulOutput(runtime, completed[completed.length - 1]);
  const message = completed.length === 1 && lastOutput
    ? lastOutput
    : (locale === 'zh'
      ? `完成。已直接执行高置信命令链：${completed.join(' → ')}。`
      : `Done. Executed high-confidence command chain: ${completed.join(' → ')}.`);
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

function lastSuccessfulOutput(runtime: AgentRuntime, toolName: string | undefined) {
  if (!toolName) return undefined;
  for (let index = runtime.session.toolCalls.length - 1; index >= 0; index -= 1) {
    const call = runtime.session.toolCalls[index];
    if (call?.tool === toolName && call.ok && call.output.trim()) {
      const text = call.output.trim();
      return text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text;
    }
  }
  return undefined;
}

async function executeStep(runtime: AgentRuntime, step: PlannedToolStep, locale: Locale) {
  runtime.ui.toolStart(step.tool, step.input);
  const result = await runtime.tools.execute(step.tool, step.input, {
    workspaceRoot: runtime.config.workspaceRoot,
    approval: runtime.config.approval,
    confirm: runtime.confirm,
    checkpoints: runtime.checkpoints,
    hooks: runtime.hooks,
    beforeConfirm: () => runtime.ui.pauseSpinnerForPrompt(),
    afterConfirm: () => runtime.ui.resumeSpinnerAfterPrompt(),
    locale,
  });
  runtime.ui.toolResult(step.tool, result);
  const recoveryHint = result.ok ? undefined : recoveryHintForToolFailure(step.tool, result.output);
  const output = recoveryHint
    ? `${result.output}\n${locale === 'zh' ? '恢复提示' : 'Recovery hint'}: ${recoveryHint}`
    : result.output;
  await runtime.sessions.appendToolCall(runtime.session, {
    tool: step.tool,
    input: step.input,
    ok: result.ok,
    output,
    data: result.data,
  });

  if (result.ok) return { ok: true as const };
  const reason = locale === 'zh'
    ? `在 ${step.tool} 失败后停止：${output}`
    : `Stopped after ${step.tool} failed: ${output}`;
  if (isTerminalToolFailure(result.output)) {
    await runtime.sessions.appendFinalAnswer(runtime.session, reason);
    return {
      ok: false as const,
      terminal: true as const,
      reason,
      outcome: classifyTerminalFailure(result.output),
    };
  }
  runtime.ui.info(
    recoveryHint
      ? (locale === 'zh' ? `直接执行失败；恢复提示：${recoveryHint}` : `direct chain failed; recovery hint: ${recoveryHint}`)
      : (locale === 'zh' ? `直接执行失败；回退模型：${step.tool}` : `direct chain failed; falling back to model: ${step.tool}`),
  );
  return { ok: false as const, terminal: false as const, reason };
}

function isTerminalToolFailure(output: string) {
  return isCancelledOutput(output) || isBlockedOutput(output);
}

function classifyTerminalFailure(output: string) {
  if (isCancelledOutput(output)) return 'cancelled' as const;
  if (isBlockedOutput(output)) return 'blocked' as const;
  return 'failed' as const;
}
