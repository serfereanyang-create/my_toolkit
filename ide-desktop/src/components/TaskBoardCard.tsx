import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, Loader2, Pause, Play, SkipForward, RotateCcw, AlertTriangle } from 'lucide-react';
import type { TaskBoard } from '../types';

type Action = 'confirm' | 'pause' | 'continue' | 'skip' | 'reopen';

const STATUS_LABEL: Record<string, string> = {
  pending: '待处理', in_progress: '进行中', done: '已完成', blocked: '已阻塞', skipped: '已跳过', cancelled: '已取消',
};

function stageFor(task: TaskBoard['tasks'][number], tasks: TaskBoard['tasks']): number {
  if (!task.dependsOn.length) return 1;
  return Math.min(4, 1 + Math.max(...task.dependsOn.map((id) => {
    const parent = tasks.find((item) => item.id === id);
    return parent ? stageFor(parent, tasks) : 0;
  })));
}

function statusIcon(status: string) {
  if (status === 'done') return <Check size={14} />;
  if (status === 'in_progress') return <Loader2 size={14} className="task-board-spin" />;
  if (status === 'blocked') return <AlertTriangle size={14} />;
  return <Circle size={12} />;
}

export function TaskBoardCard({ board, onAction }: { board: TaskBoard; onAction: (action: Action, taskId?: string) => void }) {
  const [open, setOpen] = useState(true);
  const [expandedTask, setExpandedTask] = useState<string | null>(board.activeTaskId ?? null);
  const stages = useMemo(() => {
    const grouped = new Map<number, typeof board.tasks>();
    board.tasks.forEach((task) => {
      const stage = stageFor(task, board.tasks);
      grouped.set(stage, [...(grouped.get(stage) ?? []), task]);
    });
    return [...grouped.entries()].sort((a, b) => a[0] - b[0]);
  }, [board.tasks]);
  const done = board.tasks.filter((task) => task.status === 'done' || task.status === 'skipped').length;
  const progress = board.tasks.length ? Math.round(done / board.tasks.length * 100) : 0;
  const waiting = board.status === 'draft' || board.runtimeMode === 'awaiting_confirm';
  const activeTask = board.tasks.find((task) => task.id === board.activeTaskId);

  return (
    <section className={`task-board-card task-board-${board.status}`}>
      <button className="task-board-head" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span className="task-board-head-main">
          <strong>{board.title || '任务计划'}</strong>
          <small>{waiting ? '等待确认' : board.status === 'completed' ? '已完成' : board.runtimeMode === 'paused' ? '已暂停' : '执行中'}</small>
        </span>
        <span className="task-board-count">{done}/{board.tasks.length}</span>
      </button>
      {open && (
        <div className="task-board-body">
          <div className="task-board-goal">{board.goal}</div>
          <div className="task-board-progress-row"><span>总体进度</span><strong>{progress}%</strong></div>
          <div className="task-board-progress"><span style={{ width: `${progress}%` }} /></div>
          {activeTask && <div className="task-board-current">当前任务：<strong>{activeTask.title}</strong></div>}

          <div className="task-board-stages">
            {stages.map(([stage, tasks]) => {
              const stageDone = tasks.filter((task) => task.status === 'done' || task.status === 'skipped').length;
              return (
                <section className="task-board-stage" key={stage}>
                  <div className="task-board-stage-head"><span>阶段 {stage}</span><small>{stageDone}/{tasks.length}</small></div>
                  {tasks.map((task) => {
                    const isCurrent = task.id === board.activeTaskId;
                    const isExpanded = expandedTask === task.id;
                    return (
                      <div className={`task-board-item task-${task.status} ${isCurrent ? 'current' : ''}`} key={task.id}>
                        <button className="task-board-item-head" onClick={() => setExpandedTask(isExpanded ? null : task.id)}>
                          <span className="task-board-item-icon">{statusIcon(task.status)}</span>
                          <span className="task-board-item-title">{task.title}</span>
                          {isCurrent && <em>当前</em>}
                          <span className="task-board-item-status">{STATUS_LABEL[task.status] ?? task.status}</span>
                          {(task.acceptance.length > 0 || task.result || task.error) && (isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
                        </button>
                        {isExpanded && (
                          <div className="task-board-item-detail">
                            {task.dependsOn.length > 0 && <div>依赖：{task.dependsOn.join('、')}</div>}
                            {task.acceptance.length > 0 && <div><strong>验收标准</strong><ul>{task.acceptance.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
                            {task.result && <div className="task-board-result">结果：{task.result}</div>}
                            {task.error && <div className="task-board-error">错误：{task.error}</div>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>

          <div className="task-board-actions">
            {waiting && <button className="task-board-primary" onClick={() => onAction('confirm')}><Play size={14} /> 确认执行计划</button>}
            {board.runtimeMode === 'executing' && <button onClick={() => onAction('pause')}><Pause size={14} /> 暂停</button>}
            {board.runtimeMode === 'paused' && <button className="task-board-primary" onClick={() => onAction('continue')}><Play size={14} /> 继续执行</button>}
            {activeTask && board.runtimeMode === 'executing' && <button onClick={() => onAction('skip', activeTask.id)}><SkipForward size={14} /> 跳过当前</button>}
            {board.status === 'blocked' && activeTask && <button onClick={() => onAction('reopen', activeTask.id)}><RotateCcw size={14} /> 重新打开</button>}
          </div>
        </div>
      )}
    </section>
  );
}
