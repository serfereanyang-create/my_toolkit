/**
 * reviewLoopTool.ts — review_loop 工具：执行者产出 → 评审者打分 → 未达标带反馈重试。
 *
 * 复用 runSubAgent 作为执行者与评审者（不同 expert），把 supervisor 式
 * 质量回路暴露给主智能体。评审 verdict 由模型按 JSON 协议返回。
 */

import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '../agent/agent.js';
import type { ToolDefinition, ToolResult } from '../tools/index.js';
import { runReviewLoop, parseVerdict, buildReviewerPrompt, type LoopRound } from './reviewLoop.js';

/**
 * 静态基础版：注册进 tools/index.ts 保证工具始终可被发现（与 spawn_subagent
 * 的基础版同模式）。root agent 组装完成后会用 createReviewLoopTool(runtime)
 * replace 掉它；如果没被替换（headless/子 agent），诚实拒绝而不是静默成功。
 */
export const reviewLoopBaseTool: ToolDefinition = {
  name: 'review_loop',
  description: '以“执行→评审→修订”回路完成高质量产出（需要完整交互 runtime）。',
  inputHint: '{"task": "...", "acceptance": ["..."], "expert": "code_edit", "maxRounds": 3}',
  risk: 'shell',
  validate(input: unknown) {
    if (!input || typeof input !== 'object') throw new Error('review_loop: input must be an object');
    const obj = input as Record<string, unknown>;
    if (typeof obj.task !== 'string' || !obj.task.trim()) throw new Error('review_loop: task is required');
    return { task: obj.task };
  },
  async execute(): Promise<ToolResult> {
    return {
      ok: false,
      output: 'review_loop 需要完整交互 runtime（由主智能体在会话启动时注入）。当前上下文未激活该能力。',
    };
  },
};

export function createReviewLoopTool(parentRuntime: AgentRuntime): ToolDefinition {
  return {
    name: 'review_loop',
    description: [
      '以“执行→评审→修订”回路完成一个高质量产出：',
      '  1. 执行者（expert 指定，默认 code_edit）产出候选结果；',
      '  2. 评审者（code_search，只读）按验收点打分输出 JSON verdict；',
      '  3. 未达标（score<80 且未 approved）则把意见拼回任务重试，最多 maxRounds 轮。',
      '适合：对质量要求高、希望自动迭代到位的产出（重构方案、测试设计、文档）。',
      '注意：执行者会真实修改文件；评审者只读。',
    ].join('\n'),
    inputHint: JSON.stringify({
      task: '为 src/utils/date.ts 补齐边界测试',
      acceptance: ['覆盖闰年与时区', '全部测试通过'],
      expert: 'test_verify',
      maxRounds: 3,
    }, null, 2),
    risk: 'shell',
    validate(input: unknown) {
      if (!input || typeof input !== 'object') throw new Error('review_loop: input must be an object');
      const obj = input as Record<string, unknown>;
      if (typeof obj.task !== 'string' || !obj.task.trim()) throw new Error('review_loop: task is required');
      const acceptance = Array.isArray(obj.acceptance)
        ? (obj.acceptance as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 10)
        : [];
      const maxRounds = typeof obj.maxRounds === 'number' && obj.maxRounds > 0
        ? Math.min(5, Math.floor(obj.maxRounds))
        : 3;
      const expert = typeof obj.expert === 'string' ? obj.expert : 'code_edit';
      const validExperts = new Set(['code_edit', 'code_search', 'test_verify', 'doc_generation', 'general']);
      if (!validExperts.has(expert)) {
        throw new Error(`review_loop: expert must be one of ${[...validExperts].join(', ')}`);
      }
      return { task: obj.task.trim(), acceptance, expert, maxRounds };
    },
    async execute(input: { task: string; acceptance: string[]; expert: string; maxRounds: number }): Promise<ToolResult> {
      try {
        const { runSubAgent } = await import('./runner.js');
        const result = await runReviewLoop({
          task: input.task,
          acceptance: input.acceptance,
          options: { maxRounds: input.maxRounds },
          generate: async (prompt, round) => {
            const exec = await runSubAgent(
              {
                id: `rl-exec-${round}-${randomUUID().slice(0, 6)}`,
                goal: prompt,
                expert: input.expert as 'code_edit',
                maxSteps: 40,
              },
              parentRuntime,
              new Map(),
              input.task,
            );
            return exec.answer;
          },
          review: async (candidate) => {
            const rev = await runSubAgent(
              {
                id: `rl-rev-${randomUUID().slice(0, 6)}`,
                goal: buildReviewerPrompt(candidate, input.acceptance),
                expert: 'code_search',
                maxSteps: 10,
              },
              parentRuntime,
              new Map(),
              input.task,
            );
            return parseVerdict(rev.answer);
          },
        });
        return { ok: true, output: formatLoopResult(result, input), data: result };
      } catch (err) {
        return { ok: false, output: `review_loop 失败: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

function formatLoopResult(result: { best: string; rounds: LoopRound[]; approved: boolean; finalScore: number; iterations: number }, input: { task: string }): string {
  const lines: string[] = [
    `## review_loop 结果（${result.iterations} 轮，最终得分 ${result.finalScore}/100，${result.approved ? '已达标' : '未达标'}）`,
    '',
    '### 迭代轨迹',
  ];
  for (const round of result.rounds) {
    const issues = round.verdict.issues.length > 0 ? `；问题: ${round.verdict.issues.join('；').slice(0, 160)}` : '';
    lines.push(`- 第 ${round.index + 1} 轮：score=${round.verdict.score} approved=${round.verdict.approved} — ${round.verdict.summary.slice(0, 80)}${issues}`);
  }
  lines.push('', '### 最终产出', '', result.best.slice(0, 4000));
  return lines.join('\n');
}
