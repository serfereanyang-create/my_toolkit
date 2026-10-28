import type { AgentRuntime } from '../agent/agent.js';
import { supervisorFor } from '../agent/agent.js';
import { createProvider } from '../providers/index.js';
import { type ResolvedTier } from '../dispatch/tierRouter.js';
import { DESTRUCTIVE_CONFIRM_REASON, isDestructiveApprovalRequest } from '../safety/policy.js';
import { resolveDispatchSelection } from '../dispatch/plan.js';
import { completeWithFallback, configForTier, isFallbackWorthy, tierProvider } from '../dispatch/tierProvider.js';

// Re-exported so the existing importers (tests, tools) keep one entry point;
// the implementation lives in dispatch/tierProvider.ts, shared with the main
// loop now that every call is routed.
export { completeWithFallback, configForTier, isFallbackWorthy, tierProvider };
import { allExperts, expertById } from '../experts/profiles.js';
import type { ExpertProfile } from '../experts/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { isResolvedToolScope, limitProviderTools, MAX_PROVIDER_TOOLS, selectScopedTools, widestScope, type ResolvedToolScope } from '../tools/scope.js';
import type { ToolDefinition } from '../tools/types.js';
import { TerminalUI } from '../ui/terminal.js';
import { formatHandoff, runSubAgentWithRollover, type RolloverSegment } from './rollover.js';
import type { SubAgentResult, SubAgentSpec } from './types.js';

/**
 * The registry a sub-agent may draw tools from — the parent's current set.
 *
 * This used to be `parentRuntime.allTools`, the whole registry, filtered only by
 * the expert profile. That made scope unenforceable across delegation: a parent
 * in `standard` cannot see `delete_path` or `git_init`, but `general` is
 * `toolFilter: () => true` with `toolScopeOverride: 'full'` (see
 * experts/profiles.ts), and `spawn_subagent` picks the expert by goal when the
 * caller does not name one — so a delegated child could reach every tool the
 * parent was denied, with approvals forced on (`confirm` in the sub-runtime).
 * Scope narrowing that stops at the process boundary is not a policy.
 *
 * `parentRuntime.tools` is the resolved scope plus the post-scope injections
 * (`spawn_subagent`, `computer_*`, `propose_plan` — see agent.ts:722-773), i.e.
 * exactly what the parent may call at this moment, so "the child never exceeds
 * the parent" holds by construction. `allTools` remains the fallback for a
 * runtime assembled without a resolved scope (tests, embedding callers).
 */
export function subAgentToolCeiling(
  parentRuntime: Pick<AgentRuntime, 'tools' | 'allTools' | 'resolvedToolScope'>,
): ToolRegistry {
  if (parentRuntime.resolvedToolScope) return parentRuntime.tools;
  return parentRuntime.allTools ?? parentRuntime.tools;
}

/**
 * Core tools every working sub-agent must keep whatever its scope or expert.
 *
 * A sub-agent is handed a task and expected to finish it — read the code, edit
 * it, run the project's own verification. `compact` is a conversation scope: it
 * withholds `write_file`/`edit_lines`/`run_command`/`apply_patch` on purpose,
 * because a small chat usually does not need them. Inheriting it unfiltered
 * would turn every `code_edit`/`test_verify` child into an agent that can read
 * but not do anything — the one outcome that is worse than a wider list.
 *
 * Deliberately NOT here: `delete_path`, `git_init` and the rest of
 * STANDARD_EXTRA_ALLOW's git writers. They are privilege, not the ability to
 * work, and they stay denied to a compact parent.
 *
 * `spawn_subagent` is here because nesting is bounded by `subAgentDepth`, not
 * by the scope. The scope grants it at standard and the parent's resolved set
 * usually holds it already; restoring it keeps a third level reachable for a
 * child of a compact parent instead of silently changing the depth contract.
 */
export const SUBAGENT_CORE_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'read_lines', 'read_many_files', 'list_files', 'search_text', 'find_files',
  'write_file', 'append_file', 'edit_lines', 'apply_patch',
  'run_command', 'poll_command',
  'run_tests', 'typecheck', 'lint',
  'spawn_subagent',
]);

/**
 * Tools `runAgentTurnCore` injects only for the root agent (agent.ts:765-791).
 *
 * A sub-agent's own turn would not add them, but the parent's resolved set can
 * already carry the runtime-bound instances (the base `review_loop` and
 * `spawn_subagent` are in the default registry). Those instances close over
 * the ROOT runtime — calling one from a child reads the root's
 * `subAgentDepth` and spawns with it, so a depth-1 child could start
 * grandchildren that the depth-0 gate then allows up to the limit again.
 * Removing them from the child's registry keeps depth a single chain.
 */
export const ROOT_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'review_loop',
  'propose_plan',
  'supervisor_status',
  'open_pull_request',
]);

/**
 * Give up non-essential tools until the registry fits `limit`, never dropping a
 * SUBAGENT_CORE_TOOL or anything the expert's filter rejects after all.
 *
 * The limit is the smaller of MAX_PROVIDER_TOOLS and the parent's own request
 * size. The child can exceed the parent ONLY by the core tools step 4 restored
 * for it (a compact parent holds none of the write/run tools), so the trim
 * takes back the least useful non-core entries — exactly what the parent's own
 * cap would have taken from a slightly larger list. If the protection set
 * itself is over the limit, the limit wins: an oversized array is a 400 on
 * every turn, which is worse than a child that has to ask a narrower way to
 * work.
 */
function trimSubAgentTools(registry: ToolRegistry, limit: number): { registry: ToolRegistry; dropped: string[] } {
  const stripped = withoutRootOnlyTools(registry);
  const tools = stripped.list();
  if (tools.length <= limit) return { registry: stripped, dropped: [] };
  const protectedNames = new Set(
    tools.filter((tool) => SUBAGENT_CORE_TOOLS.has(tool.name)).map((tool) => tool.name),
  );
  const trimmed = limitProviderTools(tools, { max: limit, protectedNames });
  return { registry: ToolRegistry.fromTools(trimmed.tools), dropped: trimmed.dropped };
}

/** A registry without the root-only tools; the same object when none are present. */
function withoutRootOnlyTools(registry: ToolRegistry): ToolRegistry {
  const tools = registry.list();
  if (!tools.some((tool) => ROOT_ONLY_TOOLS.has(tool.name))) return registry;
  return ToolRegistry.fromTools(tools.filter((tool) => !ROOT_ONLY_TOOLS.has(tool.name)));
}

/**
 * The scope a sub-agent runs in.
 *
 * Precedence: the parent's already-resolved scope, else the expert's
 * `toolScopeOverride`, else the parent's requested scope when that is already
 * one of the three resolved values, else `full` — the old whole-registry
 * behaviour, reachable only by a runtime assembled without a live scope
 * (tests, embedding callers).
 *
 * What the expert's `toolScopeOverride` may and may not do. It was introduced
 * to stop a child being *narrowed* below what its role needs (`code_search`
 * wants a small read-only list, `test_verify` needs the shell), so it is read
 * as a floor. Above the parent's own scope it only widens *which general
 * tools* are negotiated — the child's list is still cut from the parent's
 * current set, so it cannot reach a tool the parent does not hold. It matters
 * in exactly one case: a parent whose config asks for compact (`toolScope`
 * literal, no turn resolved yet) delegating to a role that needs the shell.
 *
 * A resolved parent scope wins outright: it is the scope the parent's own tool
 * array was built in this session, so a child under it cannot see further than
 * its parent by construction — except for one bounded case handled below.
 *
 * An editing expert never runs below `standard`. A sub-agent that is handed a
 * task and can only read would have to hand it back undone, and the child's OWN
 * turn re-runs `selectScopedTools` with this scope, so restoring the core tools
 * into the registry alone is not enough: `compact`'s allowlist would drop them
 * again at request time. The floor is `standard` only for experts whose filter
 * accepts `write_file`; a read-only researcher keeps the parent's compact list.
 * What `standard` adds is then trimmed back to the parent's own request size
 * below, with the core tools protected — so the child gains the ability to
 * edit and run, at the cost of low-ranked utilities, and still sends no more
 * tools than its parent.
 */
export function subAgentScope(
  parentRuntime: Pick<AgentRuntime, 'resolvedToolScope' | 'toolScope'>,
  profile: Pick<ExpertProfile, 'toolFilter' | 'toolScopeOverride'>,
): ResolvedToolScope {
  const parentScope = isResolvedToolScope(parentRuntime.resolvedToolScope)
    ? parentRuntime.resolvedToolScope
    : isResolvedToolScope(profile.toolScopeOverride)
      ? profile.toolScopeOverride
      : isResolvedToolScope(parentRuntime.toolScope)
        ? parentRuntime.toolScope
        : 'full';
  const canEdit = profile.toolFilter({ name: 'write_file', risk: 'write', description: '' });
  return canEdit ? widestScope(parentScope, 'standard') : parentScope;
}

/**
 * The exact tool list a sub-agent segment is allowed to draw from, with the
 * provider cap applied. A pure function of the runtime the child was delegated
 * FROM plus the expert and scope: the direct callers (`runCodeReview` from the
 * REPL, the workflow subAgentRunner) are not inside a parent turn, and their
 * child still has to be bounded.
 *
 * Ordered narrow → narrow → cap:
 *   1. ceiling   — when the parent has resolved a turn, its CURRENT set
 *                  (`parentRuntime.tools`); otherwise the whole registry with
 *                  the parent's runtime `toolFilter` applied. The second arm is
 *                  the one the direct callers use: a task-board hand-off sets
 *                  `toolFilter`, which is invisible in the (pre-filter) registry.
 *   2. profile   — the expert's toolFilter.
 *   3. scope     — `selectScopedTools` in the sub-agent's own scope. Without
 *                  this step the child of a `compact` parent received `full`'s
 *                  surface: measured on this tree, 238 tools against 205.
 *   4. core      — SUBAGENT_CORE_TOOLS the expert accepts, restored from the
 *                  parent's full registry. A compact parent's resolved set
 *                  holds none of the write/run tools, so without this step a
 *                  delegated `code_edit`/`test_verify` child could only read.
 *                  The parent's filter still applies, so a hand-off cannot
 *                  regain a tool it excluded.
 *   5. cap       — `limitProviderTools` at `min(MAX_PROVIDER_TOOLS, the
 *                  parent's delegated-from size)`. Two properties at once: the
 *                  child never exceeds the provider ceiling (the per-turn 400)
 *                  and never sends more tools than its parent. The core set
 *                  restored in step 4 is protected, so the trim takes back
 *                  low-ranked utilities rather than the ability to work.
 *
 * Root-only tools that survive into the result are removed by the segment
 * builder (they close over the root runtime; see ROOT_ONLY_TOOLS).
 */
export function buildSubAgentTools(options: {
  parentRuntime: Pick<AgentRuntime, 'tools' | 'allTools' | 'resolvedToolScope' | 'toolFilter'>;
  profile: Pick<ExpertProfile, 'toolFilter'>;
  scope: ResolvedToolScope;
}): { registry: ToolRegistry; dropped: string[] } {
  const { parentRuntime, profile, scope } = options;

  // The delegated-from surface. `resolvedToolScope` is written on every turn,
  // so when it is set `parentRuntime.tools` is exactly what the parent may call
  // right now. When it is not, this runtime has not run a turn (direct review /
  // workflow calls) and the whole registry — minus the task-board filter — is
  // the honest ceiling.
  const ceilingTools: ToolDefinition[] = isResolvedToolScope(parentRuntime.resolvedToolScope)
    ? parentRuntime.tools.list()
    : (parentRuntime.allTools ?? parentRuntime.tools).list()
      .filter((tool) => parentRuntime.toolFilter?.(tool) ?? true);
  const ceilingRegistry = ToolRegistry.fromTools(ceilingTools);
  const scoped = selectScopedTools(ceilingRegistry, scope);

  const accepted = new Map<string, ToolDefinition>();
  for (const tool of scoped) {
    if (profile.toolFilter({ name: tool.name, risk: tool.risk, description: tool.description })) {
      accepted.set(tool.name, tool);
    }
  }
  // Restore only the work core, and only from the parent's full registry: a
  // fixed list, never a scope, so the child may regain the ability to edit and
  // run but not an arbitrary corner of the registry.
  for (const tool of (parentRuntime.allTools ?? ceilingRegistry).list()) {
    if (accepted.has(tool.name) || !SUBAGENT_CORE_TOOLS.has(tool.name)) continue;
    if (!(parentRuntime.toolFilter?.(tool) ?? true)) continue;
    if (!profile.toolFilter({ name: tool.name, risk: tool.risk, description: tool.description })) continue;
    accepted.set(tool.name, tool);
  }

  const tools = [...accepted.values()];
  const parentBound = Math.min(MAX_PROVIDER_TOOLS, ceilingTools.length);
  const protectedNames = new Set(
    tools.filter((tool) => SUBAGENT_CORE_TOOLS.has(tool.name)).map((tool) => tool.name),
  );
  const limited = limitProviderTools(tools, { max: Math.min(MAX_PROVIDER_TOOLS, parentBound), protectedNames });
  return { registry: ToolRegistry.fromTools(limited.tools), dropped: limited.dropped };
}

/**
 * The "how to use the tools you have" block injected into every sub-agent task,
 * between `## 你的角色` and `## 当前任务`.
 *
 * Generated from the registry the segment will actually receive, not written as
 * a fixed paragraph. The instruction has to stay true to the surface: a
 * read-only reviewer told to "run the tests" tries, fails, and burns a step; a
 * child offered `spawn_subagent` but never told when to use it reads a large
 * file set one call at a time (the serial path delegation exists to avoid).
 * Naming only what is present also keeps the paragraph from widening the
 * surface by suggestion.
 *
 * `## 你的角色` is the expert's own prose and `## 当前任务` is the caller's goal;
 * this block is the missing third piece — the conventions for the tools in
 * between.
 */
export function subAgentToolGuidance(tools: Array<{ name: string }>): string {
  const has = (name: string) => tools.some((tool) => tool.name === name);
  const canEdit = has('write_file') || has('apply_patch') || has('edit_lines') || has('append_file');
  const canRun = has('run_command');
  const verifiers = ['run_tests', 'typecheck', 'lint'].filter(has);
  const lines = [
    '## 工具使用约定',
    canEdit
      ? '- 先读再改：动手前用 read_file / search_text / find_symbol 确认上下文，不要凭猜测改文件。'
      // "先读再改" is a contradiction for a role that cannot write; say what
      // reading is FOR instead of reusing the editing sentence.
      : '- 先读再答：结论要落到具体的文件与行，用 read_file / search_text / find_symbol 拿到原文，不要凭印象或常见做法推断。',
  ];
  if (canEdit) {
    lines.push('- 改动尽量小且集中，做完再进入下一处；不要顺手重排无关代码。');
  }
  if (verifiers.length > 0) {
    lines.push(`- 改完自检：用 ${verifiers.join(' / ')} 跑一遍；失败就修到通过再结束，并说明跑了什么。`);
  } else if (canRun) {
    lines.push('- 自检只能用 run_command：按项目里的脚本跑（看 package.json / Makefile / README 里怎么写的），不要凭空编一条命令；失败就修到通过再结束，并说明跑了什么。');
    if (canEdit) lines.push('- 写完之后不要声称跑过测试——你手上没有测试工具，普通命令不等于跑过测试。');
  } else if (canEdit) {
    lines.push('- 本角色没有执行能力，写完后说明改了什么、应当由谁验证，不要声称已经跑过测试。');
  }
  if (!canEdit && !canRun) {
    lines.push('- 本角色只读：没有写文件或执行命令的能力。发现问题写进结论，不要尝试修改。');
  } else if (!canEdit && canRun) {
    lines.push('- 本角色不改文件：可以跑命令收集证据，但改动只能写进结论交给调用方。');
  }
  if (has('spawn_subagent')) {
    if (canEdit) {
      lines.push('- 任务能拆成互不依赖的部分时，用 spawn_subagent 一次派出多个子任务并行处理；有先后依赖的用 dependsOn 串起来，不要为了省事把可并行的读操作串行做完。');
    } else {
      // A read-only or run-only child cannot hand a WRITE to a sub-agent — its
      // own surface has no write tools — so "parallelise the work" would be
      // advice it cannot follow. Scope the suggestion to reading.
      lines.push('- 同一批文件要分别看完再下结论时，可以用 spawn_subagent 按文件分组并行读；有先后依赖的用 dependsOn 串起来。');
    }
  }
  lines.push('- 结束时用 TASK_DONE: <结论或改动摘要> 收尾。');
  return lines.join('\n');
}


/**
 * Swap the sub-runtime onto another dispatch tier's provider.
 *
 * Returns the overrides to spread into the sub-runtime. Undefined when the
 * request carries no tier (inherit the parent model), when the session has no
 * dispatch selection, or when the tier cannot be resolved — in every failure
 * case we fall back to inheriting rather than failing the delegation, but we
 * say so instead of pretending the cheap model ran.
 */
export function applyTierOverride(
  tier: 'expensive' | 'standard' | 'cheap' | undefined,
  parentRuntime: AgentRuntime,
): { provider?: AgentRuntime['provider']; config?: AgentRuntime['config']; chain?: ResolvedTier[]; note?: string } {
  if (!tier) return {};
  // Same precedence as the main loop: an explicit /省钱分级 selection wins,
  // otherwise the tiers are derived from the models actually configured. There
  // is no settings-panel default to read any more — that UI is gone.
  let chain;
  try {
    const selection = resolveDispatchSelection(parentRuntime);
    if (!selection) {
      return { note: `[dispatch] 无法确定分档（没有显式配置，也没有可推导的模型），${tier} 档回落到父模型 ${parentRuntime.config.model}` };
    }
    chain = selection.tiers[tier];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { note: `[dispatch] ${tier} 档解析失败（${msg}），回落到父模型 ${parentRuntime.config.model}` };
  }
  if (!chain || chain.length === 0) {
    return { note: `[dispatch] ${tier} 档未配置，回落到父模型 ${parentRuntime.config.model}` };
  }
  // The first model in the chain is the primary; the rest are fallbacks for
  // when the primary is rate limited or unavailable. Both are returned so the
  // caller can build a provider that actually fails over (see tierProvider).
  const resolved = chain[0];
  const providerConfig = configForTier(parentRuntime.config, resolved);
  return {
    provider: createProvider(providerConfig),
    config: providerConfig,
    chain,
    note: `[dispatch] ${tier} 档 → ${resolved.providerName}/${resolved.model}`,
  };
}

/**
 * Steps one sub-agent **segment** may take before it rolls over into a fresh
 * session. This is not a cap on the sub-agent's work — exceeding it starts a new
 * segment with a handoff summary and a renewed budget.
 *
 * The main agent has no step limit at all (see AppConfig.maxSteps); a bounded
 * segment exists here because a delegated unit of work should finish or hand
 * off, not accumulate an unbounded transcript.
 */
export const DEFAULT_SUBAGENT_SEGMENT_STEPS = 40;

/**
 * Which expert a `spawn_subagent` call runs as.
 *
 * `readonly: true` promises "no file writes", and the expert's toolFilter is
 * what enforces that — so the flag has to select the read-only expert rather
 * than be applied as a filter afterwards. Kept as a named function because the
 * promise is a security property: the runner used to ignore the option entirely
 * and always pass `code_edit`, so a caller asking for a read-only sub-agent
 * silently got one that could write.
 */
export function expertIdForSubAgentRequest(options?: { readonly?: boolean }): string {
  return options?.readonly ? 'code_search' : 'code_edit';
}

/**
 * 子 agent（无头）的确认回调：常规确认自动放行，破坏性确认一律拒绝。
 * `policy.ts` 对 `alwaysPrompt` 工具无条件返回 needsPrompt（注释写的是
 * 「任何模式下都不静默批准」），而 `registry.ts` 只在 `context.confirm` 缺失
 * 时才拒绝。子 runtime 过去注入 `() => Promise.resolve(true)`，于是
 * `git_restore`（不带 --staged，丢弃未提交改动）和 `computer_close` 在子
 * agent 里被静默放行——父 agent 在 ask 模式下会被拒绝的操作，交给子 agent
 * 就能执行。
 *
 * 修法：子 agent 的普通自动确认（write 类工具）保持不动，只对 alwaysPrompt
 * 这一类拒绝。registry 把 policy 的 `reason` 原样放进 `ApprovalRequest`，
 * `alwaysPrompt` 分支的 reason 是固定字符串，据此区分。拒绝时向子 UI 说明
 * 原因，模型收到的是 registry 的标准取消结果（不是静默成功）。
 */
export function createSubAgentConfirm(
  onDestructiveRefusal?: (tool: string) => void,
): NonNullable<AgentRuntime['confirm']> {
  return async (_message, request) => {
    // registry 从不传 request 给 git-safety 等非工具路径；没有 request 就不是
    // 工具审批，按常规放行，保持 headless 子 agent 的既有行为。
    if (request && isDestructiveApprovalRequest(request)) {
      onDestructiveRefusal?.(request.tool);
      return false;
    }
    return true;
  };
}

export { DESTRUCTIVE_CONFIRM_REASON, isDestructiveApprovalRequest };

/**
 * 运行单个子智能体。
 *
 * 子 agent 拥有：
 *  - 独立 SessionRecord（独立历史、独立审计链）
 *  - 按 ExpertProfile 过滤后的受限 ToolRegistry
 *  - 可选的推理档位覆盖
 *  - 上游结果摘要自动注入 prompt 前缀
 *
 * 单段步数用尽时不停在这里：runSubAgentWithRollover 会新开一个会话，带着交接
 * 摘要继续，直到完成或段数用尽。
 */
export async function runSubAgent(
  spec: SubAgentSpec,
  parentRuntime: AgentRuntime,
  upstreamResults: Map<string, SubAgentResult>,
  parentGoal?: string,
  /**
   * 由调度器注入的协作式中止判据（超时/父级取消）。
   * 与父 runtime 自己的 cancelRequested 取或：任一为真即在安全检查点停止。
   * 不硬杀进程 —— 已跑完的工具结果仍留在子 session 里。
   */
  options?: { cancelRequested?: () => boolean },
): Promise<SubAgentResult> {
  const t0 = Date.now();

  // ── 1. 找到对应专家配置 ──────────────────────────────────────────────────────
  // By profile id, and a miss is fatal. The fallback used to be "last profile
  // in the roster", which handed an unknown expert the general expert's full
  // toolset — a silent privilege widening for a caller that may have asked for
  // the read-only reviewer. (It was also the general expert only by accident:
  // it happened to be last.)
  // The label is what the progress panel and 子智能体目录 show, so it must be
  // short. `spec.goal` is the full task text sent to the model — for a code
  // review that is the whole diff, and using it as a label both floods the
  // panel and writes the diff into the desktop's persisted run records.
  const label = spec.label?.trim() || spec.goal;

  const profile = expertById(spec.expert);
  if (!profile) {
    const answer = `未知的专家档案：${spec.expert}。可用：${allExperts.map((e) => e.id).join(', ')}`;
    parentRuntime.subagentEmit?.({
      phase: 'done',
      id: spec.id,
      goal: label,
      expert: spec.expert,
      ok: false,
      answer,
      subSessionId: '',
      durationMs: 0,
      steps: 0,
    });
    return {
      id: spec.id,
      goal: spec.goal,
      expert: spec.expert,
      ok: false,
      answer,
      sessionId: '',
      durationMs: 0,
      steps: 0,
    };
  }

  const segmentSteps = spec.maxSteps ?? DEFAULT_SUBAGENT_SEGMENT_STEPS;
  const segments: RolloverSegment[] = [];
  let firstSessionId = '';

  // Surface the run in the desktop 子智能体目录. The parent runtime owns the
  // hook; the sub-runtime inherits it via the spread below, so nested spawns
  // report too. Emitting before the turn is what makes a run visible while it
  // is still in flight.
  parentRuntime.subagentEmit?.({
    phase: 'started',
    id: spec.id,
    goal: label,
    expert: profile.id,
    subSessionId: '',
  });
  supervisorFor(parentRuntime).start({
    kind: 'subagent',
    id: spec.id,
    label,
    expert: profile.id,
    segment: 1,
  });

  /**
   * Build one segment: a fresh session, a filtered tool registry, and the
   * sub-runtime. Called once per rollover so a new segment starts clean while
   * inheriting the parent's provider/config/sessions.
   */
  const createSegment = async (segmentGoal: string) => {
    // The tier override is resolved before the session is created so the
    // sub-session records the provider/model that will actually run. This used
    // to read the parent's, which was wrong twice over: it ignored the tier,
    // and it disagreed with the provider the turn was switched to.
    const tierOverride = applyTierOverride(spec.tier, parentRuntime);
    if (tierOverride.note) parentRuntime.ui?.info(tierOverride.note);

    // ── 2. 创建独立 Session ────────────────────────────────────────────────────
    // 子会话写进同级的 sessions-subagents，而不是用户会话目录：桌面端把会话目录
    // 里的每条记录都当一次对话列出来，子智能体每段建一个，侧栏因此塞满了空壳和
    // 以「## 主任务背景」开头的内部记录。目录由 SessionStore.sibling 从父目录推出，
    // 所以 CLI 单独运行和桌面端带 --session-dir 的形态都适用。
    const subStore = parentRuntime.sessions.sibling('sessions-subagents');
    const subSession = await subStore.create({
      provider: tierOverride.provider?.name ?? parentRuntime.provider.name,
      model: tierOverride.provider?.model ?? parentRuntime.provider.model,
      workspaceRoot: parentRuntime.config.workspaceRoot,
    });
    if (!firstSessionId) firstSessionId = subSession.id;

    // ── 3. 构建受限工具集 ──────────────────────────────────────────────────────
    //
    // The child's ceiling is the parent's CURRENT set, not the whole registry —
    // see subAgentToolCeiling. On top of the ceiling the child is re-scoped
    // (selectScopedTools in its own scope), keeps the expert's filter and the
    // parent's runtime toolFilter, gets SUBAGENT_CORE_TOOLS back where the
    // scope withholds them, and is finally capped at the smaller of
    // MAX_PROVIDER_TOOLS and the parent's own request size. Before this, a
    // compact parent handed its child `full`'s 238 tools and nothing in
    // runSubAgent capped the list at all.
    const childScope = subAgentScope(parentRuntime, profile);
    const builtTools = buildSubAgentTools({ parentRuntime, profile, scope: childScope });
    // The depth-0 pass in the parent's turn dropped its own root-only tools via
    // the runtime toolFilter: strip the same out of the parent's accepted set
    // so the child's bound is measured against the same surface the parent
    // actually sends.
    const parentRequestTools = subAgentToolCeiling(parentRuntime).list()
      .filter((tool) => !ROOT_ONLY_TOOLS.has(tool.name))
      .filter((tool) => profile.toolFilter({ name: tool.name, risk: tool.risk, description: tool.description }))
      .filter((tool) => parentRuntime.toolFilter?.(tool) ?? true);
    const childTools = trimSubAgentTools(
      builtTools.registry,
      Math.min(MAX_PROVIDER_TOOLS, parentRequestTools.length),
    ).registry;
    // The child's runtime is a fresh construct, not a copy: every mutable
    // control field is pinned to a child scope. `sessionToolScopeFloor` in
    // particular must not be inherited — runAgentTurnCore writes it back on
    // every turn, so sharing it would let a child widen (or be dragged down
    // by) the parent's floor. Depth, toolScope and the tool filter are the
    // child's own for the same reason.

    // ── 4. 组装轻量子运行时（继承 provider/config/sessions，覆盖 session/tools）──
    const subUI = new TerminalUI({ quiet: true });
    // Tier override: a 'cheap' sub-agent runs on the router's cheap provider
    // instead of inheriting the parent model. This is the single point where
    // /省钱分级 turns from a prompt convention into an actual dispatch.
    // The provider walks the tier's whole chain, so a rate-limited primary
    // falls over to its fallbacks instead of failing the delegation.
    const tierConfig = tierOverride.chain && tierOverride.chain.length > 1
      ? configForTier(parentRuntime.config, tierOverride.chain[0])
      : tierOverride.config;
    const subRuntime: AgentRuntime = {
      ...parentRuntime,
      // Spread the tier's provider/config over the parent's so the whole
      // sub-turn (and any nested delegation) runs on the cheap model.
      ...(tierOverride.chain
        ? { provider: tierProvider(parentRuntime.config, tierOverride.chain, (failed, next, error) => {
            parentRuntime.ui?.info(
              `[dispatch] ${failed.providerName}/${failed.model} 不可用（${error instanceof Error ? error.message : String(error)}），降级到 ${next.providerName}/${next.model}`,
            );
          }) }
        : {}),
      ...(tierConfig ? { config: tierConfig } : {}),
      session: subSession,
      // 保存也必须走子会话库：展开父 runtime 会把 sessions 一并继承过来，
      // 那样每轮的 appendMessage 仍写回父会话文件，隔离就只做了一半。
      sessions: subStore,
      tools: childTools,
      allTools: childTools,
      // Same value as the filter already applied in buildSubAgentTools. It is
      // still set so the child's own turn re-applies the parent's filter to
      // whatever it resolves later in the segment.
      toolFilter: tool => profile.toolFilter(tool) && (parentRuntime.toolFilter?.(tool) ?? true),
      // Fresh floor, current child scope. Inheriting the parent's would share
      // one mutable field across both runtimes: the child's turn would raise
      // the parent's floor (a widening) and a parent turn could raise the
      // child's (the child then sees a scope it was never granted).
      sessionToolScopeFloor: childScope,
      // Pinned to the scope the tool list above was selected in, so the child's
      // first turn resolves to the same scope instead of re-deriving it from
      // its own short prompt.
      toolScope: childScope,
      resolvedToolScope: childScope,
      ui: subUI,
      // 子 agent 不继承 git safety 单元（避免嵌套 unit 污染父 session）
      gitSafety: undefined,
      gitRollback: undefined,
      gitPublisher: undefined,
      gitProcess: undefined,
      gitRepository: undefined,
      // 推理档位覆盖
      reasoningEffort: spec.reasoningEffort ?? parentRuntime.reasoningEffort,
      // Root-only tools: `review_loop`, `propose_plan`, `supervisor_status` and
      // `open_pull_request` are injected by runAgentTurnCore only at depth 0
      // (agent.ts:765-791). A child is not offered them, but the parent's
      // resolved set may already contain live instances — those close over the
      // root runtime, so executing one from a child would re-enter the root
      // (and spawn grandchildren at depth 1, under the depth-0 gate). Drop them
      // for that reason; everything else the parent can call, the child may.
      // (childTools above is already the filtered registry.)
      // 每段一个步数预算：用尽即换新段续跑，而不是让整轮失败。必须基于上面已
      // 合入档位的 config 再覆盖 maxSteps —— 写成 parentRuntime.config 会把档位的
      // provider/model/apiKey 一起丢掉，等于档位没生效。
      config: { ...(tierConfig ?? parentRuntime.config), maxSteps: segmentSteps },
      // 子 agent 使用简单的自动批准确认（headless 模式）——但只对「常规确认」。
      // `alwaysPrompt` 的破坏性确认必须拒绝，见 createSubAgentConfirm。
      confirm: createSubAgentConfirm((tool) => subUI.info(
        `子 agent 无法执行破坏性操作 ${tool}：需要主会话用户确认`,
      )),
      toolConfirm: createSubAgentConfirm((tool) => subUI.info(
        `子 agent 无法执行破坏性操作 ${tool}：需要主会话用户确认`,
      )),
      // 深度递增：子 agent 再派生时 spawn_subagent 会检查该值（root=0，子=+1）
      subAgentDepth: (parentRuntime.subAgentDepth ?? 0) + 1,
      // Stamp the tier so the turn's usage block can write the dispatch ledger.
      ...(spec.tier ? { dispatchTier: spec.tier } : {}),
      // 超时/父级取消经由调度器注入的判据，与父 runtime 的取或。
      // 覆盖父值是有意的：子 agent 必须同时受自己那条超时线和父级取消支配。
      cancelRequested: options?.cancelRequested
        ? () => options.cancelRequested!() || parentRuntime.cancelRequested?.() === true
        : parentRuntime.cancelRequested,
    };

    return { runtime: subRuntime, sessionId: subSession.id, goal: segmentGoal };
  };

  // ── 5. 构建增强 prompt（每段重建；交接块只从第 2 段起出现）──────────────────
  const baseParts: string[] = [];
  if (parentGoal) {
    baseParts.push(`## 主任务背景\n${parentGoal}\n`);
  }
  if (upstreamResults.size > 0) {
    const upstreamLines: string[] = [];
    for (const [depId, result] of upstreamResults) {
      upstreamLines.push(`- **${depId}** (${result.expert}): ${result.answer.slice(0, 300)}`);
    }
    baseParts.push(`## 上游子任务结果\n${upstreamLines.join('\n')}\n`);
  }
  if (spec.contextHint) {
    baseParts.push(`## 额外背景\n${spec.contextHint}\n`);
  }
  baseParts.push(`## 你的角色\n${profile.systemPrompt}\n`);
  // 工具使用约定：只描述这个角色实际拿得到的工具。子 agent 的旧提示只有
  // 「角色 + 任务」两段散文，模型于是把「改完跑测试」「跨文件时并行拆分」
  // 当成角色设定之外的事；而只读角色拿到写类指引又会试着调用不存在的工具。
  // 所以按实际工具集生成，缺席的能力明说缺席。
  baseParts.push(subAgentToolGuidance(
    buildSubAgentTools({ parentRuntime, profile, scope: subAgentScope(parentRuntime, profile) }).registry.list(),
  ));
  baseParts.push(`## 当前任务\n${spec.goal}`);

  const buildGoal = (segment: number, handoff: string | undefined) =>
    baseParts.join('\n') + formatHandoff(segment, handoff);

  // ── 6. 执行（必要时跨段续跑）────────────────────────────────────────────────
  const totalStepsOf = () => segments.reduce((sum, segment) => sum + segment.steps, 0);

  let outcome;
  try {
    outcome = await runSubAgentWithRollover(
      parentRuntime,
      async (goal) => {
        const built = await createSegment(goal);
        return { runtime: built.runtime, sessionId: built.sessionId };
      },
      {
        segmentSteps,
        buildGoal,
        cancelRequested: options?.cancelRequested,
        onSegmentStart: (segment, sessionId) => {
          // Each segment is the same logical unit continuing, so this updates the
          // existing entry (and its segment index) rather than adding a row.
          supervisorFor(parentRuntime).start({
            kind: 'subagent',
            id: spec.id,
            label,
            expert: profile.id,
            segment,
            sessionId,
          });
        },
        onSegmentDone: (segment) => {
          segments.push(segment);
          supervisorFor(parentRuntime).progress('subagent', spec.id, totalStepsOf());
        },
      },
    );
  } catch (err) {
    const answer = err instanceof Error ? err.message : String(err);
    parentRuntime.subagentEmit?.({
      phase: 'done',
      id: spec.id,
      goal: label,
      expert: profile.id,
      ok: false,
      answer,
      subSessionId: firstSessionId,
      durationMs: Date.now() - t0,
      steps: totalStepsOf(),
    });
    return {
      id: spec.id,
      goal: spec.goal,
      expert: spec.expert,
      ok: false,
      answer,
      sessionId: firstSessionId,
      durationMs: Date.now() - t0,
      steps: totalStepsOf(),
    };
  }

  supervisorFor(parentRuntime).finish('subagent', spec.id, outcome.ok ? 'done' : 'failed', {
    steps: outcome.steps,
    sessionId: outcome.sessionId || firstSessionId,
    ...(outcome.exhausted ? { error: outcome.answer } : {}),
  });

  parentRuntime.subagentEmit?.({
    phase: 'done',
    id: spec.id,
    goal: label,
    expert: profile.id,
    ok: outcome.ok,
    answer: outcome.answer,
    subSessionId: outcome.sessionId || firstSessionId,
    durationMs: Date.now() - t0,
    steps: outcome.steps,
  });

  return {
    id: spec.id,
    goal: spec.goal,
    expert: spec.expert,
    ok: outcome.ok,
    answer: outcome.answer,
    sessionId: outcome.sessionId || firstSessionId,
    durationMs: Date.now() - t0,
    steps: outcome.steps,
    ...(segments.length > 1 ? { segments: segments.length } : {}),
    ...(outcome.exhausted ? { exhaustedSegments: true } : {}),
  };
}
