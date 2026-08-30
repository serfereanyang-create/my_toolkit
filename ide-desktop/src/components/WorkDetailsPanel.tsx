import { useState } from 'react';
import { BrainCircuit, Check, ChevronDown, ChevronRight, CircleAlert, FileEdit, Loader2, Search, Terminal, X } from 'lucide-react';
import type { AppState, WorkLogEntry } from '../types';

function iconFor(entry: WorkLogEntry) {
  if (entry.type === 'thinking' || entry.type === 'model') return <BrainCircuit size={15} />;
  if (entry.type === 'tool' && (entry.tool?.includes('read') || entry.tool?.includes('search'))) return <Search size={15} />;
  if (entry.type === 'tool' && (entry.tool?.includes('write') || entry.tool?.includes('edit') || entry.tool?.includes('patch'))) return <FileEdit size={15} />;
  if (entry.type === 'tool' && (entry.tool?.includes('run') || entry.tool?.includes('command'))) return <Terminal size={15} />;
  if (entry.type === 'error') return <CircleAlert size={15} />;
  return <Check size={15} />;
}

function groupTitle(type: WorkLogEntry['type']) {
  if (type === 'model' || type === 'thinking') return '思考过程';
  if (type === 'tool') return '探索与执行';
  if (type === 'approval') return '待处理';
  if (type === 'error') return '错误';
  return '过程记录';
}

function WorkEntry({ entry }: { entry: WorkLogEntry }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(entry.detail || entry.data);
  const status = entry.phase === 'running' ? <Loader2 size={13} className="work-spin" /> : entry.phase === 'failed' ? <CircleAlert size={13} /> : <Check size={13} />;
  return (
    <div className={`work-entry work-entry-${entry.phase}`}>
      <button className="work-entry-head" onClick={() => expandable && setOpen((v) => !v)} disabled={!expandable}>
        <span className="work-entry-icon">{iconFor(entry)}</span>
        <span className="work-entry-title">{entry.title}</span>
        {entry.durationMs != null && <span className="work-entry-duration">{(entry.durationMs / 1000).toFixed(1)}s</span>}
        <span className="work-entry-status">{status}</span>
        {expandable && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
      </button>
      {open && (
        <div className="work-entry-detail">
          {entry.detail && <pre>{entry.detail}</pre>}
          {entry.data !== undefined && <pre>{JSON.stringify(entry.data, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

export function WorkDetailsPanel({ state, onClose }: { state: AppState; onClose: () => void }) {
  const groups = new Map<string, WorkLogEntry[]>();
  for (const entry of state.workLog) {
    const title = groupTitle(entry.type);
    const list = groups.get(title) ?? [];
    list.push(entry);
    groups.set(title, list);
  }
  const turn = [...state.chat].reverse().find((item) => item.kind === 'turn');
  const boardDone = state.taskBoard?.tasks.filter((task) => task.status === 'done' || task.status === 'skipped').length ?? 0;
  const boardTotal = state.taskBoard?.tasks.length ?? 0;
  const boardProgress = boardTotal ? Math.round(boardDone / boardTotal * 100) : 0;
  const elapsed = turn && turn.kind === 'turn' ? Math.max(0, Math.round(((turn.endedAt ?? Date.now()) - turn.startedAt) / 1000)) : 0;
  return (
    <aside className="work-details-panel">
      <div className="work-panel-header">
        <div><strong>工作详情</strong><span>{state.workPhase === 'done' ? '已完成' : state.workPhase === 'failed' ? '执行失败' : '正在工作'}</span></div>
        <button className="work-panel-close" onClick={onClose} aria-label="关闭"><X size={16} /></button>
      </div>
      <div className="work-panel-summary">已工作 {elapsed} 秒 · {turn && turn.kind === 'turn' ? turn.steps.length : 0} 步</div>
      {state.taskBoard && <div className="work-panel-progress"><div><span>计划进度</span><strong>{boardDone}/{boardTotal} · {boardProgress}%</strong></div><div className="task-board-progress"><span style={{ width: `${boardProgress}%` }} /></div><small>{state.taskBoard.activeTaskId ? `当前任务：${state.taskBoard.tasks.find((task) => task.id === state.taskBoard?.activeTaskId)?.title ?? '—'}` : '暂无进行中任务'}</small></div>}
      <div className="work-panel-body">
        {[...groups.entries()].map(([title, entries]) => (
          <section className="work-group" key={title}>
            <h3>{title}</h3>
            {entries.map((entry) => <WorkEntry key={entry.id} entry={entry} />)}
          </section>
        ))}
        {state.workLog.length === 0 && <div className="work-empty">等待智能体开始工作</div>}
      </div>
      {turn && turn.kind === 'turn' && (
        <div className="work-panel-footer"><span className="turn-add">+{turn.added}</span><span className="turn-del">-{turn.removed}</span><span>{turn.files.length} 个文件</span></div>
      )}
    </aside>
  );
}
