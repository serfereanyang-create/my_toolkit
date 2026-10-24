import { ChevronRight, CheckCircle2, Loader2, XCircle, Circle } from 'lucide-react';
import type { TaskSummary, ChatItem, ToolChatItem } from '../types';

export function TaskCard({ 
  summary, 
  chat,
  onToggle 
}: { 
  summary: TaskSummary;
  chat: ChatItem[];
  onToggle: () => void;
}) {
  // Prefer the running turn; fall back to the newest turn once it finished.
  // Looking only for an unfinished turn emptied the card the moment a task
  // completed: the title stayed in the top bar and (0/x) with it, so clicking
  // it opened nothing.
  let currentTurn: ChatItem | undefined;
  for (let i = chat.length - 1; i >= 0; i--) {
    const item = chat[i];
    if (item.kind !== 'turn') continue;
    if (item.endedAt === undefined) { currentTurn = item; break; }
    if (!currentTurn) currentTurn = item;
  }

  const steps: ToolChatItem[] = currentTurn?.kind === 'turn' ? currentTurn.steps : [];
  const completedSteps = steps.filter((s) => s.status === 'done' && s.ok).length;
  
  return (
    <div className="task-card-wrapper">
      <button className="task-card" onClick={onToggle}>
        <ChevronRight 
          size={14} 
          className={summary.expanded ? 'task-chevron open' : 'task-chevron'} 
        />
        <span className="task-title">{summary.title}</span>
        {steps.length > 0 && (
          <span className="task-progress">
            （{completedSteps}/{steps.length} 完成）
          </span>
        )}
      </button>
      
      {summary.expanded && steps.length > 0 && (
        <div className="task-steps-dropdown">
          {steps.map((step, i) => (
            <div key={step.id} className="task-step">
              {getStepIcon(step)}
              <span className="task-step-text">{step.tool}</span>
              {step.status === 'failed' && (
                <span className="task-step-error">失败</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function getStepIcon(step: ToolChatItem) {
  if (step.status === 'running') {
    return <Loader2 size={14} className="task-icon spin" />;
  }
  if (step.status === 'failed') {
    return <XCircle size={14} className="task-icon task-icon-error" />;
  }
  if (step.status === 'done' && step.ok) {
    return <CheckCircle2 size={14} className="task-icon task-icon-success" />;
  }
  return <Circle size={14} className="task-icon task-icon-muted" />;
}
