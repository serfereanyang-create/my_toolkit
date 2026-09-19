import type { AgentRuntime, AgentTurnResult } from '../agent.js';
import { recoveryHintForToolFailure } from '../toolStrategy.js';
import type { Locale } from '../../i18n/locale.js';
import { isBlockedOutput } from '../../i18n/messages.js';
import { formatResultCard } from '../../ui/resultCard.js';
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

  // Prefer a conclusion card / real tool output over a meta "Done." line.
  const lastTool = completed[completed.length - 1];
  const lastCall = lastSuccessfulCall(runtime, lastTool);
  const card = lastCall
    ? formatResultCard({ tool: lastCall.tool, output: lastCall.output, data: lastCall.data, locale })
    : undefined;
  const lastOutput = lastCall?.output;
  const message = card
    || (completed.length === 1 && lastOutput
      ? lastOutput
      : (locale === 'zh'
        ? `完成。已直接执行高置信命令链：${completed.join(' → ')}。`
        : `Done. Executed high-confidence command chain: ${completed.join(' → ')}.`));
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

function lastSuccessfulCall(runtime: AgentRuntime, toolName: string | undefined) {
  if (!toolName) return undefined;
  for (let index = runtime.session.toolCalls.length - 1; index >= 0; index -= 1) {
    const call = runtime.session.toolCalls[index];
    if (call?.tool === toolName && call.ok && call.output.trim()) {
      const text = call.output.trim();
      return {
        tool: call.tool,
        output: text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text,
        data: call.data,
      };
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
    networkAllowlist: runtime.config.network?.enabled === false ? [] : runtime.config.network?.allowlist,
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

/**
 * Whether a failed tool call must end the direct chain.
 *
 * Mirrors `agent.ts`: a user DENYING one approval renders as
 * `cancelled by user` and is NOT terminal, so the chain falls back to the
 * model, which gets a chance to propose an alternative. Only a policy block
 * ends the chain, since retrying a blocked action cannot help.
 */
function isTerminalToolFailure(output: string) {
  return isBlockedOutput(output);
}

function classifyTerminalFailure(output: string) {
  if (isBlockedOutput(output)) return 'blocked' as const;
  return 'failed' as const;
}
