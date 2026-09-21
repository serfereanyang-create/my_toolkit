import { useEffect, useState, useRef } from 'react';
import { Wifi, Copy, Pencil, Check, FoldVertical } from 'lucide-react';
import type { AppState, ChatItem } from '../types';
import type { AppAction } from '../lib/state';
import { ToolCard } from './ToolCard';
import { TurnSummary } from './TurnSummary';
import { ChatLauncher } from './ChatLauncher';
import { Markdown } from './Markdown';
import { MessageOutline } from './MessageOutline';
import { activeTurnProgress } from '../lib/state';
import { desktop } from '../lib/ipc';
import { TaskBoardCard } from './TaskBoardCard';
import { ReviewReport } from './ReviewReport';

export function ConversationStream({ state, onApprove, onEditUser, onLaunch, onUndo, onOpenFile, dispatch, expandAll, onPickCommand, onCancel }: {
  state: AppState;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
  onEditUser: (text: string) => void;
  onLaunch: (id: string) => void;
  onUndo: (turnId: string) => void;
  onOpenFile?: (path: string) => void;
  dispatch: React.Dispatch<AppAction>;
  /** Ctrl+O global expand/collapse of all tool step details. */
  expandAll?: boolean;
  /** Codex welcome screen: clicking a starter command prefills the composer. */
  onPickCommand?: (command: string) => void;
  /** Codex status row: "esc to interrupt" — click or Esc cancels the turn. */
  onCancel?: () => void;
}) {
  const streamRef = useRef<HTMLDivElement>(null);
  // Whether the user is reading near the bottom. While streaming, deltas must
  // keep the view pinned to the newest output — but once the user scrolls up
  // to read, auto-scroll must stop yanking them back down.
  const nearBottomRef = useRef(true);

  // Length of the last assistant text: streaming deltas mutate it in place
  // without changing chat.length, so this is the signal to keep following.
  const lastItem = state.chat[state.chat.length - 1];
  const streamingLen = lastItem?.kind === 'assistant' ? lastItem.text.length : 0;

  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const onScroll = () => {
      nearBottomRef.current = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
    };
    stream.addEventListener('scroll', onScroll, { passive: true });
    return () => stream.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll: smooth for new messages, instant while streaming deltas so
  // high-frequency updates don't fight the smooth-scroll animation.
  useEffect(() => {
    if (!nearBottomRef.current) return;
    const stream = streamRef.current;
    if (!stream) return;
    stream.scrollTop = stream.scrollHeight;
  }, [state.chat.length, streamingLen]);

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
    const activeProvider = state.settings?.providers.find((item) => item.id === state.settings?.activeProviderId);
    return (
      <div className="stream" ref={streamRef}>
        <ChatLauncher
          onPick={onLaunch}
          onPickCommand={onPickCommand}
          model={activeProvider?.model}
          workspaceRoot={state.workspaceRoot}
        />
      </div>
    );
  }

  return (
    <div className="stream" ref={streamRef}>
      {progress && (
        // codex status_indicator_widget.rs: `• Working (12s • esc to interrupt)`
        // with the blinking bullet; the parenthetical hint cancels the turn.
        <div className="workflow-progress" role="status">
          <button className="workflow-progress-main" onClick={() => dispatch({ type: 'work/toggle' })} title="查看工作详情">
            <span className="codex-bullet blink">•</span>
            <span className="workflow-progress-label">Working</span>
            <span className="workflow-progress-paren">
              ({fmtElapsedCompact(progress.elapsedMs)}
              {onCancel && (
                <> • <span className="workflow-progress-key">esc</span> to interrupt</>
              )}
              )
            </span>
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
          </button>
          {onCancel && (
            <button className="workflow-progress-cancel" onClick={onCancel} title="停止当前轮次（Esc）">
              停止
            </button>
          )}
        </div>
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
            ? <TurnRow key={item.id} item={item} onApprove={onApprove} onUndo={onUndo} now={now} onOpenFile={onOpenFile} expandAll={expandAll} />
            : <Row key={item.id} item={item} onApprove={onApprove} onEditUser={onEditUser} onOpenFile={onOpenFile} dispatch={dispatch} />
        )}
        <div />
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

function TurnRow({ item, onApprove, onUndo, now, onOpenFile, expandAll }: {
  item: Extract<ChatItem, { kind: 'turn' }>;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
  onUndo: (turnId: string) => void;
  now: number;
  onOpenFile?: (path: string) => void;
  expandAll?: boolean;
}) {
  return <TurnSummary item={item} onApprove={onApprove} onUndo={onUndo} now={now} onOpenFile={onOpenFile} expandAll={expandAll} />;
}

function Row({ item, onApprove, onEditUser, onOpenFile, dispatch }: {
  item: Exclude<ChatItem, { kind: 'turn' }>;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
  onEditUser: (text: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  dispatch: React.Dispatch<AppAction>;
}) {
  if (item.kind === 'tool' || item.kind === 'approval') return <ToolCard item={item} onApprove={onApprove} />;
  if (item.kind === 'compaction') {
    // Codex renders compaction as a full-width hairline divider with the
    // label centered over it; the running row pulses, the done row is static.
    const label = item.phase === 'running'
      ? '正在压缩上下文'
      : item.phase === 'failed'
        ? '上下文压缩失败'
        : item.auto ? '上下文已自动压缩' : '上下文已压缩';
    return (
      <div className={`compaction-divider ${item.phase}`} role="status">
        <span className="compaction-divider-line" />
        <span className="compaction-divider-label">
          {item.phase !== 'running' && <FoldVertical size={13} />}
          {label}
        </span>
        <span className="compaction-divider-line" />
      </div>
    );
  }
  if (item.kind === 'user') {
    return (
      <div className="msg-user-group">
        {/* codex messages.rs: bold `›` prefix on the user block */}
        <div className="msg-user"><span className="msg-user-caret">›</span>{item.text}</div>
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
  if (item.kind === 'review') {
    // Rendered from the structured report rather than the prose: the same
    // component the 审查 tab uses, so the transcript and the tab cannot
    // disagree about what the review said.
    return <ReviewReport review={item} onOpenFile={onOpenFile} />;
  }
  
  // Assistant message with code block actions
  const hasCodeBlock = item.text.includes('```');
  if (hasCodeBlock) {
    return <AssistantWithCodeBlocks text={item.text} dispatch={dispatch} anchorPrefix={`m-${item.id}`} />;
  }
  
  return (
    <div className="msg-assistant">
      <MessageOutline text={item.text} anchorPrefix={`m-${item.id}`} />
      <Markdown text={item.text} anchorPrefix={`m-${item.id}`} />
    </div>
  );
}

function AssistantWithCodeBlocks({ text, dispatch, anchorPrefix }: { text: string; dispatch: React.Dispatch<AppAction>; anchorPrefix: string }) {
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
      <MessageOutline text={text} anchorPrefix={anchorPrefix} />
      {parts.map((part, idx) => {
        if (part.type === 'text') {
          return part.content.trim() ? <Markdown key={idx} text={part.content} anchorPrefix={anchorPrefix} /> : null;
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

/** status_indicator_widget.rs fmt_elapsed_compact: 42s / 3m 05s / 1h 02m 03s. */
function fmtElapsedCompact(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}
