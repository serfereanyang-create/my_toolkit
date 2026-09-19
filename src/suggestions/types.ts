/**
 * suggestions/types.ts — 智能代码建议引擎类型
 *
 * 建议引擎不重复实现检测逻辑，而是把复杂度、异味、安全、依赖图等
 * 分析器的输出归并为去重、评分、排序后的可执行改进建议。
 */

export type SuggestionCategory =
  | 'refactor'      // 重构：提取方法、简化条件等
  | 'security'      // 安全修复
  | 'performance'   // 性能优化
  | 'testing'       // 测试补充
  | 'architecture'; // 架构/依赖治理

export type SuggestionPriority = 'critical' | 'high' | 'medium' | 'low';

export type SuggestionEffort = 'trivial' | 'easy' | 'medium' | 'hard';

export type Suggestion = {
  /** 稳定 ID：类别+文件+行+类型哈希，用于去重与增量跟踪 */
  id: string;
  title: string;
  category: SuggestionCategory;
  priority: SuggestionPriority;
  file: string;
  line: number;
  /** 问题描述与修复思路（给 agent 或人的完整上下文） */
  description: string;
  /** 量化依据（复杂度数值、问题数等） */
  rationale: string;
  effort: SuggestionEffort;
  /** 修复后预期收益 0-100 */
  impact: number;
  /** 引擎能否通过现有重构工具自动完成 */
  automatable: boolean;
  /** 建议使用的 CLI 工具名（automatable 时给出） */
  suggestedTool?: string;
};

export type SuggestionFilter = {
  categories?: SuggestionCategory[];
  minPriority?: SuggestionPriority;
  filePattern?: string;
  maxResults?: number;
  onlyAutomatable?: boolean;
};

export type SuggestionReport = {
  generatedAt: string;
  durationMs: number;
  totalFiles: number;
  suggestions: Suggestion[];
  stats: Record<SuggestionCategory, number>;
  quickWins: Suggestion[];
};

export const PRIORITY_ORDER: Record<SuggestionPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const EFFORT_WEIGHT: Record<SuggestionEffort, number> = {
  trivial: 1,
  easy: 2,
  medium: 4,
  hard: 7,
};
