import { useEffect, useRef, useState } from 'react';
import { FilePlus, MessageSquare, Clock, Files, Settings, PanelLeft, Search, HelpCircle, Pin, CalendarClock, FolderOpen, Check, X } from 'lucide-react';
import type { AppState, SessionMeta } from '../types';
import { HelpMenu, type HelpAction } from './HelpMenu';
import { ConversationContextMenu, type ConvoAction } from './ConversationContextMenu';

type MainView = 'chat' | 'files' | 'git' | 'automation' | 'settings' | 'editor';

// ── Rename dialog ─────────────────────────────────────────────────────────────
function RenameDialog({ initialTitle, onConfirm, onCancel }: {
  initialTitle: string;
  onConfirm: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  function handleConfirm() {
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
  }

  return (
    <div className="rename-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="rename-dialog" role="dialog" aria-modal="true">
        <div className="rename-dialog-head">
          <span>重命名会话</span>
          <button className="rename-close" onClick={onCancel} aria-label="关闭"><X size={15} /></button>
        </div>
        <div className="rename-dialog-body">
          <input
            ref={inputRef}
            className="rename-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleConfirm(); }
              if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            }}
            autoFocus
          />
        </div>
        <div className="rename-dialog-foot">
          <button className="rename-btn-cancel" onClick={onCancel}>取消</button>
          <button className="rename-btn-confirm" onClick={handleConfirm} disabled={!value.trim()}>确认</button>
        </div>
      </div>
    </div>
  );
}

function SessionItem({ session, active, onOpen, onContextMenu, onRename }: {
  session: SessionMeta;
  active: boolean;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(session.title);
      setTimeout(() => { inputRef.current?.select(); }, 0);
    }
  }, [editing, session.title]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.title) onRename(trimmed);
    setEditing(false);
  }

  function cancel() {
    setDraft(session.title);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="rail-convo rail-convo-editing">
        {session.pinned ? <Pin size={14} /> : <Clock size={15} />}
        <input
          ref={inputRef}
          className="rail-rename-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          onBlur={commit}
          autoFocus
        />
        <button className="rail-rename-btn" onMouseDown={(e) => { e.preventDefault(); commit(); }} title="确认"><Check size={12} /></button>
        <button className="rail-rename-btn" onMouseDown={(e) => { e.preventDefault(); cancel(); }} title="取消"><X size={12} /></button>
      </div>
    );
  }

  return (
    <button
      className={`rail-convo ${active ? 'active' : ''}`}
      title={session.title}
      onClick={onOpen}
      onDoubleClick={() => setEditing(true)}
      onContextMenu={onContextMenu}
    >
      {session.pinned ? <Pin size={14} /> : <Clock size={15} />}
      <span>{session.title}</span>
    </button>
  );
}

export function Rail({ state, sessions, mainView, onNewChat, onOpenWorkspace, onSelectView, onHelpAction, onConvoAction, onOpenSession }: {
  state: AppState;
  sessions: SessionMeta[];
  mainView: MainView;
  onNewChat: () => void;
  onOpenWorkspace: () => void;
  onSelectView: (view: MainView) => void;
  onHelpAction: (action: HelpAction) => void;
  onConvoAction: (action: ConvoAction, sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number; session: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const workspaceName = state.workspaceRoot ? state.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() : '无项目';

  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="rail-brand">
          <PanelLeft size={18} />
          <span>YOYcode</span>
        </div>
        <div className="rail-head-actions">
          <button className="icon-button" title="搜索文件" onClick={() => onSelectView('files')}><Search size={17} /></button>
        </div>
      </div>

      <nav className="rail-nav">
        {/* UX-1 fix: give the chat view its own nav item with active state.
            Previously "新对话" had no active indicator, so users couldn't tell
            which view was active when in the chat view. */}
        <button
          className={`rail-item ${mainView === 'chat' ? 'active' : ''}`}
          onClick={() => onSelectView('chat')}
        >
          <MessageSquare size={17} /> 对话
        </button>
        <button className="rail-item" title="开始新对话" onClick={onNewChat}><FilePlus size={17} /> 新对话</button>
        <button className={`rail-item ${mainView === 'files' ? 'active' : ''}`} onClick={() => onSelectView('files')}><Files size={17} /> 文件</button>
        <button className={`rail-item ${mainView === 'automation' ? 'active' : ''}`} onClick={() => onSelectView('automation')}><CalendarClock size={17} /> 自动化</button>
        <button className={`rail-item ${mainView === 'settings' ? 'active' : ''}`} onClick={() => onSelectView('settings')}><Settings size={17} /> 设置</button>
      </nav>

      <div className="rail-section">项目</div>
      <div className="rail-scroll">
        <button className="rail-convo" onClick={onOpenWorkspace} title={state.workspaceRoot || '打开文件夹'}>
          <FolderOpen size={16} />
          <span>{workspaceName}</span>
        </button>

        <div className="rail-section">会话</div>
        {sessions.length === 0
          ? <div className="pane-title" style={{ textTransform: 'none', letterSpacing: 0 }}>暂无会话</div>
          : sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              active={state.activeSessionId === session.id}
              onOpen={() => onOpenSession(session.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setCtx({ x: event.clientX, y: event.clientY, session: session.id });
              }}
              onRename={(title) => onConvoAction('rename' as ConvoAction, session.id + '::' + title)}
            />
          ))}
      </div>

      {ctx && (
        <ConversationContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          onPick={(action) => {
            const session = ctx.session;
            setCtx(null);
            if (action === 'rename') {
              const meta = sessions.find((s) => s.id === session);
              setRenaming({ id: session, title: meta?.title ?? '' });
            } else {
              onConvoAction(action, session);
            }
          }}
        />
      )}

      {renaming && (
        <RenameDialog
          initialTitle={renaming.title}
          onConfirm={(title) => { onConvoAction('rename', renaming.id + '::' + title); setRenaming(null); }}
          onCancel={() => setRenaming(null)}
        />
      )}

      <div className="rail-foot">
        <div className="rail-foot-anchor">
          {helpOpen && (
            <HelpMenu
              onClose={() => setHelpOpen(false)}
              onPick={(action) => { setHelpOpen(false); onHelpAction(action); }}
            />
          )}
          <button
            className={`rail-item ${helpOpen ? 'active' : ''}`}
            onClick={() => setHelpOpen((open) => !open)}
          >
            <HelpCircle size={17} /> 帮助
          </button>
        </div>
      </div>
    </aside>
  );
}
