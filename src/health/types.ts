/**
 * health/types.ts — 项目健康度仪表板数据层类型
 *
 * 为桌面 UI 仪表板准备的数据层：定期采集快照 → 持久化历史 → 计算趋势。
 * 所有数值都是确定性派生的，UI 只需渲染 JSON。
 */

export type HealthMetricTrend = 'improving' | 'stable' | 'worsening' | 'no-data';

export type HealthMetrics = {
  /** 源文件行数（不含测试与生成目录） */
  linesOfCode: number;
  sourceFiles: number;
  testFiles: number;
  /** 测试文件 / 源文件 * 100 */
  testRatio: number;
  /** 平均圈复杂度 */
  avgComplexity: number;
  /** 高风险（critical+high）函数数 */
  riskyFunctions: number;
  /** critical+high 安全问题数 */
  securityIssues: number;
  /** critical+major 代码异味数 */
  codeSmells: number;
};

export type HealthScores = {
  /** 综合健康分 0-100 */
  overall: number;
  structure: number;
  security: number;
  testDiscipline: number;
};

export type HealthSnapshot = {
  id: string;
  timestamp: string;
  metrics: HealthMetrics;
  scores: HealthScores;
};

export type MetricTrend = {
  metric: keyof HealthMetrics;
  first: number;
  last: number;
  delta: number;
  /** 相对变化百分比，首值为 0 时为 null */
  deltaPercent: number | null;
  trend: HealthMetricTrend;
};

export type HealthTrend = {
  snapshotCount: number;
  windowDays: number;
  /** 趋势向量：值上升是否算"好转"由 metricDirection 定义 */
  metrics: MetricTrend[];
  overallDelta: number;
  trend: HealthMetricTrend;
};

export type HealthReport = {
  latest: HealthSnapshot | null;
  trend: HealthTrend | null;
  /** 给 UI/agent 的中文摘要 */
  summary: string[];
};

/**
 * 指标方向定义：值越高越好（'higher'）还是越低越好（'lower'）。
 * 决定趋势标签 improving/worsening。
 */
export const METRIC_DIRECTION: Record<keyof HealthMetrics, 'higher' | 'lower'> = {
  linesOfCode: 'higher',
  sourceFiles: 'higher',
  testFiles: 'higher',
  testRatio: 'higher',
  avgComplexity: 'lower',
  riskyFunctions: 'lower',
  securityIssues: 'lower',
  codeSmells: 'lower',
};

/** 历史存储上限，防止无限增长。 */
export const MAX_SNAPSHOTS = 200;
