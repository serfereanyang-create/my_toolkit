import type { AgentRuntime } from '../agent/agent.js';
import { allExperts } from '../experts/profiles.js';
import { selectExpertForGoal } from '../experts/router.js';
import type { ToolDefinition, ToolResult } from '../tools/index.js';
import { runSubAgentBatch } from './orchestrator.js';
import { MAX_SUBAGENT_CONCURRENCY, MAX_SUBAGENTS_PER_BATCH } from './orchestrator.js';
import type { SubAgentBatchInput, SubAgentResult } from './types.js';

/**
 * Valid expert role IDs for validation.
 *
 * Derived from the roster rather than hardcoded: the previous literal list
 * silently rejected any expert added to profiles.ts, so a new role was
 * unusable until someone remembered to edit this file too.
 */
const VALID_EXPERTS = new Set(allExperts.map((e) => e.id));

/**
 * Dispatch tiers a sub-agent may be routed to. Kept in sync with
 * tierRouter's DispatchTier: the router resolves all three, so the tool must
 * accept all three — accepting only two silently dropped `standard` back onto
 * the parent model.
 */
const VALID_TIERS = new Set(['expensive', 'standard', 'cheap']);

/**
 * 子智能体嵌套深度上限：root agent 为 0 层，其派生的子 agent 为 1 层，以此类推。
 * 子 agent 自身携带 spawn_subagent 时深度递增，达到上限即拒绝，防止无限递归。
 */
export const MAX_SUBAGENT_DEPTH = 3;

function validateBatchInput(raw: unknown): SubAgentBatchInput {
  if (!raw || typeof raw !== 'object') {
    throw new Error('spawn_subagent: input must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj['subagents'])) {
    throw new Error('spawn_subagent: "subagents" must be an array');
  }
  if (obj['subagents'].length === 0) {
    throw new Error('spawn_subagent: "subagents" array must not be empty');
  }
  if (obj['subagents'].length > MAX_SUBAGENTS_PER_BATCH) {
    throw new Error(`spawn_subagent: maximum ${MAX_SUBAGENTS_PER_BATCH} sub-agents per call`);
  }

  const specs = (obj['subagents'] as unknown[]).map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`spawn_subagent: subagents[${idx}] must be an object`);
    }
    const s = item as Record<string, unknown>;
    if (typeof s['id'] !== 'string' || !s['id'].trim()) {
      throw new Error(`spawn_subagent: subagents[${idx}].id must be a non-empty string`);
    }
    if (typeof s['goal'] !== 'string' || !s['goal'].trim()) {
      throw new Error(`spawn_subagent: subagents[${idx}].goal must be a non-empty string`);
    }
    if (s['expert'] !== undefined && typeof s['expert'] !== 'string') {
      throw new Error(`spawn_subagent: subagents[${idx}].expert must be a string when provided`);
    }
    const goal = (s['goal'] as string).trim();
    const expert = typeof s['expert'] === 'string' ? s['expert'].trim() : selectExpertForGoal(goal).id;
    if (!VALID_EXPERTS.has(expert)) {
      throw new Error(
        `spawn_subagent: subagents[${idx}].expert must be one of: ${[...VALID_EXPERTS].join(', ')}`,
      );
    }
    if (s['dependsOn'] !== undefined && !Array.isArray(s['dependsOn'])) {
      throw new Error(`spawn_subagent: subagents[${idx}].dependsOn must be an array or omitted`);
    }
    if (Array.isArray(s['dependsOn']) && s['dependsOn'].some((dependency) => typeof dependency !== 'string')) {
      throw new Error(`spawn_subagent: subagents[${idx}].dependsOn must contain only strings`);
    }
    if (s['tier'] !== undefined && (typeof s['tier'] !== 'string' || !VALID_TIERS.has(s['tier']))) {
      throw new Error(`spawn_subagent: subagents[${idx}].tier must be one of: ${[...VALID_TIERS].join(', ')}`);
    }
    if (s['priority'] !== undefined && (typeof s['priority'] !== 'number' || !Number.isFinite(s['priority']))) {
      throw new Error(`spawn_subagent: subagents[${idx}].priority must be a finite number or omitted`);
    }
    if (s['writePaths'] !== undefined && !Array.isArray(s['writePaths'])) {
      throw new Error(`spawn_subagent: subagents[${idx}].writePaths must be an array or omitted`);
    }
    if (Array.isArray(s['writePaths']) && s['writePaths'].some((path) => typeof path !== 'string' || !path.trim())) {
      throw new Error(`spawn_subagent: subagents[${idx}].writePaths must contain non-empty strings`);
    }
    return {
      id: (s['id'] as string).trim(),
      goal,
      label: typeof s['label'] === 'string' && s['label'].trim() ? s['label'].trim() : undefined,
      expert,
      dependsOn: Array.isArray(s['dependsOn']) ? (s['dependsOn'] as string[]) : undefined,
      reasoningEffort: typeof s['reasoningEffort'] === 'string'
        ? s['reasoningEffort'] as SubAgentBatchInput['subagents'][number]['reasoningEffort']
        : undefined,
      maxSteps: typeof s['maxSteps'] === 'number' ? s['maxSteps'] : undefined,
      contextHint: typeof s['contextHint'] === 'string' ? s['contextHint'] : undefined,
      tier: s['tier'] as SubAgentBatchInput['subagents'][number]['tier'],
      priority: typeof s['priority'] === 'number' ? s['priority'] : undefined,
      writePaths: Array.isArray(s['writePaths']) ? (s['writePaths'] as string[]).map((path) => path.trim()) : undefined,
    };
  });

  // 调度旋钮：必须在这里显式转发，否则调度器永远只能拿到默认值 —— 曾经
  // concurrency/failFast/timeoutMs 只存在于 types.ts 和调度器里，模型填了也
  // 会被这一层丢掉，功能等于没接上。
  const concurrency = obj['concurrency'];
  if (concurrency !== undefined && (typeof concurrency !== 'number' || !Number.isFinite(concurrency))) {
    throw new Error('spawn_subagent: "concurrency" must be a number or omitted');
  }
  const failFast = obj['failFast'];
  if (failFast !== undefined && typeof failFast !== 'boolean') {
    throw new Error('spawn_subagent: "failFast" must be a boolean or omitted');
  }
  const timeoutMs = obj['timeoutMs'];
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs))) {
    throw new Error('spawn_subagent: "timeoutMs" must be a number or omitted');
  }

  return {
    subagents: specs,
    parentGoal: typeof obj['parentGoal'] === 'string' ? obj['parentGoal'] : undefined,
    concurrency: typeof concurrency === 'number' ? concurrency : undefined,
    failFast: typeof failFast === 'boolean' ? failFast : undefined,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
  };
}

function formatResults(results: SubAgentResult[]): string {
  const successCount = results.filter((r) => r.ok).length;
  const total = results.length;

  const header = `子智能体执行完成 (${successCount}/${total} 成功)\n`;

  const rows = results.map((r) => {
    const status = r.ok
      ? '✓'
      : r.blockedBy ? `blocked:${r.blockedBy.join(',')}`
        : r.cancelled ? 'cancelled'
          : r.timedOut ? 'timeout'
            : '✗';
    const summary = r.answer.replace(/\n+/g, ' ').slice(0, 200);
    const duration = r.durationMs < 1000
      ? `${r.durationMs}ms`
      : `${(r.durationMs / 1000).toFixed(1)}s`;
    return `| ${r.id} | ${r.expert} | ${r.goal.slice(0, 60)} | ${status} | ${duration} | ${summary} |`;
  });

  const table = [
    '| ID | 角色 | 目标 | 状态 | 耗时 | 摘要 |',
    '|----|------|------|------|------|------|',
    ...rows,
  ].join('\n');

  const details = results
    .filter((r) => !r.ok)
    .map((r) => `\n### ✗ ${r.id} 失败详情\n${r.answer}`)
    .join('\n');

  return header + '\n' + table + (details || '');
}

/**
 * 创建 spawn_subagent 工具定义。
 * 必须在 AgentRuntime 组装完成后调用（需要 parentRuntime 引用）。
 */
export function createSpawnSubagentTool(parentRuntime: AgentRuntime): ToolDefinition {
  return {
    name: 'spawn_subagent',
    description: [
      '将当前任务拆解为多个子任务，交给专门的子智能体并行或串行完成。',
      '每个子智能体拥有独立会话和按角色限制的工具集。',
      '适用于：多文件重构、同时研究+实现、写代码+写测试+写文档等复合型任务。',
      'expert 可省略：框架会根据 goal 自动选择最合适的专家；明确指定时优先使用你的选择。',
      '',
      '支持的 expert 角色：',
      ...allExperts.map((expert) => `  ${expert.id.padEnd(16)} ${expert.description}`),
      '',
      '用 dependsOn 声明子任务间的依赖关系，框架自动并行无依赖任务、串行有依赖任务。',
      '',
      '每个子任务可选的档位参数：',
      '  tier         该子任务跑在哪一档模型上：expensive（贵档，出方案/终审）、',
      '               standard（中档，普通功能开发）、cheap（便宜档，写代码/排查）。',
      '               省略则继承父模型。可用档位取决于会话是否执行过 /省钱分级',
      '               或桌面是否配置了全局默认。',
      '',
      '调度参数（都可省略）：',
      `  concurrency  同时运行的上限，默认 4，上限 ${MAX_SUBAGENT_CONCURRENCY}。批量大且任务重时调低。`,
      '  failFast     上游失败时是否阻断依赖它的任务，默认 true。',
      '               被阻断的任务会带 blockedBy 说明，而不是带着空结果硬跑。',
      '  timeoutMs    单个子任务的超时（ms），默认 600000。超时在安全检查点中止，',
      '               不硬杀进程，已完成的工具结果保留。',
      '  priority     数字越大越优先。writePaths 重叠的任务会自动错峰，避免覆盖。',
      '有任务失败时，先读它的 answer 判断原因，再决定是否补派一个子任务，不要直接放弃整批。',
    ].join('\n'),
    inputHint: JSON.stringify({
      subagents: [
        {
          id: 'analyzer',
          goal: '分析 src/ 目录找出所有 API 端点',
          expert: 'code_search',
        },
        {
          id: 'writer',
          goal: '为找到的 API 端点补充 JSDoc 注释',
          expert: 'code_edit',
          dependsOn: ['analyzer'],
          tier: 'cheap',
          writePaths: ['src/routes.ts'],
          priority: 10,
        },
      ],
      parentGoal: '为整个项目 API 层补充文档',
      concurrency: 4,
      failFast: true,
      timeoutMs: 600000,
    }, null, 2),
    risk: 'shell',
    validate(input: unknown): SubAgentBatchInput {
      return validateBatchInput(input);
    },
    async execute(input: SubAgentBatchInput): Promise<ToolResult> {
      try {
        // 深度防护：runtime.subAgentDepth 由 runSubAgent 递增（root=0）。
        const currentDepth = parentRuntime.subAgentDepth ?? 0;
        if (currentDepth >= MAX_SUBAGENT_DEPTH) {
          return {
            ok: false,
            output: `spawn_subagent 已达嵌套深度上限（${MAX_SUBAGENT_DEPTH} 层，当前 ${currentDepth} 层）。请直接完成任务，不要再派生子智能体。`,
          };
        }
        const results = await runSubAgentBatch(input, parentRuntime);
        return { ok: results.every((result) => result.ok), output: formatResults(results), data: results };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, output: `spawn_subagent 失败: ${message}` };
      }
    },
  };
}
