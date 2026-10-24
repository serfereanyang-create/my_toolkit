import { useEffect, useRef, useState } from 'react';
import type { ContextStats, ProviderConfig } from '../types';
import { desktop, type CachePrediction } from '../lib/ipc';

const CATEGORY_ROWS: { key: keyof ContextStats['categories']; label: string; color: string }[] = [
  { key: 'messages', label: '消息', color: '#1681f8' },
  { key: 'systemTools', label: '系统工具', color: '#4095f2' },
  { key: 'mcpTools', label: 'MCP 工具', color: '#67a8ed' },
  { key: 'skills', label: '技能', color: '#82b6e7' },
  { key: 'systemPrompt', label: '系统提示词', color: '#9dc4e9' },
  { key: 'other', label: '其他', color: '#b8d2e9' },
];

function formatTokens(value: number): string {
  if (value >= 10_000) return `${(value / 10_000).toFixed(value % 10_000 === 0 ? 0 : 1)}万`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  return String(value);
}

function percent(value: number, total: number): string {
  if (total <= 0) return '0%';
  const p = (value / total) * 100;
  return `${p.toFixed(p >= 10 ? 1 : 1)}%`;
}

function contextWindowFor(provider: ProviderConfig | undefined, model: string): number | undefined {
  const match = provider?.models?.find((entry) => entry.id === model);
  return match?.contextWindow;
}

export function ContextStatsMenu({ stats, provider, onClose }: {
  stats: ContextStats | null;
  provider?: ProviderConfig;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [prediction, setPrediction] = useState<CachePrediction | null>(null);

  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Fetch the REAL historical cache-hit-rate prediction for this model from the
  // usage ledger. Distinct from the current turn's actual rate above.
  useEffect(() => {
    let live = true;
    const model = stats?.model;
    if (!model) return;
    desktop.usage.cachePrediction(model).then((result) => {
      if (live) setPrediction(result);
    }).catch(() => {
      if (live) setPrediction(null);
    });
    return () => { live = false; };
  }, [stats?.model]);

  if (!stats) {
    return (
      <div className="context-menu" ref={ref} role="dialog" aria-label="上下文与缓存">
        <div className="context-menu-empty">
          <strong>暂无上下文统计</strong>
          <span>完成一次真实模型请求后显示 API 返回的 token 与缓存数据。</span>
        </div>
      </div>
    );
  }

  const total = stats.inputTokens;
  // Context capacity is the whole prompt the model read: net input plus the
  // cache-served part. Using the net number alone understated the bar by the
  // cache-hit share.
  const totalWithCache = total + stats.cacheReadTokens;
  const contextWindow = contextWindowFor(provider, stats.model);
  const contextRate = contextWindow ? Math.min(100, (totalWithCache / contextWindow) * 100) : null;
  const predictedRate = stats.predictedPromptCacheRate === null ? null : stats.predictedPromptCacheRate * 100;
  const historicalRate = prediction?.predicted === null || prediction?.predicted === undefined ? null : prediction.predicted * 100;
  // 供应商实报命中率：cacheRead / (input + cacheRead) 是正确分母
  // total（stats.inputTokens）是净输入，不含缓存，分母要加上缓存部分
  const providerCacheRate = stats.providerCacheReported && totalWithCache > 0
    ? Math.min(100, (stats.cacheReadTokens / totalWithCache) * 100)
    : null;
  const localRate = stats.localCache.hitRate === null ? null : stats.localCache.hitRate * 100;

  return (
    <div className="context-menu" ref={ref} role="dialog" aria-label="上下文与缓存">
      <section className="context-section">
        <div className="context-title-row">
          <span className="context-title">上下文容量</span>
          <span className="context-value">
            {formatTokens(totalWithCache)} / {contextWindow ? formatTokens(contextWindow) : '未配置'}
            {contextRate !== null ? ` (${contextRate.toFixed(1)}%)` : ''}
          </span>
        </div>
        <div className="context-progress" aria-label="上下文占用">
          <span style={{ width: `${contextRate ?? 0}%` }} />
        </div>
        <div className="context-categories">
          {CATEGORY_ROWS.map((row) => (
            <div className="context-row" key={row.key}>
              <span className="context-dot" style={{ background: row.color }} />
              <span className="context-row-label">{row.label}</span>
              <span className="context-row-value">{percent(stats.categories[row.key], totalWithCache)}</span>
            </div>
          ))}
        </div>
        <div className="context-footnote">总 token 来自模型 API；分类按实际提示内容字符占比折算。</div>
      </section>

      <section className="context-section context-cache-section">
        <div className="cache-row">
          <span>Agent 自主预测命中率</span>
          <strong>{predictedRate === null ? '首轮暂无预测' : `${predictedRate.toFixed(1)}%`}</strong>
        </div>
        <div className="cache-subline">
          {predictedRate === null
            ? '基于与上一轮提示前缀的重合度估算；从第二轮开始稳定'
            : '按当前轮提示结构与上一轮稳定前缀重合度估算，不依赖模型商回报'}
        </div>
        <div className="cache-row">
          <span>历史自主预测</span>
          <strong>{historicalRate === null ? '暂无样本' : `${historicalRate.toFixed(1)}%`}</strong>
        </div>
        <div className="cache-subline">
          {historicalRate === null
            ? '同模型历史轮次不足，暂不能给出稳定预测'
            : `过去 ${prediction?.windowDays ?? 30} 天同模型 ${prediction?.samples ?? 0} 轮加权预测${prediction?.source === 'provider-reported' ? '（暂回退到供应商实报）' : ''}`}
        </div>
        <div className="cache-row">
          <span>供应商实报命中率</span>
          <strong>{providerCacheRate === null ? '未提供' : `${providerCacheRate.toFixed(1)}%`}</strong>
        </div>
        <div className="cache-subline">
          {stats.providerCacheReported
            ? `${formatTokens(stats.cacheReadTokens)} / ${formatTokens(totalWithCache)} 输入 tokens 来自缓存`
            : '仅作旁证；该轮 usage 未返回 cache_read / cached_tokens'}
        </div>
        <div className="cache-row cache-local-row">
          <span>CLI 本地缓存探针</span>
          <strong>{localRate === null ? '暂无样本' : `${localRate.toFixed(1)}%`}</strong>
        </div>
        <div className="cache-subline">
          {stats.localCache.totalLookups > 0
            ? `${stats.localCache.totalHits}/${stats.localCache.totalLookups} 次命中（项目上下文 + 导航索引）`
            : '重复读取项目上下文或符号索引后开始累积'}
        </div>
      </section>
    </div>
  );
}
