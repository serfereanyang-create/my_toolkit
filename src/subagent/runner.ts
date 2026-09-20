import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '../agent/agent.js';
import { runAgentTurn } from '../agent/agent.js';
import { allExperts } from '../experts/profiles.js';
import { ToolRegistry } from '../tools/registry.js';
import { TerminalUI } from '../ui/terminal.js';
import type { SubAgentResult, SubAgentSpec } from './types.js';

/**
 * 运行单个子智能体。
 *
 * 子 agent 拥有：
 *  - 独立 SessionRecord（独立历史、独立审计链）
 *  - 按 ExpertProfile 过滤后的受限 ToolRegistry
 *  - 可选的推理档位覆盖
 *  - 上游结果摘要自动注入 prompt 前缀
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
  const profile = allExperts.find((e) => e.id === spec.expert) ?? allExperts[allExperts.length - 1]!;

  // ── 2. 创建独立 Session ──────────────────────────────────────────────────────
  const subSession = await parentRuntime.sessions.create({
    provider: parentRuntime.provider.name,
    model: parentRuntime.provider.model,
    workspaceRoot: parentRuntime.config.workspaceRoot,
  });

  // ── 3. 构建受限工具集 ────────────────────────────────────────────────────────
  const sourceTools = parentRuntime.allTools ?? parentRuntime.tools;
  const filteredTools = ToolRegistry.fromTools(
    sourceTools.list().filter((tool) =>
      profile.toolFilter({ name: tool.name, risk: tool.risk, description: tool.description }),
    ),
  );

  // ── 4. 组装轻量子运行时（继承 provider/config/sessions，覆盖 session/tools）──
  const subUI = new TerminalUI({ quiet: true });
  const subRuntime: AgentRuntime = {
    ...parentRuntime,
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
    // maxSteps 通过 config 覆盖（浅拷贝 config 避免影响父运行时）
    config: spec.maxSteps
      ? { ...parentRuntime.config, maxSteps: spec.maxSteps }
      : parentRuntime.config,
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

  // ── 5. 构建增强 prompt ───────────────────────────────────────────────────────
  const parts: string[] = [];

  if (parentGoal) {
    parts.push(`## 主任务背景\n${parentGoal}\n`);
  }

  if (upstreamResults.size > 0) {
    const upstreamLines: string[] = [];
    for (const [depId, result] of upstreamResults) {
      upstreamLines.push(`- **${depId}** (${result.expert}): ${result.answer.slice(0, 300)}`);
    }
    parts.push(`## 上游子任务结果\n${upstreamLines.join('\n')}\n`);
  }

  if (spec.contextHint) {
    parts.push(`## 额外背景\n${spec.contextHint}\n`);
  }

  // 专家角色提示
  parts.push(`## 你的角色\n${profile.systemPrompt}\n`);
  parts.push(`## 当前任务\n${spec.goal}`);

  const enrichedGoal = parts.join('\n');

  // ── 6. 执行子 agent ──────────────────────────────────────────────────────────
  let ok = false;
  let answer = '';
  let steps = 0;

  // Surface the run in the desktop 子智能体目录. The parent runtime owns the
  // hook; the sub-runtime inherits it via the spread above, so nested spawns
  // report too. Emitting before the turn is what makes a run visible while it
  // is still in flight.
  parentRuntime.subagentEmit?.({
    phase: 'started',
    id: spec.id,
    goal: spec.goal,
    expert: profile.id,
    subSessionId: subSession.id,
  });

  try {
    const result = await runAgentTurn(subRuntime, enrichedGoal, {
      displayText: `[subagent:${spec.id}] ${spec.goal.slice(0, 80)}`,
    });
    ok = result.ok;
    answer = result.finalAnswer ?? result.reason ?? '(no answer)';
    steps = subSession.messages.filter((m) => m.role === 'assistant').length;
  } catch (err) {
    ok = false;
    answer = err instanceof Error ? err.message : String(err);
  }

  parentRuntime.subagentEmit?.({
    phase: 'done',
    id: spec.id,
    goal: spec.goal,
    expert: profile.id,
    ok,
    answer,
    subSessionId: subSession.id,
    durationMs: Date.now() - t0,
    steps,
  });

  return {
    id: spec.id,
    goal: spec.goal,
    expert: spec.expert,
    ok,
    answer,
    sessionId: subSession.id,
    durationMs: Date.now() - t0,
    steps,
  };
}
