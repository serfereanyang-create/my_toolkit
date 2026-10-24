import { resolve } from 'node:path';
import type { AgentRuntime } from '../agent/agent.js';
import { runSubAgent } from './runner.js';
import type { SubAgentBatchInput, SubAgentResult, SubAgentSpec } from './types.js';

/**
 * 批量子智能体调度器。
 *
 * 调度策略：
 *  - 按 dependsOn 建 DAG，启动前做一次拓扑校验（有环直接报错）
 *  - 就绪队列 + 固定大小 worker 池，最多 concurrency 个并发（不再整轮 barrier）
 *  - 上游失败时阻断依赖它的任务，标记 blockedBy，而不是让它带着空结果硬跑
 *  - 单任务超时走协作式中止（复用 runtime.cancelRequested），不硬杀进程
 *  - 父级取消后不再启动新任务，未启动的标记 cancelled
 *
 * 每个任务的 started/done 事件仍由 runSubAgent 发往 subagentEmit，桌面目录照旧。
 */
export const DEFAULT_SUBAGENT_CONCURRENCY = 4;
export const MAX_SUBAGENT_CONCURRENCY = 16;
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 600_000;
export const MAX_SUBAGENTS_PER_BATCH = 64;

function normalizeWorkspacePath(workspaceRoot: string, path: string): string {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '');
  const rootValue = normalize(resolve(workspaceRoot));
  const absoluteValue = normalize(resolve(workspaceRoot, path));
  const root = process.platform === 'win32' ? rootValue.toLowerCase() : rootValue;
  const absolute = process.platform === 'win32' ? absoluteValue.toLowerCase() : absoluteValue;
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw new Error(`writePaths must stay inside the workspace: ${path}`);
  }
  return absolute;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function clampConcurrency(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SUBAGENT_CONCURRENCY;
  return Math.min(MAX_SUBAGENT_CONCURRENCY, Math.max(1, Math.floor(value)));
}

function clampTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_SUBAGENT_TIMEOUT_MS;
  return Math.floor(value);
}

/** 校验 ID 唯一性与依赖引用，返回 id -> spec 与 id -> 依赖表。 */
function validateSpecs(subagents: SubAgentSpec[]): {
  byId: Map<string, SubAgentSpec>;
  deps: Map<string, string[]>;
} {
  if (subagents.length > MAX_SUBAGENTS_PER_BATCH) {
    throw new Error(`spawn_subagent: maximum ${MAX_SUBAGENTS_PER_BATCH} sub-agents per call`);
  }
  const byId = new Map<string, SubAgentSpec>();
  for (const spec of subagents) {
    if (byId.has(spec.id)) throw new Error(`spawn_subagent: 重复的子 agent ID "${spec.id}"`);
    byId.set(spec.id, spec);
  }

  const deps = new Map<string, string[]>();
  for (const spec of subagents) {
    const list = spec.dependsOn ?? [];
    for (const dep of list) {
      if (!byId.has(dep)) throw new Error(`spawn_subagent: "${spec.id}" 依赖了不存在的子 agent "${dep}"`);
      if (dep === spec.id) throw new Error(`spawn_subagent: "${spec.id}" 不能依赖自身`);
    }
    deps.set(spec.id, [...new Set(list)]);
  }
  return { byId, deps };
}

/** 拓扑校验：有环时给出仍然卡住的节点，而不是靠轮数上限猜测。 */
function assertAcyclic(
  subagents: SubAgentSpec[],
  deps: Map<string, string[]>,
  dependents: Map<string, string[]>,
): void {
  const indeg = new Map(subagents.map((s) => [s.id, deps.get(s.id)!.length]));
  const queue = subagents.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  let seen = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    seen += 1;
    for (const next of dependents.get(id) ?? []) {
      const left = indeg.get(next)! - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (seen !== subagents.length) {
    const stuck = subagents.filter((s) => (indeg.get(s.id) ?? 0) > 0).map((s) => s.id).join(', ');
    throw new Error(`spawn_subagent: 检测到循环依赖，未能调度的子 agent: ${stuck}`);
  }
}

export async function runSubAgentBatch(
  input: SubAgentBatchInput,
  parentRuntime: AgentRuntime,
): Promise<SubAgentResult[]> {
  const { subagents, parentGoal } = input;
  if (subagents.length === 0) return [];

  const { byId, deps } = validateSpecs(subagents);
  const concurrency = clampConcurrency(input.concurrency);
  const timeoutMs = clampTimeout(input.timeoutMs);
  const failFast = input.failFast !== false;

  const dependents = new Map<string, string[]>();
  for (const spec of subagents) {
    for (const dep of deps.get(spec.id)!) {
      const list = dependents.get(dep) ?? [];
      list.push(spec.id);
      dependents.set(dep, list);
    }
  }
  assertAcyclic(subagents, deps, dependents);

  const total = subagents.length;
  const results = new Map<string, SubAgentResult>();
  const indeg = new Map(subagents.map((s) => [s.id, deps.get(s.id)!.length]));
  const ready: string[] = subagents.filter((s) => deps.get(s.id)!.length === 0).map((s) => s.id);
  ready.sort((left, right) => (byId.get(right)?.priority ?? 0) - (byId.get(left)?.priority ?? 0));
  const workspaceRoot = parentRuntime.config?.workspaceRoot ?? process.cwd();
  const writePaths = new Map<string, string[]>();
  for (const spec of subagents) {
    writePaths.set(spec.id, (spec.writePaths ?? []).map((path) => normalizeWorkspacePath(workspaceRoot, path)));
  }
  const activeWritePaths = new Map<string, string[]>();

  let settled = 0;
  let inFlight = 0;
  let parentCancelled = false;

  // Workers park here when the ready queue is momentarily empty but tasks are
  // still running; completing a task wakes them with newly unblocked work.
  const waiters: Array<() => void> = [];
  const notify = () => { while (waiters.length > 0) waiters.shift()!(); };
  const waitForWork = () => new Promise<void>((resolve) => waiters.push(resolve));

  const record = (result: SubAgentResult) => {
    results.set(result.id, result);
    settled += 1;
  };

  /** 记录一个「未执行」结果：被上游失败阻断，或父级取消。 */
  const markNotRun = (id: string, reason: 'blocked' | 'cancelled', blockedBy?: string[]) => {
    const spec = byId.get(id)!;
    const answer = reason === 'blocked'
      ? `未执行：上游子智能体失败 (${(blockedBy ?? []).join(', ')})，依赖任务已阻断。`
      : '未执行：父级已取消，本任务未启动。';
    record({
      id,
      goal: spec.goal,
      expert: spec.expert,
      ok: false,
      answer,
      sessionId: '',
      durationMs: 0,
      steps: 0,
      ...(reason === 'blocked' ? { blockedBy } : { cancelled: true }),
    });
    release(id);
  };

  /** 一个任务落定后，放行它的下游。 */
  function release(id: string): void {
    for (const next of dependents.get(id) ?? []) {
      const left = indeg.get(next)! - 1;
      indeg.set(next, left);
      if (left > 0) continue;
      if (parentCancelled) { markNotRun(next, 'cancelled'); continue; }
      if (failFast) {
        const failed = deps.get(next)!.filter((dep) => results.get(dep)?.ok !== true);
        if (failed.length > 0) { markNotRun(next, 'blocked', failed); continue; }
      }
      ready.push(next);
    }
    ready.sort((left, right) => (byId.get(right)?.priority ?? 0) - (byId.get(left)?.priority ?? 0));
    notify();
  }

  const runOne = async (id: string): Promise<void> => {
    const spec = byId.get(id)!;
    const upstreamResults = new Map<string, SubAgentResult>();
    for (const dep of deps.get(id)!) {
      const upstream = results.get(dep);
      if (upstream) upstreamResults.set(dep, upstream);
    }

    const deadline = Date.now() + timeoutMs;
    let stopReason: 'timeout' | 'parent' | null = null;

    inFlight += 1;
    let result: SubAgentResult;
    try {
      result = await runSubAgent(spec, parentRuntime, upstreamResults, parentGoal, {
        // Reuse the runtime's cooperative cancel poll so the sub-agent stops at
        // a safe boundary (between steps) instead of us killing a live process.
        cancelRequested: () => {
          if (Date.now() > deadline) { stopReason = 'timeout'; return true; }
          if (parentRuntime.cancelRequested?.() === true) { stopReason = 'parent'; return true; }
          return false;
        },
      });
    } catch (err) {
      // 一个任务崩掉不能连坐整批：runSubAgent 自己吞掉 turn 级异常，能冒到这里的
      // 是基础设施故障（建会话、事件钩子）。记成这一项失败，让 DAG 继续走 ——
      // 兄弟任务保住已完成的工作，下游按 failFast 正常被阻断。
      result = {
        id: spec.id,
        goal: spec.goal,
        expert: spec.expert,
        ok: false,
        answer: `子智能体启动失败：${err instanceof Error ? err.message : String(err)}`,
        sessionId: '',
        durationMs: 0,
        steps: 0,
      };
    } finally {
      inFlight -= 1;
    }

    if (stopReason === 'timeout') {
      result.ok = false;
      result.timedOut = true;
      result.answer = `超时 ${timeoutMs}ms 已在中止点停止：${result.answer}`;
    } else if (stopReason === 'parent') {
      result.ok = false;
      result.cancelled = true;
      parentCancelled = true;
    }

    record(result);
    release(id);
  };

  const worker = async (): Promise<void> => {
    while (settled < total) {
      if (parentCancelled || parentRuntime.cancelRequested?.() === true) {
        parentCancelled = true;
        notify();
        return;
      }
      const readyIndex = ready.findIndex((candidate) => {
        const candidatePaths = writePaths.get(candidate) ?? [];
        return ![...activeWritePaths.values()].some((activePaths) =>
          candidatePaths.some((candidatePath) => activePaths.some((activePath) => pathsOverlap(candidatePath, activePath))),
        );
      });
      const id = readyIndex >= 0 ? ready.splice(readyIndex, 1)[0] : undefined;
      if (id === undefined) {
        // Nothing runnable right now. If nothing is running either, the DAG is
        // inconsistent — bail out rather than park forever.
        if (inFlight === 0) return;
        await waitForWork();
        continue;
      }
      activeWritePaths.set(id, writePaths.get(id) ?? []);
      try {
        await runOne(id);
      } finally {
        activeWritePaths.delete(id);
        notify();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));

  // Anything still unrecorded was never started (parent cancel or failFast stop).
  for (const spec of subagents) {
    if (!results.has(spec.id)) markNotRun(spec.id, 'cancelled');
  }

  // 保持原始声明顺序返回（方便主 agent 阅读）
  return subagents.map((s) => results.get(s.id)!).filter(Boolean);
}
