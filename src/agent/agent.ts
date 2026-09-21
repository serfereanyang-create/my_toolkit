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
import { withModelRetry } from '../providers/retry.js';
import { maybeAutoCompact } from './autoCompact.js';
import type { HookRegistry } from '../hooks/hooks.js';
import type { CheckpointStore } from '../session/checkpoint.js';
import type { SessionRecord, SessionStore } from '../session/store.js';
import type { McpManager } from '../mcp/manager.js';
import { ToolRegistry } from '../tools/registry.js';
import { limitProviderTools, resolveToolScope, selectScopedTools, type ToolScope, type ResolvedToolScope } from '../tools/scope.js';
import type { TerminalUI } from '../ui/terminal.js';
import { executeCommandPlan, extractCommand, formatCommandStrategy, planCommand } from './commandExtract/index.js';
import { formatProjectContext, readProjectContext } from './context.js';
import { formatMemories } from '../memory/format.js';
import { selectRelevantMemories } from '../memory/select.js';
import { compactMessagesForModel, resolveContextBudgetChars } from './contextBudget.js';
import { globalToolHealth } from './toolHealth.js';
import { buildToolSystemPrompt, buildToolSystemPromptParts } from '../providers/protocol.js';
import { planLocalFallback } from './fallback.js';
import { PLANNING_TURN_FINAL_CALL, PLANNING_TURN_INSTRUCTION, PLANNING_TURN_MAX_STEPS, shouldUseTaskBoard } from '../tasks/planner.js';
import { formatToolStrategy, planToolStrategy, recentToolResultsFromSession, recoveryHintForToolFailure, nextStepHint } from './toolStrategy.js';
import { detectLocale, resolveSessionLocale, type Locale } from '../i18n/locale.js';
import { isBlockedOutput } from '../i18n/messages.js';
import { formatResultCard, isMetaTranslatedDone } from '../ui/resultCard.js';
import { appendUsage, resolveUsageLogPath } from '../usage/ledger.js';
import { buildLowCacheHint, collectCacheProbe } from '../probe/cacheProbe.js';
import { MAX_SUBAGENT_DEPTH } from '../tools/subagent.js';
import type { SubAgentOptions } from '../tools/types.js';
import { getReasoningCapability, clampReasoningEffort } from '../providers/capabilities.js';
import { analyzeTaskComplexity } from '../tasks/complexity.js';
import { COMPUTER_USE_STRATEGY, computerUseShouldWake } from '../tools/computer.js';
import { Supervisor } from '../supervisor/supervisor.js';
import { AutoReviewGate, reviewAction } from '../safety/autoReview.js';

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
  lastPromptCacheBasis?: PromptCacheBasis;
  hooks?: HookRegistry;
  /**
   * Plain approval callback (REPL, git-safety, board-commit confirms). The
   * optional second argument carries the structured ApprovalRequest (incl. a
   * before/after diff) when the caller has one, so interactive UIs can render
   * a real Codex-style diff instead of prose-only text. Return stays boolean
   * for backward compatibility; desktop allow_session flows via toolConfirm.
   */
  confirm?: (
    message: string,
    request?: import('../tools/types.js').ApprovalRequest,
  ) => Promise<boolean>;
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
  commandJobs?: import('../safety/commandJobs.js').CommandJobService;
  /** Project memory store (.aicode/memory) for cross-session recall. */
  memory?: import('../memory/store.js').ProjectMemoryStore;
  /** Reflexion store (.aicode/reflections.json): terminal-failure lessons. */
  reflections?: import('../reflection/store.js').ReflectionStore;
  /**
   * Automation manager shared across /automate slash commands in this session.
   * Created lazily so watcher/git/cron resources live as long as the runtime
   * and are released when the runtime is closed.
   */
  automationManager?: import('../automation/manager.js').AutomationManager;
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
   * Monotonic floor for the session's tool scope. Once a turn needs the write
   * tools, later turns keep them even when their phrasing looks small.
   *
   * Kept separate from `resolvedToolScope` on purpose: expert routing (see
   * tasks/runtime.ts) temporarily overwrites `resolvedToolScope` for its own
   * task and restores it afterwards, so using that field as the floor would let
   * a task-board expert lower the session floor by accident.
   */
  sessionToolScopeFloor?: ResolvedToolScope;
  /**
   * True for the current turn when the computer-control tools are live:
   * either the session armed them via `/computer use`, or full access
   * (approval 'auto') + desktop "任意应用" lets the agent self-wake.
   */
  computerUseActive?: boolean;
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
  /**
   * The user's original request for the planning turn currently in flight.
   *
   * `propose_plan` reads it to record the board's `goal`. The tool cannot
   * recover it any other way: during a planning turn the prompt is a planning
   * instruction, not the user's words, and the goal must be the user's.
   */
  planGoal?: string;
  /**
   * Set by `propose_plan` when it persists a board. The planning turn reads it
   * to decide whether the model planned or whether to fall back to the
   * template. A board id is not a usable signal here: revising a plan reuses
   * the session's existing draft board id.
   */
  planProposed?: boolean;
  /**
   * Injected by the desktop bridge to surface subagent runs in the 子智能体
   * directory (running / finished). Emitted by runSubAgent at start and at
   * completion; the terminal UI is unaffected because the hook is optional and
   * embedding-layer only.
   */
  subagentEmit?: (payload: {
    phase: 'started' | 'done';
    id: string;
    goal: string;
    expert: string;
    ok?: boolean;
    answer?: string;
    /** The subagent's own session id (distinct from the parent session). */
    subSessionId?: string;
    durationMs?: number;
    steps?: number;
  }) => void;
  /**
   * Injected by the desktop bridge to surface a finished code review as
   * structured findings, so the 审查 tab can render P0-P3 groups with
   * click-to-jump instead of parsing the transcript. The review itself is
   * recorded in session history regardless (review/writeback.ts); this hook is
   * only how the renderer hears about it while the session is live.
   */
  reviewEmit?: (payload: {
    /** What was reviewed, as shown to the user. */
    label: string;
    ok: boolean;
    /** Present when the review could not run. */
    error?: string;
    /** True when the reply did not match the rubric's schema. */
    unparsed?: boolean;
    findings: Array<{
      title: string;
      body: string;
      priority?: number;
      confidenceScore?: number;
      filePath?: string;
      lineStart?: number;
      lineEnd?: number;
    }>;
    outcome?: 'correct' | 'incorrect' | 'unknown';
    explanation?: string;
    /** The sub-session the review ran in, for drill-down. */
    subSessionId?: string;
    durationMs?: number;
  }) => void;
  compactEmit?: (payload: {
    phase: 'started' | 'completed' | 'failed';
    auto: boolean;
    before?: number;
    after?: number;
    reason?: string;
  }) => void;
  /**
   * Cooperative-cancel predicate. Set by the desktop bridge (or any embedding
   * loop) on the `cancel` command; the agent loop polls it at safe boundaries
   * (between steps, before a model call / tool execution) and aborts the turn
   * with a CancelledError. A running tool call is never interrupted — the turn
   * stops at the next checkpoint.
   */
  cancelRequested?: () => boolean;
  /**
   * Aggregates every unit of work in this session (subagents, board tasks,
   * turns) so a caller can answer "what is running and is any of it stuck"
   * without joining three event streams by hand. Created lazily by
   * `supervisorFor`; the CLI runs unchanged when nobody reads it.
   */
  supervisor?: import('../supervisor/supervisor.js').Supervisor;
  /**
   * Called whenever the supervisor's state changes, so an embedding layer can
   * push an aggregate progress snapshot to its UI. Optional and embedding-only:
   * the terminal CLI never sets it.
   */
  supervisorEmit?: () => void;
  /**
   * Model round-trips the most recent turn made.
   *
   * Written by the agent loop rather than returned from it: the loop has eight
   * return paths, and a caller that needs the count (rollover does) must not
   * depend on all eight remembering to set it.
   */
  lastTurnSteps?: number;
  /**
   * Denial-streak state for the auto-reviewer.
   *
   * On the runtime rather than a local, because the reviewer is consulted from
   * `executeToolAction` — a different function from the loop that owns the turn.
   */
  autoReviewGate?: AutoReviewGate;
};

/**
 * The runtime's supervisor, created on first use.
 *
 * Lazily created so a plain CLI session pays nothing for a surface only the
 * embedding layers read.
 */
export function supervisorFor(runtime: AgentRuntime): import('../supervisor/supervisor.js').Supervisor {
  if (!runtime.supervisor) {
    runtime.supervisor = new Supervisor();
    // Wired once, at creation: every later mutation notifies without the call
    // sites having to remember.
    const emit = runtime.supervisorEmit;
    if (emit) runtime.supervisor.onChange = () => emit();
  }
  return runtime.supervisor;
}

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
  /**
   * Model round-trips this turn actually made.
   *
   * Reported by the loop because callers cannot derive it: counting assistant
   * messages undercounts a tool-only run (a segment that makes three tool calls
   * and stops on budget leaves one message), which is exactly the number a
   * rollover decision needs to be right about.
   */
  steps?: number;
  /**
   * Whether the turn changed anything: it ran at least one tool.
   *
   * `ok` means "the loop ended without an error" — a model that answers a
   * question, or declines a request, sets `ok` while doing no work at all.
   * Callers that need to tell "done" from "nothing happened" must read this
   * rather than inferring from `ok`.
   */
  producedActivity?: boolean;
};

/** Thrown at a safe boundary when the user requested cancel via runtime.cancelRequested. */
export class CancelledError extends Error {
  constructor(message = 'cancelled by user') {
    super(message);
    this.name = 'AgentCancelledError';
  }
}

/** Abort the turn at the current checkpoint when a cancel was requested. */
export function throwIfCancelled(runtime: AgentRuntime): void {
  if (runtime.cancelRequested?.()) throw new CancelledError();
}

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
  // Correlation fields for the usage ledger: turn identity, tool activity,
  // and task-board linkage make per-session/per-task drill-down possible.
  const turnId = `turn_${randomUUID().slice(0, 8)}`;
  const turnStartedAt = Date.now();
  const toolCallsBefore = runtime.session.toolCalls.length;
  await runtime.sessions.setLastTurn(runtime.session, {
    prompt,
    ...(options.displayText !== undefined ? { displayText: options.displayText } : {}),
    ...(options.parts !== undefined ? { parts: options.parts } : {}),
    status: 'running',
    startedAt: new Date(turnStartedAt).toISOString(),
  });

  let coreResult: AgentTurnResult = { ok: true, session: runtime.session, outcome: 'done' };
  let thrown: unknown;
  try {
    coreResult = await runAgentTurnCore(runtime, prompt, options, usageTotals);
  } catch (error) {
    thrown = error;
    if (error instanceof CancelledError) {
      // A user cancel is NOT a terminal failure: no fallback/recover, no
      // "failed" record. Tools that already ran keep their results in the
      // session; /retry replays the same prompt fresh. It also completes the
      // turn normally (outcome 'cancelled') — do not rethrow to callers.
      thrown = undefined;
      coreResult = {
        ok: false,
        session: runtime.session,
        reason: 'cancelled by user',
        outcome: 'cancelled',
        hadTerminalFailure: false,
      };
    } else {
      coreResult = {
        ok: false,
        session: runtime.session,
        reason: error instanceof Error ? error.message : String(error),
        outcome: 'failed',
        hadTerminalFailure: true,
      };
    }
  }

  // Codex-style per-turn footer (real context/cache numbers from the last
  // contextStats snapshot). Runs for ok/failed/cancelled turns alike.
  runtime.ui.turnEnd();

  /**
   * Did this turn actually change anything?
   *
   * Modelled on codex's per-turn activity accounting
   * (codex-rs/ext/goal/src/accounting.rs): a turn is "active" when it ran a tool
   * or wrote files. A turn that only produced prose is not.
   *
   * This exists because `ok: true` means "the loop ended without an error", not
   * "the work was done" — codex's own `TurnStatus::Completed` is an
   * execution-liveness status and its TUI says "done" for a turn that ran no
   * tools at all. Reporting that as 任务完成 tells the user something false, so
   * the distinction is tracked explicitly rather than inferred from `ok`.
   */
  const toolCallsThisTurn = runtime.session.toolCalls.length - toolCallsBefore;
  const producedActivity = toolCallsThisTurn > 0;

  // Persist the final lifecycle status of the replayed payload. The payload
  // itself (prompt/parts) is kept so /retry can replay the same user turn.
  try {
    await runtime.sessions.setLastTurn(runtime.session, {
      prompt,
      ...(options.displayText !== undefined ? { displayText: options.displayText } : {}),
      ...(options.parts !== undefined ? { parts: options.parts } : {}),
      status: coreResult.ok ? 'done' : 'failed',
      startedAt: new Date(turnStartedAt).toISOString(),
    });
  } catch { /* status persistence is best-effort */ }

  if (usageTotals.inputTokens > 0 || usageTotals.outputTokens > 0) {
    const newToolCalls = runtime.session.toolCalls.slice(toolCallsBefore);
    const toolsUsed = [...new Set(newToolCalls.map((call) => call.tool))].slice(0, 12);
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
      turnId,
      toolCalls: newToolCalls.length,
      ...(toolsUsed.length > 0 ? { toolsUsed } : {}),
      // Which tool surface this turn actually sent. The tool array sits inside
      // the cached prompt prefix, so this is the field that explains a bad hit
      // rate: a changing toolCount between turns means the cache died at byte 0.
      ...(runtime.resolvedToolScope ? { toolScope: runtime.resolvedToolScope } : {}),
      ...(runtime.tools ? { toolCount: runtime.tools.list().length } : {}),
      ...(options.gitSafetyUnit?.request.kind === 'task'
        ? { boardId: options.gitSafetyUnit.request.boardId, taskId: options.gitSafetyUnit.request.taskId }
        : {}),
      durationMs: Date.now() - turnStartedAt,
    });
  }

  // Auto-record memory from successful turns. Failures to write are
  // swallowed so a memory problem never breaks turn delivery.
  if (runtime.memory && coreResult.ok && coreResult.finalAnswer) {
    recordTurnMemory(runtime, coreResult.finalAnswer).catch(() => {});
  }

  // Reflexion: terminal failures (exception or max-steps exhaustion) become a
  // structured lesson in .aicode/reflections.json so future similar tasks can
  // avoid repeating the same mistake. User cancels are NOT failures — no lesson.
  if (coreResult.hadTerminalFailure && coreResult.outcome === 'failed') {
    recordTurnReflection(runtime, prompt, coreResult).catch(() => {});
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
  return { ...coreResult, gitSafety, steps: runtime.lastTurnSteps, producedActivity };
}

async function runAgentTurnCore(
  runtime: AgentRuntime,
  prompt: string,
  options: AgentTurnOptions = {},
  usageTotals?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; localCachePredictedRate?: number },
): Promise<AgentTurnResult> {
  // codex turn.rs:1231-1260 — pre-turn auto-compact fires BEFORE the new user
  // input enters history, when the conversation nears the context window.
  await maybeAutoCompact(runtime);
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
  // Skills layer (.aicode/skills/<name>/SKILL.md): scan + trigger-match against
  // the task prompt; matched instructions are injected alongside memories at
  // step 0. Failures here must never break a turn.
  const skillBlock = await loadSkillBlock(runtime, prompt);
  // Reflexion: recall lessons from past terminal failures on similar tasks.
  const reflectionBlock = await loadReflectionBlock(runtime, prompt);
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
  // Computer use: two wake paths, decided per turn.
  // 1) Explicit: the user armed this session via `/computer use` (persisted on
  //    the session record) — tools available under normal approval gating.
  // 2) Auto: full access (approval 'auto') + desktop "任意应用" — the agent may
  //    wake computer control on its own whenever a task needs the GUI.
  runtime.computerUseActive = computerUseShouldWake({
    approval: runtime.config.approval,
    computerAnyApp: runtime.config.computerAnyApp === true,
    sessionArmed: runtime.session.computerUse === true,
  });
  const baseToolStrategy = formatCommandStrategy(commandPlan, extraction)
    || formatToolStrategy(planToolStrategy({
      prompt,
      recentTools,
      workspaceRoot: runtime.config.workspaceRoot,
    }));
  const toolStrategy = runtime.computerUseActive
    ? [baseToolStrategy, COMPUTER_USE_STRATEGY].filter(Boolean).join('\n')
    : baseToolStrategy;
  const requestedEffort = runtime.reasoningEffort ?? runtime.config.reasoningEffort ?? 'off';
  const capability = getReasoningCapability(runtime.provider.name, runtime.provider.model);
  const taskComplexity = analyzeTaskComplexity(prompt);
  const taskBoard = taskComplexity.complexity === 'large';
  const effectiveEffort = clampReasoningEffort(requestedEffort, capability, prompt, taskBoard);
  if (requestedEffort !== effectiveEffort) {
    runtime.ui.info(locale === 'zh'
      ? `当前模型不支持 ${requestedEffort} 推理，已调整为 ${effectiveEffort}`
      : `Model capability adjusted reasoning from ${requestedEffort} to ${effectiveEffort}`);
  }
  const resolvedToolScope = resolveToolScope({
    requested: runtime.toolScope ?? runtime.config.toolScope,
    reasoningEffort: effectiveEffort,
    prompt,
    shouldUseTaskBoard: taskBoard,
    // The floor is what keeps the tool array — and therefore the cached prompt
    // prefix — stable across turns. See resolveToolScope for why that matters.
    previousScope: runtime.sessionToolScopeFloor,
  });
  runtime.sessionToolScopeFloor = resolvedToolScope;
  const scopedTools = selectScopedTools(runtime.allTools ?? runtime.tools, resolvedToolScope);
  const activeTools = ToolRegistry.fromTools(scopedTools);
  runtime.tools = activeTools;
  runtime.resolvedToolScope = resolvedToolScope;

  // Tools registered below are injected AFTER scope selection, so they are not
  // in the scoped set. Record their names to keep them off the trim list.
  const injectedToolNames: string[] = [];

  // Inject the computer-control tools post-scope so they exist regardless of
  // tool scope, mirroring the spawn_subagent pattern below.
  if (runtime.computerUseActive) {
    const { createComputerTools } = await import('../tools/computer.js');
    for (const tool of createComputerTools()) {
      runtime.tools.register(tool, { replace: true });
      injectedToolNames.push(tool.name);
    }
  }

  // Inject spawn_subagent tool so the main agent can delegate sub-tasks.
  // Done here (post-scope-selection) so it is always available regardless of scope,
  // and after the runtime is fully assembled to avoid circular dependency issues.
  {
    const { createSpawnSubagentTool } = await import('../subagent/tool.js');
    const tool = createSpawnSubagentTool(runtime);
    runtime.tools.register(tool, { replace: true });
    injectedToolNames.push(tool.name);
  }
  // review_loop (executor→reviewer→revise supervisor loop) for the root agent only;
  // sub-agents must not nest review loops.
  if ((runtime.subAgentDepth ?? 0) === 0) {
    const { createReviewLoopTool } = await import('../subagent/reviewLoopTool.js');
    const tool = createReviewLoopTool(runtime);
    runtime.tools.register(tool, { replace: true });
    injectedToolNames.push(tool.name);
  }
  // propose_plan lets the model write the plan document for a large task instead
  // of the hardcoded template in tasks/planner.ts. Injected post-scope for the
  // same reason as spawn_subagent: the planning turn must be able to call it at
  // any tool scope. Root agent only — a sub-agent works inside an existing plan.
  if ((runtime.subAgentDepth ?? 0) === 0) {
    const { createProposePlanTool } = await import('../tasks/proposeTool.js');
    const tool = createProposePlanTool(runtime);
    runtime.tools.register(tool, { replace: true });
    injectedToolNames.push(tool.name);
  }
  // Supervisor + PR tools. Root agent only: a sub-agent reports INTO the
  // supervisor rather than querying it, and must not open PRs of its own.
  if ((runtime.subAgentDepth ?? 0) === 0) {
    const { createOpenPullRequestTool, createSupervisorStatusTool } = await import('../tools/supervisorTools.js');
    for (const tool of [createSupervisorStatusTool(runtime), createOpenPullRequestTool(runtime)]) {
      runtime.tools.register(tool, { replace: true });
      injectedToolNames.push(tool.name);
    }
  }

  // Cap LAST, after every injection above. Capping before the injections let the
  // post-scope tools push the serialized array back over the provider ceiling —
  // the exact 400 this cap exists to prevent. Those injected tools are the ones
  // the agent cannot work without, so they are protected from trimming.
  const limited = limitProviderTools(runtime.tools.list(), {
    protectedNames: new Set(injectedToolNames),
  });
  if (limited.dropped.length > 0) {
    runtime.ui.info(locale === 'zh'
      ? `工具数超过端点上限，本轮发送 ${limited.tools.length} 个（省略 ${limited.dropped.length} 个插件/MCP 工具）`
      : `Tool count exceeds the endpoint limit; sending ${limited.tools.length} this turn (${limited.dropped.length} plugin/MCP tools omitted)`);
    runtime.tools = ToolRegistry.fromTools(limited.tools);
  }

  const planningBlock = runtime.planGoal ? PLANNING_TURN_INSTRUCTION : undefined;
  // A planning turn keeps a small cap — that cap is about producing a plan
  // promptly, not about bounding the work. An explicit --max-steps still lowers
  // it further.
  const planningStepBudget = planningBlock
    ? Math.min(runtime.config.maxSteps ?? PLANNING_TURN_MAX_STEPS, PLANNING_TURN_MAX_STEPS)
    : undefined;
  /**
   * Model round-trips allowed this turn. `undefined` means unlimited, which is
   * the default: a fixed step count cuts real work off mid-task and reports it
   * as a failure, and the reference implementation (codex-rs) has no such cap —
   * its turn ends when the model stops calling tools.
   */
  const stepBudget = planningBlock ? planningStepBudget : runtime.config.maxSteps;
  /**
   * The real safety bound, when the user sets one. It caps spend rather than
   * iteration count, so a long task that is making progress is never stopped by
   * arithmetic. Usage is summed across the turn's model calls.
   */
  const tokenBudget = runtime.config.maxTokens;
  let spentTokens = 0;
  // On the final budgeted step of a planning turn the read tools are withdrawn,
  // leaving propose_plan as the only tool that can advance the turn. Nudging in
  // prose was not enough: a model mid-survey reads the nudge as one more thing
  // to investigate and keeps calling read_file until the budget is gone.
  const planningOnlyTools = planningBlock
    ? ToolRegistry.fromTools(runtime.tools.list().filter((tool) => tool.name === 'propose_plan'))
    : undefined;

  let finalAnswer: string | undefined;
  let warnedAboutCompaction = false;
  let lastToolName: string | undefined;
  let stoppedBy: 'steps' | 'tokens' | undefined;
  /** Model round-trips actually made, reported to the caller on every exit. */
  let stepsTaken = 0;
  // A new turn gets a fresh denial streak: the limit exists to stop a bad plan
  // from stalling, not to mute the reviewer for the rest of the session.
  runtime.autoReviewGate = new AutoReviewGate();
  for (let step = 0; stepBudget === undefined || step < stepBudget; step += 1) {
    throwIfCancelled(runtime);
    if (tokenBudget !== undefined && spentTokens >= tokenBudget) {
      stoppedBy = 'tokens';
      break;
    }
    // Last budgeted step, still nothing proposed: withdraw everything except
    // propose_plan so the only way forward is to write the plan.
    const lastCall = planningStepBudget !== undefined
      && step === planningStepBudget - 1
      && !runtime.planProposed;
    const stepTools = lastCall && planningOnlyTools ? planningOnlyTools : runtime.tools;
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
      if (step === 0 && skillBlock) {
        packed.messages.unshift({
          role: 'user',
          content: skillBlock,
          createdAt: new Date().toISOString(),
        });
      }
      if (step === 0 && reflectionBlock) {
        packed.messages.unshift({
          role: 'user',
          content: reflectionBlock,
          createdAt: new Date().toISOString(),
        });
      }
      // Planning turn: the instruction rides on the newest user message, i.e.
      // AFTER the sliding cache breakpoint. Putting it in the system prompt
      // instead would change the cached prefix for every later turn.
      if (step === 0 && planningBlock && packed.messages.length > 0) {
        const last = packed.messages[packed.messages.length - 1]!;
        if (last.role === 'user') {
          packed.messages[packed.messages.length - 1] = {
            ...last,
            content: `${last.content}\n\n${planningBlock}`,
          };
        }
      }
      // Last call: the budget is nearly gone and the model has not proposed.
      // Appending here (rather than trusting the opening instruction) is what
      // makes the cap a guarantee instead of a hope.
      if (lastCall) {
        packed.messages.push({
          role: 'user',
          content: PLANNING_TURN_FINAL_CALL,
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
      const promptCacheBasis = buildPromptCacheBasis(packed.messages, stepTools.specs(), projectContext, toolStrategy);
      const predictedPromptCacheRate = predictPromptCacheReuse(runtime.lastPromptCacheBasis, promptCacheBasis);
      // Counted before the call: a model round-trip that throws still happened,
      // and a budget that ignores failed attempts would be a budget that leaks.
      // Published on the runtime as we go so every return path reports it.
      stepsTaken += 1;
      runtime.lastTurnSteps = stepsTaken;
      // codex-rs two-tier retry collapsed onto the single complete() entry:
      // transport-class failures (5xx/network/timeout) back off exponentially
      // and re-issue the whole request; 429/4xx and user cancels propagate.
      response = await withModelRetry(
        () => runtime.provider.complete({
          messages: packed.messages,
          tools: stepTools.specs(),
          workspaceRoot: runtime.config.workspaceRoot,
          projectContext,
          toolStrategy,
          onTextDelta: (delta) => runtime.ui.assistantDelta(delta),
          onThinkingDelta: (delta) => runtime.ui.thinkingDelta(delta),
          reasoningEffort: effectiveEffort,
          desktopBridge: runtime.config.desktopBridge,
          customProvider: runtime.config.customProvider,
          continuation: runtime.session.providerContinuation,
        }),
        {
          onRetry: (attempt, maxRetries, delayMs, error) => {
            runtime.ui.info(`Reconnecting… ${attempt}/${maxRetries} (${delayMs}ms) — ${error instanceof Error ? error.message : String(error)}`);
          },
        },
      );
      // Accumulate the real token usage this step reported (if any).
      if (response.usage) {
        response.usage.localCachePredictedRate = predictedPromptCacheRate;
        // Counted for the turn's token budget. Input tokens dominate on a long
        // run (the whole history is resent each step), which is exactly the
        // spend a step cap was a crude proxy for.
        spentTokens += response.usage.inputTokens + response.usage.outputTokens;
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
          const execution = await executeToolAction(runtime, action, locale);
          await appendToolActionResult(runtime, execution);
          if (!execution.ok) {
            // Never invent a generic reason: `output` is what the tool actually
            // said, and dropping it leaves the user with a bare "tool failed".
            const reason = execution.reason ?? execution.output ?? `工具 ${action.tool} 执行失败（未返回说明）`;
            return {
              ok: false,
              session: runtime.session,
              reason,
              finalAnswer: reason,
              hadTerminalFailure: true,
              outcome: execution.outcome ?? 'failed',
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
    for (let actionIndex = 0; actionIndex < response.actions.length; actionIndex += 1) {
      const action = response.actions[actionIndex]!;
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

      // Only an explicit parallelSafe marker opts a tool into a parallel read batch.
      // In particular, risk=read alone is not sufficient because some read tools
      // populate repository/navigation/semantic caches as part of execution.
      const batch: Array<Extract<AgentAction, { type: 'tool' }>> = [action];
      if (isParallelSafeAction(runtime, action)) {
        while (actionIndex + batch.length < response.actions.length) {
          const next = response.actions[actionIndex + batch.length];
          if (!isParallelSafeAction(runtime, next) || isDuplicateSuccessfulTool(runtime, next.tool, next.input)) break;
          batch.push(next);
        }
      }

      // On the final planning step the model may still name a withdrawn tool
      // (providers echo a stale tool list). Refuse it here rather than running
      // it: the tool array is the contract, and executing something it does not
      // contain would silently reopen the survey the cap exists to close.
      if (lastCall && batch.some((item) => item.tool !== 'propose_plan')) {
        for (const item of batch) {
          if (item.tool === 'propose_plan') continue;
          const refusal = `工具 ${item.tool} 在计划提交阶段不可用。请调用 propose_plan 提交计划。`;
          await runtime.sessions.appendToolCall(runtime.session, {
            tool: item.tool,
            input: item.input,
            ok: false,
            output: refusal,
            providerCallId: item.callId,
          });
          if (item.callId) responseToolOutputs.push({ callId: item.callId, output: refusal });
        }
        batch.splice(0, batch.length, ...batch.filter((item) => item.tool === 'propose_plan'));
        if (batch.length === 0) continue;
      }

      sawTool = true;
      const executions = batch.length > 1
        ? await Promise.all(batch.map((item) => executeToolAction(runtime, item, locale)))
        : [await executeToolAction(runtime, action, locale)];
      for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
        const batchAction = batch[batchIndex]!;
        const toolResult = await appendToolActionResult(runtime, executions[batchIndex]!);
        lastToolName = batchAction.tool;
        if (batchAction.callId) responseToolOutputs.push({ callId: batchAction.callId, output: toolResult.output ?? toolResult.reason ?? '' });
        if (!toolResult.ok) {
          const reason = toolFailureReason(toolResult, batchAction.tool, locale);
          return {
            ok: false,
            session: runtime.session,
            reason,
            finalAnswer: reason,
            hadTerminalFailure: true,
            outcome: toolResult.outcome ?? 'failed',
          };
        }
        if (isTerminalCreateTool(batchAction.tool)) {
          const prior = latestSuccessfulTool(runtime, batchAction.tool);
          terminalCreateDone = { tool: batchAction.tool, output: prior?.output ?? '' };
        }
      }
      actionIndex += batch.length - 1;
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

  // Falling out of the loop means a budget the user explicitly set was hit.
  // With no budget configured the loop cannot reach here — it exits from one of
  // the returns above — so this path never invents a limit that does not exist.
  const message = stoppedBy === 'tokens'
    ? `Stopped after reaching the token budget (${tokenBudget} tokens).`
    : `Stopped after reaching max steps (${stepBudget ?? runtime.config.maxSteps}).`;
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

type ToolActionExecution = {
  ok: boolean;
  output: string;
  reason?: string;
  outcome?: GitUnitOutcome;
  terminal?: boolean;
  record: {
    tool: string;
    input: unknown;
    ok: boolean;
    output: string;
    data?: unknown;
    providerCallId?: string;
    /** Multimodal parts (screenshots) attached to the tool message. */
    parts?: import('../providers/types.js').MessagePart[];
  };
};

/**
 * computer_screenshot returns the PNG as base64 in `data.computerImage`; turn
 * it into an image part so the model actually sees the screen on the next
 * step. Only the CURRENT turn's screenshot is kept — stripHistoricalImages
 * removes older ones to bound token cost.
 */
function computerScreenshotImageParts(tool: string, result: { ok: boolean; data?: unknown }): import('../providers/types.js').MessagePart[] | undefined {
  if (tool !== 'computer_screenshot' || result.ok !== true) return undefined;
  const data = result.data as { computerImage?: { mediaType?: unknown; data?: unknown; path?: unknown } } | undefined;
  const image = data?.computerImage;
  if (!image || typeof image.mediaType !== 'string' || typeof image.data !== 'string' || !image.data) return undefined;
  return [
    { type: 'text', text: typeof image.path === 'string' ? `[screenshot ${image.path}]` : '[screenshot]' },
    { type: 'image', mediaType: image.mediaType, data: image.data, path: typeof image.path === 'string' ? image.path : undefined },
  ];
}

async function executeToolAction(
  runtime: AgentRuntime,
  action: Extract<AgentAction, { type: 'tool' }>,
  locale: Locale = 'en',
): Promise<ToolActionExecution> {
  // Circuit breaker: a tool still cooling down from repeated failures is
  // refused without execution, and the model is told to route around it.
  if (globalToolHealth.inCooldown(action.tool)) {
    const message = globalToolHealth.cooldownMessage(action.tool);
    runtime.ui.toolStart(action.tool, action.input);
    runtime.ui.toolResult(action.tool, { ok: false, output: message });
    const record = { tool: action.tool, input: action.input, ok: false, output: message, providerCallId: action.callId };
    // `reason` is set, not left for the caller to invent: an error surfaced to
    // the user must always say what went wrong.
    return { ok: false, output: message, reason: message, record };
  }
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
    commandJobs: runtime.commandJobs,
    computerAnyApp: runtime.config.computerAnyApp === true,
    computerAllowedApps: runtime.config.allowedApps,
    computerUse: runtime.computerUseActive === true,
    locale,
    // Auto-review: consult a second model call instead of prompting the user,
    // but only for actions the policy layer already decided to prompt for. The
    // registry calls this strictly after its hard-deny branch, so a blocked
    // command can never be revived here. Gated per turn so a reviewer that keeps
    // denying stops being asked.
    autoReview: runtime.config.autoReview === true
      ? async (request) => {
          // Fresh streak per turn: the limit is about a run of refusals within
          // one plan, not a lifetime count that would eventually mute the
          // reviewer forever.
          const gate = runtime.autoReviewGate ?? (runtime.autoReviewGate = new AutoReviewGate());
          if (!gate.shouldConsult(request, true)) {
            return { decision: 'abstain', reason: `自动审核已连续拒绝 ${gate.denialCount} 次，改为询问用户` };
          }
          const decision = await reviewAction(runtime, request, {
            recentContext: latestUserRequest(runtime),
          });
          gate.record(decision);
          // Surfaced to the user as a log line: an action that ran without a
          // prompt must still be visible, or "auto-reviewed" is indistinguishable
          // from "silently allowed".
          if (decision.decision === 'allow') {
            runtime.ui.info(`自动审核允许 ${request.tool}：${decision.rationale}`);
          } else if (decision.decision === 'deny') {
            runtime.ui.info(`自动审核拒绝 ${request.tool}：${decision.rationale}`);
          }
          return decision;
        }
      : undefined,
    // Only the root agent may launch workflow task nodes as sub-agents; a
    // workflow running inside a sub-agent must not nest further.
    subAgentRunner: (runtime.subAgentDepth ?? 0) === 0 && runtime.runSubAgentTurn
      ? async (goal, options) => {
          const { runSubAgent, expertIdForSubAgentRequest } = await import('../subagent/runner.js');
          const result = await runSubAgent(
            {
              id: 'wf-' + randomUUID().slice(0, 6),
              goal,
              // `readonly` selects the read-only expert, whose toolFilter is
              // the boundary that makes the flag real.
              expert: expertIdForSubAgentRequest(options),
              ...(options?.maxSteps ? { maxSteps: options.maxSteps } : {}),
            },
            runtime,
            new Map(),
          );
          if (!result.ok) throw new Error(result.answer);
          return result.answer;
        }
      : undefined,
  });
  // Feed the circuit breaker with this attempt's outcome (success resets the
  // consecutive-failure counter; failures accumulate toward a cooldown trip).
  globalToolHealth.observe(action.tool, result.ok === true);
  runtime.ui.toolResult(action.tool, result);
  const recoveryHint = result.ok ? undefined : recoveryHintForToolFailure(action.tool, result.output);
  const successHint = result.ok ? nextStepHint(action.tool, result.output, result.output?.length ?? 0) : undefined;
  const hint = recoveryHint || successHint;
  const output = hint
    ? `${result.output}\n${locale === 'zh' ? (result.ok ? '建议' : '恢复提示') : (result.ok ? 'Hint' : 'Recovery hint')}: ${hint}`
    : result.output;
  const screenshotParts = computerScreenshotImageParts(action.tool, result);
  const record = {
    tool: action.tool,
    input: action.input,
    ok: result.ok,
    output,
    data: result.data,
    providerCallId: action.callId,
    // A fresh screenshot rides to the model as a multimodal image part on the
    // tool message (see appendToolActionResult → SessionStore.appendToolCall).
    ...(screenshotParts ? { parts: screenshotParts } : {}),
  };
  if (!result.ok) {
    const reason = locale === 'zh'
      ? `在 ${action.tool} 失败后停止：${output}`
      : `Stopped after ${action.tool} failed: ${output}`;
    if (isTerminalToolFailure(result.output)) {
      return {
        ok: false,
        output,
        reason,
        outcome: classifyTerminalFailure(result.output),
        terminal: true,
        record,
      };
    }
    // Recoverable failure: the turn continues, but the user still has to be
    // told what went wrong — the tool's own output is the only useful part.
    const failureDetail = result.output?.trim() || (locale === 'zh' ? '未返回说明' : 'no output');
    runtime.ui.info(
      recoveryHint
        ? (locale === 'zh' ? `工具 ${action.tool} 失败：${failureDetail}；恢复提示：${recoveryHint}` : `${action.tool} failed: ${failureDetail}; recovery hint: ${recoveryHint}`)
        : (locale === 'zh' ? `工具 ${action.tool} 失败：${failureDetail}；交给模型继续恢复` : `${action.tool} failed: ${failureDetail}; asking model to recover`),
    );
    return { ok: true, output, record };
  }
  return { ok: true, output, record };
}

async function appendToolActionResult(
  runtime: AgentRuntime,
  execution: ToolActionExecution,
) {
  await runtime.sessions.appendToolCall(
    runtime.session,
    {
      tool: execution.record.tool,
      input: execution.record.input,
      ok: execution.record.ok,
      output: execution.record.output,
      data: execution.record.data,
      providerCallId: execution.record.providerCallId,
    },
    execution.record.parts?.length ? { parts: execution.record.parts } : undefined,
  );
  if (!execution.ok && execution.terminal) {
    await runtime.sessions.appendFinalAnswer(runtime.session, execution.reason ?? execution.output);
  }
  return execution;
}

/**
 * The user's most recent request, used as the reviewer's authorization evidence.
 *
 * Only user messages count: the reviewer's whole trust model rests on "did the
 * user ask for this", and assistant text or tool output is exactly the material
 * a prompt injection would arrive in.
 */
function latestUserRequest(runtime: AgentRuntime): string | undefined {
  const messages = runtime.session.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    // Skip the framework's own injected blocks (memories, skills, planning).
    const content = message.content ?? '';
    if (content.startsWith('<relevant-project-memories>') || content.startsWith('<planning-turn')) continue;
    return content;
  }
  return undefined;
}

/**
 * The reason to report for a failed tool call.
 *
 * Guarantees a non-empty, informative string. A bare "tool failed" tells the
 * user nothing they cannot already see, and it used to be what surfaced whenever
 * a caller forgot to set `reason` — so the real cause (the tool's own output)
 * was thrown away at the exact moment it mattered most.
 */
function toolFailureReason(
  execution: Pick<ToolActionExecution, 'reason' | 'output'>,
  tool: string,
  locale: Locale,
): string {
  const reason = execution.reason?.trim();
  if (reason) return reason;
  const output = execution.output?.trim();
  if (output) {
    return locale === 'zh'
      ? `工具 ${tool} 执行失败：${output}`
      : `Tool ${tool} failed: ${output}`;
  }
  return locale === 'zh'
    ? `工具 ${tool} 执行失败，且没有返回任何说明。`
    : `Tool ${tool} failed without reporting a cause.`;
}

function isParallelSafeAction(
  runtime: AgentRuntime,
  action: AgentAction | undefined,
): action is Extract<AgentAction, { type: 'tool' }> {
  if (!action || action.type !== 'tool') return false;
  const tool = runtime.tools.get(action.tool);
  // The marker is opt-in; retain an explicit read-risk check so write/shell/network
  // tools remain serial even if a plugin is misconfigured with parallelSafe=true.
  return tool?.risk === 'read' && tool.parallelSafe === true;
}

function resolveConfirm(runtime: AgentRuntime) {
  // Only the interactive REPL installs a confirm callback. Prompt/CI/smoke modes must
  // never block on stdin for git init or other safety confirmations.
  // The desktop bridge overrides `runtime.tools`-side confirm through ToolContext,
  // so this shim is only used for git-safety and task-board style confirms that
  // do not need structured approval requests.
  if (runtime.confirm) {
    return async (message: string, request?: import('../tools/types.js').ApprovalRequest) =>
      runtime.confirm!(message, request);
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

// Scan workspace skills and match them against the task prompt. Returns the
// injectable skill block, or undefined when no skill matches / skills dir is
// absent. Swallows all failures so a broken skill never breaks a turn.
async function loadSkillBlock(runtime: AgentRuntime, prompt: string): Promise<string | undefined> {
  try {
    const { scanSkills, matchSkills, buildSkillBlock } = await import('../skills/index.js');
    const { skills } = await scanSkills(runtime.config.workspaceRoot);
    if (skills.length === 0) return undefined;
    const matches = matchSkills(prompt, skills);
    if (matches.length === 0) return undefined;
    const block = buildSkillBlock(matches);
    return block || undefined;
  } catch {
    return undefined;
  }
}

// Recall past-failure lessons relevant to this prompt. Returns the injectable
// <past-reflections> block (and bumps hit counters), or undefined when nothing
// matches. Swallows all failures so a reflection problem never breaks a turn.
async function loadReflectionBlock(runtime: AgentRuntime, prompt: string): Promise<string | undefined> {
  if (!runtime.reflections) return undefined;
  try {
    const entries = await runtime.reflections.list();
    if (entries.length === 0) return undefined;
    const relevant = runtime.reflections.selectRelevant(entries, prompt);
    if (relevant.length === 0) return undefined;
    void runtime.reflections.touchHits(relevant.map((e) => e.id)).catch(() => {});
    return runtime.reflections.buildBlock(relevant) || undefined;
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

// Reflexion: persist a terminal failure as a lesson entry. The topic is the
// task prompt (truncated); the failure is the reason plus the last tool that
// ran; the lesson is derived heuristically from the failure text.
async function recordTurnReflection(
  runtime: AgentRuntime,
  prompt: string,
  coreResult: { reason?: string; finalAnswer?: string },
): Promise<void> {
  if (!runtime.reflections) return;
  const { deriveLesson } = await import('../reflection/types.js');
  const lastCall = [...runtime.session.toolCalls].reverse().find((call) => !call.ok);
  const reason = coreResult.reason ?? coreResult.finalAnswer ?? 'unknown failure';
  const isMaxSteps = reason.includes('max steps');
  const kind = isMaxSteps ? 'max_steps' : 'exception';
  const failure = lastCall
    ? `${reason}（最后失败工具: ${lastCall.tool} → ${lastCall.output.slice(0, 120)}）`
    : reason;
  await runtime.reflections.add({
    topic: prompt.slice(0, 160),
    failure,
    lesson: deriveLesson(failure, kind),
    kind,
  });
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
  // API error bodies arrive as `… failed: 400 {"error":{"message":"…"}}` —
  // collapse the JSON blob to `status + error.message` so chat output stays
  // one readable line instead of a raw dump.
  const statusAndMessage = message.match(/(\d{3})\b[\s\S]*?"message"\s*:\s*"([^"]{1,200})"/);
  if (statusAndMessage) return `${statusAndMessage[1]} ${statusAndMessage[2]}`;
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

/**
 * Whether a failed tool call must end the turn.
 *
 * A user DENYING one approval renders as `cancelled by user`, and that is NOT
 * terminal: denying a tool means "not that way", so the model must get another
 * step to propose an alternative. Cancelling the whole TURN is a different
 * signal, which travels as CancelledError from a safe-boundary poll rather
 * than as a tool output string. Only a policy block is terminal, because
 * retrying a blocked action cannot help.
 */
function isTerminalToolFailure(output: string) {
  return isBlockedOutput(output);
}

function classifyTerminalFailure(output: string): GitUnitOutcome {
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
  // Skill instructions injected at step 0 live inside user messages wrapped in
  // <relevant-skills>…</relevant-skills>; measure their real char footprint and
  // exclude it from messageChars so the same bytes are not double-counted.
  const SKILL_OPEN = '<relevant-skills>';
  const SKILL_CLOSE = '</relevant-skills>';
  const stripSkillBlock = (content: string): { text: string; block: string } => {
    const open = content.indexOf(SKILL_OPEN);
    if (open < 0) return { text: content, block: '' };
    const close = content.indexOf(SKILL_CLOSE, open);
    const block = close > open
      ? content.slice(open, close + SKILL_CLOSE.length)
      : content.slice(open);
    return { text: content.replace(block, ''), block };
  };
  let skillsChars = 0;
  const messageChars = packed.messages.reduce((sum, message) => {
    const partsChars = (message.parts ?? []).reduce(
      (acc, part) => acc + (part.type === 'text' ? part.text.length : 0),
      0,
    );
    const { text, block } = typeof message.content === 'string'
      ? stripSkillBlock(message.content)
      : { text: message.content, block: '' };
    skillsChars += block.length;
    return sum + text.length + (message.name?.length ?? 0) + message.role.length + 8 + partsChars;
  }, 0);
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
