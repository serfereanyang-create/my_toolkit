import { useEffect, useState, useRef } from 'react';
import { Wifi, Copy, Pencil, Loader2, Check } from 'lucide-react';
import type { AppState, ChatItem } from '../types';
import type { AppAction } from '../lib/state';
import { ToolCard } from './ToolCard';
import { TurnSummary } from './TurnSummary';
import { ChatLauncher } from './ChatLauncher';
import { Markdown } from './Markdown';
import { activeTurnProgress } from '../lib/state';
import { desktop } from '../lib/ipc';
import { TaskBoardCard } from './TaskBoardCard';

export function ConversationStream({ state, onApprove, onEditUser, onLaunch, onUndo, onOpenFile, dispatch }: {
  state: AppState;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
  onEditUser: (text: string) => void;
  onLaunch: (id: string) => void;
  onUndo: (turnId: string) => void;
  onOpenFile?: (path: string) => void;
  dispatch: React.Dispatch<AppAction>;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.chat.length]);

  // Tick once a second only while a turn is still running, so the "已工作" timer
  // counts up live without re-rendering the whole stream when idle.
  const hasRunningTurn = state.chat.some((item) => item.kind === 'turn' && item.endedAt === undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunningTurn) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunningTurn]);

  const progress = activeTurnProgress(state);

  if (state.chat.length === 0) {
    return (
      <div className="stream">
        <ChatLauncher onPick={onLaunch} />
      </div>
    );
  }

  return (
    <div className="stream">
      {progress && (
        <button className="workflow-progress" onClick={() => dispatch({ type: 'work/toggle' })} title="查看工作详情">
          <Loader2 size={14} className="workflow-progress-spinner" />
          <span className="workflow-progress-label">正在工作</span>
          <span className="workflow-progress-sep">·</span>
          <span className="workflow-progress-step">第{progress.stepCount}步</span>
          {progress.lastTool && (
            <>
              <span className="workflow-progress-sep">·</span>
              <span className="workflow-progress-tool">{progress.lastTool}</span>
            </>
          )}
          {(progress.added > 0 || progress.removed > 0) && (
            <>
              <span className="workflow-progress-sep">·</span>
              <span className="workflow-progress-changes">
                <span className="workflow-progress-add">+{progress.added}</span>
                <span className="workflow-progress-del">−{progress.removed}</span>
              </span>
            </>
          )}
          <span className="workflow-progress-sep">·</span>
          <span className="workflow-progress-time">
            已工作 {Math.floor(progress.elapsedMs / 1000)}秒
          </span>
        </button>
      )}
      <div className="stream-inner">
        {state.taskBoard && <TaskBoardCard board={state.taskBoard} onAction={(action, taskId) => void desktop.agent.taskBoardAction(action, taskId)} />}
        {state.agentStatus === 'starting' && (
          <div className="status-line"><Wifi size={15} /> 正在连接…</div>
        )}
        {/* UX-4 fix: only pass `now` to turn items that actually need it for the
            live timer.  All other items (user/assistant/tool/approval) are pure
            display and do NOT depend on the time, so they skip the prop and avoid
            re-rendering every second during an active agent turn. */}
        {state.chat.map((item) =>
          item.kind === 'turn'
            ? <TurnRow key={item.id} item={item} onApprove={onApprove} onUndo={onUndo} now={now} onOpenFile={onOpenFile} />
            : <Row key={item.id} item={item} onApprove={onApprove} onEditUser={onEditUser} dispatch={dispatch} />
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}

function formatTime(ts?: number): string {
  const date = ts ? new Date(ts) : new Date();
  const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${days[date.getDay()]}${hh}:${mm}`;
}

function TurnRow({ item, onApprove, onUndo, now, onOpenFile }: {
  item: Extract<ChatItem, { kind: 'turn' }>;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
  onUndo: (turnId: string) => void;
  now: number;
  onOpenFile?: (path: string) => void;
}) {
  return <TurnSummary item={item} onApprove={onApprove} onUndo={onUndo} now={now} onOpenFile={onOpenFile} />;
}

function Row({ item, onApprove, onEditUser, dispatch }: {
  item: Exclude<ChatItem, { kind: 'turn' }>;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
  onEditUser: (text: string) => void;
  dispatch: React.Dispatch<AppAction>;
}) {
  if (item.kind === 'tool' || item.kind === 'approval') return <ToolCard item={item} onApprove={onApprove} />;
  if (item.kind === 'user') {
    return (
      <div className="msg-user-group">
        <div className="msg-user">{item.text}</div>
        <div className="msg-user-meta">
          <span className="msg-time">{formatTime(item.ts)}</span>
          <button className="msg-action" title="复制" onClick={() => navigator.clipboard?.writeText(item.text)}><Copy size={14} /></button>
          <button className="msg-action" title="编辑" onClick={() => onEditUser(item.text)}><Pencil size={14} /></button>
        </div>
      </div>
    );
  }
  if (item.kind === 'error') {
    return (
      <div className="msg-error" role="alert">
        <span className="msg-error-icon">⚠</span>
        <span className="msg-error-text">{item.text}</span>
      </div>
    );
  }
  
  // Assistant message with code block actions
  const hasCodeBlock = item.text.includes('```');
  if (hasCodeBlock) {
    return <AssistantWithCodeBlocks text={item.text} dispatch={dispatch} />;
  }
  
  return <div className="msg-assistant"><Markdown text={item.text} /></div>;
}

function AssistantWithCodeBlocks({ text, dispatch }: { text: string; dispatch: React.Dispatch<AppAction> }) {
  const [copied, setCopied] = useState<number | null>(null);

  // Extract code blocks using string split
  const parts: Array<{ type: 'text' | 'code'; content: string; lang?: string }> = [];
  const lines = text.split('\n');
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      // Code block start
      const lang = line.slice(3).trim() || 'text';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      parts.push({ type: 'code', content: codeLines.join('\n'), lang });
      i++; // skip closing ```
    } else {
      // Regular text
      const textLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        textLines.push(lines[i]);
        i++;
      }
      if (textLines.length > 0) {
        parts.push({ type: 'text', content: textLines.join('\n') });
      }
    }
  }

  const handleApply = async (code: string, idx: number) => {
    // 简化：直接保存到 workspace 根目录下的临时文件
    const filename = `ai-generated-${Date.now()}.txt`;
    try {
      await desktop.fs.write(filename, code);
      setCopied(idx);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to save code:', err);
    }
  };

  const handleCopy = async (code: string, idx: number) => {
    await navigator.clipboard?.writeText(code);
    setCopied(idx);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="msg-assistant">
      {parts.map((part, idx) => {
        if (part.type === 'text') {
          return part.content.trim() ? <Markdown key={idx} text={part.content} /> : null;
        }
        return (
          <div key={idx} className="code-block-with-actions">
            <div className="code-block-header">
              <span className="code-block-lang">{part.lang}</span>
              <div className="code-block-actions">
                <button className="code-block-btn" onClick={() => handleCopy(part.content, idx)}>
                  {copied === idx ? <Check size={14} /> : <Copy size={14} />}
                  {copied === idx ? '已复制' : '复制'}
                </button>
                <button className="code-block-btn code-block-btn-primary" onClick={() => handleApply(part.content, idx)}>
                  <Check size={14} />
                  应用
                </button>
              </div>
            </div>
            <pre className={`language-${part.lang}`}>
              <code>{part.content}</code>
            </pre>
          </div>
        );
      })}
    </div>
  );
}
