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
import { ToolRegistry } from '../tools/registry.js';
import { resolveToolScope, selectScopedTools, type ToolScope, type ResolvedToolScope } from '../tools/scope.js';
import type { TerminalUI } from '../ui/terminal.js';
import { executeCommandPlan, extractCommand, formatCommandStrategy, planCommand } from './commandExtract/index.js';
import { formatProjectContext, readProjectContext } from './context.js';
import { formatMemories } from '../memory/format.js';
import { selectRelevantMemories } from '../memory/select.js';
import { compactMessagesForModel, resolveContextBudgetChars } from './contextBudget.js';
import { buildToolSystemPrompt, buildToolSystemPromptParts } from '../providers/protocol.js';
import { planLocalFallback } from './fallback.js';
import { shouldUseTaskBoard } from '../tasks/planner.js';
import { formatToolStrategy, planToolStrategy, recentToolResultsFromSession, recoveryHintForToolFailure, nextStepHint } from './toolStrategy.js';
import { detectLocale, resolveSessionLocale, type Locale } from '../i18n/locale.js';
import { isBlockedOutput, isCancelledOutput } from '../i18n/messages.js';
import { formatResultCard, isMetaTranslatedDone } from '../ui/resultCard.js';
import { appendUsage, resolveUsageLogPath } from '../usage/ledger.js';
import { buildLowCacheHint, collectCacheProbe } from '../probe/cacheProbe.js';
import { MAX_SUBAGENT_DEPTH } from '../tools/subagent.js';
import type { SubAgentOptions } from '../tools/types.js';
import { getReasoningCapability, clampReasoningEffort } from '../providers/capabilities.js';

type PromptCacheBasis = {
  stablePrefix: string;
  totalChars: number;
};

export type AgentRuntime = {
  config: AppConfig;
  provider: Provider;
  tools: ToolRegistry;
  allTools?: ToolRegistry;
  sessions: SessionStore;
  checkpoints?: CheckpointStore;
  session: SessionRecord;
  ui: TerminalUI;
  /** Last packed prompt signature used for local prompt-cache reuse prediction. */
  lastPromptCacheBasis?: PromptCacheBasis;
  hooks?: HookRegistry;
  confirm?: (message: string) => Promise<boolean>;
  /**
   * Optional structured approval callback for tool execution.
   * When set, replaces the plain `confirm` shim inside ToolContext so UIs
   * (desktop bridge) can carry tool/risk/input/reason metadata to the user.
   */
  toolConfirm?: (
    message: string,
    request?: import('../tools/types.js').ApprovalRequest,
  ) => Promise<import('../tools/types.js').ApprovalDecision>;
  gitSafety?: GitSafetyService;
  gitRollback?: GitRollbackService;
  gitPublisher?: GitRemotePublisher;
  gitProcess?: GitProcess;
  gitRepository?: GitRepository;
  mcp?: McpManager;
  reloadMcp?: () => Promise<McpManager>;
  /** Project memory store (.aicode/memory) for cross-session recall. */
  memory?: import('../memory/store.js').ProjectMemoryStore;
  /** Files staged via /attach or /paste-image for the next user turn. */
  pendingAttachments?: import('../cli/attachments.js').Attachment[];
  /** Sticky UI language for approval prompts and gate messages. */
  locale?: Locale;
  /**
   * Live reasoning/thinking effort tier. Mutable so the desktop bridge can
   * change it per message (via a `set_effort` stdin command) without respawning
   * the child. Passed into every provider.complete() call.
   */
  reasoningEffort?: import('../providers/types.js').ReasoningEffort;
  toolScope?: ToolScope;
  resolvedToolScope?: ResolvedToolScope;
  /**
   * Current sub-agent nesting depth. 0 = root agent, 1 = first-level sub-agent.
   * spawn_subagent refuses to run when depth >= MAX_SUBAGENT_DEPTH (3) to
   * prevent unbounded recursion.
   */
  subAgentDepth?: number;
  /**
   * Injected by repl.ts so spawn_subagent can invoke a new agent turn
   * without a dynamic import (which would create a circular dependency).
   * Set to undefined when subAgentDepth >= MAX_SUBAGENT_DEPTH.
   */
  runSubAgentTurn?: (runtime: AgentRuntime, goal: string) => Promise<string>;
  taskBoardEmit?: (board: unknown) => void;
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

  // Accumulate REAL token usage across every model step in this turn, then
  // persist one ledger line with the turn total. Written whether the turn
  // succeeds or fails, so genuine usage is never lost.
  const usageTotals: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; localCachePredictedRate?: number } = { inputTokens: 0, outputTokens: 0 };

  let coreResult: AgentTurnResult = { ok: true, session: runtime.session, outcome: 'done' };
  let thrown: unknown;
  try {
    coreResult = await runAgentTurnCore(runtime, prompt, options, usageTotals);
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

  if (usageTotals.inputTokens > 0 || usageTotals.outputTokens > 0) {
    await appendUsage(resolveUsageLogPath(runtime.config.usageLog), {
      ts: new Date().toISOString(),
      sessionId: runtime.session.id,
      provider: runtime.provider.name,
      model: runtime.provider.model,
      baseUrl: runtime.config.baseUrl,
      inputTokens: usageTotals.inputTokens,
      outputTokens: usageTotals.outputTokens,
      cacheReadTokens: usageTotals.cacheReadTokens,
      cacheCreationTokens: usageTotals.cacheCreationTokens,
      localCachePredictedRate: usageTotals.localCachePredictedRate,
      cacheEfficiency: (() => {
        const read = usageTotals.cacheReadTokens ?? 0;
        const denom = read + usageTotals.inputTokens;
        return denom > 0 ? read / denom : undefined;
      })(),
      reasoningEffort: runtime.reasoningEffort && runtime.reasoningEffort !== 'off'
        ? runtime.reasoningEffort
        : undefined,
    });
  }

  // Auto-record memory from successful turns. Failures to write are
  // swallowed so a memory problem never breaks turn delivery.
  if (runtime.memory && coreResult.ok && coreResult.finalAnswer) {
    recordTurnMemory(runtime, coreResult.finalAnswer).catch(() => {});
  }

  // Proactive cache self-awareness: after a successful turn, if the local cache
  // is clearly cold (low hit rate with a real sample), append a short note so
  // the agent surfaces cache health on its own instead of waiting to be asked.
  // Skip turns that were themselves about the cache — the reply already covers
  // it and a trailing note would be redundant.
  if (coreResult.ok && coreResult.finalAnswer && !answerIsAboutCache(coreResult.finalAnswer)) {
    const hintLocale = resolveSessionLocale({
      text: options.displayText ?? prompt,
      previous: runtime.locale,
    });
    const hint = buildLowCacheHint(hintLocale === 'zh' ? 'zh' : 'en');
    if (hint) {
      runtime.ui.assistant(hint);
      coreResult = { ...coreResult, finalAnswer: `${coreResult.finalAnswer}\n\n${hint}` };
    }
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

async function runAgentTurnCore(
  runtime: AgentRuntime,
  prompt: string,
  options: AgentTurnOptions = {},
  usageTotals?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; localCachePredictedRate?: number },
): Promise<AgentTurnResult> {
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
  const baseContext = formatProjectContext(await readProjectContext(runtime.config.workspaceRoot));
  // Inject relevant project memories (.aicode/memory) so ordinary chat turns —
  // not just the task board — benefit from cross-session recall of conventions,
  // decisions, and pitfalls. Failures here must never break a turn.
  const memoryBlock = await loadMemoryBlock(runtime, prompt);
  // Keep projectContext stable for cache hit — memory goes into messages, not system.
  const projectContext = baseContext;
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
  const requestedEffort = runtime.reasoningEffort ?? runtime.config.reasoningEffort ?? 'off';
  const capability = getReasoningCapability(runtime.provider.name, runtime.provider.model);
  const effectiveEffort = clampReasoningEffort(requestedEffort, capability, prompt, shouldUseTaskBoard(prompt));
  if (requestedEffort !== effectiveEffort) {
    runtime.ui.info(locale === 'zh'
      ? `当前模型不支持 ${requestedEffort} 推理，已调整为 ${effectiveEffort}`
      : `Model capability adjusted reasoning from ${requestedEffort} to ${effectiveEffort}`);
  }
  const resolvedToolScope = resolveToolScope({
    requested: runtime.toolScope ?? runtime.config.toolScope,
    reasoningEffort: effectiveEffort,
    prompt,
    shouldUseTaskBoard: shouldUseTaskBoard(prompt),
  });
  const activeTools = ToolRegistry.fromTools(selectScopedTools(runtime.allTools ?? runtime.tools, resolvedToolScope));
  runtime.tools = activeTools;
  runtime.resolvedToolScope = resolvedToolScope;

  // Inject spawn_subagent tool so the main agent can delegate sub-tasks.
  // Done here (post-scope-selection) so it is always available regardless of scope,
  // and after the runtime is fully assembled to avoid circular dependency issues.
  {
    const { createSpawnSubagentTool } = await import('../subagent/tool.js');
    runtime.tools.register(createSpawnSubagentTool(runtime), { replace: true });
  }

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
      // Inject memory block as first user message if available (step 0 only, to avoid re-injecting on loops).
      if (step === 0 && memoryBlock) {
        packed.messages.unshift({ 
          role: 'user', 
          content: `<relevant-project-memories>\n${memoryBlock}\n</relevant-project-memories>`,
          createdAt: new Date().toISOString(),
        });
      }
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
      const promptCacheBasis = buildPromptCacheBasis(packed.messages, runtime.tools.specs(), projectContext, toolStrategy);
      const predictedPromptCacheRate = predictPromptCacheReuse(runtime.lastPromptCacheBasis, promptCacheBasis);
      response = await runtime.provider.complete({
        messages: packed.messages,
        tools: runtime.tools.specs(),
        workspaceRoot: runtime.config.workspaceRoot,
        projectContext,
        toolStrategy,
        onTextDelta: (delta) => runtime.ui.assistantDelta(delta),
        reasoningEffort: effectiveEffort,
        desktopBridge: runtime.config.desktopBridge,
        customProvider: runtime.config.customProvider,
        continuation: runtime.session.providerContinuation,
      });
      // Accumulate the real token usage this step reported (if any).
      if (response.usage) {
        response.usage.localCachePredictedRate = predictedPromptCacheRate;
      }
      if (usageTotals && response.usage) {
        usageTotals.inputTokens += response.usage.inputTokens;
        usageTotals.outputTokens += response.usage.outputTokens;
        if (typeof response.usage.cacheReadTokens === 'number') {
          usageTotals.cacheReadTokens = (usageTotals.cacheReadTokens ?? 0) + response.usage.cacheReadTokens;
        }
        if (typeof response.usage.cacheCreationTokens === 'number') {
          usageTotals.cacheCreationTokens = (usageTotals.cacheCreationTokens ?? 0) + response.usage.cacheCreationTokens;
        }
        if (typeof predictedPromptCacheRate === 'number') {
          usageTotals.localCachePredictedRate = predictedPromptCacheRate;
        }
      }
      runtime.lastPromptCacheBasis = promptCacheBasis;
      // Emit a real per-turn context/cache snapshot so the desktop can show the
      // context-capacity breakdown and cache-hit-rate from genuine numbers.
      if (response.usage) {
        runtime.ui.contextStats(
          buildContextStats(runtime, packed, response.usage, projectContext, toolStrategy),
        );
      }
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
    const responseToolOutputs: Array<{ callId: string; output: string }> = [];
    let terminalCreateDone: { tool: string; output: string } | undefined;
    for (const action of response.actions) {
      if (action.type === 'message') {
        const card = maybeUpgradeMetaMessage(runtime, action.content, lastToolName, locale);
        const content = card ?? action.content;
        runtime.ui.assistant(content);
        await runtime.sessions.appendFinalAnswer(runtime.session, content);
        finalAnswer = content;
        continue;
      }

      // Model sometimes re-issues create_docx after it already succeeded — do not re-run.
      if (isDuplicateSuccessfulTool(runtime, action.tool, action.input)) {
        runtime.ui.info(
          locale === 'zh'
            ? `跳过重复工具 ${action.tool}（本轮已成功执行过相同操作）。`
            : `Skipping duplicate ${action.tool} (same call already succeeded this turn).`,
        );
        lastToolName = action.tool;
        sawTool = true;
        if (isTerminalCreateTool(action.tool)) {
          const prior = latestSuccessfulTool(runtime, action.tool);
          terminalCreateDone = { tool: action.tool, output: prior?.output ?? '' };
        }
        continue;
      }

      sawTool = true;
      lastToolName = action.tool;
      const toolResult = await executeToolAction(runtime, action, locale);
      if (action.callId) responseToolOutputs.push({ callId: action.callId, output: toolResult.output ?? toolResult.reason ?? '' });
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
      if (isTerminalCreateTool(action.tool)) {
        const prior = latestSuccessfulTool(runtime, action.tool);
        terminalCreateDone = { tool: action.tool, output: prior?.output ?? '' };
      }
    }

    if (response.continuation && responseToolOutputs.length > 0 && runtime.provider.name === 'openai-responses') {
      runtime.session.providerContinuation = {
        responseId: response.continuation.responseId,
        toolOutputs: responseToolOutputs,
      };
      await runtime.sessions.save(runtime.session);
    } else if (!sawTool && runtime.provider.name === 'openai-responses') {
      runtime.session.providerContinuation = undefined;
    }

    // create_docx / rename_file etc. already finished the user goal — stop looping.
    if (terminalCreateDone) {
      const message = formatTerminalCreateDone(terminalCreateDone, locale);
      runtime.ui.assistant(message);
      await runtime.sessions.appendFinalAnswer(runtime.session, message);
      return { ok: true, session: runtime.session, finalAnswer: message, outcome: 'done' };
    }

    if (!sawTool) {
      return {
        ok: true,
        session: runtime.session,
        finalAnswer,
        outcome: 'done',
      };
    }

    // If this step only ran tools and the model already emitted a final answer in the same
    // action list, prefer stopping rather than another provider round-trip.
    if (finalAnswer) {
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
    confirm: resolveToolConfirm(runtime),
    checkpoints: runtime.checkpoints,
    hooks: runtime.hooks,
    beforeConfirm: () => runtime.ui.pauseSpinnerForPrompt(),
    afterConfirm: () => runtime.ui.resumeSpinnerAfterPrompt(),
    networkAllowlist: runtime.config.network?.enabled === false ? [] : runtime.config.network?.allowlist,
    computerAnyApp: runtime.config.computerAnyApp === true,
    computerAllowedApps: runtime.config.allowedApps,
    locale,
  });
  runtime.ui.toolResult(action.tool, result);
  const recoveryHint = result.ok ? undefined : recoveryHintForToolFailure(action.tool, result.output);
  const successHint = result.ok ? nextStepHint(action.tool, result.output, result.output?.length ?? 0) : undefined;
  const hint = recoveryHint || successHint;
  const output = hint
    ? `${result.output}\n${locale === 'zh' ? (result.ok ? '建议' : '恢复提示') : (result.ok ? 'Hint' : 'Recovery hint')}: ${hint}`
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
    return { ok: true, output } as const;
  }
  return { ok: true, output } as const;
}

function resolveConfirm(runtime: AgentRuntime) {
  // Only the interactive REPL installs a confirm callback. Prompt/CI/smoke modes must
  // never block on stdin for git init or other safety confirmations.
  // The desktop bridge overrides `runtime.tools`-side confirm through ToolContext,
  // so this shim is only used for git-safety and task-board style confirms that
  // do not need structured approval requests.
  if (runtime.confirm) {
    return async (message: string, _request?: import('../tools/types.js').ApprovalRequest) =>
      runtime.confirm!(message);
  }
  if (runtime.config.noInput || runtime.config.prompt !== undefined || runtime.config.ci) return undefined;
  if (process.stdin.isTTY) {
    return async (message: string) => askForApproval(message, { locale: runtime.locale ?? 'en' });
  }
  return undefined;
}

/**
 * Resolve the confirm callback used for tool execution (ToolContext.confirm).
 * Prefers the structured `toolConfirm` if provided (e.g. desktop bridge),
 * otherwise falls back to the plain confirm shim.
 */
function resolveToolConfirm(runtime: AgentRuntime) {
  if (runtime.toolConfirm) {
    return runtime.toolConfirm;
  }
  return resolveConfirm(runtime);
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

// Load relevant project memories for this turn and render them as a context
// block. Returns undefined when there is no memory store or nothing relevant.
// Any failure is swallowed so a memory problem never breaks a turn.
async function loadMemoryBlock(runtime: AgentRuntime, prompt: string): Promise<string | undefined> {
  if (!runtime.memory) return undefined;
  try {
    const entries = await runtime.memory.list({ includeInactive: true });
    if (entries.length === 0) return undefined;
    const relevant = selectRelevantMemories({ entries, goal: prompt, limit: 5 });
    if (relevant.length === 0) return undefined;
    return formatMemories(relevant);
  } catch {
    return undefined;
  }
}

function buildPromptCacheBasis(
  messages: import('../providers/types.js').AgentMessage[],
  tools: import('../providers/types.js').ProviderToolSpec[],
  projectContext?: string,
  toolStrategy?: string,
): PromptCacheBasis {
  const stableParts = buildToolSystemPromptParts(tools, projectContext, toolStrategy);
  // The sliding breakpoint caches tools + system + ALL messages except the
  // last one (the newest message after the breakpoint is the only uncached
  // increment). Align the local prediction with that real cached range.
  const cachedMessages = messages.slice(0, -1);
  const messageBlock = cachedMessages.map((message) => {
    const parts = (message.parts ?? [])
      .map((part) => part.type === 'text' ? part.text : `[image:${part.mediaType}:${part.path ?? ''}]`)
      .join('');
    return `${message.role}|${message.name ?? ''}|${message.content}|${parts}`;
  }).join('\n');
  const stablePrefix = [stableParts.stable, messageBlock].filter(Boolean).join('\n===messages===\n');
  const lastMessageChars = messages.length > 0 ? JSON.stringify(messages[messages.length - 1]).length : 0;
  return { stablePrefix, totalChars: stablePrefix.length + lastMessageChars };
}

function predictPromptCacheReuse(previous: PromptCacheBasis | undefined, current: PromptCacheBasis): number | undefined {
  if (!previous || previous.totalChars <= 0 || current.totalChars <= 0) return undefined;
  const shared = commonPrefixLength(previous.stablePrefix, current.stablePrefix);
  if (shared <= 0) return 0;
  return Math.max(0, Math.min(1, shared / current.totalChars));
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

// The turn's reply already discusses the cache (e.g. a cache_probe answer), so
// a trailing low-cache note would just repeat it. Detect that to suppress the
// proactive hint.
function answerIsAboutCache(answer: string): boolean {
  const compact = answer.replace(/\s+/g, '');
  return /缓存命中|命中率|缓存探针|Cacheprobe|cachehit|hitrate|averagehitrate|缓存效率|缓存健康/i.test(compact);
}

// Attempt to auto-record a memory from the final answer of a successful turn.
// Only summaries that pass the usefulness / de-dup filters are persisted.
async function recordTurnMemory(runtime: AgentRuntime, finalAnswer: string): Promise<void> {
  if (!runtime.memory) return;
  const { isUsefulMemoryText, isDuplicateMemory } = await import('../memory/extract.js');
  const { deriveKeywords } = await import('../memory/store.js');
  const summary = finalAnswer.slice(0, 280).replace(/\s+/g, ' ').trim();
  if (!isUsefulMemoryText(summary)) return;
  const existing = await runtime.memory.list({ includeInactive: true });
  if (isDuplicateMemory(existing, summary)) return;
  // Lightweight kind classifier (mirrors extract.ts classifySuccessKind).
  const lower = summary.toLowerCase();
  const kind = /约定|convention|always use|必须使用/.test(lower) ? 'convention'
    : /use |must|never|不要|必须|prefer/.test(lower) ? 'decision'
    : 'note';
  await runtime.memory.add({ kind, summary, keywords: deriveKeywords(summary), source: { type: 'system' } });
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

/** Tools that complete a user-facing goal — do not keep calling the model after success. */
function isTerminalCreateTool(tool: string) {
  return tool === 'create_docx' || tool === 'rename_file';
}

function toolFingerprint(tool: string, input: unknown) {
  try {
    return `${tool}:${JSON.stringify(input ?? {})}`;
  } catch {
    return `${tool}:[unserializable]`;
  }
}

function isDuplicateSuccessfulTool(runtime: AgentRuntime, tool: string, input: unknown) {
  const needle = toolFingerprint(tool, input);
  for (let index = runtime.session.toolCalls.length - 1; index >= 0; index -= 1) {
    const call = runtime.session.toolCalls[index];
    if (!call || call.tool !== tool || !call.ok) continue;
    if (toolFingerprint(call.tool, call.input) === needle) return true;
    // Same create_docx path even if title/body differ slightly — still treat as done.
    if (isTerminalCreateTool(tool) && sameCreatePath(call.input, input)) return true;
  }
  return false;
}

function sameCreatePath(left: unknown, right: unknown) {
  const a = isRecord(left) && typeof left.path === 'string' ? left.path.replace(/\\/g, '/').toLowerCase() : '';
  const b = isRecord(right) && typeof right.path === 'string' ? right.path.replace(/\\/g, '/').toLowerCase() : '';
  return Boolean(a && b && a === b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatTerminalCreateDone(done: { tool: string; output: string }, locale: Locale) {
  const detail = done.output.trim();
  if (locale === 'zh') {
    if (done.tool === 'create_docx') {
      return detail
        ? `已完成：Word 文档创建成功。\n${detail}`
        : '已完成：Word 文档创建成功。';
    }
    return detail ? `已完成：${done.tool} 成功。\n${detail}` : `已完成：${done.tool} 成功。`;
  }
  if (done.tool === 'create_docx') {
    return detail ? `Done: Word document created.\n${detail}` : 'Done: Word document created.';
  }
  return detail ? `Done: ${done.tool} succeeded.\n${detail}` : `Done: ${done.tool} succeeded.`;
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

/**
 * Build a REAL per-turn context/cache snapshot for the desktop UI.
 *
 * Honesty contract:
 *   - `inputTokens`/`outputTokens`/`cache*Tokens` are the genuine numbers the
 *     provider API reported for this step (never estimated).
 *   - The per-category breakdown splits the real input-token total by the
 *     MEASURED character proportion of each actual prompt component (system
 *     prompt text, built-in tool schemas, MCP tool schemas, conversation
 *     messages). The total is real; the split is a measured proportion, not a
 *     guess. `skills` is 0 because the CLI has no skill layer today.
 *   - The desktop computes the context-window percentage and cache-hit-rate
 *     from these numbers against the model's known context window.
 */
function buildContextStats(
  runtime: AgentRuntime,
  packed: { messages: import('../providers/types.js').AgentMessage[] },
  usage: import('../providers/types.js').ProviderUsage,
  projectContext?: string,
  toolStrategy?: string,
): Record<string, unknown> {
  const specs = runtime.tools.specs();
  const specChars = (spec: { name: string; description: string; inputHint: string }) =>
    spec.name.length + spec.description.length + spec.inputHint.length + 8;

  const builtinChars = specs
    .filter((spec) => !spec.name.startsWith('mcp_'))
    .reduce((sum, spec) => sum + specChars(spec), 0);
  const mcpChars = specs
    .filter((spec) => spec.name.startsWith('mcp_'))
    .reduce((sum, spec) => sum + specChars(spec), 0);
  // Base system instructions WITHOUT the tool list (tools counted separately),
  // so no component is double-counted.
  const systemPromptChars = buildToolSystemPrompt([], undefined, undefined).length;
  const messageChars = packed.messages.reduce((sum, message) => {
    const partsChars = (message.parts ?? []).reduce(
      (acc, part) => acc + (part.type === 'text' ? part.text.length : 0),
      0,
    );
    return sum + message.content.length + (message.name?.length ?? 0) + message.role.length + 8 + partsChars;
  }, 0);
  const skillsChars = 0;
  // Project instructions/persona and per-turn strategy are real prompt content
  // but do not fit a named screenshot category; account for them as "other".
  const otherChars = (projectContext?.length ?? 0) + (toolStrategy?.length ?? 0);

  const measured = systemPromptChars + builtinChars + mcpChars + messageChars + skillsChars + otherChars;
  const input = usage.inputTokens;
  // Distribute the REAL input-token total across measured components by their
  // char proportion. "other" absorbs the remainder (rounding + any prompt bytes
  // not attributed to a named component).
  const share = (chars: number) => (measured > 0 ? Math.round((chars / measured) * input) : 0);
  const messages = share(messageChars);
  const systemTools = share(builtinChars);
  const mcpTools = share(mcpChars);
  const skills = share(skillsChars);
  const systemPrompt = share(systemPromptChars);
  // Start with the measured "other" component; then add any rounding remainder
  // so every real input token is represented exactly once.
  const measuredOther = share(otherChars);
  const attributed = messages + systemTools + mcpTools + skills + systemPrompt + measuredOther;
  const other = measuredOther + Math.max(0, input - attributed);
  const localCache = collectCacheProbe();

  return {
    provider: runtime.provider.name,
    model: runtime.provider.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    // Distinguish "provider explicitly reported 0" from "provider did not report
    // cache metrics" so the UI never presents missing data as a precise 0%.
    providerCacheReported: usage.cacheReadTokens !== undefined,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
    predictedPromptCacheRate: typeof usage.localCachePredictedRate === 'number'
      ? usage.localCachePredictedRate
      : null,
    localCache: {
      totalHits: localCache.totalHits,
      totalMisses: localCache.totalMisses,
      totalLookups: localCache.totalLookups,
      hitRate: localCache.averageHitRate,
      buckets: localCache.buckets,
    },
    categories: { messages, systemTools, mcpTools, skills, systemPrompt, other },
  };
}
