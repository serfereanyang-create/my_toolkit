import type { AgentRuntime } from '../agent/agent.js';
import { runSubAgent } from './runner.js';
import type { SubAgentBatchInput, SubAgentResult, SubAgentSpec } from './types.js';

/**
 * 批量子智能体调度器。
 *
 * 调度策略：
 *  - 按 dependsOn 字段建立 DAG
 *  - 每轮找出所有「依赖已完成」的待运行 spec → Promise.all 并行执行
 *  - 直到所有 spec 执行完毕或检测到循环依赖
 */
export async function runSubAgentBatch(
  input: SubAgentBatchInput,
  parentRuntime: AgentRuntime,
): Promise<SubAgentResult[]> {
  const { subagents, parentGoal } = input;

  if (subagents.length === 0) return [];

  // ── 1. 校验：ID 唯一性 ───────────────────────────────────────────────────────
  const ids = new Set<string>();
  for (const spec of subagents) {
    if (ids.has(spec.id)) {
      throw new Error(`spawn_subagent: 重复的子 agent ID "${spec.id}"`);
    }
    ids.add(spec.id);
  }

  // ── 2. 校验：依赖引用必须存在 ────────────────────────────────────────────────
  for (const spec of subagents) {
    for (const dep of spec.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`spawn_subagent: "${spec.id}" 依赖了不存在的子 agent "${dep}"`);
      }
    }
  }

  // ── 3. 拓扑调度主循环 ────────────────────────────────────────────────────────
  const completed = new Map<string, SubAgentResult>();
  const allResults: SubAgentResult[] = [];
  const pending = new Map<string, SubAgentSpec>(subagents.map((s) => [s.id, s]));

  let safetyCounter = 0;
  const maxRounds = subagents.length + 1; // 最多 N 轮，超出则循环依赖

  while (pending.size > 0) {
    if (++safetyCounter > maxRounds) {
      const remaining = [...pending.keys()].join(', ');
      throw new Error(`spawn_subagent: 检测到循环依赖，未能调度的子 agent: ${remaining}`);
    }

    // 找出本轮可以运行的 spec（所有依赖均已完成）
    const runnable: SubAgentSpec[] = [];
    for (const [id, spec] of pending) {
      const deps = spec.dependsOn ?? [];
      if (deps.every((dep) => completed.has(dep))) {
        runnable.push(spec);
        pending.delete(id);
      }
    }

    if (runnable.length === 0 && pending.size > 0) {
      // 本轮没有可运行任务但还有待处理任务 → 循环依赖
      const remaining = [...pending.keys()].join(', ');
      throw new Error(`spawn_subagent: 循环依赖死锁，无法调度: ${remaining}`);
    }

    if (runnable.length === 0) break;

    // 本轮并行执行所有可运行任务
    const batchResults = await Promise.all(
      runnable.map((spec) => {
        // 收集该 spec 所有直接依赖的结果
        const upstreamResults = new Map<string, SubAgentResult>();
        for (const dep of spec.dependsOn ?? []) {
          const r = completed.get(dep);
          if (r) upstreamResults.set(dep, r);
        }
        return runSubAgent(spec, parentRuntime, upstreamResults, parentGoal);
      }),
    );

    for (const result of batchResults) {
      completed.set(result.id, result);
      allResults.push(result);
    }
  }

  // 保持原始声明顺序返回（方便主 agent 阅读）
  return subagents.map((s) => allResults.find((r) => r.id === s.id)!).filter(Boolean);
}
