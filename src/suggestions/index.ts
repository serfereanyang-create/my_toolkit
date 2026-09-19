/**
 * suggestions/index.ts — 智能建议模块导出
 */

export { SuggestionEngine } from './engine.js';
export { suggestionTools } from './tools.js';
export {
  PRIORITY_ORDER,
  EFFORT_WEIGHT,
  type Suggestion,
  type SuggestionCategory,
  type SuggestionPriority,
  type SuggestionEffort,
  type SuggestionFilter,
  type SuggestionReport,
} from './types.js';
