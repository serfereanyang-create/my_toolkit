import { useEffect, useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { desktop } from '../../lib/ipc';
import type { UsageSummary, UsageHourlySummary, UsageModelStats, UsageRecordsResult, UsageRecord } from '../../lib/ipc';
import type { CustomModel, DesktopSettings } from '../../types';
import { Segmented, EmptyState } from './controls';

/*
 * 用量统计 — real token usage, aggregated from the CLI's usage ledger
 * (~/.aicode/usage.jsonl). Every number here comes from genuine provider-
 * reported token counts; there is no synthetic or estimated data. When no real
 * usage has been recorded yet, the page shows an empty state rather than mock
 * history.
 *
 * Two views over the selected window (7, 30, or 90 days):
 *   - 活跃热力图: per-day intensity grid (GitHub-style), hover shows tokens/rounds.
 *   - 按天 Token 趋势: per-day stacked bars, one color segment per model.
 */

// Deterministic, colorblind-friendly-ish palette. Assigned by model rank so the
// same model keeps the same color across the legend, bars, and tooltip.
const PALETTE = [
  '#2f81f7', // blue
  '#238636', // green
  '#a371f7', // purple
  '#f85149', // red
  '#db6d28', // orange
  '#1f9c8f', // teal
  '#d29922', // gold
  '#bf4b8a', // magenta
  '#57606a', // grey
];

function colorForIndex(index: number): string {
  return PALETTE[index % PALETTE.length];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

// Chinese-unit token formatting for the model donut (亿 = 1e8, 万 = 1e4),
// matching how large real totals read naturally in the usage panel.
function formatTokensCN(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(n % 100_000_000 === 0 ? 0 : 1)}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(n % 10_000 === 0 ? 0 : 1)}万`;
  return String(n);
}

function formatPct(value: number, total: number): string {
  if (total <= 0) return '0%';
  const pct = (value / total) * 100;
  // Whole numbers stay clean (45%); small shares keep one decimal (3.8%).
  return pct >= 10 || Number.isInteger(pct) ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

function formatLastUsed(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  // 少于1小时显示分钟
  if (diffMins < 60) {
    return diffMins <= 1 ? '刚刚' : `${diffMins}分钟前`;
  }
  // 少于24小时显示小时
  if (diffHours < 24) {
    return `${diffHours}小时前`;
  }
  // 少于7天显示天数
  if (diffDays < 7) {
    return `${diffDays}天前`;
  }
  // 超过7天显示具体日期
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}月${day}日 ${hour}:${minute}`;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${month}月${day}日 ${hour}:${minute}:${second}`;
}

function shortDate(date: string): string {
  // date is YYYY-MM-DD; render as M月D日.
  const [, m, d] = date.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

export function UsageSettings({ activeProviderId }: { activeProviderId?: string }) {
  const [days, setDays] = useState<7 | 30 | 90>(7);
  const [hours, setHours] = useState<24 | 36 | 48>(24);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [hourly, setHourly] = useState<UsageHourlySummary | null>(null);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  
  // 详细记录视图状态
  const [view, setView] = useState<'summary' | 'details'>('summary');
  const [records, setRecords] = useState<UsageRecordsResult | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(20);
  const [loadingRecords, setLoadingRecords] = useState(false);

  // Load daily summary
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    desktop.usage.summary(days)
      .then((result) => { if (!cancelled) setSummary(result); })
      .catch(() => { if (!cancelled) setSummary(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  // Load hourly summary + auto-refresh every 60s
  useEffect(() => {
    let cancelled = false;
    const load = () => desktop.usage.hourly(hours)
      .then((result) => { if (!cancelled) setHourly(result); })
      .catch(() => { if (!cancelled) setHourly(null); });
    void load();
    const id = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [hours]);

  // Manual refresh
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const result = await desktop.usage.hourly(hours);
      setHourly(result);
    } catch {
      // ignore error
    } finally {
      setRefreshing(false);
    }
  };

  // Load settings for pricing
  useEffect(() => {
    desktop.settings.get().then(setSettings).catch(() => {});
  }, []);

  // Load detailed records when view switches to 'details'
  useEffect(() => {
    if (view !== 'details') return;
    let cancelled = false;
    setLoadingRecords(true);
    const offset = (page - 1) * pageSize;
    desktop.usage.records(hours, offset, pageSize)
      .then((result) => { if (!cancelled) setRecords(result); })
      .catch(() => { if (!cancelled) setRecords(null); })
      .finally(() => { if (!cancelled) setLoadingRecords(false); });
    return () => { cancelled = true; };
  }, [view, hours, page, pageSize]);

  const colorByModel = useMemo(() => {
    const map = new Map<string, string>();
    (summary?.models ?? []).forEach((m, index) => map.set(m.model, colorForIndex(index)));
    return map;
  }, [summary]);

  const hourlyColorByModel = useMemo(() => {
    const map = new Map<string, string>();
    (hourly?.models ?? []).forEach((m, index) => map.set(m.model, colorForIndex(index)));
    return map;
  }, [hourly]);

  const hasData = Boolean(summary && summary.totals.tokens > 0);
  const hasHourlyData = Boolean(hourly && hourly.totals.tokens > 0);

  return (
    <div className="settings-page usage-settings">
      <div className="usage-header">
        <div>
          <h1 className="settings-page-title">用量统计</h1>
          <p className="settings-page-subtitle">
            真实 Token 用量，来自本地用量账本。仅统计供应商实际返回的 token，不含估算。
          </p>
        </div>
        <Segmented<'7' | '30' | '90'>
          value={String(days) as '7' | '30' | '90'}
          onChange={(next) => setDays(next === '90' ? 90 : next === '30' ? 30 : 7)}
          options={[{ value: '7', label: '7 天' }, { value: '30', label: '30 天' }, { value: '90', label: '90 天' }]}
        />
      </div>

      {loading ? (
        <EmptyState title="正在加载用量数据…" loading />
      ) : !hasData ? (
        <EmptyState
          icon={<BarChart3 size={22} />}
          title="暂无真实用量数据"
          description="发起真实对话后，各模型的每日 token 用量会在这里逐日累积。"
        />
      ) : (
        <>
          <UsageTotals summary={summary!} />
          <ModelDonut summary={summary!} colorByModel={colorByModel} />
          <Heatmap summary={summary!} />
          <TrendChart summary={summary!} />
          <Legend summary={summary!} colorByModel={colorByModel} />
        </>
      )}

      {/* Hourly trend + cost — always shown once hourly data arrives */}
      {!loading && hourly && (
        <>
          <div className="usage-header" style={{ marginTop: 16 }}>
            <div>
              <h1 className="settings-page-title" style={{ fontSize: 16 }}>Token 使用趋势</h1>
              <p className="settings-page-subtitle">按小时粒度，展示输入/输出和缓存命中情况。每 60 秒自动刷新。</p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Segmented<'summary' | 'details'>
                value={view}
                onChange={setView}
                options={[{ value: 'summary', label: '汇总' }, { value: 'details', label: '明细' }]}
              />
              <button
                className="settings-icon-btn"
                aria-label="刷新"
                title="刷新数据"
                onClick={handleRefresh}
                disabled={refreshing}
                style={{ opacity: refreshing ? 0.5 : 1 }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <polyline points="1 20 1 14 7 14"></polyline>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                </svg>
              </button>
              <Segmented<'24' | '36' | '48'>
                value={String(hours) as '24' | '36' | '48'}
                onChange={(next) => setHours(next === '48' ? 48 : next === '36' ? 36 : 24)}
                options={[{ value: '24', label: '24h' }, { value: '36', label: '36h' }, { value: '48', label: '48h' }]}
              />
            </div>
          </div>
          {hasHourlyData ? (
            <>
              <HourlyStatsCards summary={hourly!} />
              <ProviderConsumption summary={hourly!} settings={settings} colorByModel={hourlyColorByModel} />
              
              {view === 'summary' ? (
                <CostTable summary={hourly!} settings={settings} colorByModel={hourlyColorByModel} activeProviderId={activeProviderId} />
              ) : loadingRecords ? (
                <div className="usage-loading" style={{ padding: '40px', textAlign: 'center', color: 'var(--fg-muted)' }}>
                  加载详细记录中...
                </div>
              ) : records && records.total > 0 ? (
                <DetailedRecordsTable
                  records={records}
                  settings={settings}
                  page={page}
                  pageSize={pageSize}
                  onPageChange={setPage}
                  onPageSizeChange={(size) => {
                    setPageSize(size);
                    setPage(1);
                  }}
                  activeProviderId={activeProviderId}
                />
              ) : (
                <EmptyState
                  icon={<BarChart3 size={22} />}
                  title="暂无详细记录"
                  description="在选定的时间窗口内未找到用量记录。"
                />
              )}
            </>
          ) : (
            <EmptyState
              icon={<BarChart3 size={22} />}
              title="暂无小时粒度用量"
              description="发起对话后，按小时的 token 用量趋势会在这里实时更新。"
            />
          )}
        </>
      )}
    </div>
  );
}

function UsageTotals({ summary }: { summary: UsageSummary }) {
  // 总 tokens = input + output + cacheRead + cacheCreation
  const totalWithCache = summary.totals.tokens + summary.totals.cacheRead + summary.totals.cacheCreation;
  return (
    <div className="usage-totals">
      <div className="usage-total-card">
        <span className="usage-total-value">{formatTokens(totalWithCache)}</span>
        <span className="usage-total-label">总 Tokens</span>
      </div>
      <div className="usage-total-card">
        <span className="usage-total-value">{summary.totals.rounds}</span>
        <span className="usage-total-label">对话轮数</span>
      </div>
      <div className="usage-total-card">
        <span className="usage-total-value">{summary.models.length}</span>
        <span className="usage-total-label">使用模型</span>
      </div>
    </div>
  );
}

// Ring "模型用量" donut: an SVG stroke-dasharray ring plus a per-model list
// with share percentages. All values are real provider-reported totals. Models
// beyond the top 5 collapse into a single "其他模型" slice so the ring stays
// readable while the total stays exact.
const DONUT_TOP_N = 5;
const OTHER_COLOR = '#1f9c8f';

function ModelDonut({ summary, colorByModel }: { summary: UsageSummary; colorByModel: Map<string, string> }) {
  // 每个模型的总 tokens = total + cacheRead + cacheCreation
  const modelsWithCache = summary.models.map(m => ({
    ...m,
    totalWithCache: m.total + m.cacheRead + m.cacheCreation,
  }));
  const total = modelsWithCache.reduce((sum, m) => sum + m.totalWithCache, 0);
  const sorted = [...modelsWithCache].sort((a, b) => b.totalWithCache - a.totalWithCache);
  const top = sorted.slice(0, DONUT_TOP_N);
  const restTotal = sorted.slice(DONUT_TOP_N).reduce((sum, m) => sum + m.totalWithCache, 0);

  const rows: { model: string; total: number; color: string }[] = top.map((m) => ({
    model: m.model,
    total: m.totalWithCache,
    color: colorByModel.get(m.model) ?? colorForIndex(0),
  }));
  if (restTotal > 0) rows.push({ model: '其他模型', total: restTotal, color: OTHER_COLOR });

  // SVG ring geometry. circumference drives the dasharray segment lengths.
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = rows.map((row) => {
    const fraction = total > 0 ? row.total / total : 0;
    const seg = { color: row.color, dash: fraction * circumference, offset };
    offset += fraction * circumference;
    return seg;
  });

  return (
    <div className="usage-block">
      <div className="usage-block-head">
        <span className="usage-block-title">模型用量</span>
      </div>
      <div className="usage-donut">
        <div className="usage-donut-chart">
          <svg viewBox="0 0 180 180" role="img" aria-label="模型用量占比">
            <g transform="rotate(-90 90 90)">
              <circle cx="90" cy="90" r={radius} className="usage-donut-track" />
              {segments.map((seg, i) => (
                <circle
                  key={i}
                  cx="90"
                  cy="90"
                  r={radius}
                  className="usage-donut-seg"
                  stroke={seg.color}
                  strokeDasharray={`${seg.dash} ${circumference - seg.dash}`}
                  strokeDashoffset={-seg.offset}
                />
              ))}
            </g>
            <text x="90" y="84" className="usage-donut-total">{formatTokensCN(total)}</text>
            <text x="90" y="104" className="usage-donut-unit">tokens</text>
          </svg>
        </div>
        <div className="usage-donut-list">
          {rows.map((row) => (
            <div key={row.model} className="usage-donut-row">
              <span className="usage-donut-name">
                <span className="usage-legend-dot" style={{ background: row.color }} />
                {row.model}
              </span>
              <span className="usage-donut-pct">{formatPct(row.total, total)}</span>
              <span className="usage-donut-tokens">{formatTokensCN(row.total)} tokens</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Local day-of-week (0 = Sun .. 6 = Sat) for a YYYY-MM-DD date string, parsed
// as a local date (not UTC) so the calendar alignment matches the same local
// midnight boundaries used to bucket entries in usage-store.cjs.
function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function Heatmap({ summary }: { summary: UsageSummary }) {
  const [hover, setHover] = useState<{ date: string; total: number; rounds: number; input: number; output: number; cacheRead: number; cacheCreation: number } | null>(null);
  const max = Math.max(1, ...summary.daily.map((d) => d.total));

  // Intensity bucket 0..4
  function bucket(total: number): number {
    if (total <= 0) return 0;
    const ratio = total / max;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  }

  const label = hover
    ? `${shortDate(hover.date)}：${formatTokens(hover.total)} tokens（输入 ${formatTokens(hover.input)} · 输出 ${formatTokens(hover.output)} · 缓存读 ${formatTokens(hover.cacheRead)} · 缓存写 ${formatTokens(hover.cacheCreation)}）· ${hover.rounds} 轮`
    : '悬停查看某天用量';

  // Fixed 120 cells: 20 columns × 6 rows.
  // Today is the LAST cell (index 119 = bottom-right corner).
  // Grid flows column-by-column from top-to-bottom, left-to-right.
  // So cell index i → column = Math.floor(i/6), row = i%6.
  // Today = index 119, yesterday = 118, …, 119 days ago = index 0.
  const TOTAL = 120;

  // Build a date→data map for quick lookup
  const byDate = new Map<string, { total: number; rounds: number; input: number; output: number; cacheRead: number; cacheCreation: number }>();
  for (const d of summary.daily) {
    byDate.set(d.date, { 
      total: d.total, 
      rounds: d.rounds,
      input: d.input,
      output: d.output,
      cacheRead: d.cacheRead,
      cacheCreation: d.cacheCreation,
    });
  }

  // Generate the 120 date strings (index 0 = oldest, 119 = today)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cells = Array.from({ length: TOTAL }, (_, i) => {
    const daysAgo = TOTAL - 1 - i;
    const d = new Date(today);
    d.setDate(d.getDate() - daysAgo);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const data = byDate.get(dateStr);
    return { 
      dateStr, 
      total: data?.total ?? 0, 
      rounds: data?.rounds ?? 0,
      input: data?.input ?? 0,
      output: data?.output ?? 0,
      cacheRead: data?.cacheRead ?? 0,
      cacheCreation: data?.cacheCreation ?? 0,
    };
  });

  return (
    <div className="usage-block">
      <div className="usage-block-head">
        <span className="usage-block-title">活跃热力图</span>
        <span className="usage-heatmap-readout">{label}</span>
        <span className="usage-heatmap-scale">
          <span className="usage-scale-label">较少</span>
          {[0, 1, 2, 3, 4].map((b) => <span key={b} className={`usage-cell b${b}`} />)}
          <span className="usage-scale-label">较多</span>
        </span>
      </div>
      <div className="usage-heatmap-grid usage-heatmap-fixed">
        {cells.map((cell) => (
          <span
            key={cell.dateStr}
            className={`usage-cell b${bucket(cell.total)}`}
            title={`${shortDate(cell.dateStr)}：${cell.total > 0 ? `${formatTokens(cell.total)} tokens（输入 ${formatTokens(cell.input)} · 输出 ${formatTokens(cell.output)} · 缓存读 ${formatTokens(cell.cacheRead)} · 缓存写 ${formatTokens(cell.cacheCreation)}）· ${cell.rounds} 轮` : '无记录'}`}
            onMouseEnter={() => setHover(cell.total > 0 ? { date: cell.dateStr, ...cell } : null)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Daily area line chart (replaces bar chart) ───────────────────────────────
// Renders Input / Output / Cache Creation / Cache Read as filled area lines,
// plus a Cache Hit Rate dashed line on a right-axis percentage scale.
const LINE_SERIES = [
  { key: 'input',        label: 'Input',          color: '#60a5fa' },
  { key: 'output',       label: 'Output',          color: '#4ade80' },
  { key: 'cacheCreation',label: 'Cache Creation',  color: '#fbbf24' },
  { key: 'cacheRead',    label: 'Cache Read',       color: '#22d3ee' },
] as const;
const HIT_RATE_COLOR = '#a78bfa';

function TrendChart({ summary }: { summary: UsageSummary }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const data = summary.daily;
  const n = data.length;
  if (n === 0) return null;

  // Left axis: max across all token series
  const tokenMax = Math.max(1, ...data.flatMap((d) => [
    d.input, d.output, d.cacheCreation, d.cacheRead,
  ]));

  // Hit rate per day: cacheRead / (input + cacheRead)
  const hitRates = data.map((d) => {
    const denom = d.input + d.cacheRead;
    return denom > 0 ? d.cacheRead / denom : 0;
  });

  const W = 800; const H = 200; const PAD_L = 54; const PAD_R = 54; const PAD_T = 12; const PAD_B = 32;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  function xOf(i: number) { return PAD_L + (i / Math.max(n - 1, 1)) * chartW; }
  function yOfToken(v: number) { return PAD_T + chartH - (v / tokenMax) * chartH; }
  function yOfRate(r: number) { return PAD_T + chartH - r * chartH; }

  function polyline(pts: [number, number][]) {
    return pts.map(([x, y]) => `${x},${y}`).join(' ');
  }
  function area(pts: [number, number][]) {
    if (pts.length === 0) return '';
    const base = PAD_T + chartH;
    return `M${pts[0][0]},${base} ` +
      pts.map(([x, y]) => `L${x},${y}`).join(' ') +
      ` L${pts[pts.length - 1][0]},${base} Z`;
  }

  // Y-axis label formatting
  function fmtY(v: number) {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(0)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
    return String(v);
  }
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ frac: t, val: tokenMax * t }));

  // X-axis: show ~6 labels
  const labelStep = Math.max(1, Math.ceil(n / 6));
  const hoverDay = hoverIdx !== null ? data[hoverIdx] : null;

  return (
    <div className="usage-block">
      <div className="usage-block-head">
        <span className="usage-block-title">Token 使用趋势</span>
        {hoverDay && (
          <span className="usage-heatmap-readout">
            {shortDate(hoverDay.date)}：{formatTokens(hoverDay.input + hoverDay.output + hoverDay.cacheRead + hoverDay.cacheCreation)} Tokens · {hoverDay.rounds} 轮
          </span>
        )}
      </div>

      {/* Legend */}
      <div className="trend-legend">
        {LINE_SERIES.map((s) => (
          <span key={s.key} className="trend-legend-item">
            <span className="trend-legend-circle" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span className="trend-legend-item">
          <span className="trend-legend-dash" style={{ borderColor: HIT_RATE_COLOR }} />
          Cache Hit Rate
        </span>
      </div>

      {/* SVG chart */}
      <div className="trend-svg-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg" preserveAspectRatio="none"
          onMouseLeave={() => setHoverIdx(null)}>

          {/* Grid lines */}
          {yTicks.map(({ frac }) => {
            const y = PAD_T + chartH - frac * chartH;
            return <line key={frac} x1={PAD_L} x2={PAD_L + chartW} y1={y} y2={y} className="trend-grid" />;
          })}

          {/* Area fills */}
          {LINE_SERIES.map((s) => {
            const pts: [number, number][] = data.map((d, i) => [xOf(i), yOfToken(d[s.key])]);
            return (
              <path key={s.key + '-area'} d={area(pts)}
                fill={s.color} fillOpacity={0.15} stroke="none" />
            );
          })}

          {/* Lines */}
          {LINE_SERIES.map((s) => {
            const pts: [number, number][] = data.map((d, i) => [xOf(i), yOfToken(d[s.key])]);
            return (
              <polyline key={s.key + '-line'} points={polyline(pts)}
                fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            );
          })}

          {/* Cache hit rate dashed line */}
          {(() => {
            const pts: [number, number][] = hitRates.map((r, i) => [xOf(i), yOfRate(r)]);
            return (
              <polyline points={polyline(pts)}
                fill="none" stroke={HIT_RATE_COLOR} strokeWidth="1.5"
                strokeDasharray="5,4" strokeLinejoin="round" strokeLinecap="round" />
            );
          })()}

          {/* Hover vertical line + dots */}
          {hoverIdx !== null && (() => {
            const x = xOf(hoverIdx);
            return (
              <>
                <line x1={x} x2={x} y1={PAD_T} y2={PAD_T + chartH} className="trend-hover-line" />
                {LINE_SERIES.map((s) => (
                  <circle key={s.key} cx={x} cy={yOfToken(data[hoverIdx][s.key])}
                    r="3.5" fill={s.color} stroke="#fff" strokeWidth="1.5" />
                ))}
                <circle cx={x} cy={yOfRate(hitRates[hoverIdx])}
                  r="3.5" fill={HIT_RATE_COLOR} stroke="#fff" strokeWidth="1.5" />
              </>
            );
          })()}

          {/* Invisible hover targets */}
          {data.map((_, i) => (
            <rect key={i} x={xOf(i) - chartW / n / 2} y={PAD_T}
              width={chartW / n} height={chartH}
              fill="transparent" onMouseEnter={() => setHoverIdx(i)} />
          ))}

          {/* Left Y-axis labels */}
          {yTicks.map(({ frac, val }) => (
            <text key={frac} x={PAD_L - 6} y={PAD_T + chartH - frac * chartH + 4}
              className="trend-axis-label" textAnchor="end">{fmtY(val)}</text>
          ))}

          {/* Right Y-axis labels (%) */}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <text key={t} x={PAD_L + chartW + 6} y={PAD_T + chartH - t * chartH + 4}
              className="trend-axis-label trend-axis-right" textAnchor="start"
              fill={HIT_RATE_COLOR}>{Math.round(t * 100)}%</text>
          ))}

          {/* X-axis labels */}
          {data.map((d, i) => i % labelStep === 0 ? (
            <text key={d.date} x={xOf(i)} y={H - 4}
              className="trend-axis-label" textAnchor="middle">{shortDate(d.date)}</text>
          ) : null)}
        </svg>
      </div>
    </div>
  );
}

function Legend({ summary, colorByModel }: { summary: UsageSummary; colorByModel: Map<string, string> }) {
  return (
    <div className="usage-legend">
      {summary.models.map((m) => (
        <span key={m.model} className="usage-legend-item">
          <span className="usage-legend-dot" style={{ background: colorByModel.get(m.model) }} />
          <span className="usage-legend-name">{m.model}</span>
          <span className="usage-legend-value">{formatTokens(m.total)}</span>
        </span>
      ))}
    </div>
  );
}

// ── Hourly stats cards ────────────────────────────────────────────────────────
function HourlyStatsCards({ summary }: { summary: UsageHourlySummary }) {
  const totalInput = summary.totals.input + summary.totals.cacheRead;
  const hitRate = totalInput > 0
    ? (summary.totals.cacheRead / totalInput * 100).toFixed(1)
    : '—';

  return (
    <div className="usage-totals">
      <div className="usage-total-card">
        <span className="usage-total-value">{formatTokens(summary.totals.input)}</span>
        <span className="usage-total-label">输入 Tokens</span>
      </div>
      <div className="usage-total-card">
        <span className="usage-total-value">{formatTokens(summary.totals.output)}</span>
        <span className="usage-total-label">输出 Tokens</span>
      </div>
      <div className="usage-total-card">
        <span className="usage-total-value">{formatTokens(summary.totals.cacheRead)}</span>
        <span className="usage-total-label">缓存读取</span>
      </div>
      <div className="usage-total-card">
        <span className="usage-total-value">{formatTokens(summary.totals.cacheCreation)}</span>
        <span className="usage-total-label">缓存写入</span>
      </div>
      <div className="usage-total-card">
        <span className="usage-total-value">{hitRate === '—' ? '—' : `${hitRate}%`}</span>
        <span className="usage-total-label">缓存命中率</span>
      </div>
      <div className="usage-total-card">
        <span className="usage-total-value">{summary.totals.rounds}</span>
        <span className="usage-total-label">请求数</span>
      </div>
    </div>
  );
}

// ── Provider cost timeline chart ─────────────────────────────────────────────
function ProviderConsumption({ summary, settings, colorByModel }: { 
  summary: UsageHourlySummary; 
  settings: DesktopSettings | null;
  colorByModel: Map<string, string>;
}) {
  const [hover, setHover] = useState<{ hour: string; provider: string; cost: number } | null>(null);

  // Safety check
  if (!summary.records || summary.records.length === 0) {
    return (
      <div className="usage-block">
        <div className="usage-block-head">
          <span className="usage-block-title">供应商消费趋势</span>
        </div>
        <div style={{ padding: 'var(--sp-4)', color: 'var(--fg-dim)', textAlign: 'center' }}>
          暂无数据
        </div>
      </div>
    );
  }

  // Assign colors to providers
  const providerColors = new Map<string, string>();
  const colors = ['#2f81f7', '#238636', '#f85149', '#a371f7', '#fb8500', '#14b8a6'];
  
  // Group by hour and provider
  const byHourProvider = new Map<string, Map<string, number>>();
  
  try {
    summary.records.forEach((rec: UsageRecord & { ts?: number }) => {
    const label = findProviderLabel(settings, rec.model, rec.provider, rec.baseUrl);
    if (!providerColors.has(label)) {
      providerColors.set(label, colors[providerColors.size % colors.length]);
    }
    
    const hourKey = new Date(rec.timestamp ?? rec.ts ?? 0).toISOString().slice(0, 13); // YYYY-MM-DDTHH
    if (!byHourProvider.has(hourKey)) {
      byHourProvider.set(hourKey, new Map());
    }
    
    const hourData = byHourProvider.get(hourKey)!;
    // Match the exact provider first. Without baseUrl, identical model ids from
    // 星/33/hanhe would incorrectly use the first provider's price.
    const pricing = findModelPricing(settings, rec.model, undefined, rec.baseUrl);
    const rawCost = pricing
      ? (rec.input / 1_000_000) * (pricing.inputPricePerM ?? 0)
        + (rec.output / 1_000_000) * (pricing.outputPricePerM ?? 0)
        + (rec.cacheRead / 1_000_000) * (pricing.cacheReadPricePerM ?? 0)
        + (rec.cacheCreation / 1_000_000) * (pricing.cacheWritePricePerM ?? 0)
      : 0;
    const cost = Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : 0;
    
    hourData.set(label, (hourData.get(label) ?? 0) + cost);
  });
  } catch (error) {
    console.error('Provider consumption chart error:', error);
    return (
      <div className="usage-block">
        <div className="usage-block-head">
          <span className="usage-block-title">供应商消费趋势</span>
        </div>
        <div style={{ padding: 'var(--sp-4)', color: 'var(--fg-dim)', textAlign: 'center' }}>
          数据加载失败
        </div>
      </div>
    );
  }

  // Build timeline data
  const providers = Array.from(providerColors.keys()).sort();
  const hours = Array.from(byHourProvider.keys()).sort();
  
  // Only show last 24 hours
  const recentHours = hours.slice(-24);
  
  const series = providers.map(provider => ({
    label: provider,
    color: providerColors.get(provider)!,
    data: recentHours.map(hour => byHourProvider.get(hour)?.get(provider) ?? 0),
  }));

  const maxCost = Math.max(0.00001, ...recentHours.map(hour =>
    providers.reduce((sum, p) => {
      const value = byHourProvider.get(hour)?.get(p) ?? 0;
      return sum + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0)
  ));

  // Responsive viewBox: CSS controls the actual width, so the chart cannot
  // overflow the settings panel on narrower windows.
  const W = 800, H = 220;
  const PAD_L = 62, PAD_R = 18, PAD_T = 18, PAD_B = 38;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const xOf = (i: number) => PAD_L + (i / Math.max(recentHours.length - 1, 1)) * chartW;
  const yOf = (cost: number) => PAD_T + chartH - (cost / maxCost) * chartH;

  const formatHour = (hourKey: string) => {
    const d = new Date(hourKey);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
  };

  return (
    <div className="usage-block">
      <div className="usage-block-head">
        <span className="usage-block-title">供应商消费趋势</span>
        {hover && (
          <span className="usage-heatmap-readout">
            {formatHour(recentHours[parseInt(hover.hour)])} · {hover.provider}：¥{hover.cost.toFixed(2)}
          </span>
        )}
        <span className="usage-heatmap-scale">
          {providers.map(p => (
            <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
              <span style={{ width: 10, height: 10, background: providerColors.get(p), display: 'inline-block', borderRadius: 2 }} />
              <span className="usage-scale-label">{p}</span>
            </span>
          ))}
        </span>
      </div>
      <div className="provider-cost-chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="provider-cost-chart">
        {/* Y-axis */}
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + chartH} stroke="var(--border)" strokeWidth={1} />
        {/* X-axis */}
        <line x1={PAD_L} y1={PAD_T + chartH} x2={PAD_L + chartW} y2={PAD_T + chartH} stroke="var(--border)" strokeWidth={1} />
        
        {/* Y-axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map(ratio => {
          const y = PAD_T + chartH * (1 - ratio);
          const val = maxCost * ratio;
          return (
            <text key={ratio} x={PAD_L - 8} y={y + 4} textAnchor="end" fontSize={11} fill="var(--fg-dim)">
              ¥{val.toFixed(2)}
            </text>
          );
        })}

        {/* Lines */}
        {series.map(s => {
          const points = s.data.map((cost, i) => [xOf(i), yOf(cost)] as [number, number]);
          return (
            <polyline
              key={s.label}
              points={points.map(([x, y]) => `${x},${y}`).join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          );
        })}

        {/* Hover zones */}
        {recentHours.map((hour, i) => {
          const x = xOf(i);
          const costs = providers.map(p => ({ provider: p, cost: byHourProvider.get(hour)?.get(p) ?? 0 })).filter(c => c.cost > 0);
          return (
            <g key={hour}>
              <rect
                x={x - 10}
                y={PAD_T}
                width={20}
                height={chartH}
                fill="transparent"
                onMouseEnter={() => costs.length > 0 && setHover({ hour: String(i), provider: costs[0].provider, cost: costs.reduce((sum, c) => sum + c.cost, 0) })}
                onMouseLeave={() => setHover(null)}
              />
              {costs.map(c => (
                <circle
                  key={c.provider}
                  cx={x}
                  cy={yOf(c.cost)}
                  r={3}
                  fill={providerColors.get(c.provider)}
                />
              ))}
            </g>
          );
        })}

        {/* X-axis labels (every 4 hours) */}
        {recentHours.map((hour, i) => {
          if (i % 4 !== 0) return null;
          const x = xOf(i);
          const label = formatHour(hour).split(' ')[1]; // Only show time
          return (
            <text key={hour} x={x} y={PAD_T + chartH + 20} textAnchor="middle" fontSize={11} fill="var(--fg-dim)">
              {label}
            </text>
          );
        })}
      </svg>
      </div>
    </div>
  );
}

// ── Cost table ────────────────────────────────────────────────────────────────
// Look up pricing from DesktopSettings providers.models.
// Priority order:
//   1. Active provider (activeProviderId) with matching model + pricing
//   2. Any provider with matching model + pricing
//   3. Active provider with matching model (no pricing configured)
//   4. Any provider with matching model (no pricing)
function findModelPricing(settings: DesktopSettings | null, model: string, activeProviderId?: string, baseUrl?: string) {
  if (!settings) return null;
  if (baseUrl) {
    const provider = settings.providers.find((p) => p.baseUrl && p.baseUrl.replace(/\/$/, '') === baseUrl.replace(/\/$/, ''));
    const exact = provider?.models?.find((m) => m.id === model);
    if (exact) return exact;
  }
  let fallback: CustomModel | null = null;
  let activeFallback: CustomModel | null = null;

  for (const provider of settings.providers) {
    const isActive = provider.id === activeProviderId;
    for (const m of provider.models ?? []) {
      if (m.id !== model) continue;
      const hasPricing = m.inputPricePerM != null || m.outputPricePerM != null;
      if (hasPricing && isActive) return m;          // best match: active + priced
      if (hasPricing && !fallback) fallback = m;     // any priced match
      if (!hasPricing && isActive && !activeFallback) activeFallback = m; // active, no price
    }
  }
  return fallback ?? activeFallback;
}

// Find the custom provider label for a given model.
// Priority: match by baseUrl first (most precise), then by model+pricing, finally raw provider string.
function findProviderLabel(settings: DesktopSettings | null, model: string, rawProvider: string, baseUrl?: string): string {
  if (!settings) return rawProvider;
  // 1. Exact baseUrl match — most reliable when available
  if (baseUrl) {
    const byUrl = settings.providers.find((p) => p.baseUrl && p.baseUrl.replace(/\/$/, '') === baseUrl.replace(/\/$/, ''));
    if (byUrl) return byUrl.label || byUrl.id;
  }
  // 2. Fall back to model+pricing priority
  let fallbackLabel: string | null = null;
  for (const provider of settings.providers) {
    const models = provider.models ?? [];
    const match = models.find((m) => m.id === model);
    if (!match) continue;
    const hasPricing = match.inputPricePerM != null || match.outputPricePerM != null;
    const label = provider.label || provider.id;
    if (hasPricing) return label;
    if (!fallbackLabel) fallbackLabel = label;
  }
  return fallbackLabel ?? rawProvider;
}

// Infer call mode from model name patterns
function inferCallMode(modelId: string): string {
  const lower = modelId.toLowerCase();
  // Common sync/non-streaming patterns
  if (lower.includes('o1') || lower.includes('o3')) return '非流式';
  if (lower.includes('sync')) return '同步';
  // Default: streaming
  return '流式';
}

function formatCost(cost: number): string {
  // 高精度：5位小数，适配低价模型（如 Haiku）的微小花费
  if (cost === 0) return '$0.00000';
  if (cost < 0.00001) return '< $0.00001';
  if (cost >= 1) return `$${cost.toFixed(2)}`; // 超过$1仍用2位
  return `$${cost.toFixed(5)}`; // 小于$1用5位精度
}

function CostTable({ summary, settings, colorByModel, activeProviderId }: {
  summary: UsageHourlySummary;
  settings: DesktopSettings | null;
  colorByModel: Map<string, string>;
  activeProviderId?: string;
}) {
  // 计算时间范围
  const timeRange = summary.hourly.length > 0
    ? `${summary.hourly[0].label} - ${summary.hourly[summary.hourly.length - 1].label}`
    : '';

  return (
    <div className="usage-block">
      <div className="usage-block-head">
        <span className="usage-block-title">模型费用</span>
        <span className="usage-heatmap-readout">
          最近 {summary.hours} 小时
          {timeRange && ` (${timeRange})`}
          · 价格需在 设置 → 模型 中配置
        </span>
      </div>
      <div className="usage-cost-table-wrap">
        <table className="usage-cost-table">
          <thead>
            <tr>
              <th>模型</th>
              <th className="num">总 Tokens</th>
              <th className="num">输入</th>
              <th className="num">输出</th>
              <th className="num">缓存读</th>
              <th className="num">缓存写</th>
              <th className="num">请求数</th>
              <th>调用模式</th>
              <th>最后使用</th>
              <th className="num">花费</th>
            </tr>
          </thead>
          <tbody>
            {summary.models.map((m) => {
              const pricing = findModelPricing(settings, m.model, activeProviderId ?? settings?.activeProviderId);
              let cost = 0;
              let costOk = false;
              if (pricing) {
                costOk = true;
                cost += (m.input / 1_000_000) * (pricing.inputPricePerM ?? 0);
                cost += (m.output / 1_000_000) * (pricing.outputPricePerM ?? 0);
                cost += (m.cacheRead / 1_000_000) * (pricing.cacheReadPricePerM ?? 0);
                cost += (m.cacheCreation / 1_000_000) * (pricing.cacheWritePricePerM ?? 0);
                console.log('[UsageSettings] Cost calculation:', {
                  input: m.input, output: m.output, 
                  cacheRead: m.cacheRead, cacheCreation: m.cacheCreation,
                  inputCost: (m.input / 1_000_000) * (pricing.inputPricePerM ?? 0),
                  outputCost: (m.output / 1_000_000) * (pricing.outputPricePerM ?? 0),
                  cacheReadCost: (m.cacheRead / 1_000_000) * (pricing.cacheReadPricePerM ?? 0),
                  cacheCreationCost: (m.cacheCreation / 1_000_000) * (pricing.cacheWritePricePerM ?? 0),
                  totalCost: cost
                });
              }
              const callMode = inferCallMode(m.model);
              const lastUsedTime = m.lastUsed ? formatLastUsed(m.lastUsed) : '—';
              return (
                <tr key={m.model}>
                  <td>
                    <span className="usage-cost-dot" style={{ background: colorByModel.get(m.model) }} />
                    <code className="usage-cost-model">{m.model}</code>
                  </td>
                  <td className="num">{formatTokens(m.total)}</td>
                  <td className="num">{formatTokens(m.input)}</td>
                  <td className="num">{formatTokens(m.output)}</td>
                  <td className="num">{formatTokens(m.cacheRead)}</td>
                  <td className="num">{formatTokens(m.cacheCreation)}</td>
                  <td className="num">{m.rounds}</td>
                  <td><span className="usage-mode-badge">{callMode}</span></td>
                  <td className="num">{lastUsedTime}</td>
                  <td className={`num ${costOk ? (cost > 1 ? 'usage-cost-high' : 'usage-cost-low') : 'usage-cost-na'}`}>
                    {costOk ? formatCost(cost) : '未配置'}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="usage-cost-total">
              <td>合计</td>
              <td className="num">{formatTokens(summary.totals.tokens)}</td>
              <td className="num">{formatTokens(summary.totals.input)}</td>
              <td className="num">{formatTokens(summary.totals.output)}</td>
              <td className="num">{formatTokens(summary.totals.cacheRead)}</td>
              <td className="num">{formatTokens(summary.totals.cacheCreation)}</td>
              <td className="num">{summary.totals.rounds}</td>
              <td>—</td>
              <td>—</td>
              <td className="num">—</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// Helper: Render page numbers with ellipsis
function renderPageNumbers(current: number, total: number, onChange: (page: number) => void) {
  const pages: (number | 'ellipsis')[] = [];
  
  if (total <= 7) {
    // Show all pages
    for (let i = 1; i <= total; i++) pages.push(i);
  } else {
    // Smart ellipsis: 1 ... 4 5 [6] 7 8 ... 10
    pages.push(1);
    if (current > 3) pages.push('ellipsis');
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
      pages.push(i);
    }
    if (current < total - 2) pages.push('ellipsis');
    if (total > 1) pages.push(total);
  }

  return pages.map((p, i) => {
    if (p === 'ellipsis') {
      return <span key={`ellipsis-${i}`} className="pagination-ellipsis">...</span>;
    }
    return (
      <button
        key={p}
        className={`pagination-page ${p === current ? 'active' : ''}`}
        onClick={() => onChange(p)}
      >
        {p}
      </button>
    );
  });
}

function DetailedRecordsTable({ 
  records, 
  settings, 
  page, 
  pageSize, 
  onPageChange, 
  onPageSizeChange,
  activeProviderId,
}: {
  records: UsageRecordsResult;
  settings: DesktopSettings | null;
  page: number;
  pageSize: 20 | 50 | 100;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: 20 | 50 | 100) => void;
  activeProviderId?: string;
}) {
  const totalPages = Math.ceil(records.total / pageSize);
  const startIndex = (page - 1) * pageSize + 1;
  const endIndex = Math.min(page * pageSize, records.total);

  return (
    <div className="usage-block">
      <div className="usage-block-head">
        <span className="usage-block-title">详细记录</span>
        <span className="usage-heatmap-readout">
          共 {records.total} 条记录 · 价格需在 设置 → 模型 中配置
        </span>
      </div>
      <div className="usage-records-table-wrap">
        <table className="usage-records-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>时间</th>
              <th>模型</th>
              <th>服务商</th>
              <th className="num">输入</th>
              <th className="num">输出</th>
              <th className="num">缓存读</th>
              <th className="num">缓存写</th>
              <th className="num">总计</th>
              <th>推理强度</th>
              <th className="num">费用</th>
            </tr>
          </thead>
          <tbody>
            {records.records.map((record, index) => {
              const pricing = findModelPricing(settings, record.model, activeProviderId ?? settings?.activeProviderId);
              let cost = 0;
              if (pricing) {
                cost += (record.input / 1_000_000) * (pricing.inputPricePerM ?? 0);
                cost += (record.output / 1_000_000) * (pricing.outputPricePerM ?? 0);
                cost += (record.cacheRead / 1_000_000) * (pricing.cacheReadPricePerM ?? 0);
                cost += (record.cacheCreation / 1_000_000) * (pricing.cacheWritePricePerM ?? 0);
              }
              const rowNumber = startIndex + index;
              return (
                <tr key={record.id}>
                  <td className="num">{rowNumber}</td>
                  <td>{formatTimestamp(record.timestamp)}</td>
                  <td><code className="usage-cost-model">{record.model}</code></td>
                  <td><span className="usage-provider-badge">{findProviderLabel(settings, record.model, record.provider, record.baseUrl)}</span></td>
                  <td className="num">{formatTokens(record.input)}</td>
                  <td className="num">{formatTokens(record.output)}</td>
                  <td className="num">{formatTokens(record.cacheRead)}</td>
                  <td className="num">{formatTokens(record.cacheCreation)}</td>
                  <td className="num">{formatTokens(record.total)}</td>
                  <td>{record.reasoningEffort
                    ? <span className="usage-mode-badge">{record.reasoningEffort}</span>
                    : <span style={{ color: 'var(--fg-dim)' }}>—</span>
                  }</td>
                  <td className="num">{pricing ? formatCost(cost) : '未配置'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* 分页控件 */}
        <div className="usage-records-pagination">
          <div className="pagination-info">
            显示 {startIndex} 至 {endIndex} 共 {records.total} 条结果
          </div>
          <div className="pagination-controls">
            <span>每页：</span>
            <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value) as 20 | 50 | 100)}>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
          <div className="pagination-pages">
            <button 
              onClick={() => onPageChange(page - 1)} 
              disabled={page === 1}
            >
              &lt;
            </button>
            {renderPageNumbers(page, totalPages, onPageChange)}
            <button 
              onClick={() => onPageChange(page + 1)} 
              disabled={page === totalPages}
            >
              &gt;
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
