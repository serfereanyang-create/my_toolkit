import { useState, useEffect, useRef, useCallback } from 'react';
import {
  GitBranch, GitCommit, Upload, ChevronDown, ChevronRight,
  CheckCircle2, Circle, Loader2, Minus, X, Maximize2,
  TerminalSquare, Bot, ListTodo, FileDiff,
} from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { AppState, ChatItem, ToolChatItem } from '../types';
import type { GitStatus, GitBranchList } from '../lib/ipc';
import { BranchMenu } from './GitPanel';
import { formatGoalElapsed, gitChangedFileCount } from '../lib/gitPanelFormat';
import { sessionChangeTotals, activeTurnProgress } from '../lib/state';

/*
 * InfoPanel — 侧边信息卡片面板。
 * 展示 Git 状态、当前计划/任务进度、终端会话、智能体状态。
 * 浮动在界面上，可拖动、可最小化。
 */

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分 ${s % 60}秒`;
}

function fmtElapsed(startedAt: number) {
  return fmt(Date.now() - startedAt);
}

// ── Git section ───────────────────────────────────────────────────────────────
function GitSection({ onCommitPush }: { onCommitPush: () => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranchList | null>(null);
  const [stats, setStats] = useState<{ added: number; removed: number } | null>(null);
  const [open, setOpen] = useState(true);
  const [branchMenu, setBranchMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [s, d] = await Promise.all([desktop.git.status(), desktop.git.diffStats()]);
        if (cancelled) return;
        setStatus(s);
        if (d.ok) setStats({ added: d.added ?? 0, removed: d.removed ?? 0 });
      } catch { /* ignore */ }
    };
    void load();
    const id = setInterval(load, 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // 分支菜单打开时才拉分支列表（避免常驻轮询）
  useEffect(() => {
    if (!branchMenu || branches) return;
    void desktop.git.branches().then((b) => { if (b.ok) setBranches(b); });
  }, [branchMenu, branches]);

  // 点击外部 / Esc 关闭分支菜单
  useEffect(() => {
    if (!branchMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setBranchMenu(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setBranchMenu(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [branchMenu]);

  if (!status?.ok) return null;

  const changed = gitChangedFileCount(status);

  const doCheckout = async (b: string) => {
    const r = await desktop.git.checkout(b);
    if (r.ok) setBranchMenu(false);
  };
  const doCreate = async (b: string) => {
    const r = await desktop.git.createBranch(b);
    if (r.ok) setBranchMenu(false);
  };

  return (
    <div className="ip-section">
      <button className="ip-section-head" onClick={() => setOpen(v => !v)}>
        <span className="ip-section-label">Git 工具</span>
        <span className="ip-section-chevron">{open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</span>
      </button>
      {open && (
        <div className="ip-section-body">
          {/* 更改行：真实 +N −M 行级统计 */}
          <div className="ip-row">
            <span className="ip-row-icon"><FileDiff size={13}/></span>
            <span className="ip-row-label">更改</span>
            <span className="ip-row-spacer"/>
            {changed > 0 ? (
              <>
                <span className="ip-add">+{stats?.added ?? changed}</span>
                <span className="ip-del">−{stats?.removed ?? 0}</span>
              </>
            ) : (
              <span style={{ color: 'var(--fg-dim)', fontSize: 'var(--fs-2)' }}>干净</span>
            )}
          </div>
          {/* 分支行：点击弹出 Codex 风格分支下拉 */}
          <div className="ip-branch-wrap" ref={menuRef}>
            <button className="ip-row ip-row-clickable" onClick={() => setBranchMenu(v => !v)}>
              <span className="ip-row-icon"><GitBranch size={13}/></span>
              <span className="ip-row-label ip-branch-name" title={status.branch}>{status.branch ?? '—'}</span>
              {(status.ahead ?? 0) > 0 && <span className="ip-badge ip-badge-up">↑{status.ahead}</span>}
              {(status.behind ?? 0) > 0 && <span className="ip-badge ip-badge-down">↓{status.behind}</span>}
              <span className="ip-row-spacer"/>
              <ChevronDown size={12} className={`ip-row-chev ${branchMenu ? 'open' : ''}`}/>
            </button>
            {branchMenu && branches && (
              <BranchMenu
                branches={branches}
                status={status}
                onCheckout={(b) => void doCheckout(b)}
                onCreate={(b) => void doCreate(b)}
                onClose={() => setBranchMenu(false)}
              />
            )}
          </div>
          {/* 提交/推送 */}
          <button className="ip-action-row" onClick={onCommitPush}>
            <Upload size={13}/>
            <span>提交或推送</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ── Plan / Task section ───────────────────────────────────────────────────────
function PlanSection({ state }: { state: AppState }) {
  const [open, setOpen] = useState(true);
  const [, setTick] = useState(0);
  const { taskSummary, chat, taskBoard } = state;

  // 目标计时：board 执行中每秒刷新
  useEffect(() => {
    if (!taskBoard || taskBoard.runtimeMode !== 'executing') return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [taskBoard?.runtimeMode]);

  if (!taskSummary && !taskBoard) return null;

  // Find todo items from the current / latest turn
  const turns = chat.filter((c): c is Extract<ChatItem, { kind: 'turn' }> => c.kind === 'turn');
  const allSteps: ToolChatItem[] = turns.flatMap((t) => t.steps);
  const done = allSteps.filter((s) => s.status === 'done' && s.ok).length;
  const total = allSteps.length;

  const boardDone = taskBoard ? taskBoard.tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length : 0;
  const goalElapsed = taskBoard?.startedAt ? formatGoalElapsed(Date.now() - taskBoard.startedAt) : null;

  return (
    <div className="ip-section">
      <button className="ip-section-head" onClick={() => setOpen(v => !v)}>
        <span className="ip-section-label">{taskBoard ? '目标' : '计划'}</span>
        {taskBoard && goalElapsed && <span className="ip-goal-time">{goalElapsed}</span>}
        <span className="ip-section-chevron">{open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</span>
      </button>
      {open && (
        <div className="ip-section-body">
          {taskBoard ? (
            <>
              {taskBoard.goal && <div className="ip-goal-text" title={taskBoard.goal}>{taskBoard.goal}</div>}
              <div className="ip-row">
                <span className="ip-row-label" style={{ color: 'var(--fg-dim)' }}>进程</span>
                <span className="ip-row-spacer"/>
                <span style={{ fontSize: 'var(--fs-3)' }}>{boardDone}/{taskBoard.tasks.length}</span>
              </div>
              {taskBoard.tasks.slice(-6).map((t) => (
                <div key={t.id} className="ip-step-row">
                  {t.status === 'in_progress'
                    ? <Loader2 size={12} className="spin ip-step-icon"/>
                    : t.status === 'done' || t.status === 'skipped'
                      ? <CheckCircle2 size={12} className="ip-step-icon ip-step-done"/>
                      : <Circle size={12} className="ip-step-icon ip-step-muted"/>
                  }
                  <span className={`ip-step-label ${t.status === 'done' || t.status === 'skipped' ? 'strike' : ''}`}>{t.title}</span>
                </div>
              ))}
            </>
          ) : (
            <>
              <div className="ip-row ip-plan-title">
                <ListTodo size={13} style={{ flexShrink: 0 }}/>
                <span className="ip-plan-text" title={taskSummary?.title}>{taskSummary?.title}</span>
              </div>
              {total > 0 && (
                <div className="ip-row">
                  <span className="ip-row-label" style={{ color: 'var(--fg-dim)' }}>进程</span>
                  <span className="ip-row-spacer"/>
                  <span style={{ fontSize: 'var(--fs-3)' }}>{done}/{total}</span>
                </div>
              )}
              {allSteps.slice(-3).reverse().map((step) => (
                <div key={step.id} className="ip-step-row">
                  {step.status === 'running'
                    ? <Loader2 size={12} className="spin ip-step-icon"/>
                    : step.ok
                      ? <CheckCircle2 size={12} className="ip-step-icon ip-step-done"/>
                      : <Circle size={12} className="ip-step-icon ip-step-muted"/>
                  }
                  <span className="ip-step-label">{step.tool}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Terminal section ──────────────────────────────────────────────────────────
function TerminalSection({ state, onOpenTerminal }: { state: AppState; onOpenTerminal: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const progress = activeTurnProgress(state);

  useEffect(() => {
    if (!progress) return;
    const id = setInterval(() => setElapsed(Date.now()), 1000);
    return () => clearInterval(id);
  }, [progress]);

  const changes = sessionChangeTotals(state.chat);

  return (
    <div className="ip-section">
      <button className="ip-section-head" onClick={onOpenTerminal}>
        <span className="ip-row-icon"><TerminalSquare size={13}/></span>
        <span className="ip-section-label">终端</span>
        <span className="ip-row-spacer"/>
        {progress ? (
          <span style={{ fontSize: 'var(--fs-2)', color: 'var(--fg-muted)' }}>
            {fmt(Date.now() - (Date.now() - progress.elapsedMs))}
          </span>
        ) : state.bottomOpen ? (
          <span style={{ fontSize: 'var(--fs-2)', color: 'var(--fg-dim)' }}>已打开</span>
        ) : (
          <span style={{ fontSize: 'var(--fs-2)', color: 'var(--fg-dim)' }}>点击打开</span>
        )}
      </button>
    </div>
  );
}

// ── Agent section ─────────────────────────────────────────────────────────────
// Always expandable: while running it shows live progress; when idle/offline it
// shows the last turn's full workflow (sourced from chat history, so it survives
// reopening a session — the user asked to see the agent's workflow any time,
// not only during a live turn). The bridge is lazily started on first prompt,
// so "离线" is explained rather than left as a dead-end badge.
function AgentSection({ state }: { state: AppState }) {
  const progress = activeTurnProgress(state);
  const [open, setOpen] = useState(true);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (!progress) return;
    const id = setInterval(() => forceUpdate(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [!!progress]);

  const statusLabel: Record<AppState['agentStatus'], string> = {
    offline: '离线',
    starting: '启动中…',
    ready: '就绪',
    running: '运行中',
  };

  const changes = sessionChangeTotals(state.chat);
  const lastTurn = [...state.chat].reverse().find((c): c is Extract<ChatItem, { kind: 'turn' }> => c.kind === 'turn');
  const lastTurnSec = lastTurn ? Math.max(0, Math.round(((lastTurn.endedAt ?? Date.now()) - lastTurn.startedAt) / 1000)) : 0;

  return (
    <div className="ip-section">
      <button className="ip-section-head" onClick={() => setOpen(v => !v)}>
        <span className="ip-row-icon"><Bot size={13}/></span>
        <span className="ip-section-label">智能体</span>
        <span className="ip-row-spacer"/>
        <span className={`ip-agent-status ip-agent-${state.agentStatus}`}>
          {state.agentStatus === 'running' && <Loader2 size={11} className="spin"/>}
          {statusLabel[state.agentStatus]}
        </span>
        <span className="ip-section-chevron">{open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</span>
      </button>
      {open && (
        <div className="ip-section-body">
          {progress ? (
            <>
              <div className="ip-row">
                <span style={{ fontSize: 'var(--fs-2)', color: 'var(--fg-muted)' }}>
                  已用 {fmt(progress.elapsedMs)} · {progress.stepCount} 步
                </span>
              </div>
              {changes && (
                <div className="ip-row">
                  <span className="ip-add">+{changes.added}</span>
                  <span style={{ margin: '0 4px', color: 'var(--fg-dim)' }}>−</span>
                  <span className="ip-del">{changes.removed}</span>
                </div>
              )}
              {progress.lastTool && (
                <div className="ip-step-row">
                  <Loader2 size={12} className="spin ip-step-icon"/>
                  <span className="ip-step-label">{progress.lastTool}</span>
                </div>
              )}
            </>
          ) : lastTurn && lastTurn.steps.length > 0 ? (
            <>
              <div className="ip-row">
                <span style={{ fontSize: 'var(--fs-2)', color: 'var(--fg-muted)' }}>
                  上次工作 {lastTurnSec}秒 · {lastTurn.steps.length} 步
                </span>
              </div>
              {lastTurn.steps.slice(-8).map((step) => (
                <div key={step.id} className="ip-step-row">
                  {step.status === 'running'
                    ? <Loader2 size={12} className="spin ip-step-icon"/>
                    : step.status === 'done' && step.ok !== false
                      ? <CheckCircle2 size={12} className="ip-step-icon ip-step-done"/>
                      : <Circle size={12} className="ip-step-icon ip-step-muted"/>
                  }
                  <span className="ip-step-label">{step.tool}</span>
                  {step.durationMs != null && (
                    <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-1)', color: 'var(--fg-dim)' }}>
                      {(step.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
              ))}
            </>
          ) : (
            <div className="ip-row">
              <span style={{ fontSize: 'var(--fs-2)', color: 'var(--fg-dim)' }}>
                {state.agentStatus === 'offline' ? '尚未连接 · 发送消息时自动连接' : '还没有工作记录'}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main InfoPanel ────────────────────────────────────────────────────────────
export function InfoPanel({
  state,
  onOpenGitPanel,
  onOpenTerminal,
}: {
  state: AppState;
  onOpenGitPanel: () => void;
  onOpenTerminal: () => void;
}) {
  const [minimized, setMinimized] = useState(false);
  const [pos, setPos] = useState(() => ({
    x: window.innerWidth - 290,
    y: 60,
  }));
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // Keep a live git status for the collapsed summary line
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const s = await desktop.git.status();
        if (!cancelled) setGitStatus(s.ok ? s : null);
      } catch { /* ignore */ }
    };
    void load();
    const id = setInterval(load, 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
  }, [pos]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 260, dragRef.current.ox + (e.clientX - dragRef.current.sx))),
        y: Math.max(0, Math.min(window.innerHeight - 40, dragRef.current.oy + (e.clientY - dragRef.current.sy))),
      });
    }
    function onUp() { dragRef.current = null; }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  const changes = sessionChangeTotals(state.chat);
  const changed = gitStatus
    ? (gitStatus.staged?.length ?? 0) + (gitStatus.unstaged?.length ?? 0) + (gitStatus.untracked?.length ?? 0)
    : 0;

  return (
    <div className="info-panel" style={{ left: pos.x, top: pos.y }}>
      {/* Title bar — when minimized shows the "更改 +N −M" summary */}
      <div className="info-panel-titlebar" onMouseDown={startDrag} onClick={() => minimized && setMinimized(false)}>
        {minimized ? (
          // Collapsed: show git change summary as a single compact row
          <>
            <span className="ip-row-icon"><GitCommit size={13}/></span>
            <span className="ip-section-label">更改</span>
            <span className="ip-row-spacer"/>
            {changed > 0 ? (
              <>
                <span className="ip-add" style={{ marginRight: 4 }}>+{changed}</span>
                <span className="ip-del">−{gitStatus?.untracked?.length ?? 0}</span>
              </>
            ) : changes ? (
              <>
                <span className="ip-add" style={{ marginRight: 4 }}>+{changes.added}</span>
                <span className="ip-del">−{changes.removed}</span>
              </>
            ) : (
              <span style={{ fontSize: 'var(--fs-2)', color: 'var(--fg-dim)' }}>干净</span>
            )}
            <div className="info-panel-actions" style={{ marginLeft: 8 }} onMouseDown={e => e.stopPropagation()}>
              <button className="icon-button ip-btn" title="展开" onClick={(e) => { e.stopPropagation(); setMinimized(false); }}>
                <Maximize2 size={12}/>
              </button>
            </div>
          </>
        ) : (
          // Expanded: normal title
          <>
            <span className="info-panel-title">概览</span>
            <div className="info-panel-actions" onMouseDown={e => e.stopPropagation()}>
              <button className="icon-button ip-btn" title="最小化" onClick={() => setMinimized(true)}>
                <Minus size={12}/>
              </button>
            </div>
          </>
        )}
      </div>

      {!minimized && (
        <div className="info-panel-body">
          <GitSection onCommitPush={onOpenGitPanel} />
          <PlanSection state={state} />
          <TerminalSection state={state} onOpenTerminal={onOpenTerminal} />
          <AgentSection state={state} />
        </div>
      )}
    </div>
  );
}
