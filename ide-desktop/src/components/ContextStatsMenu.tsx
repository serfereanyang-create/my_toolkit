import { useEffect, useRef } from 'react';
import type { ContextStats, ProviderConfig } from '../types';

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
  // 供应商实报命中率：cacheRead / (input + cacheRead) 是正确分母
  // total（stats.inputTokens）是净输入，不含缓存，分母要加上缓存部分
  const providerCacheRate = stats.providerCacheReported && totalWithCache > 0
    ? Math.min(100, (stats.cacheReadTokens / totalWithCache) * 100)
    : null;

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
          <span>缓存命中率</span>
          <strong data-cache-hit-rate={providerCacheRate === null ? '' : providerCacheRate.toFixed(1)}>
            {providerCacheRate === null ? '未提供' : `${providerCacheRate.toFixed(1)}%`}
          </strong>
        </div>
        <div className="cache-subline">
          {providerCacheRate === null
            ? '本轮 usage 没有返回 cache_read / cached_tokens，不估一个数出来'
            : `${formatTokens(stats.cacheReadTokens)} / ${formatTokens(totalWithCache)} 输入 tokens 来自缓存`}
        </div>
      </section>
    </div>
  );
}
