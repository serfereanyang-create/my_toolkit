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
import type { McpManager } from '../mcp/manager.js';
import type { ToolRegistry } from '../tools/index.js';
import type { TerminalUI } from '../ui/terminal.js';
import { executeCommandPlan, extractCommand, formatCommandStrategy, planCommand } from './commandExtract/index.js';
import { formatProjectContext, readProjectContext } from './context.js';
import { compactMessagesForModel, resolveContextBudgetChars } from './contextBudget.js';
import { planLocalFallback } from './fallback.js';
import { formatToolStrategy, planToolStrategy, recentToolResultsFromSession, recoveryHintForToolFailure } from './toolStrategy.js';
import { detectLocale, resolveSessionLocale, type Locale } from '../i18n/locale.js';
import { isBlockedOutput, isCancelledOutput } from '../i18n/messages.js';
import { formatResultCard, isMetaTranslatedDone } from '../ui/resultCard.js';

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
  mcp?: McpManager;
  reloadMcp?: () => Promise<McpManager>;
  /** Files staged via /attach or /paste-image for the next user turn. */
  pendingAttachments?: import('../cli/attachments.js').Attachment[];
  /** Sticky UI language for approval prompts and gate messages. */
  locale?: Locale;
};

export type AgentTurnOptions = {
  gitSafetyUnit?: GitUnitContext;
  /** Optional multimodal parts (images) for the user turn. */
  parts?: import('../providers/types.js').MessagePart[];
  /** Display/log text; defaults to prompt. */
  displayText?: string;
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
  runtime.ui.turnStart(options.displayText ?? prompt);

  const ownsUnit = !options.gitSafetyUnit && Boolean(runtime.gitSafety);
  let unit = options.gitSafetyUnit;
  if (ownsUnit && runtime.gitSafety) {
    unit = await runtime.gitSafety.startUnit({
      kind: 'turn',
      sessionId: runtime.session.id,
      turnId: `turn_${randomUUID()}`,
    }, {
      confirm: resolveConfirm(runtime),
      onWarning: (message) => runtime.ui.info(summarizeGitSafetyWarning(message)),
      locale: resolveSessionLocale({
        text: options.displayText ?? prompt,
        previous: runtime.locale,
      }),
    });
  }

  let coreResult: AgentTurnResult = { ok: true, session: runtime.session, outcome: 'done' };
  let thrown: unknown;
  try {
    coreResult = await runAgentTurnCore(runtime, prompt, options);
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

async function runAgentTurnCore(runtime: AgentRuntime, prompt: string, options: AgentTurnOptions = {}): Promise<AgentTurnResult> {
  const recentTools = recentToolResultsFromSession(runtime.session);
  const locale = resolveSessionLocale({
    text: options.displayText ?? prompt,
    previous: runtime.locale,
  });
  runtime.locale = locale;
  await runtime.sessions.appendMessage(runtime.session, {
    role: 'user',
    content: prompt,
    parts: options.parts,
  });
  const projectContext = formatProjectContext(await readProjectContext(runtime.config.workspaceRoot));
  const extraction = extractCommand(prompt);
  const commandPlan = planCommand(extraction);
  // Mock multi-step demos stay model-driven one tool per turn, except pure cache_probe
  // which must never fall into a code-search rabbit hole from NL like "缓存命中".
  const pureDirectOnly = commandPlan.steps.length > 0 && commandPlan.steps.every((step) => step.tool === 'cache_probe');
  if (commandPlan.mode === 'execute' && (runtime.provider.name !== 'mock' || pureDirectOnly)) {
    try {
      const direct = await executeCommandPlan(runtime, commandPlan, locale);
      if (direct.status === 'completed') return direct.result;
      runtime.ui.info(locale === 'zh' ? `直接命令链回退：${direct.reason}` : `Direct command chain fallback: ${direct.reason}`);
    } catch (error) {
      runtime.ui.info(
        locale === 'zh'
          ? `直接命令链失败，改走模型：${error instanceof Error ? error.message : String(error)}`
          : `Direct command chain failed open to provider: ${error instanceof Error ? error.message : String(error)}`,
      );
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
  let lastToolName: string | undefined;
  for (let step = 0; step < runtime.config.maxSteps; step += 1) {
    let response;
    try {
      runtime.ui.modelStart();
      const packed = compactMessagesForModel(runtime.session.messages, {
        budgetChars: resolveContextBudgetChars(),
      });
      if (packed.truncated && !warnedAboutCompaction) {
        const detail = [
          `mode=${packed.mode}`,
          `kept≈${packed.compactChars}`,
          packed.droppedMessages ? `dropped=${packed.droppedMessages}` : undefined,
          packed.imagesStripped ? `imagesStripped=${packed.imagesStripped}` : undefined,
          packed.softTriggered ? 'soft' : undefined,
        ].filter(Boolean).join(' ');
        runtime.ui.info(`Context compacted for model: ${detail}`);
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
        runtime.ui.assistant(
          locale === 'zh'
            ? `模型请求失败：${errorMessage(error)}。改用本地兜底。`
            : `Model request failed: ${errorMessage(error)}. Falling back to local tool planning.`,
        );
        for (const action of fallbackActions) {
          const toolResult = await executeToolAction(runtime, action, locale);
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
          lastToolName = action.tool;
        }
        const message = locale === 'zh' ? '已使用本地兜底工具完成操作。' : 'Completed with local fallback tools.';
        runtime.ui.assistant(message);
        await runtime.sessions.appendFinalAnswer(runtime.session, message);
        return { ok: true, session: runtime.session, finalAnswer: message, outcome: 'done' };
      }

      // Tools already succeeded this turn, but the follow-up model stream died (e.g. "terminated").
      // Prefer a conclusion from tool results over a bare provider error.
      const recovered = recoverFromSuccessfulTools(runtime, lastToolName, locale, errorMessage(error));
      if (recovered) {
        runtime.ui.assistant(recovered);
        await runtime.sessions.appendFinalAnswer(runtime.session, recovered);
        return { ok: true, session: runtime.session, finalAnswer: recovered, outcome: 'done' };
      }

      const message = locale === 'zh'
        ? `模型请求失败：${friendlyModelError(errorMessage(error))}。工具若已执行，结果仍保留在会话里；可重试或换 /cache、磁盘等本地命令。`
        : `Model request failed: ${friendlyModelError(errorMessage(error))}. If tools already ran, results remain in session; retry or use local commands.`;
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
        const card = maybeUpgradeMetaMessage(runtime, action.content, lastToolName, locale);
        const content = card ?? action.content;
        runtime.ui.assistant(content);
        await runtime.sessions.appendFinalAnswer(runtime.session, content);
        finalAnswer = content;
        continue;
      }

      sawTool = true;
      lastToolName = action.tool;
      const toolResult = await executeToolAction(runtime, action, locale);
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

  // Tools ran across steps but no final assistant message: still try one conclusion card.
  if (!finalAnswer && lastToolName) {
    const card = maybeUpgradeMetaMessage(runtime, '', lastToolName, locale);
    if (card) {
      runtime.ui.assistant(card);
      await runtime.sessions.appendFinalAnswer(runtime.session, card);
      return { ok: true, session: runtime.session, finalAnswer: card, outcome: 'done' };
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

async function executeToolAction(
  runtime: AgentRuntime,
  action: Extract<AgentAction, { type: 'tool' }>,
  locale: Locale = 'en',
) {
  runtime.ui.toolStart(action.tool, action.input);
  const result = await runtime.tools.execute(action.tool, action.input, {
    workspaceRoot: runtime.config.workspaceRoot,
    approval: runtime.config.approval,
    confirm: resolveConfirm(runtime),
    checkpoints: runtime.checkpoints,
    hooks: runtime.hooks,
    beforeConfirm: () => runtime.ui.pauseSpinnerForPrompt(),
    afterConfirm: () => runtime.ui.resumeSpinnerAfterPrompt(),
    locale,
  });
  runtime.ui.toolResult(action.tool, result);
  const recoveryHint = result.ok ? undefined : recoveryHintForToolFailure(action.tool, result.output);
  const output = recoveryHint
    ? `${result.output}\n${locale === 'zh' ? '恢复提示' : 'Recovery hint'}: ${recoveryHint}`
    : result.output;
  await runtime.sessions.appendToolCall(runtime.session, {
    tool: action.tool,
    input: action.input,
    ok: result.ok,
    output,
    data: result.data,
  });
  if (!result.ok) {
    const reason = locale === 'zh'
      ? `在 ${action.tool} 失败后停止：${output}`
      : `Stopped after ${action.tool} failed: ${output}`;
    if (isTerminalToolFailure(result.output)) {
      await runtime.sessions.appendFinalAnswer(runtime.session, reason);
      return {
        ok: false,
        reason,
        outcome: classifyTerminalFailure(result.output),
      } as const;
    }
    runtime.ui.info(
      recoveryHint
        ? (locale === 'zh' ? `工具失败；恢复提示：${recoveryHint}` : `tool failed; recovery hint: ${recoveryHint}`)
        : (locale === 'zh' ? `工具失败；请模型继续恢复：${action.tool}` : `tool failed; asking model to recover: ${action.tool}`),
    );
    return { ok: true } as const;
  }
  return { ok: true } as const;
}

function resolveConfirm(runtime: AgentRuntime) {
  // Only the interactive REPL installs a confirm callback. Prompt/CI/smoke modes must
  // never block on stdin for git init or other safety confirmations.
  if (runtime.confirm) {
    return async (message: string) => runtime.confirm!(message);
  }
  if (runtime.config.noInput || runtime.config.prompt !== undefined || runtime.config.ci) return undefined;
  if (process.stdin.isTTY) {
    return async (message: string) => askForApproval(message, { locale: runtime.locale ?? 'en' });
  }
  return undefined;
}

/** Collapse noisy Git CRLF / ignored-path dumps into a single short line for the UI. */
function summarizeGitSafetyWarning(message: string) {
  if (!message) return message;
  const hasCrlf = /LF will be replaced by CRLF|CRLF will be replaced by LF/i.test(message);
  const hasIgnored = /paths are ignored by one of your \.gitignore/i.test(message);
  if (hasCrlf || hasIgnored) {
    const parts = [
      hasCrlf ? 'line-ending notices suppressed' : undefined,
      hasIgnored ? 'ignored-path advice suppressed' : undefined,
    ].filter((part): part is string => Boolean(part));
    return `Git safety: snapshot notes (${parts.join(', ')}).`;
  }
  if (message.length > 280) return `${message.slice(0, 277)}...`;
  return message;
}

function maybeUpgradeMetaMessage(
  runtime: AgentRuntime,
  content: string,
  lastToolName: string | undefined,
  locale: Locale,
) {
  // Replace mock meta "Done. I translated..." or empty finals with a real conclusion card.
  if (content && !isMetaTranslatedDone(content)) return undefined;
  const preferred = lastToolName
    ?? [...runtime.session.toolCalls].reverse().find((call) => call.ok && call.output.trim())?.tool;
  if (!preferred) return undefined;
  for (let index = runtime.session.toolCalls.length - 1; index >= 0; index -= 1) {
    const call = runtime.session.toolCalls[index];
    if (call?.tool === preferred && call.ok && call.output.trim()) {
      return formatResultCard({
        tool: call.tool,
        output: call.output,
        data: call.data,
        locale,
      });
    }
  }
  return undefined;
}

function recoverFromSuccessfulTools(
  runtime: AgentRuntime,
  lastToolName: string | undefined,
  locale: Locale,
  error: string,
) {
  const call = latestSuccessfulTool(runtime, lastToolName);
  if (!call) return undefined;
  const card = formatResultCard({
    tool: call.tool,
    output: call.output,
    data: call.data,
    locale,
  });
  if (card) {
    const note = locale === 'zh'
      ? `\n\n（模型后续连接中断：${friendlyModelError(error)}；以上为已成功工具结果。）`
      : `\n\n(Model stream interrupted: ${friendlyModelError(error)}; showing successful tool result.)`;
    return `${card}${note}`;
  }
  const snippet = call.output.trim().slice(0, 1200);
  if (locale === 'zh') {
    return [
      `结论：工具 ${call.tool} 已成功，但模型总结时连接中断（${friendlyModelError(error)}）。`,
      '数据：',
      snippet,
      '下一步：可再说一次需求，或直接用 /status /cache 等本地命令。',
    ].join('\n');
  }
  return [
    `Conclusion: tool ${call.tool} succeeded, but the model stream died (${friendlyModelError(error)}).`,
    'Data:',
    snippet,
    'Next: retry the request, or use local commands like /status /cache.',
  ].join('\n');
}

function latestSuccessfulTool(runtime: AgentRuntime, lastToolName: string | undefined) {
  const preferred = lastToolName
    ?? [...runtime.session.toolCalls].reverse().find((call) => call.ok && call.output.trim())?.tool;
  if (!preferred) return undefined;
  for (let index = runtime.session.toolCalls.length - 1; index >= 0; index -= 1) {
    const call = runtime.session.toolCalls[index];
    if (call?.tool === preferred && call.ok && call.output.trim()) return call;
  }
  return undefined;
}

function friendlyModelError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes('terminated') || lower.includes('aborted') || lower.includes('econnreset') || lower.includes('socket')) {
    return '连接被中断/终止（常见于流式 SSE 超时或代理掐断）';
  }
  if (lower.includes('timeout')) return '请求超时';
  if (lower.includes('401') || lower.includes('invalid api key') || lower.includes('invalid token')) {
    return '鉴权失败（API key / base URL 不匹配）';
  }
  return message;
}

function isTerminalToolFailure(output: string) {
  return isCancelledOutput(output) || isBlockedOutput(output);
}

function classifyTerminalFailure(output: string): GitUnitOutcome {
  if (isCancelledOutput(output)) return 'cancelled';
  if (isBlockedOutput(output)) return 'blocked';
  return 'failed';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
