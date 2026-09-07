import type { ExpertIntent } from '../experts/types.js';
import type { ReasoningEffort } from '../providers/types.js';

/**
 * 单个子智能体任务规格
 * 主 agent 在调用 spawn_subagent 时填写这个结构体。
 */
export type SubAgentSpec = {
  /** 调用方给定的逻辑 ID，用于 dependsOn 中互相引用 */
  id: string;
  /** 子任务的自然语言目标 */
  goal: string;
  /**
   * 专家角色 → 自动限制可用工具集和 toolScope。
   * 无需主 agent 手动列举工具，框架根据 ExpertProfile 自动过滤。
   */
  expert: ExpertIntent;
  /**
   * 依赖的其他子 agent ID 列表。
   * 只有列表中所有子 agent 都完成后，本任务才会开始执行。
   * 省略或传空数组 = 无依赖，可与其他无依赖任务并行。
   */
  dependsOn?: string[];
  /**
   * 给子 agent 的推理档位覆盖（可省略，默认继承主 agent 设置）。
   * 纯搜索类子任务可用 'low' 节省 token；关键修复用 'high'。
   */
  reasoningEffort?: ReasoningEffort;
  /** 最大执行步数覆盖，默认使用主 agent config.maxSteps */
  maxSteps?: number;
  /**
   * 额外背景信息，会注入到子 agent 的 prompt 前缀。
   * 框架会自动将上游依赖的 finalAnswer 摘要注入，
   * 此字段用于额外补充主 agent 认为子 agent 需要知道的上下文。
   */
  contextHint?: string;
};

/**
 * 单个子智能体的执行结果，主 agent 通过 tool result 读取此结构的序列化形式。
 */
export type SubAgentResult = {
  /** 对应 SubAgentSpec.id */
  id: string;
  /** 对应 SubAgentSpec.goal */
  goal: string;
  /** 使用的专家角色 */
  expert: ExpertIntent;
  /** 执行是否成功 */
  ok: boolean;
  /** 子 agent 的 finalAnswer，或失败时的 reason */
  answer: string;
  /** 子会话 ID，可用于审计、调试 */
  sessionId: string;
  /** 执行耗时（ms） */
  durationMs: number;
  /** 实际执行的 LLM 步数 */
  steps: number;
};

/**
 * spawn_subagent 工具的输入格式（主 agent 传给工具的 JSON）。
 */
export type SubAgentBatchInput = {
  /** 要派发的子智能体列表（可以有依赖关系，框架自动调度） */
  subagents: SubAgentSpec[];
  /**
   * 主任务目标描述（可省略）。
   * 注入到每个子 agent 的 system context，让子 agent 了解整体大目标。
   */
  parentGoal?: string;
};
