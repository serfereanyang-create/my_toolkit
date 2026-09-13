import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GitBranch, GitCommit, GitPullRequest, ChevronDown, ChevronRight, Search,
  Plus, Upload, Check, X, AlertCircle, Loader2, Play, Pause, FileDiff,
  CheckCircle2, Circle, MinusCircle, GitGraph, Settings2,
} from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { GitStatus, GitBranchList, GitCommit as GitCommitType, GitDiffStats } from '../lib/ipc';
import type { AppState, TaskBoard } from '../types';
import { formatGoalElapsed, taskProgress, computeStages } from '../lib/gitPanelFormat';

/*
 * GitPanel — Codex 风格的「Git 工具」卡片。
 * 结构对齐 Codex 侧栏：Git 工具（更改 +N −M / 分支下拉 / 提交或推送）、
 * 目标（计时 + 暂停 + 阶段进度）、进程（任务清单，完成项划线）、智能体。
 * 旧的变更/历史/分支三个 tab 的能力全部保留，折叠进各 section 的展开体里。
 */

type Action = 'confirm' | 'pause' | 'continue' | 'skip' | 'reopen';

function fmtCount(n: number): string {
  return String(n);
}

// ── 分支选择弹层（InfoPanel 也复用此组件） ──────────────────────────────────
export function BranchMenu({
  branches, status, onCheckout, onCreate, onClose, onOpenGraph,
}: {
  branches: GitBranchList;
  status: GitStatus | null;
  onCheckout: (b: string) => void;
  onCreate: (b: string) => void;
  onClose: () => void;
  /** 提供时在底部显示「Git 图谱」入口。 */
  onOpenGraph?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const local = (branches.local ?? []).filter((b) => !q || b.toLowerCase().includes(q));
  const remote = (branches.remote ?? []).filter((b) => !q || b.toLowerCase().includes(q));
  const uncommitted = status
    ? (status.staged?.length ?? 0) + (status.unstaged?.length ?? 0) + (status.untracked?.length ?? 0)
    : 0;

  return (
    <div className="gtx-branch-menu" ref={ref}>
      <label className="gtx-branch-search">
        <Search size={13} />
        <input
          autoFocus
          placeholder="搜索分支"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="gtx-branch-group-label">分支</div>
      {local.map((b) => (
        <button
          key={b}
          className={`gtx-branch-item ${b === branches.current ? 'current' : ''}`}
          onClick={() => { if (b !== branches.current) onCheckout(b); else onClose(); }}
        >
          <GitBranch size={13} className="gtx-branch-item-icon" />
          <span className="gtx-branch-item-body">
            <span className="gtx-branch-item-name" title={b}>{b}</span>
            {b === branches.current && uncommitted > 0 && (
              <span className="gtx-branch-item-sub">未提交的更改：{uncommitted} 个文件</span>
            )}
          </span>
          {b === branches.current && <Check size={13} className="gtx-branch-item-check" />}
        </button>
      ))}
      {remote.length > 0 && (
        <>
          <div className="gtx-branch-group-label">远程</div>
          {remote.map((b) => (
            <button key={b} className="gtx-branch-item" onClick={() => onCheckout(b.replace(/^[^/]+\//, ''))}>
              <GitBranch size={13} className="gtx-branch-item-icon dim" />
              <span className="gtx-branch-item-body"><span className="gtx-branch-item-name" title={b}>{b}</span></span>
            </button>
          ))}
        </>
      )}
      {creating ? (
        <div className="gtx-branch-create">
          <input
            autoFocus
            placeholder="新分支名称"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) { onCreate(draft.trim()); onClose(); }
              if (e.key === 'Escape') { setCreating(false); setDraft(''); }
            }}
          />
          <button className="icon-button" title="创建并检出" onClick={() => { if (draft.trim()) { onCreate(draft.trim()); onClose(); } }}><Check size={13} /></button>
        </div>
      ) : (
        <button className="gtx-branch-item create" onClick={() => setCreating(true)}>
          <Plus size={13} className="gtx-branch-item-icon" />
          <span className="gtx-branch-item-body"><span className="gtx-branch-item-name">创建并检出新分支…</span></span>
        </button>
      )}
      {onOpenGraph && (
        <button className="gtx-branch-item create" onClick={() => { onOpenGraph(); onClose(); }}>
          <GitGraph size={13} className="gtx-branch-item-icon" />
          <span className="gtx-branch-item-body"><span className="gtx-branch-item-name">Git 图谱</span></span>
        </button>
      )}
    </div>
  );
}

// ── 任务状态图标 ──────────────────────────────────────────────────────────────
function TaskIcon({ status }: { status: string }) {
  if (status === 'done') return <CheckCircle2 size={14} className="gtx-task-icon done" />;
  if (status === 'in_progress') return <Loader2 size={14} className="gtx-task-icon spin running" />;
  if (status === 'blocked') return <AlertCircle size={14} className="gtx-task-icon blocked" />;
  if (status === 'skipped') return <MinusCircle size={14} className="gtx-task-icon skipped" />;
  if (status === 'cancelled') return <X size={14} className="gtx-task-icon skipped" />;
  return <Circle size={13} className="gtx-task-icon pending" />;
}

// ── 主面板 ────────────────────────────────────────────────────────────────────
export function GitPanel({
  state, forcePush = false, branchPrefix = 'codex/',
}: {
  state: AppState;
  forcePush?: boolean;
  branchPrefix?: string;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranchList | null>(null);
  const [stats, setStats] = useState<GitDiffStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // section 展开态
  const [changesOpen, setChangesOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);

  // 变更清单选择
  const [sel, setSel] = useState<Set<string>>(new Set());

  // 提交 / 推送
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  // PR
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prDraft, setPrDraft] = useState(false);
  const [prCreating, setPrCreating] = useState(false);
  const [prResult, setPrResult] = useState<{ ok: boolean; url?: string; error?: string } | null>(null);

  // 提交历史
  const [log, setLog] = useState<GitCommitType[]>([]);

  const board = state.taskBoard;
  const [, setTick] = useState(0);

  const refreshRef = useRef(0);
  const refresh = useCallback(async () => {
    const tick = ++refreshRef.current;
    setLoading(true);
    try {
      const [s, b, d] = await Promise.all([
        desktop.git.status(), desktop.git.branches(), desktop.git.diffStats(),
      ]);
      if (tick !== refreshRef.current) return;
      setStatus(s.ok ? s : null);
      setBranches(b.ok ? b : null);
      setStats(d.ok ? d : null);
      if (!s.ok) setError(s.error ?? '无法读取 Git 状态');
      setSel(new Set());
    } catch (e) {
      if (tick === refreshRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (tick === refreshRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  // 轻量轮询 diffStats，保持 +N −M 与外部改动同步
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const d = await desktop.git.diffStats();
        if (d.ok) setStats(d);
      } catch { /* ignore */ }
    }, 8000);
    return () => clearInterval(id);
  }, []);

  // 目标计时每秒刷新
  useEffect(() => {
    if (!board || board.runtimeMode !== 'executing') return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [board?.runtimeMode]);

  useEffect(() => {
    if (logOpen && log.length === 0) {
      void desktop.git.log(50).then((r) => { if (r.ok && r.commits) setLog(r.commits); });
    }
  }, [logOpen, log.length]);

  // ── actions ────────────────────────────────────────────────────────────────
  async function doCheckout(branch: string) {
    const r = await desktop.git.checkout(branch);
    if (r.ok) { setBranchMenuOpen(false); await refresh(); }
    else setError(r.error ?? '无法切换分支');
  }

  async function doCreateBranch(raw: string) {
    const prefix = (branchPrefix || '').trim();
    const name = prefix && !raw.startsWith(prefix) && !raw.includes('/') ? `${prefix}${raw}` : raw;
    const r = await desktop.git.createBranch(name);
    if (r.ok) { setBranchMenuOpen(false); await refresh(); }
    else setError(r.error ?? '无法创建分支');
  }

  async function doStage(paths: string[]) {
    if (!paths.length) return;
    await desktop.git.stage(paths);
    await refresh();
  }

  async function doUnstage(paths: string[]) {
    if (!paths.length) return;
    await desktop.git.unstage(paths);
    await refresh();
  }

  async function doDiscard() {
    const paths = [...sel].filter((p) => status?.unstaged?.some((f) => f.path === p));
    if (!paths.length) return;
    if (!window.confirm(`放弃 ${paths.length} 个文件的更改？此操作不可撤销。`)) return;
    await desktop.git.discard(paths);
    await refresh();
  }

  async function doCommit() {
    const msg = commitMsg.trim();
    if (!msg) return;
    setCommitting(true);
    setCommitResult(null);
    try {
      const r = await desktop.git.commit(msg);
      if (r.ok) {
        setCommitMsg('');
        setCommitResult(`✔ ${r.shortHash} ${r.message}`);
        await refresh();
      } else {
        setCommitResult(`✘ ${r.error}`);
      }
    } finally {
      setCommitting(false);
    }
  }

  async function doPush() {
    setPushing(true);
    setSyncMsg(null);
    try {
      const r = await desktop.git.push('origin', status?.branch ?? '', forcePush);
      setSyncMsg(r.ok ? (forcePush ? '✔ 已强制推送 (--force-with-lease)' : '✔ 已推送') : `✘ ${r.error}`);
      if (r.ok) await refresh();
    } finally {
      setPushing(false);
    }
  }

  async function doPull() {
    setPulling(true);
    setSyncMsg(null);
    try {
      const r = await desktop.git.pull('origin', status?.branch ?? '');
      setSyncMsg(r.ok ? '✔ 已拉取' : `✘ ${r.error}`);
      if (r.ok) { await refresh(); setLog([]); }
    } finally {
      setPulling(false);
    }
  }

  async function doCreatePr() {
    const title = prTitle.trim();
    if (!title) return;
    setPrCreating(true);
    setPrResult(null);
    try {
      const r = await desktop.git.createPr({ title, body: prBody, draft: prDraft });
      setPrResult({ ok: r.ok, url: r.url, error: r.error });
      if (r.ok) { setPrTitle(''); setPrBody(''); }
    } finally {
      setPrCreating(false);
    }
  }

  function boardAction(action: Action, taskId?: string) {
    void desktop.agent.taskBoardAction(action, taskId);
  }

  // ── render helpers ─────────────────────────────────────────────────────────
  const changedFiles = status
    ? (status.staged?.length ?? 0) + (status.unstaged?.length ?? 0) + (status.untracked?.length ?? 0)
    : 0;
  const added = stats?.added ?? 0;
  const removed = stats?.removed ?? 0;
  const progress = board ? taskProgress(board.tasks) : null;
  const stages = board ? computeStages(board.tasks) : [];

  const goalElapsed = board?.startedAt ? formatGoalElapsed(Date.now() - board.startedAt) : null;
  const goalRunning = board?.runtimeMode === 'executing';

  return (
    <div className="gtx-panel">
      {/* ── Git 工具 ──────────────────────────────────────────────────────── */}
      <div className="gtx-card">
        <div className="gtx-card-head">
          <span className="gtx-card-title">Git 工具</span>
          <span className="gtx-card-spacer" />
          <button className={`icon-button ${prOpen ? 'active' : ''}`} title="创建 Pull Request" onClick={() => { setPrOpen((o) => !o); setPrResult(null); }}>
            <GitPullRequest size={14} />
          </button>
          <button className="icon-button" title="刷新" disabled={loading} onClick={() => void refresh()}>
            {loading ? <Loader2 size={14} className="spin" /> : <Settings2 size={14} />}
          </button>
        </div>

        {/* 更改行 */}
        <button className="gtx-row" onClick={() => setChangesOpen((v) => !v)}>
          <FileDiff size={15} className="gtx-row-icon" />
          <span className="gtx-row-label">更改</span>
          <span className="gtx-row-spacer" />
          {changedFiles > 0 ? (
            <>
              <span className="gtx-add">+{fmtCount(added)}</span>
              <span className="gtx-del">−{fmtCount(removed)}</span>
            </>
          ) : (
            <span className="gtx-clean">干净</span>
          )}
          {changesOpen ? <ChevronDown size={13} className="gtx-row-chev" /> : <ChevronRight size={13} className="gtx-row-chev" />}
        </button>

        {/* 分支行（下拉） */}
        <div className="gtx-branch-wrap">
          <button className="gtx-row" onClick={() => setBranchMenuOpen((v) => !v)}>
            <GitBranch size={15} className="gtx-row-icon" />
            <span className="gtx-row-label gtx-branch-name" title={status?.branch ?? ''}>{status?.branch ?? '…'}</span>
            {(status?.ahead ?? 0) > 0 && <span className="gtx-badge up">↑{status!.ahead}</span>}
            {(status?.behind ?? 0) > 0 && <span className="gtx-badge down">↓{status!.behind}</span>}
            <span className="gtx-row-spacer" />
            <ChevronDown size={13} className={`gtx-row-chev ${branchMenuOpen ? 'open' : ''}`} />
          </button>
          {branchMenuOpen && branches && (
            <BranchMenu
              branches={branches}
              status={status}
              onCheckout={(b) => void doCheckout(b)}
              onCreate={(b) => void doCreateBranch(b)}
              onClose={() => setBranchMenuOpen(false)}
              onOpenGraph={() => { setChangesOpen(true); setLogOpen(true); }}
            />
          )}
        </div>

        {/* 提交或推送行 */}
        <button className="gtx-row" onClick={() => setCommitOpen((v) => !v)}>
          <Upload size={15} className="gtx-row-icon" />
          <span className="gtx-row-label">提交或推送</span>
          <span className="gtx-row-spacer" />
          {(status?.ahead ?? 0) > 0 && <span className="gtx-badge up">待推送 {status!.ahead}</span>}
          {commitOpen ? <ChevronDown size={13} className="gtx-row-chev" /> : <ChevronRight size={13} className="gtx-row-chev" />}
        </button>

        {/* 展开体：变更清单 */}
        {changesOpen && (
          <div className="gtx-body">
            {error && (
              <div className="gtx-error">
                <AlertCircle size={13} /><span>{error}</span>
                <button className="icon-button" onClick={() => setError(null)}><X size={12} /></button>
              </div>
            )}
            {changedFiles === 0 ? (
              <div className="gtx-empty">工作区干净，没有未提交的更改</div>
            ) : (
              <>
                {status?.staged?.map((f) => (
                  <div key={`s:${f.path}`} className="gtx-file-row">
                    <span className="gtx-file-letter ok">S</span>
                    <span className="gtx-file-path" title={f.path}>{f.path}</span>
                    <button className="icon-button" title="取消暂存" onClick={() => void doUnstage([f.path])}><MinusCircle size={13} /></button>
                  </div>
                ))}
                {status?.unstaged?.map((f) => (
                  <div key={`u:${f.path}`} className="gtx-file-row">
                    <input
                      type="checkbox"
                      checked={sel.has(f.path)}
                      onChange={() => setSel((prev) => {
                        const next = new Set(prev);
                        if (next.has(f.path)) next.delete(f.path); else next.add(f.path);
                        return next;
                      })}
                    />
                    <span className="gtx-file-letter mod">{f.working || f.index}</span>
                    <span className="gtx-file-path" title={f.path}>{f.path}</span>
                    <button className="icon-button" title="暂存" onClick={() => void doStage([f.path])}><Plus size={13} /></button>
                  </div>
                ))}
                {status?.untracked?.map((p) => (
                  <div key={`?:${p}`} className="gtx-file-row dim">
                    <span className="gtx-file-letter untracked">U</span>
                    <span className="gtx-file-path" title={p}>{p}</span>
                    <button className="icon-button" title="暂存" onClick={() => void doStage([p])}><Plus size={13} /></button>
                  </div>
                ))}
                <div className="gtx-body-toolbar">
                  <button className="gtx-btn" onClick={() => void doStage([...(status?.unstaged?.map((f) => f.path) ?? []), ...(status?.untracked ?? [])])}>
                    <Plus size={12} /> 全部暂存
                  </button>
                  <button className="gtx-btn danger" disabled={sel.size === 0} onClick={() => void doDiscard()}>
                    放弃选中 ({sel.size})
                  </button>
                </div>
              </>
            )}
            <button className="gtx-btn ghost log-toggle" onClick={() => setLogOpen((v) => !v)}>
              <GitGraph size={12} /> {logOpen ? '收起提交历史' : '查看提交历史'}
            </button>
            {logOpen && (
              <div className="gtx-log">
                {log.length === 0 ? <div className="gtx-empty">暂无提交历史</div> : log.map((c) => (
                  <div key={c.hash} className="gtx-log-row">
                    <code className="gtx-log-hash">{c.shortHash}</code>
                    <span className="gtx-log-msg" title={c.message}>{c.message}</span>
                    <span className="gtx-log-date">{new Date(c.date).toLocaleDateString('zh-CN')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 展开体：提交/推送 */}
        {commitOpen && (
          <div className="gtx-body">
            <textarea
              className="gtx-commit-input"
              placeholder="提交说明（Ctrl+Enter 提交）"
              rows={3}
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void doCommit(); } }}
            />
            <div className="gtx-commit-row">
              <button
                className="gtx-btn primary"
                disabled={committing || !commitMsg.trim() || (status?.staged?.length ?? 0) === 0}
                title={(status?.staged?.length ?? 0) === 0 ? '请先在「更改」里暂存文件' : 'Ctrl+Enter 提交'}
                onClick={() => void doCommit()}
              >
                {committing ? <Loader2 size={13} className="spin" /> : <GitCommit size={13} />} 提交
              </button>
              <button className="gtx-btn" disabled={pushing} onClick={() => void doPush()}>
                {pushing ? <Loader2 size={13} className="spin" /> : <Upload size={13} />} 推送
              </button>
              <button className="gtx-btn" disabled={pulling} onClick={() => void doPull()}>
                {pulling ? <Loader2 size={13} className="spin" /> : <Upload size={13} className="flip" />} 拉取
              </button>
            </div>
            {commitResult && <div className={`gtx-msg ${commitResult.startsWith('✘') ? 'err' : 'ok'}`}>{commitResult}</div>}
            {syncMsg && <div className={`gtx-msg ${syncMsg.startsWith('✘') ? 'err' : 'ok'}`}>{syncMsg}</div>}
            {prOpen && (
              <div className="gtx-pr">
                <input className="gtx-pr-input" placeholder="PR 标题（必填）" value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />
                <textarea className="gtx-pr-input" placeholder="PR 描述（可选）" rows={2} value={prBody} onChange={(e) => setPrBody(e.target.value)} />
                <label className="gtx-pr-draft">
                  <input type="checkbox" checked={prDraft} onChange={(e) => setPrDraft(e.target.checked)} /> 草稿 PR
                </label>
                <button className="gtx-btn primary" disabled={!prTitle.trim() || prCreating} onClick={() => void doCreatePr()}>
                  {prCreating ? <Loader2 size={13} className="spin" /> : <GitPullRequest size={13} />} 创建 PR
                </button>
                {prResult && (
                  <div className={`gtx-msg ${prResult.ok ? 'ok' : 'err'}`}>
                    {prResult.ok ? <>✔ 已创建 <a onClick={(e) => { e.preventDefault(); void desktop.preview.openExternal(prResult.url ?? ''); }}>{prResult.url}</a></> : `✘ ${prResult.error}`}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 目标 + 进程（TaskBoard） ─────────────────────────────────────── */}
      {board && (
        <div className="gtx-card">
          {board.goal && (
            <div className="gtx-goal">
              <span className="gtx-goal-label">目标</span>
              {goalElapsed && <span className="gtx-goal-time">{goalElapsed}</span>}
              {goalRunning && (
                <button className="icon-button gtx-goal-pause" title="暂停" onClick={() => boardAction('pause')}>
                  <Pause size={13} />
                </button>
              )}
              {board.runtimeMode === 'paused' && (
                <button className="icon-button gtx-goal-pause" title="继续" onClick={() => boardAction('continue')}>
                  <Play size={13} />
                </button>
              )}
            </div>
          )}
          {board.goal && <div className="gtx-goal-text" title={board.goal}>{board.goal}</div>}

          <div className="gtx-progress-head">
            <span>进程</span>
            <span className="gtx-progress-count">{progress?.label ?? ''}</span>
          </div>
          {stages.map(({ stage, tasks }) => {
            const sp = taskProgress(tasks);
            return (
              <div key={stage} className="gtx-stage">
                {tasks.map((t) => (
                  <div key={t.id} className={`gtx-task ${t.status}`}>
                    <TaskIcon status={t.status} />
                    <span className={`gtx-task-title ${t.status === 'done' || t.status === 'skipped' ? 'strike' : ''}`} title={t.title}>
                      {tasks.length > 1 || stage > 0 ? `${t.title}` : t.title}
                    </span>
                    {t.id === board.activeTaskId && <em className="gtx-task-current">当前</em>}
                    <span className="gtx-row-spacer" />
                    <span className="gtx-task-count">{sp.done}/{sp.total}</span>
                  </div>
                ))}
              </div>
            );
          })}
          {board.status === 'draft' || board.runtimeMode === 'awaiting_confirm' ? (
            <button className="gtx-btn primary full" onClick={() => boardAction('confirm')}>
              <Play size={13} /> 确认执行计划
            </button>
          ) : board.status === 'blocked' && board.activeTaskId ? (
            <button className="gtx-btn full" onClick={() => boardAction('reopen', board.activeTaskId)}>
              重新打开当前任务
            </button>
          ) : null}
        </div>
      )}

      {/* ── 智能体 ───────────────────────────────────────────────────────── */}
      <div className="gtx-card">
        <div className="gtx-agent-head">
          <span className="gtx-card-title">智能体</span>
          <span className="gtx-row-spacer" />
          <span className={`gtx-agent-status ${state.agentStatus}`}>
            {state.agentStatus === 'running' && <Loader2 size={11} className="spin" />}
            {{ offline: '离线', starting: '启动中…', ready: '就绪', running: '运行中' }[state.agentStatus]}
          </span>
        </div>
      </div>
    </div>
  );
}
