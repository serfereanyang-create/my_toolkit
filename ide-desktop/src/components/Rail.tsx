import { useEffect, useRef, useState } from 'react';
import { FilePlus, MessageSquare, Clock, Files, Settings, PanelLeft, Search, HelpCircle, Pin, CalendarClock, FolderOpen, Check, X, Braces, BookmarkCheck, History, BarChart3, FileClock } from 'lucide-react';
import type { AppState, SessionMeta } from '../types';
import { HelpMenu, type HelpAction } from './HelpMenu';
import { ConversationContextMenu, type ConvoAction } from './ConversationContextMenu';
import { TagEditorDialog } from './TagEditorDialog';
import { formatAgo, recentLabel, type RecentFile } from '../lib/recentFiles';
import { sessionMatchesTag, tagCloud, tagColorIndex } from '../lib/sessionTags';

type MainView = 'chat' | 'files' | 'search' | 'snippets' | 'bookmarks' | 'history' | 'stats' | 'git' | 'automation' | 'settings' | 'editor' | 'quality';

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

function SessionItem({ session, active, tags, onOpen, onContextMenu, onRename }: {
  session: SessionMeta;
  active: boolean;
  tags: string[];
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
      {tags.length > 0 && (
        <span className="rail-tags" aria-label={`标签：${tags.join('、')}`}>
          {tags.slice(0, 2).map((tag) => (
            <span key={tag} className={`tag-chip tiny c${tagColorIndex(tag)}`}>{tag}</span>
          ))}
          {tags.length > 2 && <span className="tag-chip tiny">+{tags.length - 2}</span>}
        </span>
      )}
    </button>
  );
}

export function Rail({ state, sessions, sessionTags, recentFiles, mainView, onNewChat, onOpenWorkspace, onSelectView, onHelpAction, onConvoAction, onOpenSession, onOpenRecent, onSetTags }: {
  state: AppState;
  sessions: SessionMeta[];
  /** sessionId -> tags, from the workspace sidecar store (iteration 18). */
  sessionTags: Record<string, string[]>;
  recentFiles: RecentFile[];
  mainView: MainView;
  onNewChat: () => void;
  onOpenWorkspace: () => void;
  onSelectView: (view: MainView) => void;
  onHelpAction: (action: HelpAction) => void;
  onConvoAction: (action: ConvoAction, sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenRecent: (path: string) => void;
  onSetTags: (sessionId: string, tags: string[]) => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number; session: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  // Iteration 18: tag editor target + active tag filter for the session list.
  const [tagEdit, setTagEdit] = useState<{ id: string } | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const workspaceName = state.workspaceRoot ? state.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() : '无项目';

  const cloud = tagCloud(sessionTags);
  const visibleSessions = sessions.filter((s) => sessionMatchesTag(sessionTags, s.id, tagFilter));
  const editTarget = tagEdit ? sessions.find((s) => s.id === tagEdit.id) : null;

  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="rail-brand">
          <PanelLeft size={18} />
          <span>YOYcode</span>
        </div>
        <div className="rail-head-actions">
          <button className="icon-button" title="搜索（全文检索工作区）" onClick={() => onSelectView('search')}><Search size={17} /></button>
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
        <button className={`rail-item ${mainView === 'snippets' ? 'active' : ''}`} onClick={() => onSelectView('snippets')}><Braces size={17} /> 片段库</button>
        <button className={`rail-item ${mainView === 'bookmarks' ? 'active' : ''}`} onClick={() => onSelectView('bookmarks')}><BookmarkCheck size={17} /> 书签</button>
        <button className={`rail-item ${mainView === 'history' ? 'active' : ''}`} onClick={() => onSelectView('history')}><History size={17} /> 保存历史</button>
        <button className={`rail-item ${mainView === 'stats' ? 'active' : ''}`} onClick={() => onSelectView('stats')}><BarChart3 size={17} /> 代码普查</button>
        {/* 编辑器 / 质量入口只在顶栏 main-tabs 提供，左栏不再重复。 */}
        <button className={`rail-item ${mainView === 'automation' ? 'active' : ''}`} onClick={() => onSelectView('automation')}><CalendarClock size={17} /> 自动化</button>
        <button className={`rail-item ${mainView === 'settings' ? 'active' : ''}`} onClick={() => onSelectView('settings')}><Settings size={17} /> 设置</button>
      </nav>

        <div className="rail-section">项目</div>
        <div className="rail-scroll">
          <button className="rail-convo" onClick={onOpenWorkspace} title={state.workspaceRoot || '打开文件夹'}>
            <FolderOpen size={16} />
            <span>{workspaceName}</span>
          </button>

          {recentFiles.length > 0 && (
            <>
              <div className="rail-section">最近文件</div>
              {recentFiles.slice(0, 6).map((file) => (
                <button
                  key={file.path}
                  className="rail-convo rail-recent"
                  title={file.path}
                  onClick={() => onOpenRecent(file.path)}
                >
                  <FileClock size={14} />
                  <span>{recentLabel(file.path)}</span>
                  <span className="rail-recent-ago">{formatAgo(file.lastOpenedAt)}</span>
                </button>
              ))}
            </>
          )}

          <div className="rail-section">会话</div>
          {cloud.length > 0 && (
            <div className="rail-tagbar">
              {cloud.map(({ tag, count }) => (
                <button
                  key={tag}
                  type="button"
                  className={`tag-chip filter small c${tagColorIndex(tag)}${tagFilter === tag ? ' active' : ''}`}
                  title={tagFilter === tag ? '取消筛选' : `只显示带「${tag}」的会话`}
                  onClick={() => setTagFilter((prev) => (prev === tag ? null : tag))}
                >
                  {tag}<span className="tag-count">{count}</span>
                </button>
              ))}
              {tagFilter && (
                <button type="button" className="tag-filter-clear" onClick={() => setTagFilter(null)} title="清除筛选"><X size={11} /></button>
              )}
            </div>
          )}
        {visibleSessions.length === 0
          ? <div className="pane-title" style={{ textTransform: 'none', letterSpacing: 0 }}>{sessions.length === 0 ? '暂无会话' : '没有匹配该标签的会话'}</div>
          : visibleSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              tags={sessionTags[session.id] ?? []}
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
            } else if (action === 'edit-tags') {
              setTagEdit({ id: session });
            } else {
              onConvoAction(action, session);
            }
          }}
        />
      )}

      {tagEdit && editTarget && (
        <TagEditorDialog
          sessionTitle={editTarget.title}
          initialTags={sessionTags[tagEdit.id] ?? []}
          allTags={cloud.map((c) => c.tag)}
          onConfirm={(tags) => { onSetTags(tagEdit.id, tags); setTagEdit(null); }}
          onCancel={() => setTagEdit(null)}
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
