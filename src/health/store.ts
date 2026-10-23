/**
 * health/store.ts — 健康度历史持久化 + 趋势计算
 *
 * 快照存于 <workspace>/.aicode/health/history.json，上限 MAX_SNAPSHOTS。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../utils/atomic.js';
import {
  MAX_SNAPSHOTS,
  METRIC_DIRECTION,
  type HealthSnapshot,
  type HealthTrend,
  type HealthReport,
  type MetricTrend,
  type HealthMetrics,
} from './types.js';

function historyPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.aicode', 'health', 'history.json');
}

export class HealthStore {
  async loadHistory(workspaceRoot: string): Promise<HealthSnapshot[]> {
    try {
      const raw = await readFile(historyPath(workspaceRoot), 'utf8');
      const parsed = JSON.parse(raw) as { snapshots?: HealthSnapshot[] };
      const snapshots = Array.isArray(parsed.snapshots) ? parsed.snapshots : [];
      // 时间升序存放
      return snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    } catch {
      return [];
    }
  }

  async append(workspaceRoot: string, snapshot: HealthSnapshot): Promise<number> {
    const history = await this.loadHistory(workspaceRoot);
    history.push(snapshot);

    // 保留最近 MAX_SNAPSHOTS 份
    const trimmed = history.slice(-MAX_SNAPSHOTS);

    await writeFileAtomic(historyPath(workspaceRoot), JSON.stringify({ snapshots: trimmed }, null, 2));
    return trimmed.length;
  }

  async clear(workspaceRoot: string): Promise<void> {
    try {
      await writeFileAtomic(historyPath(workspaceRoot), JSON.stringify({ snapshots: [] }));
    } catch {
      // Ignore
    }
  }

  /**
   * 计算趋势：比较窗口起点与终点两份快照（默认窗口 30 天内的历史）。
   * 至少需要 2 份快照才有趋势。
   */
  computeTrend(history: HealthSnapshot[], windowDays: number = 30): HealthTrend | null {
    if (history.length < 2) return null;

    const windowStart = Date.now() - windowDays * 24 * 3600 * 1000;
    const inWindow = history.filter((s) => new Date(s.timestamp).getTime() >= windowStart);
    const samples = inWindow.length >= 2 ? inWindow : history.slice(-2);

    const first = samples[0];
    const last = samples[samples.length - 1];

    const metricKeys = Object.keys(METRIC_DIRECTION) as Array<keyof HealthMetrics>;
    const metrics: MetricTrend[] = metricKeys.map((metric) => {
      const a = first.metrics[metric];
      const b = last.metrics[metric];
      const delta = b - a;
      const deltaPercent = a !== 0 ? Math.round((delta / Math.abs(a)) * 1000) / 10 : null;

      let trend: MetricTrend['trend'] = 'stable';
      if (delta === 0) {
        trend = 'stable';
      } else if (METRIC_DIRECTION[metric] === 'higher') {
        trend = delta > 0 ? 'improving' : 'worsening';
      } else {
        trend = delta < 0 ? 'improving' : 'worsening';
      }

      return { metric, first: a, last: b, delta, deltaPercent, trend };
    });

    const overallDelta = last.scores.overall - first.scores.overall;
    const overallTrend: HealthTrend['trend'] =
      overallDelta > 2 ? 'improving' : overallDelta < -2 ? 'worsening' : 'stable';

    const spanDays = Math.max(
      0,
      Math.round((new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / (24 * 3600 * 1000))
    );

    return {
      snapshotCount: samples.length,
      windowDays: spanDays,
      metrics,
      overallDelta,
      trend: overallTrend,
    };
  }

  /** 组装完整健康报告：最新快照 + 趋势 + 人读摘要。 */
  async buildReport(workspaceRoot: string): Promise<HealthReport> {
    const history = await this.loadHistory(workspaceRoot);
    const latest = history.length > 0 ? history[history.length - 1] : null;
    const trend = this.computeTrend(history);

    const summary: string[] = [];
    if (!latest) {
      summary.push('尚无健康快照。运行 health_snapshot 采集第一份数据。');
      return { latest: null, trend: null, summary };
    }

    summary.push(
      '综合健康分 ' + latest.scores.overall + '/100（结构 ' + latest.scores.structure +
      ' · 安全 ' + latest.scores.security + ' · 测试纪律 ' + latest.scores.testDiscipline + '）'
    );
    summary.push(
      '规模: ' + latest.metrics.sourceFiles + ' 源文件 / ' + latest.metrics.testFiles +
      ' 测试文件 / ' + latest.metrics.linesOfCode + ' 行'
    );
    summary.push(
      '质量: 平均复杂度 ' + latest.metrics.avgComplexity +
      '，风险函数 ' + latest.metrics.riskyFunctions +
      '，安全问题 ' + latest.metrics.securityIssues +
      '，重要异味 ' + latest.metrics.codeSmells
    );

    if (trend) {
      const directionText = trend.trend === 'improving' ? '↗ 改善中' : trend.trend === 'worsening' ? '↘ 恶化中' : '→ 稳定';
      summary.push('趋势: ' + directionText + '（综合分变化 ' + (trend.overallDelta >= 0 ? '+' : '') + trend.overallDelta + '，窗口 ' + trend.windowDays + ' 天，' + trend.snapshotCount + ' 份快照）');

      const worsening = trend.metrics.filter((m) => m.trend === 'worsening');
      if (worsening.length > 0) {
        summary.push('恶化指标: ' + worsening.map((m) => m.metric).join(', '));
      }
    }

    return { latest, trend, summary };
  }
}
