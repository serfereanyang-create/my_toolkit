/**
 * health/store.ts — 健康度历史持久化 + 趋势计算
 *
 * 快照存于 <workspace>/.aicode/health/history.json，上限 MAX_SNAPSHOTS。
 *
 * 这是一个整文件「读—改—写」，所以和记忆库/CLI 历史同一组失效模式：
 *   - 两个写入方各读同一份快照再写回，后写的把先写的整份覆盖（实测：
 *     10 次并发 append 只剩 1 份）；
 *   - 文件被写坏后，`loadHistory` 静默返回 []，下一次 append 再把坏文件
 *     直接盖掉——损坏那几份快照从此没有任何副本。
 * 因此：进程内串行化 + 跨进程文件锁、损坏文件先挪开保留、读不出来的文件
 * 绝不覆盖，并把「历史不可读」作为报告的一部分说出来，而不是当成空历史。
 */

import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { serializeWrites, writeFileAtomic } from '../utils/atomic.js';
import { withFileLock, type LockOptions } from '../utils/lockfile.js';
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

/**
 * What the history file looked like.
 *
 * `missing` and `corrupt` both yield an empty list, but only one of them is safe
 * to overwrite: a corrupt file is somebody's data, a missing one is nobody's.
 */
export type HealthHistoryRead = {
  snapshots: HealthSnapshot[];
  status: 'ok' | 'missing' | 'corrupt' | 'unreadable';
  /** Where the damaged file was preserved, once quarantine ran. */
  quarantinedTo?: string;
  /** One-line explanation for the report. */
  note?: string;
};

export type HealthStoreOptions = {
  lock?: LockOptions;
  now?: () => number;
};

export class HealthStore {
  constructor(private readonly options: HealthStoreOptions = {}) {}

  /** 读历史（兼容旧调用方）。损坏时返回空数组；详情见 readHistory。 */
  async loadHistory(workspaceRoot: string): Promise<HealthSnapshot[]> {
    return (await this.readHistory(workspaceRoot)).snapshots;
  }

  /** 读历史并说明它为什么是空的。 */
  async readHistory(workspaceRoot: string): Promise<HealthHistoryRead> {
    const file = historyPath(workspaceRoot);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { snapshots: [], status: 'missing' };
      }
      return {
        snapshots: [],
        status: 'unreadable',
        note: `健康历史无法读取（${(error as NodeJS.ErrnoException).code ?? '未知错误'}），本次结果没有覆盖它。`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { snapshots: [], status: 'corrupt', note: '健康历史文件不是有效 JSON，已保留损坏文件并重新开始记录。' };
    }
    const snapshots = (parsed as { snapshots?: unknown })?.snapshots;
    if (!Array.isArray(snapshots)) {
      return { snapshots: [], status: 'corrupt', note: '健康历史文件结构不对（缺少 snapshots 数组），已保留损坏文件并重新开始记录。' };
    }
    const valid = snapshots.filter(isSnapshot);
    // 时间升序存放
    return { snapshots: valid.sort((a, b) => a.timestamp.localeCompare(b.timestamp)), status: 'ok' };
  }

  /**
   * 追加一份快照，返回历史条数。
   *
   * 并发安全：同一进程内按路径串行，跨进程用文件锁，且「读」在锁内进行——
   * 锁外读到的快照可能是上一个写者马上要替换掉的旧版本。
   * 幂等：同一份快照（id + timestamp 相同）重复追加只留一条，重试不会翻倍。
   */
  async append(workspaceRoot: string, snapshot: HealthSnapshot): Promise<number> {
    const file = historyPath(workspaceRoot);
    return serializeWrites(file, () =>
      withFileLock(`${file}.lock`, async () => {
        const read = await this.readHistory(workspaceRoot);
        if (read.status === 'unreadable') {
          // 内容存在但读不到（EPERM/EBUSY/EIO）：绝不覆盖看不见的数据。
          throw new Error(read.note ?? '健康历史无法读取，未写入新快照。');
        }
        if (read.status === 'corrupt') {
          await this.quarantine(file);
        }

        const history = [...read.snapshots];
        const duplicate = history.some(
          (item) => item.id === snapshot.id && item.timestamp === snapshot.timestamp,
        );
        if (!duplicate) history.push(snapshot);

        // 保留最近 MAX_SNAPSHOTS 份
        const trimmed = history.slice(-MAX_SNAPSHOTS);

        await writeFileAtomic(file, JSON.stringify({ snapshots: trimmed }, null, 2));
        return trimmed.length;
      }, this.options.lock ?? {}),
    );
  }

  async clear(workspaceRoot: string): Promise<void> {
    try {
      await writeFileAtomic(historyPath(workspaceRoot), JSON.stringify({ snapshots: [] }));
    } catch {
      // Ignore
    }
  }

  /** 把损坏的历史挪到一边（只挪一次），用户的旧快照仍可人工找回。 */
  private async quarantine(file: string): Promise<string | undefined> {
    const stamp = this.options.now ? this.options.now() : Date.now();
    const backup = `${file}.corrupt-${stamp}.json`;
    try {
      await rename(file, backup);
      return backup;
    } catch {
      return undefined;
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

    const first = samples[0]!;
    const last = samples[samples.length - 1]!;

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
    const read = await this.readHistory(workspaceRoot);
    const history = read.snapshots;
    const latest = history.length > 0 ? history[history.length - 1]! : null;
    const trend = this.computeTrend(history);

    const summary: string[] = [];
    if (!latest) {
      if (read.note) summary.push(read.note);
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
    // 快照采集不全时，分数只是下界：不说出来，100 分就等于「项目很健康」。
    if (latest.warnings && latest.warnings.length > 0) {
      summary.push('注意：本次快照采集不完整，分数只代表已看到的部分 ——');
      for (const warning of latest.warnings) summary.push('  - ' + warning);
    }
    if (read.note) summary.push(read.note);

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

/** A record we can compute with: numeric metrics, numeric scores, string timestamp. */
function isSnapshot(value: unknown): value is HealthSnapshot {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || typeof record['timestamp'] !== 'string') return false;
  const metrics = record['metrics'] as Record<string, unknown> | undefined;
  const scores = record['scores'] as Record<string, unknown> | undefined;
  if (!metrics || typeof metrics !== 'object' || !scores || typeof scores !== 'object') return false;
  return Object.keys(METRIC_DIRECTION).every((key) => typeof metrics[key] === 'number' && Number.isFinite(metrics[key]));
}
