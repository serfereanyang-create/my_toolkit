import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../agent/agent.js';
import type { SubAgentResult, SubAgentSpec } from './types.js';

/*
 * 批量子智能体调度器的行为契约。
 *
 * 这些断言固定的是「一批子任务怎么跑」：并发上限、依赖顺序、失败怎么传播、
 * 超时与取消怎么收场。调度逻辑全是时序敏感的并发代码，靠肉眼看注释判断对错
 * 不可靠，所以这里用可控制的 runSubAgent 替身把时序钉死。
 *
 * 替身只替换 runSubAgent 一个函数：调度器不碰 LLM、不碰文件系统，其余逻辑
 * （拓扑校验、就绪队列、worker 池、阻断传播）都是真实代码路径。
 */
vi.mock('./runner.js', () => ({ runSubAgent: vi.fn() }));

import { runSubAgent } from './runner.js';
import {
  DEFAULT_SUBAGENT_CONCURRENCY,
  MAX_SUBAGENT_CONCURRENCY,
  runSubAgentBatch,
} from './orchestrator.js';

const mockRun = vi.mocked(runSubAgent);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function spec(id: string, dependsOn?: string[]): SubAgentSpec {
  return { id, goal: `goal-${id}`, expert: 'general', dependsOn };
}

function okResult(s: SubAgentSpec, patch: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    id: s.id,
    goal: s.goal,
    expert: s.expert,
    ok: true,
    answer: `answer-${s.id}`,
    sessionId: `sess-${s.id}`,
    durationMs: 1,
    steps: 1,
    ...patch,
  };
}

/** 最小父运行时：调度器只读 cancelRequested，其余字段原样透传给替身。 */
function runtime(overrides: Record<string, unknown> = {}): AgentRuntime {
  return { cancelRequested: () => false, ...overrides } as unknown as AgentRuntime;
}

/** 记录替身「同时在场」的峰值，用来断言并发上限真的生效。 */
type Peak = { now: number; max: number };

function trackPeak(peak: Peak, holdMs = 5): void {
  mockRun.mockImplementation(async (s) => {
    peak.now += 1;
    peak.max = Math.max(peak.max, peak.now);
    await sleep(holdMs);
    peak.now -= 1;
    return okResult(s);
  });
}

const calledIds = () => mockRun.mock.calls.map((call) => call[0].id);

const byId = (results: SubAgentResult[]) => new Map(results.map((r) => [r.id, r]));

beforeEach(() => {
  mockRun.mockReset();
});

describe('runSubAgentBatch — 启动前校验', () => {
  it('空批次返回空数组，不启动任何子 agent', async () => {
    await expect(runSubAgentBatch({ subagents: [] }, runtime())).resolves.toEqual([]);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('重复 ID 直接拒绝，不启动任何任务', async () => {
    await expect(runSubAgentBatch({ subagents: [spec('a'), spec('a')] }, runtime()))
      .rejects.toThrow(/重复的子 agent ID/);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('依赖了不存在的 ID 直接拒绝', async () => {
    await expect(runSubAgentBatch({ subagents: [spec('a', ['ghost'])] }, runtime()))
      .rejects.toThrow(/依赖了不存在的子 agent/);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('自依赖直接拒绝', async () => {
    await expect(runSubAgentBatch({ subagents: [spec('a', ['a'])] }, runtime()))
      .rejects.toThrow(/不能依赖自身/);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('循环依赖在启动前拒绝，并点名卡住的节点', async () => {
    const subagents = [spec('a', ['c']), spec('b', ['a']), spec('c', ['b'])];
    await expect(runSubAgentBatch({ subagents }, runtime())).rejects.toThrow(/循环依赖/);
    // 关键：不是跑一轮才发现死锁，而是根本没启动任何任务。
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('dependsOn 重复引用同一上游只算一次依赖，不会把下游饿死', async () => {
    mockRun.mockImplementation(async (s) => okResult(s));
    const results = await runSubAgentBatch({ subagents: [spec('a'), spec('b', ['a', 'a'])] }, runtime());
    expect(calledIds()).toEqual(['a', 'b']);
    expect(byId(results).get('b')!.ok).toBe(true);
  });
});

describe('runSubAgentBatch — 并发上限', () => {
  it(`默认并发上限为 ${DEFAULT_SUBAGENT_CONCURRENCY}`, async () => {
    const peak: Peak = { now: 0, max: 0 };
    trackPeak(peak);
    const subagents = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => spec(id));
    const results = await runSubAgentBatch({ subagents }, runtime());
    expect(peak.max).toBe(DEFAULT_SUBAGENT_CONCURRENCY);
    expect(results).toHaveLength(6);
  });

  it('显式 concurrency 生效', async () => {
    const peak: Peak = { now: 0, max: 0 };
    trackPeak(peak);
    const subagents = ['a', 'b', 'c', 'd'].map((id) => spec(id));
    await runSubAgentBatch({ subagents, concurrency: 2 }, runtime());
    expect(peak.max).toBe(2);
  });

  it('concurrency 低于 1 被夹到 1，而不是零 worker 卡死', async () => {
    const peak: Peak = { now: 0, max: 0 };
    trackPeak(peak);
    const subagents = ['a', 'b', 'c'].map((id) => spec(id));
    const results = await runSubAgentBatch({ subagents, concurrency: 0 }, runtime());
    expect(peak.max).toBe(1);
    expect(results).toHaveLength(3);
  });

  it(`concurrency 超过上限被夹到 ${MAX_SUBAGENT_CONCURRENCY}`, async () => {
    const peak: Peak = { now: 0, max: 0 };
    trackPeak(peak, 2);
    const subagents = Array.from({ length: 20 }, (_, i) => spec(`t${i}`));
    const results = await runSubAgentBatch({ subagents, concurrency: 999 }, runtime());
    expect(peak.max).toBe(MAX_SUBAGENT_CONCURRENCY);
    expect(results).toHaveLength(20);
  });
});

describe('runSubAgentBatch — 依赖调度', () => {
  it('下游等上游完成后才开始，并拿到上游结果与 parentGoal', async () => {
    const order: string[] = [];
    const upstreamSeen = new Map<string, string[]>();
    mockRun.mockImplementation(async (s, _rt, upstream) => {
      order.push(`start:${s.id}`);
      upstreamSeen.set(s.id, [...upstream.keys()]);
      await sleep(5);
      order.push(`done:${s.id}`);
      return okResult(s);
    });

    const results = await runSubAgentBatch(
      { subagents: [spec('a'), spec('b', ['a'])], parentGoal: '总目标' },
      runtime(),
    );

    expect(order.indexOf('done:a')).toBeLessThan(order.indexOf('start:b'));
    expect(upstreamSeen.get('a')).toEqual([]);
    expect(upstreamSeen.get('b')).toEqual(['a']);
    // parentGoal 必须透传到每个子 agent，否则子任务不知道整体目标。
    expect(mockRun.mock.calls[0]![3]).toBe('总目标');
    expect(results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('返回顺序按声明顺序，而不是完成顺序', async () => {
    mockRun.mockImplementation(async (s) => {
      await sleep(s.id === 'a' ? 20 : 1);
      return okResult(s);
    });
    const subagents = [spec('a'), spec('b'), spec('c')];
    const results = await runSubAgentBatch({ subagents }, runtime());
    expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('菱形依赖下每个任务只跑一次，汇聚点拿到两条上游', async () => {
    const upstreamSeen = new Map<string, string[]>();
    mockRun.mockImplementation(async (s, _rt, upstream) => {
      upstreamSeen.set(s.id, [...upstream.keys()].sort());
      await sleep(3);
      return okResult(s);
    });
    const subagents = [
      spec('root'),
      spec('left', ['root']),
      spec('right', ['root']),
      spec('join', ['left', 'right']),
    ];

    const results = await runSubAgentBatch({ subagents, concurrency: 4 }, runtime());

    expect(new Set(calledIds()).size).toBe(4);
    expect(calledIds().sort()).toEqual(['join', 'left', 'right', 'root']);
    expect(upstreamSeen.get('join')).toEqual(['left', 'right']);
    expect(byId(results).get('join')!.ok).toBe(true);
  });
});

describe('runSubAgentBatch — 失败传播', () => {
  it('默认 failFast：上游失败则下游被标记 blockedBy 且从未启动', async () => {
    mockRun.mockImplementation(async (s) =>
      s.id === 'a' ? okResult(s, { ok: false, answer: 'boom' }) : okResult(s));

    const results = await runSubAgentBatch(
      { subagents: [spec('a'), spec('b', ['a']), spec('c', ['b']), spec('d')] },
      runtime(),
    );
    const by = byId(results);

    expect(by.get('b')!.ok).toBe(false);
    expect(by.get('b')!.blockedBy).toEqual(['a']);
    expect(by.get('b')!.answer).toContain('未执行');
    // 阻断会沿依赖链传递：b 没跑，c 也拿不到可用的上游。
    expect(by.get('c')!.blockedBy).toEqual(['b']);
    // 无依赖的兄弟任务不受牵连。
    expect(by.get('d')!.ok).toBe(true);
    // 被阻断的任务从未启动 —— 这是「不要带着空结果硬跑」的落点。
    expect(calledIds()).toEqual(['a', 'd']);
  });

  it('多个上游只把真正失败的那个列进 blockedBy', async () => {
    mockRun.mockImplementation(async (s) =>
      s.id === 'bad' ? okResult(s, { ok: false, answer: 'nope' }) : okResult(s));

    const results = await runSubAgentBatch(
      { subagents: [spec('ok1'), spec('bad'), spec('join', ['ok1', 'bad'])] },
      runtime(),
    );
    expect(byId(results).get('join')!.blockedBy).toEqual(['bad']);
  });

  it('failFast:false 时下游照常执行，并读到上游的失败结果', async () => {
    const upstreamSeen = new Map<string, SubAgentResult>();
    mockRun.mockImplementation(async (s, _rt, upstream) => {
      if (upstream.size > 0) upstreamSeen.set(s.id, upstream.get('a')!);
      return s.id === 'a' ? okResult(s, { ok: false, answer: 'boom' }) : okResult(s);
    });

    const results = await runSubAgentBatch(
      { subagents: [spec('a'), spec('b', ['a'])], failFast: false },
      runtime(),
    );

    expect(calledIds()).toContain('b');
    expect(byId(results).get('b')!.ok).toBe(true);
    expect(byId(results).get('b')!.blockedBy).toBeUndefined();
    expect(upstreamSeen.get('b')!.ok).toBe(false);
    expect(upstreamSeen.get('b')!.answer).toBe('boom');
  });

  it('单个任务抛异常不会丢掉整批：记为该项失败，兄弟照跑、下游照常阻断', async () => {
    mockRun.mockImplementation(async (s) => {
      if (s.id === 'bad') throw new Error('session create failed');
      return okResult(s);
    });

    const results = await runSubAgentBatch(
      { subagents: [spec('bad'), spec('good'), spec('after', ['bad'])] },
      runtime(),
    );
    const by = byId(results);

    expect(by.get('bad')!.ok).toBe(false);
    expect(by.get('bad')!.answer).toContain('session create failed');
    expect(by.get('good')!.ok).toBe(true);
    expect(by.get('after')!.blockedBy).toEqual(['bad']);
  });
});

describe('runSubAgentBatch — 超时与父级取消', () => {
  it('单任务超时按协作式中止，标记 timedOut 并保留中止说明', async () => {
    mockRun.mockImplementation(async (s, _rt, _up, _goal, options) => {
      // 模拟子 agent 在安全检查点轮询中止判据：真实 runAgentTurn 就是这么停的。
      while (!options?.cancelRequested?.()) await sleep(2);
      return okResult(s, { ok: false, answer: '已完成部分工作' });
    });

    const results = await runSubAgentBatch(
      { subagents: [spec('slow'), spec('fast'), spec('after', ['slow'])], timeoutMs: 30 },
      runtime(),
    );
    const by = byId(results);

    expect(by.get('slow')!.timedOut).toBe(true);
    expect(by.get('slow')!.ok).toBe(false);
    expect(by.get('slow')!.answer).toContain('超时 30ms');
    // 中止不是硬杀：子 agent 已经做完的部分要留在答案里。
    expect(by.get('slow')!.answer).toContain('已完成部分工作');
    // 超时同样是失败，下游按 failFast 阻断。
    expect(by.get('after')!.blockedBy).toEqual(['slow']);
  });

  it('父级取消后不再启动新任务，在跑与未启动的都标记 cancelled', async () => {
    let cancelled = false;
    mockRun.mockImplementation(async (s, _rt, _up, _goal, options) => {
      while (!options?.cancelRequested?.()) await sleep(2);
      return okResult(s);
    });

    const parent = runtime({ cancelRequested: () => cancelled });
    // 第一个任务开始轮询后父级才取消，覆盖「正在跑」这条路径。
    setTimeout(() => { cancelled = true; }, 15);

    const results = await runSubAgentBatch(
      { subagents: [spec('a'), spec('b'), spec('c')], concurrency: 1 },
      parent,
    );
    const by = byId(results);

    expect(calledIds()).toEqual(['a']);
    expect(by.get('a')!.cancelled).toBe(true);
    expect(by.get('a')!.ok).toBe(false);
    // 父级取消不是超时，两个标记不能混。
    expect(by.get('a')!.timedOut).toBeUndefined();
    // 未启动的任务也要出现在结果里，否则主 agent 不知道它们没跑。
    expect(by.get('b')!.cancelled).toBe(true);
    expect(by.get('b')!.sessionId).toBe('');
    expect(by.get('c')!.cancelled).toBe(true);
    expect(results).toHaveLength(3);
  });
});
