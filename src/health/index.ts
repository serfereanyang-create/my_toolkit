/**
 * health/index.ts — 项目健康度模块导出
 */

export { HealthCollector, computeScores, type HealthCollectOptions } from './collector.js';
export { HealthStore, type HealthHistoryRead, type HealthStoreOptions } from './store.js';
export { healthTools } from './tools.js';
export {
  METRIC_DIRECTION,
  MAX_SNAPSHOTS,
  type HealthMetrics,
  type HealthScores,
  type HealthSnapshot,
  type HealthTrend,
  type HealthReport,
  type HealthMetricTrend,
  type MetricTrend,
} from './types.js';
