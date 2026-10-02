import type { AgentRuntime } from '../agent/agent.js';
import { supervisorFor } from '../agent/agent.js';
import { createProvider } from '../providers/index.js';
import { resolveTiers, readGlobalDispatchDefault } from '../dispatch/tierRouter.js';
import { allExperts, expertById } from '../experts/profiles.js';
import { ToolRegistry } from '../tools/registry.js';
import { TerminalUI } from '../ui/terminal.js';
import { formatHandoff, runSubAgentWithRollover, type RolloverSegment } from './rollover.js';
import type { SubAgentResult, SubAgentSpec } from './types.js';

/**
 * Swap the sub-runtime onto another dispatch tier's provider.
 *
 * Returns the overrides to spread into the sub-runtime. Undefined when the
 * request carries no tier (inherit the parent model), when the session has no
 * dispatch selection, or when the tier cannot be resolved — in every failure
 * case we fall back to inheriting rather than failing the delegation, but we
 * say so instead of pretending the cheap model ran.
 */
function applyTierOverride(
  tier: 'expensive' | 'standard' | 'cheap' | undefined,
  parentRuntime: AgentRuntime,
): { provider?: AgentRuntime['provider']; config?: AgentRuntime['config']; note?: string } {
  if (!tier) return {};
  // Session selection wins; a session that never ran /省钱分级 falls back to
  // the global default the desktop settings panel writes.
  const selection = parentRuntime.session.dispatch ?? readGlobalDispatchDefault();
  if (!selection) {
    return { note: `[dispatch] 未配置分级（会话未执行 /省钱分级，也没有全局默认），${tier} 档回落到父模型 ${parentRuntime.config.model}` };
  }
  let chain;
  try {
    const tiers = resolveTiers(selection);
    // resolveTiers reports a bad selection as `{ error }` rather than throwing.
    if ('error' in tiers) {
      return { note: `[dispatch] ${tier} 档解析失败（${tiers.error}），回落到父模型 ${parentRuntime.config.model}` };
    }
    chain = tiers[tier];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { note: `[dispatch] ${tier} 档解析失败（${msg}），回落到父模型 ${parentRuntime.config.model}` };
  }
  if (!chain || chain.length === 0) {
    return { note: `[dispatch] ${tier} 档未配置，回落到父模型 ${parentRuntime.config.model}` };
  }
  // The first model in the chain is the primary; the rest are fallbacks the
  // caller can retry with when the primary is rate limited or unavailable.
  const resolved = chain[0];
  const providerConfig = {
    ...parentRuntime.config,
    provider: resolved.provider as AgentRuntime['config']['provider'],
    model: resolved.model,
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
  };
  return {
    provider: createProvider(providerConfig),
    config: providerConfig,
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
    // ── 2. 创建独立 Session ────────────────────────────────────────────────────
    const subSession = await parentRuntime.sessions.create({
      provider: parentRuntime.provider.name,
      model: parentRuntime.provider.model,
      workspaceRoot: parentRuntime.config.workspaceRoot,
    });
    if (!firstSessionId) firstSessionId = subSession.id;

    // ── 3. 构建受限工具集 ──────────────────────────────────────────────────────
    const sourceTools = parentRuntime.allTools ?? parentRuntime.tools;
    const filteredTools = ToolRegistry.fromTools(
      sourceTools.list().filter((tool) =>
        profile.toolFilter({ name: tool.name, risk: tool.risk, description: tool.description }),
      ),
    );

    // ── 4. 组装轻量子运行时（继承 provider/config/sessions，覆盖 session/tools）──
    const subUI = new TerminalUI({ quiet: true });
    // Tier override: a 'cheap' sub-agent runs on the router's cheap provider
    // instead of inheriting the parent model. This is the single point where
    // /省钱分级 turns from a prompt convention into an actual dispatch.
    const tierOverride = applyTierOverride(spec.tier, parentRuntime);
    const subRuntime: AgentRuntime = {
      ...parentRuntime,
      // Spread the tier's provider/config over the parent's so the whole
      // sub-turn (and any nested delegation) runs on the cheap model.
      ...(tierOverride.provider ? { provider: tierOverride.provider } : {}),
      ...(tierOverride.config ? { config: tierOverride.config } : {}),
      session: subSession,
      tools: filteredTools,
      allTools: filteredTools,
      ui: subUI,
      // 子 agent 不继承 git safety 单元（避免嵌套 unit 污染父 session）
      gitSafety: undefined,
      gitRollback: undefined,
      gitPublisher: undefined,
      gitProcess: undefined,
      gitRepository: undefined,
      // 推理档位覆盖
      reasoningEffort: spec.reasoningEffort ?? parentRuntime.reasoningEffort,
      // 专家的工具作用域覆盖必须显式传下去：runAgentTurn 会用 toolScope 重新解析，
      // 子 agent 的小 prompt 会被判成 compact，把 run_command/write_file 这类
      // 关键工具裁掉（test_verify 就整个失效）。任务板路径一直有这层覆盖，子
      // agent 路径漏了。
      toolScope: profile.toolScopeOverride ?? parentRuntime.toolScope,
      // 每段一个步数预算：用尽即换新段续跑，而不是让整轮失败。
      config: { ...parentRuntime.config, maxSteps: segmentSteps },
      // 子 agent 使用简单的自动批准确认（headless 模式）
      confirm: () => Promise.resolve(true),
      toolConfirm: () => Promise.resolve(true),
      // 深度递增：子 agent 再派生时 spawn_subagent 会检查该值（root=0，子=+1）
      subAgentDepth: (parentRuntime.subAgentDepth ?? 0) + 1,
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
