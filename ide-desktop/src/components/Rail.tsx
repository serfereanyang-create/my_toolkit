import { useEffect, useRef, useState } from 'react';
import { FilePlus, LoaderCircle, MessageSquare, Clock, Files, Settings, Search, HelpCircle, Pin, CalendarClock, FolderOpen, Check, X, BarChart3, FileClock, MoreHorizontal, ChevronDown, GitBranch, Monitor, LayoutGrid } from 'lucide-react';
import type { AppState, SessionMeta } from '../types';
import { HelpMenu, type HelpAction } from './HelpMenu';
import { ConversationContextMenu, type ConvoAction } from './ConversationContextMenu';
import { TagEditorDialog } from './TagEditorDialog';
import { formatAgo, recentLabel, type RecentFile } from '../lib/recentFiles';
import { sessionMatchesTag, tagCloud, tagColorIndex } from '../lib/sessionTags';
import { ContextSidebar } from './ContextSidebar';
import type { ContextPanelModel, OutputFile } from '../lib/contextSidebar';

type MainView = 'newtab' | 'chat' | 'files' | 'search' | 'snippets' | 'bookmarks' | 'history' | 'stats' | 'git' | 'automation' | 'settings' | 'editor' | 'quality' | 'computer' | 'memory';

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
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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

function SessionItem({ session, active, tags, running, approvals, onOpen, onOpenActions, onRename }: {
  session: SessionMeta;
  active: boolean;
  tags: string[];
  /** The session has a live turn — host shows a spinning ✳ lane glyph. */
  running: boolean;
  /** Count of unresolved approvals — host shows a blue attention dot. */
  approvals: number;
  onOpen: () => void;
  onOpenActions: (x: number, y: number) => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  // The rename box edits the real title: a clashing row carries a timestamp
  // suffix for display only, and confirming the box must not bake it in.
  const editableTitle = session.baseTitle ?? session.title;
  const [draft, setDraft] = useState(editableTitle);
  const inputRef = useRef<HTMLInputElement>(null);
  const updatedAt = Date.parse(session.updatedAt);
  const statusLabel = approvals > 0 ? `待审批 ${approvals}` : running ? '运行中' : '';
  const showActions = (event: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = event.currentTarget.getBoundingClientRect();
    onOpenActions(anchor.right, anchor.bottom + 4);
  };

  useEffect(() => {
    if (editing) {
      setDraft(editableTitle);
      setTimeout(() => { inputRef.current?.select(); }, 0);
    }
  }, [editing, editableTitle]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== editableTitle) onRename(trimmed);
    setEditing(false);
  }

  function cancel() {
    setDraft(editableTitle);
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
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
    <div className={`rail-session ${active ? 'active' : ''}`} data-session-id={session.id}>
    <button
      type="button"
      className={`rail-convo ${active ? 'active' : ''}`}
      title={session.title}
      aria-label={`${session.title}${statusLabel ? `，${statusLabel}` : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onOpen}
      onDoubleClick={() => setEditing(true)}
      onContextMenu={(event) => { event.preventDefault(); onOpenActions(event.clientX, event.clientY); }}
    >
      {/* Status glyph first (host: ✳ for running, blue dot for waiting
          approvals), then pin, then the title. */}
      {approvals > 0 ? (
        <span className="rail-status-dot" title={`${approvals} 个待审批`} />
      ) : running ? (
        <LoaderCircle size={14} className="rail-status-spin" />
      ) : session.pinned ? (
        <Pin size={13} />
      ) : null}
      <span className="rail-session-copy">
      <span className="rail-convo-title">{session.title}</span>
      {tags.length > 0 && (
        <span className="rail-tags" aria-label={`标签：${tags.join('、')}`}>
          {tags.slice(0, 2).map((tag) => (
            <span key={tag} className={`tag-chip tiny c${tagColorIndex(tag)}`}>{tag}</span>
          ))}
          {tags.length > 2 && <span className="tag-chip tiny">+{tags.length - 2}</span>}
        </span>
      )}
      </span>
      {statusLabel ? (
        <span className={`rail-convo-state ${approvals > 0 ? 'waiting' : 'working'}`}>{statusLabel}</span>
      ) : Number.isFinite(updatedAt) ? (
        <time className="rail-convo-time" dateTime={session.updatedAt}>{formatAgo(updatedAt)}</time>
      ) : null}
    </button>
    <button type="button" className="rail-convo-more" aria-label={`更多操作：${session.title}`} title="更多操作" onClick={showActions}>
      <MoreHorizontal size={15} />
    </button>
    </div>
  );
}

export function Rail({ state, sessions, sessionTags, recentFiles, mainView, shortcuts, runningIds, approvals, contextPanel, outputs, compacting, onCompact, onOpenOutput, onSwitchWorkspace, onNewChat, onOpenWorkspace, onSelectView, onHelpAction, onConvoAction, onOpenSession, onOpenRecent, onSetTags }: {
  state: AppState;
  sessions: SessionMeta[];
  /** sessionId -> tags, from the workspace sidecar store (iteration 18). */
  sessionTags: Record<string, string[]>;
  recentFiles: RecentFile[];
  mainView: MainView;
  /** Real resolved chords for the primary rows' kbd hints. */
  shortcuts?: { newChat?: string; search?: string };
  /** Sessions with a live turn (drives the ✳ status glyph). */
  runningIds?: string[];
  /** Unresolved approval counts per session (drives the blue dot). */
  approvals?: Record<string, number>;
  onNewChat: () => void;
  onOpenWorkspace: () => void;
  onSelectView: (view: MainView) => void;
  onHelpAction: (action: HelpAction) => void;
  onConvoAction: (action: ConvoAction, sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenRecent: (path: string) => void;
  onSetTags: (sessionId: string, tags: string[]) => void;
  /**
   * 底部常驻的「环境 / 上下文 / 输出」。传 null 就不渲染——只有在拿不到任何
   * 上下文数据（比如纯静态渲染的场景）时才该这样，正常运行时一直有。
   */
  contextPanel?: ContextPanelModel | null;
  outputs?: OutputFile[];
  compacting?: boolean;
  onCompact?: () => void;
  onOpenOutput?: (path: string) => void;
  onSwitchWorkspace?: (root: string) => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number; session: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  // Iteration 18: tag editor target + active tag filter for the session list.
  const [tagEdit, setTagEdit] = useState<{ id: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string } | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const workspaceName = state.workspaceRoot ? state.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() : '无项目';

  const cloud = tagCloud(sessionTags);
  const visibleSessions = sessions.filter((s) => sessionMatchesTag(sessionTags, s.id, tagFilter));
  const editTarget = tagEdit ? sessions.find((s) => s.id === tagEdit.id) : null;
  const runningSet = runningIds ?? [];
  const approvalCounts = approvals ?? {};

  // ZCode-style time grouping: pinned first, then 今天/昨天/7 天内/更早.
  const groups = (() => {
    const pinned: SessionMeta[] = [];
    const today: SessionMeta[] = [];
    const yesterday: SessionMeta[] = [];
    const week: SessionMeta[] = [];
    const older: SessionMeta[] = [];
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86_400_000;
    const weekAgo = startOfToday - 6 * 86_400_000;
    for (const session of visibleSessions) {
      const t = Date.parse(session.updatedAt);
      if (session.pinned) pinned.push(session);
      else if (!Number.isFinite(t) || t >= startOfToday) today.push(session);
      else if (t >= startOfYesterday) yesterday.push(session);
      else if (t >= weekAgo) week.push(session);
      else older.push(session);
    }
    return ([
      ['置顶', pinned], ['今天', today], ['昨天', yesterday], ['7 天内', week], ['更早', older],
    ] as const).filter(([, list]) => list.length > 0);
  })();

  const renderSession = (session: SessionMeta) => (
    <SessionItem
      key={session.id}
      session={session}
      tags={sessionTags[session.id] ?? []}
      active={state.activeSessionId === session.id}
      running={runningSet.includes(session.id)}
      approvals={approvalCounts[session.id] ?? 0}
      onOpen={() => onOpenSession(session.id)}
      onOpenActions={(x, y) => setCtx({ x, y, session: session.id })}
      onRename={(title) => onConvoAction('rename' as ConvoAction, session.id + '::' + title)}
    />
  );

  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="rail-brand">
          {/* ZCode marks the sidebar with a solid brand tile, not just text. */}
          <span className="rail-logo" aria-hidden="true">
            <img src="./icon.svg" alt="" />
          </span>
          <span>YOYcode</span>
        </div>
      </div>

      <button type="button" className="rail-workspace" onClick={onOpenWorkspace} title={state.workspaceRoot || '打开文件夹'} aria-label={`切换项目：${workspaceName}`}>
        <FolderOpen size={16} />
        <span>{workspaceName}</span>
        <ChevronDown size={13} />
      </button>

      {/* Host sidebar leads with labeled primary actions before the list;
          kbd hints show the app's REAL resolved bindings. */}
      <div className="rail-primary">
        <button className="rail-primary-row rail-primary-new" onClick={onNewChat}>
          <FilePlus size={16} />
          <span>新对话</span>
          {shortcuts?.newChat && <kbd className="rail-kbd">{shortcuts.newChat}</kbd>}
        </button>
        <button className="rail-primary-row" onClick={() => onSelectView('search')}>
          <Search size={16} />
          <span>搜索</span>
          {shortcuts?.search && <kbd className="rail-kbd">{shortcuts.search}</kbd>}
        </button>
      </div>

      {/* ZCode side-pane style: views are 28px icon toggles, not a list of
          label buttons — the session list is the sidebar's main content. */}
      <nav className="rail-viewbar" aria-label="视图切换">
        {/* 新标签页是入口页：文件/浏览器/终端/审查/辅助对话 和四个文档插件都在
            这里一次点到，省得靠记快捷键或翻插件菜单。 */}
        <button
          className={`rail-view ${mainView === 'newtab' ? 'active' : ''}`}
          title="新标签页"
          aria-label="新标签页"
          aria-pressed={mainView === 'newtab'}
          onClick={() => onSelectView('newtab')}
        >
          <LayoutGrid size={15} /><span>新建</span>
        </button>
        <button
          className={`rail-view ${mainView === 'chat' ? 'active' : ''}`}
          title="对话"
          aria-label="对话"
          aria-pressed={mainView === 'chat'}
          onClick={() => onSelectView('chat')}
        >
          <MessageSquare size={15} /><span>对话</span>
        </button>
        <button
          className={`rail-view ${mainView === 'files' || mainView === 'editor' ? 'active' : ''}`}
          title="文件"
          aria-label="文件"
          aria-pressed={mainView === 'files' || mainView === 'editor'}
          onClick={() => onSelectView('files')}
        >
          <Files size={15} /><span>文件</span>
        </button>
        <button type="button" className={`rail-view ${mainView === 'git' ? 'active' : ''}`} title="源代码管理" aria-label="源代码管理" aria-pressed={mainView === 'git'} onClick={() => onSelectView('git')}>
          <GitBranch size={15} /><span>更改</span>
        </button>
        <button
          className={`rail-view ${mainView === 'stats' ? 'active' : ''}`}
          title="代码普查"
          aria-label="代码普查"
          aria-pressed={mainView === 'stats'}
          onClick={() => onSelectView('stats')}
        >
          <BarChart3 size={15} /><span>统计</span>
        </button>
        {/* 编辑器 / 质量 / 片段库 / 书签 / 保存历史 都不在左栏：编辑器随文件打开，
            其余走命令面板（Ctrl+Shift+P）或输入框的插件菜单。这里曾写着「顶栏
            main-tabs 提供」，但那个控件并不存在，照它找入口会找不到。 */}
        <button
          className={`rail-view ${mainView === 'automation' ? 'active' : ''}`}
          title="自动化"
          aria-label="自动化"
          aria-pressed={mainView === 'automation'}
          onClick={() => onSelectView('automation')}
        >
          <CalendarClock size={15} /><span>自动化</span>
        </button>
        {/* 电脑操控 had no entry anywhere in the window: the computer_* tools
            were reachable only by asking the agent in a sentence, so "看看我的
            电脑上有什么" needed the user to know they could ask. */}
        <button
          className={`rail-view ${mainView === 'computer' ? 'active' : ''}`}
          title="电脑操控"
          aria-label="电脑操控"
          aria-pressed={mainView === 'computer'}
          onClick={() => onSelectView('computer')}
        >
          <Monitor size={15} /><span>电脑</span>
        </button>
      </nav>

      <div className="rail-scroll">
        {/* Sessions are the sidebar's primary content, grouped like ZCode's
            task list (pinned / today / yesterday / older). Project and recent
            files move below the list. */}
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
          : groups.map(([label, list]) => (
            <div key={label} className="rail-group">
              <div className="rail-section"><span>{label}</span><span className="rail-section-count">{list.length}</span></div>
              {list.map(renderSession)}
            </div>
          ))}

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
      </div>

      {ctx && (
        <ConversationContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={(restoreFocus) => {
            setCtx(null);
            if (restoreFocus) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(ctx.session)}"] .rail-convo-more`)?.focus());
          }}
          onPick={(action) => {
            const session = ctx.session;
            setCtx(null);
            if (action === 'rename') {
              const meta = sessions.find((s) => s.id === session);
              setRenaming({ id: session, title: meta?.baseTitle ?? meta?.title ?? '' });
            } else if (action === 'edit-tags') {
              setTagEdit({ id: session });
            } else if (action === 'remove') {
              // Deleting a session removes its file from disk; there is no undo
              // and it is not in the OS recycle bin. The menu entry is one click
              // away from 归档, which does keep the record, so the destructive
              // one has to confirm first.
              setDeleting({ id: session });
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

      {deleting && (
        <div className="rename-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setDeleting(null); }}>
          <div className="rename-dialog" role="alertdialog" aria-modal="true" aria-label="确认删除会话">
            <div className="rename-dialog-head">
              <span>永久删除聊天？</span>
              <button className="rename-close" onClick={() => setDeleting(null)} aria-label="关闭"><X size={15} /></button>
            </div>
            <div className="rename-dialog-body">
              <p className="rename-dialog-note">
                「{sessions.find((s) => s.id === deleting.id)?.title || '未命名会话'}」的记录会从磁盘删除，无法恢复，也不会进入回收站。
                如果只是想让它从列表里消失，请改用<strong>归档聊天</strong>。
              </p>
            </div>
            <div className="rename-dialog-foot">
              <button className="rename-btn-cancel" onClick={() => setDeleting(null)}>取消</button>
              <button className="rename-btn-confirm"
                onClick={() => { onConvoAction('remove', deleting.id); setDeleting(null); }}>
                永久删除
              </button>
            </div>
          </div>
        </div>
      )}

      {contextPanel && (
        <ContextSidebar
          panel={contextPanel}
          outputs={outputs ?? []}
          workspaceRoot={state.workspaceRoot}
          recentWorkspaces={state.settings?.recentWorkspaces ?? []}
          compacting={Boolean(compacting)}
          onCompact={onCompact ?? (() => {})}
          onOpenFile={onOpenOutput ?? (() => {})}
          onOpenWorkspace={onOpenWorkspace}
          onSwitchWorkspace={onSwitchWorkspace ?? (() => {})}
        />
      )}

      <div className="rail-foot">
        <button type="button" className={`rail-item rail-settings ${mainView === 'settings' ? 'active' : ''}`} aria-pressed={mainView === 'settings'} onClick={() => onSelectView('settings')}>
          <Settings size={16} />设置
        </button>
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
