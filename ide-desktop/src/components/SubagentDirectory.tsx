import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { SubagentRun, SubagentRunStatus } from '../lib/ipc';
import { formatAgo } from '../lib/recentFiles';

/*
 * SubagentDirectory — 子智能体目录.
 *
 * Lists every `spawn_subagent` run for the active session, split into 正在运行
 * and 已结束. Runs are recorded by the main process from the CLI's
 * subagent_started / subagent_done events and persisted to a workspace
 * sidecar, so the list survives a reload.
 *
 * The running/finished split is decided by the main process (only it knows
 * which sessions still have a live bridge); a run whose bridge died mid-flight
 * arrives as `interrupted` rather than a stale "running".
 */

const STATUS_VIEW: Record<SubagentRunStatus, { label: string; className: string }> = {
  running: { label: '运行中', className: 'subagent-status-running' },
  done: { label: '已完成', className: 'subagent-status-done' },
  failed: { label: '失败', className: 'subagent-status-failed' },
  interrupted: { label: '已中断', className: 'subagent-status-interrupted' },
};

function StatusIcon({ status }: { status: SubagentRunStatus }) {
  if (status === 'running') return <Loader2 size={15} className="subagent-spin" />;
  if (status === 'done') return <CheckCircle2 size={15} />;
  if (status === 'failed') return <XCircle size={15} />;
  return <AlertTriangle size={15} />;
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function SubagentDirectory({ sessionId }: { sessionId?: string }) {
  const [running, setRunning] = useState<SubagentRun[]>([]);
  const [finished, setFinished] = useState<SubagentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await desktop.subagents.list(sessionId);
      setRunning(Array.isArray(result.running) ? result.running : []);
      setFinished(Array.isArray(result.finished) ? result.finished : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while anything is running: the list has no push channel of its own
  // (the agent event stream drives the conversation, not this panel), and a
  // running row that never updates would look frozen. Stops when idle so an
  // open panel is not a permanent timer.
  const runningRef = useRef(false);
  runningRef.current = running.length > 0;
  useEffect(() => {
    const timer = window.setInterval(() => { if (runningRef.current) void refresh(); }, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <section className="subagent-panel" aria-label="子智能体目录">
      <header className="subagent-head">
        <span className="subagent-head-icon"><Bot size={16} /></span>
        <div className="subagent-head-titles">
          <strong>子智能体目录</strong>
          <span>由 spawn_subagent 派发的独立子会话</span>
        </div>
        <button
          type="button"
          className="subagent-refresh"
          onClick={() => void refresh()}
          disabled={loading}
          title="刷新"
        >
          <RefreshCw size={14} className={loading ? 'subagent-spin' : undefined} />
        </button>
      </header>

      {error && (
        <div className="subagent-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      <div className="subagent-section">
        <div className="subagent-section-head">
          <span>正在运行 · {running.length}</span>
        </div>
        {running.length === 0
          ? <p className="subagent-empty">没有正在运行的子智能体</p>
          : (
            <ul className="subagent-list">
              {running.map((run) => (
                <li key={`${run.id}-${run.startedAt}`} className="subagent-item">
                  <span className={`subagent-item-icon ${STATUS_VIEW[run.status].className}`}>
                    <StatusIcon status={run.status} />
                  </span>
                  <div className="subagent-item-main">
                    <div className="subagent-item-title">
                      <span>{run.goal || run.id}</span>
                      <span className={`subagent-status ${STATUS_VIEW[run.status].className}`}>
                        {STATUS_VIEW[run.status].label}
                      </span>
                    </div>
                    <div className="subagent-item-meta">
                      <code>{run.expert}</code>
                      <span>{formatAgo(new Date(run.startedAt).getTime())}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </div>

      <div className="subagent-section">
        <div className="subagent-section-head">
          <span>已结束 · {finished.length}</span>
        </div>
        {finished.length === 0
          ? <p className="subagent-empty">还没有已结束的子智能体</p>
          : (
            <ul className="subagent-list">
              {finished.map((run) => {
                const key = `${run.id}-${run.startedAt}`;
                const open = expanded === key;
                const view = STATUS_VIEW[run.status];
                return (
                  <li key={key} className={`subagent-item ${open ? 'open' : ''}`}>
                    <button
                      type="button"
                      className="subagent-item-head"
                      onClick={() => setExpanded(open ? null : key)}
                      aria-expanded={open}
                    >
                      <span className={`subagent-item-icon ${view.className}`}>
                        <StatusIcon status={run.status} />
                      </span>
                      <div className="subagent-item-main">
                        <div className="subagent-item-title">
                          <span>{run.goal || run.id}</span>
                          <span className={`subagent-status ${view.className}`}>{view.label}</span>
                        </div>
                        <div className="subagent-item-meta">
                          <code>{run.expert}</code>
                          {run.steps ? <span>{run.steps} 步</span> : null}
                          {run.durationMs ? <span>{formatDuration(run.durationMs)}</span> : null}
                          <span className="subagent-item-ago">
                            {run.finishedAt ? formatAgo(new Date(run.finishedAt).getTime()) : ''}
                          </span>
                        </div>
                        {!open && run.answer && (
                          <p className="subagent-item-preview">{run.answer}</p>
                        )}
                      </div>
                      <span className="subagent-item-chevron">
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                    </button>
                    {open && (
                      <div className="subagent-item-body">
                        {run.answer
                          ? <pre>{run.answer}</pre>
                          : <p className="subagent-empty">该子智能体没有返回文本结果。</p>}
                        {run.subSessionId && (
                          <div className="subagent-item-session">
                            子会话：<code>{run.subSessionId}</code>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
      </div>
    </section>
  );
}
