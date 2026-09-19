/**
 * toolHealth.ts — 工具级熔断与健康度追踪（circuit breaker 模式）。
 *
 * 同一工具连续失败 N 次后进入冷却：拒绝执行并提示模型换路径，避免
 * agent 对着同一个坏工具反复烧步数。数据也用于恢复提示与用量分析。
 * 纯内存计数，进程级；不跨会话持久化（刻意保守，重启即清零）。
 */

const DEFAULT_CONSECUTIVE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface ToolHealthSnapshot {
  tool: string;
  calls: number;
  failures: number;
  consecutiveFailures: number;
  /** 0-1 */
  failureRate: number;
  /** 冷却剩余毫秒（0 = 可用） */
  cooldownRemainingMs: number;
}

interface ToolState {
  calls: number;
  failures: number;
  consecutiveFailures: number;
  /** 冷却截止的 epoch ms */
  cooldownUntil: number;
}

export class ToolHealthTracker {
  private readonly states = new Map<string, ToolState>();
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(options: { threshold?: number; cooldownMs?: number } = {}) {
    this.threshold = options.threshold ?? envPositiveInt('AICODE_TOOL_BREAKER_THRESHOLD', DEFAULT_CONSECUTIVE_THRESHOLD);
    this.cooldownMs = options.cooldownMs ?? envPositiveInt('AICODE_TOOL_BREAKER_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);
  }

  /** 记录一次工具结果。成功清零连败计数。 */
  observe(tool: string, ok: boolean): void {
    const state = this.states.get(tool) ?? { calls: 0, failures: 0, consecutiveFailures: 0, cooldownUntil: 0 };
    state.calls += 1;
    if (ok) {
      state.consecutiveFailures = 0;
    } else {
      state.failures += 1;
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= this.threshold) {
        state.cooldownUntil = Date.now() + this.cooldownMs;
        // 触发熔断后重置连败，冷却结束后给工具重新试错的机会
        state.consecutiveFailures = 0;
      }
    }
    this.states.set(tool, state);
  }

  /** 工具是否处于冷却。now 参数便于测试注入。 */
  inCooldown(tool: string, now = Date.now()): boolean {
    const state = this.states.get(tool);
    if (!state) return false;
    return state.cooldownUntil > now;
  }

  /** 冷却拒绝时给模型的提示文本。 */
  cooldownMessage(tool: string, now = Date.now()): string {
    const state = this.states.get(tool);
    const remain = state ? Math.max(0, Math.ceil((state.cooldownUntil - now) / 1000)) : 0;
    return `工具 ${tool} 连续失败已被临时熔断（冷却约 ${remain}s）。请改用其他工具或路径完成该步骤，不要重复调用同一工具。`;
  }

  snapshot(now = Date.now()): ToolHealthSnapshot[] {
    return [...this.states.entries()]
      .map(([tool, state]) => ({
        tool,
        calls: state.calls,
        failures: state.failures,
        consecutiveFailures: state.consecutiveFailures,
        failureRate: state.calls > 0 ? state.failures / state.calls : 0,
        cooldownRemainingMs: Math.max(0, state.cooldownUntil - now),
      }))
      .sort((a, b) => b.failures - a.failures || b.calls - a.calls);
  }

  /** 给恢复提示用的简短摘要（只列失败过的工具）。 */
  failureHints(): string[] {
    return this.snapshot()
      .filter((s) => s.failures > 0)
      .map((s) => `- ${s.tool}: ${s.failures}/${s.calls} 次失败${s.cooldownRemainingMs > 0 ? `（冷却中，剩 ${Math.ceil(s.cooldownRemainingMs / 1000)}s）` : ''}`);
  }
}

/** 进程级默认实例（agent 主循环共享）。 */
export const globalToolHealth = new ToolHealthTracker();
