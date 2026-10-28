import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Clock, Search, Wrench } from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { TrajectoryRecord } from '../lib/ipc';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  return `${mins}m ${String(total % 60).padStart(2, '0')}s`;
}

/** One round-trip: header line, expandable to the real prompt tail + reply. */
function TrajectoryRow({ record }: { record: TrajectoryRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`traj-row ${open ? 'open' : ''}`}>
      <button className="traj-head" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={13} className="traj-chevron" />
        <span className="traj-step">#{record.step}</span>
        <span className="traj-model">{record.model}</span>
        {record.toolNames.length > 0 && (
          <span className="traj-tools">
            <Wrench size={11} />
            {record.toolNames.join(', ')}
          </span>
        )}
        <span className="traj-dur">
          <Clock size={11} />
          {formatDuration(record.durationMs)}
        </span>
        {record.streamMetrics?.timeToFirstOutputMs !== null && record.streamMetrics?.timeToFirstOutputMs !== undefined && (
          <span className="traj-ttft" title="首个模型输出到达时间">首输出 {formatDuration(record.streamMetrics.timeToFirstOutputMs)}</span>
        )}
      </button>
      {open && (
        <div className="traj-body">
          <div className="traj-meta">
            发送 {record.requestMessageCount} 条消息 · {record.promptChars} 字符
            {record.usage?.inputTokens !== undefined && ` · 输入 ${record.usage.inputTokens} 词元`}
            {record.streamMetrics && ` · ${record.streamMetrics.transport.toUpperCase()} ${record.streamMetrics.eventCount} 包 · 输出 ${record.streamMetrics.outputChars} 字符`}
          </div>
          {record.streamMetrics && (
            <div className="traj-meta">
              首事件 {record.streamMetrics.timeToFirstEventMs === null ? '—' : formatDuration(record.streamMetrics.timeToFirstEventMs)}
              {' · '}首输出 {record.streamMetrics.timeToFirstOutputMs === null ? '—' : formatDuration(record.streamMetrics.timeToFirstOutputMs)}
              {' · '}包间隔 P50 {record.streamMetrics.interEventP50Ms === null ? '—' : formatDuration(record.streamMetrics.interEventP50Ms)}
              {' · '}P95 {record.streamMetrics.interEventP95Ms === null ? '—' : formatDuration(record.streamMetrics.interEventP95Ms)}
            </div>
          )}
          <div className="traj-section-label">请求尾部（实际发送）</div>
          {record.requestTail.map((message, index) => (
            <div key={index} className={`traj-msg role-${message.role}`}>
              <span className="traj-msg-role">{message.role}</span>
              <span className="traj-msg-text">{message.content.slice(0, 600)}</span>
            </div>
          ))}
          {record.responseText && (
            <>
              <div className="traj-section-label">模型输出</div>
              <div className="traj-response">{record.responseText.slice(0, 1200)}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Model trajectory viewer: every model round-trip of this session, newest
 * last, with the real prompt tail and response for each. The recorder lives in
 * the CLI (it owns what was actually sent), so this panel only reads.
 */
export function ModelTrajectoryPanel({ sessionId }: { sessionId?: string }) {
  const [records, setRecords] = useState<TrajectoryRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) { setRecords([]); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    void desktop.sessions.trajectory(sessionId).then((next) => {
      if (!alive) return;
      if (next.ok) {
        setRecords(next.records ?? []);
        setError(null);
      } else {
        setError(next.error ?? '读取失败');
      }
      setLoading(false);
    });
    return () => { alive = false; };
  }, [sessionId]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return records;
    return records.filter((record) => (
      record.model.toLowerCase().includes(needle)
      || record.responseText.toLowerCase().includes(needle)
      || record.toolNames.some((name) => name.toLowerCase().includes(needle))
    ));
  }, [records, query]);

  const totals = useMemo(() => records.reduce(
    (acc, record) => ({
      durationMs: acc.durationMs + (record.durationMs ?? 0),
      chars: acc.chars + (record.promptChars ?? 0),
    }),
    { durationMs: 0, chars: 0 },
  ), [records]);

  return (
    <div className="trajectory-panel">
      <div className="trajectory-toolbar">
        <span className="trajectory-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模型、工具或回复内容…"
          />
        </span>
      </div>

      <div className="trajectory-summary">
        共 <strong>{records.length}</strong> 次模型调用
        {records.length > 0 && (
          <>
            {' · '}累计 <strong>{formatDuration(totals.durationMs)}</strong>
            {' · '}送入 <strong>{Math.round(totals.chars / 1000)}k</strong> 字符
          </>
        )}
      </div>

      {loading && <div className="trajectory-empty" role="status" aria-busy="true">正在读取轨迹…</div>}
      {!loading && error && <div className="trajectory-empty trajectory-error" role="alert">{error}</div>}
      {!loading && !error && records.length === 0 && (
        <div className="trajectory-empty" role="status">
          这个会话还没有模型调用记录。轨迹从启用后新建的调用开始记录。
        </div>
      )}

      <div className="trajectory-list">
        {visible.map((record) => <TrajectoryRow key={record.requestId} record={record} />)}
      </div>
    </div>
  );
}
