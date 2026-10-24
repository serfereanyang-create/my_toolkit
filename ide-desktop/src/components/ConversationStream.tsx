import { memo, useCallback, useDeferredValue, useEffect, useState, useRef } from 'react';
import { Wifi, Copy, Pencil, Check, FoldVertical, FolderSearch, FileCode2, Bug } from 'lucide-react';
import type { AppState, ChatItem } from '../types';
import type { AppAction } from '../lib/state';
import { ToolCard } from './ToolCard';
import { TurnSummary } from './TurnSummary';
import { Markdown } from './Markdown';
import { MessageOutline } from './MessageOutline';
import { activeTurnProgress } from '../lib/state';
import { desktop } from '../lib/ipc';
import { TaskBoardCard } from './TaskBoardCard';
import { ReviewReport } from './ReviewReport';
import { formatWorkDuration } from '../lib/workProgress';
import { copyText } from '../lib/clipboard';

export function ConversationStream({ state, onApprove, onEditUser, onUndo, onOpenFile, dispatch, expandAll, onCancel }: {
  state: AppState;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
  onEditUser: (text: string) => void;
  onUndo: (turnId: string) => void;
  onOpenFile?: (path: string) => void;
  dispatch: React.Dispatch<AppAction>;
  /** Ctrl+O global expand/collapse of all tool step details. */
  expandAll?: boolean;
  /** Codex status row: "esc to interrupt" — click or Esc cancels the turn. */
  onCancel?: () => void;
}) {
  const streamRef = useRef<HTMLDivElement>(null);
  // Every streamed delta re-renders this component. Only the row that actually
  // changed should re-render, so the callbacks handed to the rows must keep
  // their identity: the parent passes inline arrows, which would break row-level
  // memoisation on every event. Forward through a ref instead.
  const handlersRef = useRef({ onApprove, onEditUser, onUndo, onOpenFile });
  handlersRef.current = { onApprove, onEditUser, onUndo, onOpenFile };
  const stableApprove = useCallback((requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => handlersRef.current.onApprove(requestId, decision), []);
  const stableEditUser = useCallback((text: string) => handlersRef.current.onEditUser(text), []);
  const stableUndo = useCallback((turnId: string) => handlersRef.current.onUndo(turnId), []);
  const stableOpenFile = useCallback((path: string, line?: number) => {
    (handlersRef.current.onOpenFile as ((path: string, line?: number) => void) | undefined)?.(path, line);
  }, []);
  // Whether the user is reading near the bottom. While streaming, deltas must
  // keep the view pinned to the newest output — but once the user scrolls up
  // to read, auto-scroll must stop yanking them back down.
  const nearBottomRef = useRef(true);

  // Length of the last assistant text: streaming deltas mutate it in place
  // without changing chat.length, so this is the signal to keep following.
  const lastItem = state.chat[state.chat.length - 1];
  const streamingLen = lastItem?.kind === 'assistant' ? lastItem.text.length : 0;
  // Throughput readout: while a reply streams, show how much has landed and how
  // fast. A frozen answer and a slow answer look identical without it, which is
  // why the conversation used to feel like nothing was happening.
  const streamingChars = lastItem?.kind === 'assistant' && lastItem.id === 'assistant-live' ? lastItem.text.length : 0;
  const firstCharAtRef = useRef<number | null>(null);
  if (streamingChars > 0 && firstCharAtRef.current === null) firstCharAtRef.current = Date.now();
  if (streamingChars === 0) firstCharAtRef.current = null;

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

  // The two signals above miss the case that matters most during a real run:
  // a tool step being appended (or its output block expanding, or a screenshot
  // arriving) grows the transcript without changing chat.length or the
  // assistant text length. The view then froze wherever it was while the turn
  // kept working below the fold. Watch the content box itself instead of
  // guessing which state fields imply growth.
  useEffect(() => {
    const stream = streamRef.current;
    const content = stream?.querySelector('.stream-inner');
    if (!stream || !content) return;
    const observer = new ResizeObserver(() => {
      if (!nearBottomRef.current) return;
      stream.scrollTop = stream.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [state.chat.length === 0]);

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

  // An empty conversation stays empty. It used to render a first-run card
  // (>_ YOYcode header, model/workspace, a "To get started" command list and a
  // row of launcher buttons) whenever the transcript was empty — so it came
  // back in every new conversation. That card is a first-run affordance, not
  // something to re-show on every Ctrl+N.
  //
  // Nothing became unreachable: every action it offered is in the command
  // palette (Ctrl+Shift+P) and the terminal it opened is the bottom panel
  // (Ctrl+T). The floating terminal it also opened keeps its own palette entry.
  // An empty conversation shows the ZCode-style welcome — greeting plus a few
  // suggestion chips that prefill the composer. The old first-run card came
  // back on every Ctrl+N because it mixed first-run affordances (launcher
  // buttons, command lists) into it; this one is deliberately just text and
  // three chips, all of which only prefill the input.
  if (state.chat.length === 0) {
    const suggestions = [
      { text: '梳理项目结构', prompt: '梳理这个项目的结构', icon: FolderSearch },
      { text: '解释代码改动', prompt: '解释最近改动的代码', icon: FileCode2 },
      { text: '排查一个问题', prompt: '帮我修一个 bug', icon: Bug },
    ];
    return (
      <div className="stream" ref={streamRef}>
        <div className="chat-welcome">
          <div className="chat-welcome-mark" aria-hidden="true">
            <img src="./icon.svg" alt="" />
          </div>
          <h2 className="chat-welcome-title">今天想做点什么？</h2>
          <p className="chat-welcome-hint">描述一个需求，或从项目里的一个问题开始。</p>
          <div className="chat-welcome-chips">
            {suggestions.map(({ text, prompt, icon: Icon }) => (
              <button key={text} type="button" className="chat-welcome-chip" onClick={() => onEditUser(prompt)}>
                <Icon size={15} aria-hidden="true" />{text}
              </button>
            ))}
          </div>
        </div>
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
            <span className="workflow-progress-label">正在工作</span>
            <span className="workflow-progress-paren">
              {formatWorkDuration(progress.elapsedMs)}
              {onCancel && (
                <> · <span className="workflow-progress-key">Esc</span> 停止</>
              )}
            </span>
            <span className="workflow-progress-sep">·</span>
            <span className="workflow-progress-step">第{progress.stepCount}步</span>
            {progress.lastTool && (
              <>
                <span className="workflow-progress-sep">·</span>
                <span className="workflow-progress-tool">{progress.lastTool}</span>
              </>
            )}
            {streamingChars > 0 && (() => {
              const firstCharAt = firstCharAtRef.current;
              // TTFT: 从回合开始到第一个字到达。流式体感差的时候，这个数字最能说明问题。
              const turnStartedAt = Date.now() - progress.elapsedMs;
              const ttftMs = firstCharAt ? Math.max(0, firstCharAt - turnStartedAt) : null;
              const seconds = firstCharAt ? Math.max(0.4, (now - firstCharAt) / 1000) : 0;
              const rate = seconds ? Math.round(streamingChars / seconds) : 0;
              return (
                <>
                  <span className="workflow-progress-sep">·</span>
                  <span
                    className="workflow-progress-stream"
                    title={ttftMs !== null ? `首字 ${formatWorkDuration(ttftMs)} 后到达` : '等待首字'}
                  >
                    生成中 {streamingChars} 字{rate > 0 ? ` · ${rate} 字/秒` : ''}
                  </span>
                </>
              );
            })()}
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
        {state.taskBoard && <TaskBoardCard board={state.taskBoard} onAction={(action, taskId) => {
          void desktop.agent.taskBoardAction(action, taskId, state.activeSessionId ?? undefined).catch(error => dispatch({ type: 'agent/event', event: { type: 'error', sessionId: state.activeSessionId ?? undefined, message: `任务计划操作失败：${error instanceof Error ? error.message : String(error)}` } }));
        }} />}
        {state.agentStatus === 'starting' && (
          <div className="status-line"><Wifi size={15} /> 正在连接…</div>
        )}
        {/* UX-4 fix: only pass `now` to turn items that actually need it for the
            live timer.  All other items (user/assistant/tool/approval) are pure
            display and do NOT depend on the time, so they skip the prop and avoid
            re-rendering every second during an active agent turn. */}
        {state.chat.map((item) =>
          item.kind === 'turn'
            // `now` only matters to a turn that is still running: passing the
            // ticking value to finished turns re-rendered every historical row
            // once a second for nothing.
            ? <MemoTurnRow key={item.id} item={item} onApprove={stableApprove} onUndo={stableUndo} now={item.endedAt === undefined ? now : 0} onOpenFile={stableOpenFile} expandAll={expandAll} />
            : <MemoRow key={item.id} item={item} onApprove={stableApprove} onEditUser={stableEditUser} onOpenFile={stableOpenFile} dispatch={dispatch} />
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
          <button className="msg-action" title="复制" onClick={() => { void copyText(item.text); }}><Copy size={14} /></button>
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
  // The live bubble is the one still being written: it gets a caret so the
  // answer visibly streams in rather than appearing as one finished block.
  const streaming = item.kind === 'assistant' && item.id === 'assistant-live';
  if (hasCodeBlock) {
    return <AssistantWithCodeBlocks text={item.text} dispatch={dispatch} anchorPrefix={`m-${item.id}`} streaming={streaming} />;
  }

  return <AssistantText text={item.text} anchorPrefix={`m-${item.id}`} streaming={streaming} />;
}

/**
 * The streaming bubble updates on every delta, so the whole text is re-parsed
 * each time. The body has to follow at full speed; the outline (which walks the
 * same text again for headings) is deferred so a long answer does not spend its
 * frame budget twice on the same characters.
 */
function AssistantText({ text, anchorPrefix, streaming }: { text: string; anchorPrefix: string; streaming?: boolean }) {
  const outlineText = useDeferredValue(text);
  return (
    <div className={`msg-assistant ${streaming ? 'streaming' : ''}`}>
      <MessageOutline text={outlineText} anchorPrefix={anchorPrefix} />
      <Markdown text={text} anchorPrefix={anchorPrefix} />
      {streaming && <span className="msg-stream-caret" aria-hidden="true" />}
      {!streaming && <ReplyCopyActions text={text} />}
    </div>
  );
}

/**
 * Copy the whole reply. Code blocks have carried their own copy button for a
 * while, but the prose around them had none, so lifting an answer out of the
 * transcript meant selecting text across rendered components.
 *
 * Always rendered and always clickable — a hover-revealed control positioned
 * past the last line was reported as impossible to hit (the pointer had to
 * leave the message to reach it, which dropped the hover and hid the button).
 * It sits dimmed in normal flow under the reply and brightens with the row;
 * the confirmation only appears once the text really reached the clipboard
 * (the navigator path rejects when the window is not focused — see
 * lib/clipboard). Not shown while the reply is still streaming: there is
 * nothing complete to copy yet.
 */
function ReplyCopyActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="msg-reply-actions">
      <button
        type="button"
        className={`msg-reply-copy${copied ? ' copied' : ''}`}
        title={copied ? '已复制' : '复制整条回复'}
        aria-label="复制整条回复"
        onClick={() => { void copyText(text).then((ok) => { if (ok) setCopied(true); }); }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

/**
 * Row identity is stable for every item except the one being written: the
 * reducer replaces only the live bubble. Memoising on that identity is what
 * turns one 120ms re-render per delta into one ~2ms re-render of a single row.
 */
const MemoRow = memo(Row);
const MemoTurnRow = memo(TurnRow);

function AssistantWithCodeBlocks({ text, dispatch, anchorPrefix, streaming }: { text: string; dispatch: React.Dispatch<AppAction>; anchorPrefix: string; streaming?: boolean }) {
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
    // Only confirm once the text really landed: the navigator path rejects
    // when the window is not focused, and this used to show 已复制 regardless.
    if (await copyText(code)) {
      setCopied(idx);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const lastPart = parts[parts.length - 1];

  return (
    <div className={`msg-assistant ${streaming ? 'streaming' : ''}`}>
      <MessageOutline text={text} anchorPrefix={anchorPrefix} />
      {parts.map((part, idx) => {
        if (part.type === 'text') {
          const isLast = idx === parts.length - 1;
          return part.content.trim() ? (
            <div key={idx} className={`msg-part ${isLast && streaming ? 'msg-part-live' : ''}`}>
              <Markdown text={part.content} anchorPrefix={anchorPrefix} />
              {/* A reply with code used to lose the streaming caret entirely,
                  because only the plain-text branch rendered one. Keep it on
                  whichever part is actually the tail. */}
              {isLast && streaming && <span className="msg-stream-caret" aria-hidden="true" />}
            </div>
          ) : null;
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
            {/* Still writing inside an unclosed fence: the tail is code, so the
                caret belongs under it rather than nowhere. */}
            {streaming && idx === parts.length - 1 && lastPart?.type === 'code' && (
              <span className="msg-stream-caret msg-stream-caret-block" aria-hidden="true" />
            )}
          </div>
        );
      })}
      {/* The reply's own markdown, fences included: pasting it back into a
          composer or a file should reproduce what was written, not a flattened
          transcript. */}
      {!streaming && <ReplyCopyActions text={text} />}
    </div>
  );
}
