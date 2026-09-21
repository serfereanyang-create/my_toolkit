import { AlertTriangle, Bot, CheckCircle2, CircleDashed, ListChecks, Loader2, RotateCw, XCircle } from 'lucide-react';
import type { SupervisedUnit, SupervisorSnapshot } from '../types';

/*
 * SupervisorPanel — 总控进度.
 *
 * The CLI supervisor aggregates every unit of work in a session (subagents,
 * board tasks) into one stream. This renders that aggregate, which answers a
 * question the per-run lists cannot: is anything still running, and has any of
 * it been running long enough to be stuck.
 *
 * It is read-only by design, matching the CLI: the supervisor reports state and
 * never intervenes, because "this looks stuck" is a judgement the UI is not in
 * a position to make. Acting on a run stays with the user.
 */

const KIND_LABEL: Record<SupervisedUnit['kind'], string> = {
  subagent: '子智能体',
  task: '任务',
  turn: '本轮',
};

const STATUS_VIEW: Record<SupervisedUnit['status'], { label: string; className: string }> = {
  running: { label: '运行中', className: 'sup-status-running' },
  done: { label: '已完成', className: 'sup-status-done' },
  failed: { label: '失败', className: 'sup-status-failed' },
  cancelled: { label: '已取消', className: 'sup-status-cancelled' },
  interrupted: { label: '已中断', className: 'sup-status-interrupted' },
};

function StatusIcon({ status }: { status: SupervisedUnit['status'] }) {
  if (status === 'running') return <Loader2 size={14} className="sup-spin" />;
  if (status === 'done') return <CheckCircle2 size={14} />;
  if (status === 'failed') return <XCircle size={14} />;
  if (status === 'cancelled') return <CircleDashed size={14} />;
  return <AlertTriangle size={14} />;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function SupervisorPanel({ snapshot }: { snapshot: SupervisorSnapshot | null }) {
  if (!snapshot || snapshot.units.length === 0) {
    return (
      <div className="sup-empty">
        <Bot size={20} />
        <strong>暂无工作单元</strong>
        <span>派发子智能体或执行任务板后，这里会汇总它们的进度</span>
      </div>
    );
  }

  const now = Date.now();
  return (
    <div className="sup-panel">
      <div className="sup-summary">
        <div className="sup-summary-row">
          <span>运行中</span>
          <strong>{snapshot.running}</strong>
        </div>
        <div className="sup-summary-row">
          <span>已完成</span>
          <strong>{snapshot.done}</strong>
        </div>
        <div className="sup-summary-row">
          <span>失败</span>
          <strong className={snapshot.failed > 0 ? 'sup-bad' : undefined}>{snapshot.failed}</strong>
        </div>
        <div className="sup-summary-row">
          <span>累计步数</span>
          <strong>{snapshot.steps}</strong>
        </div>
      </div>

      {snapshot.longestRunningMs !== undefined && snapshot.longestRunningMs > 0 && (
        <div className="sup-longest">
          <RotateCw size={12} />
          <span>最久的运行中单元已跑 {formatElapsed(snapshot.longestRunningMs)}</span>
        </div>
      )}

      <div className="sup-list">
        {snapshot.units.map((unit) => {
          const view = STATUS_VIEW[unit.status];
          const elapsed = (unit.finishedAt ?? now) - unit.startedAt;
          return (
            <div className={`sup-item ${view.className}`} key={`${unit.kind}:${unit.id}`}>
              <div className="sup-item-head">
                <span className="sup-item-icon"><StatusIcon status={unit.status} /></span>
                <span className="sup-item-kind">{KIND_LABEL[unit.kind]}</span>
                <span className="sup-item-id">{unit.id}</span>
                {unit.segment !== undefined && unit.segment > 1 && (
                  // A rollover means the unit ran out of its segment budget and
                  // continued in a fresh session — worth showing, since it
                  // explains why one unit has several sessions.
                  <span className="sup-item-segment">第 {unit.segment} 段</span>
                )}
                <span className="sup-item-status">{view.label}</span>
              </div>
              <div className="sup-item-label" title={unit.label}>{unit.label}</div>
              <div className="sup-item-meta">
                <span>{unit.steps} 步</span>
                <span>{formatElapsed(elapsed)}</span>
                {unit.expert && <span>{unit.expert}</span>}
              </div>
              {unit.error && <div className="sup-item-error">{unit.error}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
