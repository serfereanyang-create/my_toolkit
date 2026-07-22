import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/types.js';
import type { GitProcess } from '../git-safety/git.js';
import type { GitRemotePublisher } from '../git-safety/publisher.js';
import type { GitRepository } from '../git-safety/repository.js';
import type { GitRollbackService } from '../git-safety/rollback.js';
import type { GitSafetyService } from '../git-safety/service.js';
import type { GitUnitContext, GitUnitOutcome, GitUnitResult } from '../git-safety/types.js';
import { askForApproval } from '../safety/policy.js';
import type { AgentAction, Provider } from '../providers/types.js';
import type { HookRegistry } from '../hooks/hooks.js';
import type { CheckpointStore } from '../session/checkpoint.js';
import type { SessionRecord, SessionStore } from '../session/store.js';
import type { ToolRegistry } from '../tools/index.js';
import type { TerminalUI } from '../ui/terminal.js';
import { executeCommandPlan, extractCommand, formatCommandStrategy, planCommand } from './commandExtract/index.js';
import { formatProjectContext, readProjectContext } from './context.js';
import { compactMessagesForModel, resolveContextBudgetChars } from './contextBudget.js';
import { planLocalFallback } from './fallback.js';
import { formatToolStrategy, planToolStrategy, recentToolResultsFromSession, recoveryHintForToolFailure } from './toolStrategy.js';

export type AgentRuntime = {
  config: AppConfig;
  provider: Provider;
  tools: ToolRegistry;
  sessions: SessionStore;
  checkpoints?: CheckpointStore;
  session: SessionRecord;
  ui: TerminalUI;
  hooks?: HookRegistry;
  confirm?: (message: string) => Promise<boolean>;
  gitSafety?: GitSafetyService;
  gitRollback?: GitRollbackService;
  gitPublisher?: GitRemotePublisher;
  gitProcess?: GitProcess;
  gitRepository?: GitRepository;
};

export type AgentTurnOptions = {
  gitSafetyUnit?: GitUnitContext;
};

export type AgentTurnResult = {
  ok: boolean;
  session: SessionRecord;
  reason?: string;
  finalAnswer?: string;
  hadTerminalFailure?: boolean;
  outcome?: GitUnitOutcome;
  gitSafety?: GitUnitResult;
};

export async function runAgentTurn(runtime: AgentRuntime, prompt: string, options: AgentTurnOptions = {}): Promise<AgentTurnResult> {
  runtime.ui.turnStart(prompt);

  const ownsUnit = !options.gitSafetyUnit && Boolean(runtime.gitSafety);
  let unit = options.gitSafetyUnit;
  if (ownsUnit && runtime.gitSafety) {
    unit = await runtime.gitSafety.startUnit({
      kind: 'turn',
      sessionId: runtime.session.id,
      turnId: `turn_${randomUUID()}`,
    }, {
      confirm: resolveConfirm(runtime),
      onWarning: (message) => runtime.ui.info(message),
    });
  }

  let coreResult: AgentTurnResult = { ok: true, session: runtime.session, outcome: 'done' };
  let thrown: unknown;
  try {
    coreResult = await runAgentTurnCore(runtime, prompt);
  } catch (error) {
    thrown = error;
    coreResult = {
      ok: false,
      session: runtime.session,
      reason: error instanceof Error ? error.message : String(error),
      outcome: 'failed',
      hadTerminalFailure: true,
    };
  }

  let gitSafety: GitUnitResult | undefined;
  if (ownsUnit && unit && runtime.gitSafety) {
    try {
      gitSafety = await runtime.gitSafety.finishUnit(unit, coreResult.outcome ?? (coreResult.ok ? 'done' : 'failed'));
    } catch (error) {
      runtime.ui.info(`Git safety finish failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (thrown) throw thrown;
  return { ...coreResult, gitSafety };
}

async function runAgentTurnCore(runtime: AgentRuntime, prompt: string): Promise<AgentTurnResult> {
  const recentTools = recentToolResultsFromSession(runtime.session);
  await runtime.sessions.appendMessage(runtime.session, { role: 'user', content: prompt });
  const projectContext = formatProjectContext(await readProjectContext(runtime.config.workspaceRoot));
  const extraction = extractCommand(prompt);
  const commandPlan = planCommand(extraction);
  // Mock already plans deterministic multi-step demos one tool per provider turn.
  // Direct execution is for real providers / non-mock paths.
  if (commandPlan.mode === 'execute' && runtime.provider.name !== 'mock') {
    try {
      const direct = await executeCommandPlan(runtime, commandPlan);
      if (direct.status === 'completed') return direct.result;
      runtime.ui.info(`Direct command chain fallback: ${direct.reason}`);
    } catch (error) {
      runtime.ui.info(`Direct command chain failed open to provider: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const toolStrategy = formatCommandStrategy(commandPlan, extraction)
    || formatToolStrategy(planToolStrategy({
      prompt,
      recentTools,
      workspaceRoot: runtime.config.workspaceRoot,
    }));

  let finalAnswer: string | undefined;
  let warnedAboutCompaction = false;
  for (let step = 0; step < runtime.config.maxSteps; step += 1) {
    let response;
    try {
      runtime.ui.modelStart();
      const packed = compactMessagesForModel(runtime.session.messages, {
        budgetChars: resolveContextBudgetChars(),
      });
      if (packed.truncated && !warnedAboutCompaction) {
        runtime.ui.info(`Context compacted for model: kept≈${packed.compactChars} chars, dropped ${packed.droppedMessages} older messages.`);
        warnedAboutCompaction = true;
      }
      response = await runtime.provider.complete({
        messages: packed.messages,
        tools: runtime.tools.specs(),
        workspaceRoot: runtime.config.workspaceRoot,
        projectContext,
        toolStrategy,
        onTextDelta: (delta) => runtime.ui.assistantDelta(delta),
      });
      runtime.ui.modelEnd();
    } catch (error) {
      runtime.ui.modelEnd();
      const fallbackActions = planLocalFallback(prompt, runtime.session);
      if (fallbackActions.length > 0) {
        runtime.ui.assistant(`Model request failed: ${errorMessage(error)}. Falling back to local tool planning.`);
        for (const action of fallbackActions) {
          const toolResult = await executeToolAction(runtime, action);
          if (!toolResult.ok) {
            const reason = toolResult.reason ?? 'tool failed';
            return {
              ok: false,
              session: runtime.session,
              reason,
              finalAnswer: reason,
              hadTerminalFailure: true,
              outcome: toolResult.outcome ?? 'failed',
            };
          }
        }
        const message = '已使用本地兜底工具完成操作。';
        runtime.ui.assistant(message);
        await runtime.sessions.appendFinalAnswer(runtime.session, message);
        return { ok: true, session: runtime.session, finalAnswer: message, outcome: 'done' };
      }
      const message = `Model request failed: ${errorMessage(error)}`;
      runtime.ui.assistant(message);
      await runtime.sessions.appendFinalAnswer(runtime.session, message);
      return {
        ok: false,
        session: runtime.session,
        reason: message,
        finalAnswer: message,
        hadTerminalFailure: true,
        outcome: 'failed',
      };
    }

    let sawTool = false;
    for (const action of response.actions) {
      if (action.type === 'message') {
        runtime.ui.assistant(action.content);
        await runtime.sessions.appendFinalAnswer(runtime.session, action.content);
        finalAnswer = action.content;
        continue;
      }

      sawTool = true;
      const toolResult = await executeToolAction(runtime, action);
      if (!toolResult.ok) {
        const reason = toolResult.reason ?? 'tool failed';
        return {
          ok: false,
          session: runtime.session,
          reason,
          finalAnswer: reason,
          hadTerminalFailure: true,
          outcome: toolResult.outcome ?? 'failed',
        };
      }
    }

    if (!sawTool) {
      return {
        ok: true,
        session: runtime.session,
        finalAnswer,
        outcome: 'done',
      };
    }
  }

  const message = `Stopped after reaching max steps (${runtime.config.maxSteps}).`;
  runtime.ui.assistant(message);
  await runtime.sessions.appendFinalAnswer(runtime.session, message);
  return {
    ok: false,
    session: runtime.session,
    reason: message,
    finalAnswer: message,
    hadTerminalFailure: true,
    outcome: 'failed',
  };
}

async function executeToolAction(runtime: AgentRuntime, action: Extract<AgentAction, { type: 'tool' }>) {
  runtime.ui.toolStart(action.tool, action.input);
  const result = await runtime.tools.execute(action.tool, action.input, {
    workspaceRoot: runtime.config.workspaceRoot,
    approval: runtime.config.approval,
    confirm: resolveConfirm(runtime),
    checkpoints: runtime.checkpoints,
    hooks: runtime.hooks,
    beforeConfirm: () => runtime.ui.pauseSpinnerForPrompt(),
    afterConfirm: () => runtime.ui.resumeSpinnerAfterPrompt(),
  });
  runtime.ui.toolResult(action.tool, result);
  const recoveryHint = result.ok ? undefined : recoveryHintForToolFailure(action.tool, result.output);
  const output = recoveryHint ? `${result.output}\nRecovery hint: ${recoveryHint}` : result.output;
  await runtime.sessions.appendToolCall(runtime.session, {
    tool: action.tool,
    input: action.input,
    ok: result.ok,
    output,
    data: result.data,
  });
  if (!result.ok) {
    const reason = `Stopped after ${action.tool} failed: ${output}`;
    if (isTerminalToolFailure(result.output)) {
      await runtime.sessions.appendFinalAnswer(runtime.session, reason);
      return {
        ok: false,
        reason,
        outcome: classifyTerminalFailure(result.output),
      } as const;
    }
    runtime.ui.info(recoveryHint ? `tool failed; recovery hint: ${recoveryHint}` : `tool failed; asking model to recover: ${action.tool}`);
    return { ok: true } as const;
  }
  return { ok: true } as const;
}

function resolveConfirm(runtime: AgentRuntime) {
  // Only the interactive REPL installs a confirm callback. Prompt/CI/smoke modes must
  // never block on stdin for git init or other safety confirmations.
  if (runtime.confirm) return runtime.confirm;
  if (runtime.config.noInput || runtime.config.prompt !== undefined || runtime.config.ci) return undefined;
  if (process.stdin.isTTY) return askForApproval;
  return undefined;
}

function isTerminalToolFailure(output: string) {
  return output.includes('cancelled by user') || output.includes('blocked:') || output.includes('Path escapes workspace');
}

function classifyTerminalFailure(output: string): GitUnitOutcome {
  if (output.includes('cancelled by user')) return 'cancelled';
  if (output.includes('blocked:') || output.includes('Path escapes workspace')) return 'blocked';
  return 'failed';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
