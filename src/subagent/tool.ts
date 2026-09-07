import type { AgentRuntime } from '../agent/agent.js';
import type { ToolDefinition, ToolResult } from '../tools/index.js';
import { runSubAgentBatch } from './orchestrator.js';
import type { SubAgentBatchInput, SubAgentResult } from './types.js';

/** Valid expert role IDs for validation */
const VALID_EXPERTS = new Set([
  'code_edit', 'code_search', 'git_ops', 'test_verify',
  'doc_generation', 'shell_runtime', 'data_processing', 'general',
]);

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
  if (obj['subagents'].length > 20) {
    throw new Error('spawn_subagent: maximum 20 sub-agents per call');
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
    if (typeof s['expert'] !== 'string' || !VALID_EXPERTS.has(s['expert'])) {
      throw new Error(
        `spawn_subagent: subagents[${idx}].expert must be one of: ${[...VALID_EXPERTS].join(', ')}`,
      );
    }
    if (s['dependsOn'] !== undefined && !Array.isArray(s['dependsOn'])) {
      throw new Error(`spawn_subagent: subagents[${idx}].dependsOn must be an array or omitted`);
    }
    return {
      id: (s['id'] as string).trim(),
      goal: (s['goal'] as string).trim(),
      expert: s['expert'] as SubAgentBatchInput['subagents'][number]['expert'],
      dependsOn: Array.isArray(s['dependsOn']) ? (s['dependsOn'] as string[]) : undefined,
      reasoningEffort: typeof s['reasoningEffort'] === 'string'
        ? s['reasoningEffort'] as SubAgentBatchInput['subagents'][number]['reasoningEffort']
        : undefined,
      maxSteps: typeof s['maxSteps'] === 'number' ? s['maxSteps'] : undefined,
      contextHint: typeof s['contextHint'] === 'string' ? s['contextHint'] : undefined,
    };
  });

  return {
    subagents: specs,
    parentGoal: typeof obj['parentGoal'] === 'string' ? obj['parentGoal'] : undefined,
  };
}

function formatResults(results: SubAgentResult[]): string {
  const successCount = results.filter((r) => r.ok).length;
  const total = results.length;

  const header = `子智能体执行完成 (${successCount}/${total} 成功)\n`;

  const rows = results.map((r) => {
    const status = r.ok ? '✓' : '✗';
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
      '',
      '支持的 expert 角色：',
      '  code_edit       代码编辑/实现/修复（只读+写文件工具）',
      '  code_search     代码搜索/理解/分析（只读工具）',
      '  git_ops         Git 操作（git_* 工具）',
      '  test_verify     测试编写与执行（run_command + 读写）',
      '  doc_generation  文档生成（docx/pptx/xlsx/pdf）',
      '  shell_runtime   Shell/进程/环境操作',
      '  data_processing JSON/CSV/YAML/XML 数据转换',
      '  general         通用（不限工具，谨慎使用）',
      '',
      '用 dependsOn 声明子任务间的依赖关系，框架自动并行无依赖任务、串行有依赖任务。',
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
        },
      ],
      parentGoal: '为整个项目 API 层补充文档',
    }, null, 2),
    risk: 'shell',
    validate(input: unknown): SubAgentBatchInput {
      return validateBatchInput(input);
    },
    async execute(input: SubAgentBatchInput): Promise<ToolResult> {
      try {
        const results = await runSubAgentBatch(input, parentRuntime);
        return { ok: true, output: formatResults(results), data: results };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, output: `spawn_subagent 失败: ${message}` };
      }
    },
  };
}
