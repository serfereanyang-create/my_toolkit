import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  GitBranch, GitCommit, GitPullRequest, ChevronDown, ChevronRight, Search,
  Plus, Upload, Check, X, AlertCircle, Loader2, Play, Pause, FileDiff,
  CheckCircle2, Circle, MinusCircle, GitGraph as GitGraphIcon, RefreshCw, ArrowDown, Settings2,
} from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { GitStatus, GitBranchList, GitFileStatus, GitPullStrategy } from '../lib/ipc';
import type { AppState, TaskBoard } from '../types';
import { formatGoalElapsed, taskProgress, computeStages, gitChangedFileCount } from '../lib/gitPanelFormat';
import { GitGraph } from './GitGraph';
import { ConfirmDialog } from './ConfirmDialog';
import { useGitWorkspace } from '../lib/useGitWorkspace';
import { GitFileDiffView } from './GitFileDiffView';
import { gitSyncTargetLabel, resolveGitSyncTargets } from '../lib/gitSyncTargets';

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
  branches, status, onCheckout, onCreate, onClose, onOpenGraph, busy = false,
}: {
  branches: GitBranchList;
  status: GitStatus | null;
  onCheckout: (b: string) => void;
  onCreate: (b: string) => void;
  onClose: () => void;
  busy?: boolean;
  /** 提供时在底部显示「Git 图谱」入口。 */
  onOpenGraph?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const restoreFocus = useRef(true);
  const triggerRef = useRef<HTMLElement | null>(null);
  const clickingTrigger = useRef(false);
  const focusRevision = useRef(0);

  useLayoutEffect(() => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previous = active && ref.current?.contains(active) ? triggerRef.current : active;
    const revision = ++focusRevision.current;
    triggerRef.current = previous;
    searchRef.current?.focus();
    return () => {
      if (restoreFocus.current && previous?.isConnected) requestAnimationFrame(() => {
        if (revision === focusRevision.current && !document.querySelector('[aria-modal="true"]') && (document.activeElement === document.body || document.activeElement === previous)) previous.focus();
      });
    };
  }, []);
  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (triggerRef.current?.contains(event.target as Node)) { clickingTrigger.current = true; return; }
      if (ref.current && !ref.current.contains(event.target as Node)) {
        restoreFocus.current = false;
        closeRef.current();
      }
    };
    const onMouseUp = () => { clickingTrigger.current = false; };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('mouseup', onMouseUp);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('mouseup', onMouseUp); };
  }, []);

  const q = query.trim().toLowerCase();
  const local = (branches.local ?? []).filter((b) => !q || b.toLowerCase().includes(q));
  const remote = (branches.remote ?? []).filter((b) => !q || b.toLowerCase().includes(q));
  const uncommitted = gitChangedFileCount(status);

  return (
    <div className="gtx-branch-menu" ref={ref} role="dialog" aria-label="切换 Git 分支"
      onBlur={(event) => {
        if (clickingTrigger.current && event.relatedTarget instanceof Node && triggerRef.current?.contains(event.relatedTarget)) return;
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
          restoreFocus.current = false;
          onClose();
        }
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation();
          if (creating) { setCreating(false); setDraft(''); searchRef.current?.focus(); }
          else onClose();
          return;
        }
        if (creating || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        if (event.target instanceof HTMLInputElement && (event.key === 'Home' || event.key === 'End')) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.gtx-branch-item:not(:disabled)')];
        if (!buttons.length) return;
        event.preventDefault(); event.stopPropagation();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : index < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0)
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      <label className="gtx-branch-search">
        <Search size={13} />
        <input
          ref={searchRef}
          aria-label="搜索分支"
          placeholder="搜索分支"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="gtx-branch-group-label">分支</div>
      {local.map((b) => (
        <button
          key={b}
          type="button" disabled={busy} aria-current={b === branches.current ? 'true' : undefined}
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
            <button key={b} type="button" disabled={busy} className="gtx-branch-item" onClick={() => onCheckout(b.replace(/^[^/]+\//, ''))}>
              <GitBranch size={13} className="gtx-branch-item-icon dim" />
              <span className="gtx-branch-item-body"><span className="gtx-branch-item-name" title={b}>{b}</span></span>
            </button>
          ))}
        </>
      )}
      {local.length === 0 && remote.length === 0 && <p className="gtx-branch-empty">没有匹配的分支</p>}
      {creating ? (
        <div className="gtx-branch-create">
          <input
            autoFocus
            aria-label="新分支名称" disabled={busy}
            placeholder="新分支名称"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim() && !busy && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && !e.repeat) { e.preventDefault(); onCreate(draft.trim()); }
            }}
          />
          <button type="button" className="icon-button" title="创建并检出" aria-label="创建并检出" disabled={busy || !draft.trim()} onClick={() => { if (draft.trim()) onCreate(draft.trim()); }}><Check size={13} /></button>
        </div>
      ) : (
        <button type="button" disabled={busy} className="gtx-branch-item create" onClick={() => setCreating(true)}>
          <Plus size={13} className="gtx-branch-item-icon" />
          <span className="gtx-branch-item-body"><span className="gtx-branch-item-name">创建并检出新分支…</span></span>
        </button>
      )}
      {onOpenGraph && (
        <button type="button" className="gtx-branch-item create" onClick={() => { onOpenGraph(); onClose(); }}>
          <GitGraphIcon size={13} className="gtx-branch-item-icon" />
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

function GitFileGroup({ title, files, staged = false, untracked = false, selected, disabled, onToggle, onStage, onUnstage, onInspect }: {
  title: string;
  files: GitFileStatus[];
  staged?: boolean;
  untracked?: boolean;
  selected: Set<string>;
  disabled: boolean;
  onToggle: (path: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onInspect: (path: string, staged: boolean) => void;
}) {
  if (!files.length) return null;
  return <section className="gtx-file-group" aria-label={title}>
    <div className="gtx-file-group-head"><h3>{title}<span>{files.length}</span></h3>
      <button type="button" className="gtx-btn ghost" disabled={disabled} onClick={() => (staged ? onUnstage : onStage)(files.map((file) => file.path))}>
        {staged ? '取消全部暂存' : '全部暂存'}
      </button>
    </div>
    {files.map((file) => {
      const separator = file.path.lastIndexOf('/');
      const name = separator < 0 ? file.path : file.path.slice(separator + 1);
      const directory = file.originalPath ? `${file.index === 'C' || file.working === 'C' ? '复制自' : '重命名自'} ${file.originalPath}` : separator < 0 ? '仓库根目录' : file.path.slice(0, separator);
      return <div key={file.path} className={`gtx-file-row${selected.has(file.path) && !staged ? ' selected' : ''}`} data-path={file.path}>
        {!staged && <input type="checkbox" aria-label={`选择 ${file.path}`} checked={selected.has(file.path)} disabled={disabled} onChange={() => onToggle(file.path)} />}
        <span className={`gtx-file-letter ${staged ? 'ok' : untracked ? 'untracked' : 'mod'}`} title={staged ? '已暂存' : untracked ? '未跟踪' : '未暂存'}>{untracked ? 'U' : (staged ? file.index : file.working)?.trim() || 'M'}</span>
        <button type="button" className="gtx-file-path gtx-file-open" data-git-path={file.path} data-staged={String(staged)} disabled={disabled} title={`查看 ${file.path} 的${staged ? '已暂存' : '工作区'}差异`} onClick={() => onInspect(file.path, staged)}><span className="gtx-file-name">{name}</span><span className="gtx-file-directory">{directory}</span></button>
        <button type="button" className="icon-button" title={staged ? '取消暂存' : '暂存'} aria-label={`${staged ? '取消暂存' : '暂存'} ${file.path}`} disabled={disabled} onClick={() => (staged ? onUnstage : onStage)([file.path])}>
          {staged ? <MinusCircle size={15} /> : <Plus size={15} />}
        </button>
      </div>;
    })}
  </section>;
}

// ── 主面板 ────────────────────────────────────────────────────────────────────
export function GitPanel({
  state, forcePush = false, branchPrefix = 'codex/', onOpenFile,
}: {
  state: AppState;
  forcePush?: boolean;
  branchPrefix?: string;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const { status, branches, stats, loading, error, notice, pending, disabled, refresh, runAction, clearError, notRepo } = useGitWorkspace(state.workspaceRoot);
  const panelId = useId();
  const [selectedDiff, setSelectedDiff] = useState<{ root: string; path: string; staged: boolean } | null>(null);
  const lastDiff = useRef<typeof selectedDiff>(null);
  const activeDiff = selectedDiff?.root === state.workspaceRoot ? selectedDiff : null;
  useLayoutEffect(() => {
    if (activeDiff || !lastDiff.current) return;
    const previous = lastDiff.current;
    lastDiff.current = null;
    if (previous.root !== state.workspaceRoot) return;
    const button = [...document.querySelectorAll<HTMLButtonElement>('.gtx-file-open')].find((element) => element.dataset.gitPath === previous.path && element.dataset.staged === String(previous.staged));
    (button ?? document.querySelector<HTMLButtonElement>('.gtx-page-header button'))?.focus();
  }, [Boolean(activeDiff), state.workspaceRoot]);
  const inspectFile = (path: string, staged: boolean) => {
    const selection = { root: state.workspaceRoot, path, staged };
    lastDiff.current = selection;
    setSelectedDiff(selection);
  };

  // section 展开态
  const [changesOpen, setChangesOpen] = useState(true);
  const [commitOpen, setCommitOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);

  // 变更清单选择
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [discardPaths, setDiscardPaths] = useState<string[] | null>(null);

  // 提交 / 推送
  const [commitMsg, setCommitMsg] = useState('');
  const [syncOptions, setSyncOptions] = useState({ context: '', remote: '', strategy: 'configured' as GitPullStrategy, expanded: false });
  const syncContext = JSON.stringify([state.workspaceRoot, status?.branch]);
  const chosenRemote = syncOptions.context === syncContext ? syncOptions.remote : '';
  const pullStrategy = syncOptions.context === syncContext ? syncOptions.strategy : 'configured';
  const syncPlan = resolveGitSyncTargets(status, branches, chosenRemote);
  const tracking = branches?.sync?.tracking;
  const pushAhead = syncPlan.push?.remote === tracking?.remote && syncPlan.push?.branch === tracking?.branch ? status?.ahead : 0;
  const pullBehind = syncPlan.pull?.remote === tracking?.remote && syncPlan.pull?.branch === tracking?.branch ? status?.behind : 0;
  const syncExpanded = (syncOptions.context === syncContext && syncOptions.expanded) || (syncPlan.remotes.length > 1 && !syncPlan.push && !syncPlan.pull);
  const updateSync = (values: Partial<Omit<typeof syncOptions, 'context'>>) => setSyncOptions({ context: syncContext, remote: chosenRemote, strategy: pullStrategy, expanded: syncExpanded, ...values });

  // PR
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prDraft, setPrDraft] = useState(false);
  const [prResult, setPrResult] = useState<{ ok: boolean; url?: string; error?: string } | null>(null);

  const board = state.taskBoard;
  const [, setTick] = useState(0);

  useEffect(() => {
    const available = new Set([...(status?.unstaged ?? []).map((file) => file.path), ...(status?.untracked ?? [])]);
    setSel((previous) => new Set([...previous].filter((path) => available.has(path))));
  }, [status]);
  useEffect(() => {
    setSel(new Set()); setDiscardPaths(null); setBranchMenuOpen(false);
    setSelectedDiff(null);
    setCommitMsg(''); setPrTitle(''); setPrBody(''); setPrResult(null); setPrOpen(false);
  }, [state.workspaceRoot]);

  // 目标计时每秒刷新
  useEffect(() => {
    if (!board || board.runtimeMode !== 'executing') return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [board?.runtimeMode]);

  // ── actions ────────────────────────────────────────────────────────────────
  async function doCheckout(branch: string) {
    const result = await runAction('切换分支', () => desktop.git.checkout(branch), () => `已切换到 ${branch}`);
    if (result) setBranchMenuOpen(false);
  }

  async function doCreateBranch(raw: string) {
    const prefix = (branchPrefix || '').trim();
    const name = prefix && !raw.startsWith(prefix) && !raw.includes('/') ? `${prefix}${raw}` : raw;
    const result = await runAction('创建分支', () => desktop.git.createBranch(name), () => `已创建并切换到 ${name}`);
    if (result) setBranchMenuOpen(false);
  }

  async function doStage(paths: string[]) {
    if (!paths.length) return;
    const unique = [...new Set(paths)];
    await runAction('暂存文件', () => desktop.git.stage(unique), () => `已暂存 ${unique.length} 个文件`);
  }

  async function doUnstage(paths: string[]) {
    if (!paths.length) return;
    await runAction('取消暂存', () => desktop.git.unstage(paths), () => `已取消暂存 ${paths.length} 个文件`);
  }

  async function doDiscard() {
    if (disabled) return;
    const paths = [...sel].filter((p) => status?.unstaged?.some((f) => f.path === p));
    if (!paths.length) return;
    setDiscardPaths(paths);
  }

  async function confirmDiscard() {
    const paths = discardPaths;
    if (!paths?.length) return;
    const result = await runAction('放弃更改', () => desktop.git.discard(paths), () => `已放弃 ${paths.length} 个文件的更改`);
    if (result) setDiscardPaths(null);
  }

  async function doCommit() {
    const msg = commitMsg.trim();
    if (!msg || !status?.staged?.length || status.hasConflicts) return;
    const result = await runAction('提交', () => desktop.git.commit(msg), (response) => `已提交 ${response.shortHash ?? ''} · ${response.message ?? msg}`);
    if (result) setCommitMsg('');
  }

  async function doPush() {
    const target = syncPlan.push;
    if (disabled || !target) return;
    const label = syncPlan.publish ? '发布分支' : '推送';
    await runAction(label, () => desktop.git.push(target.remote, `refs/heads/${target.localBranch}:refs/heads/${target.branch}`, forcePush, syncPlan.publish), () => `${syncPlan.publish ? '已发布并设置追踪' : forcePush ? '已使用 force-with-lease 推送' : '已推送'} · ${gitSyncTargetLabel(target)}`);
  }

  async function doPull() {
    const target = syncPlan.pull;
    if (disabled || !target) return;
    await runAction('拉取', () => desktop.git.pull(target.remote, target.branch, pullStrategy), () => `已拉取 · ${gitSyncTargetLabel(target)}`);
  }

  async function doCreatePr() {
    const title = prTitle.trim();
    if (!title) return;
    setPrResult(null);
    const result = await runAction('创建 PR', () => desktop.git.createPr({ title, body: prBody, draft: prDraft }), () => 'Pull Request 已创建');
    if (result) { setPrResult({ ok: true, url: result.url }); setPrTitle(''); setPrBody(''); }
  }

  function boardAction(action: Action, taskId?: string) {
    void desktop.agent.taskBoardAction(action, taskId);
  }

  // ── render helpers ─────────────────────────────────────────────────────────
  const changedFiles = gitChangedFileCount(status);
  const stagedFiles = status?.staged ?? [];
  const unstagedFiles = status?.unstaged ?? [];
  const untrackedFiles = status?.untracked ?? [];
  const discardable = [...sel].filter((path) => unstagedFiles.some((file) => file.path === path));
  const added = stats?.added ?? 0;
  const removed = stats?.removed ?? 0;
  const progress = board ? taskProgress(board.tasks) : null;
  const stages = board ? computeStages(board.tasks) : [];

  const goalElapsed = board?.startedAt ? formatGoalElapsed(Date.now() - board.startedAt) : null;
  const goalRunning = board?.runtimeMode === 'executing';
  const workspaceName = state.workspaceRoot.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || '当前工作区';
  const toggleSelected = (path: string) => setSel((previous) => {
    const next = new Set(previous);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  function initializeRepository() {
    void runAction('初始化仓库', () => desktop.git.init(), () => '已初始化 git 仓库，现在可以逐文件查看改动');
  }

  if (notRepo) return <div className="gtx-panel" aria-label="源代码管理">
    <header className="gtx-page-header">
      <div><span className="gtx-eyebrow"><GitBranch size={14} />工作区</span><h1>源代码管理</h1><p title={state.workspaceRoot}>{workspaceName}<span>·</span>{loading ? '正在读取' : '还没有版本库'}</p></div>
      <button type="button" className="gtx-btn" title="刷新" disabled={loading || pending !== null} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? 'spin' : undefined} />刷新</button>
    </header>
    <div className="gtx-repo-empty">
      <GitBranch size={26} />
      <h2>这个文件夹还不是 git 仓库</h2>
      <p>初始化后，改动会在这里逐文件列出，可以暂存、提交、回退，也能推送或创建 Pull Request。</p>
      <p className="gtx-repo-empty-note">只创建 .git 目录，不暂存、不提交、不删除任何文件。</p>
      <button type="button" className="gtx-btn primary" disabled={pending !== null} onClick={initializeRepository}>
        {pending === '初始化仓库' ? <><Loader2 size={14} className="spin" />正在初始化…</> : <><Plus size={14} />初始化仓库</>}
      </button>
      {error && <div className="gtx-error" role="alert"><AlertCircle size={15} /><span>{error}</span><button type="button" className="icon-button" aria-label="关闭 Git 错误提示" onClick={clearError}><X size={14} /></button></div>}
    </div>
  </div>;

  if (activeDiff) return <div className="gtx-panel gtx-diff-page">
    <div className="gtx-diff-breadcrumb"><GitBranch size={14} /><span>源代码管理</span><ChevronRight size={13} /><span title={activeDiff.path}>{activeDiff.path}</span></div>
    <GitFileDiffView workspaceRoot={state.workspaceRoot} path={activeDiff.path} staged={activeDiff.staged} onBack={() => setSelectedDiff(null)} onOpenFile={onOpenFile} onStageChange={(staged) => inspectFile(activeDiff.path, staged)} />
  </div>;

  return (
    <>
    <div className="gtx-panel" aria-label="源代码管理">
      <header className="gtx-page-header">
        <div><span className="gtx-eyebrow"><GitBranch size={14} />工作区</span><h1>源代码管理</h1><p title={state.workspaceRoot}>{workspaceName}<span>·</span>{loading && !status ? '正在读取仓库' : status ? `${changedFiles} 个文件有更改` : '仓库状态不可用'}</p></div>
        <button type="button" className="gtx-btn" title="刷新" disabled={loading || pending !== null} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? 'spin' : undefined} />刷新</button>
      </header>
      {error && <div className="gtx-error" role="alert"><AlertCircle size={15} /><span>{error}</span><button type="button" className="icon-button" aria-label="关闭 Git 错误提示" onClick={clearError}><X size={14} /></button></div>}
      {(pending || notice) && <div className={`gtx-operation${pending ? ' pending' : ''}`} role="status">{pending ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}<span>{pending ? `正在${pending}…` : notice}</span></div>}
      {status?.hasConflicts && <div className="gtx-conflict-notice"><AlertCircle size={15} /><span>存在合并冲突，请先解决并暂存冲突文件，再提交。</span></div>}
      <div className="gtx-workbench">
      {/* ── Git 工具 ──────────────────────────────────────────────────────── */}
      <div className="gtx-card gtx-repository" aria-busy={loading || pending !== null}>
        <div className="gtx-card-head">
          <span className="gtx-card-heading">
            <span className="gtx-card-title">仓库更改</span>
            <span className="gtx-card-subtitle">{status?.upstream || (status ? '本地仓库' : loading ? '正在连接仓库…' : '请检查仓库状态')}</span>
          </span>
          <span className="gtx-card-spacer" />
          <button type="button" disabled={disabled} className={`gtx-btn ${prOpen ? 'active' : ''}`} title="创建 Pull Request" aria-expanded={prOpen} aria-controls={`${panelId}-pr`} onClick={() => { setPrOpen((previous) => !previous); setPrResult(null); }}>
            <GitPullRequest size={14} />发起 PR
          </button>
        </div>

        {/* 更改行 */}
        <button type="button" className="gtx-row" aria-expanded={changesOpen} aria-controls={`${panelId}-changes`} onClick={() => setChangesOpen((v) => !v)}>
          <FileDiff size={15} className="gtx-row-icon" />
          <span className="gtx-row-label">更改</span>
          <span className="gtx-row-spacer" />
          {changedFiles > 0 ? (
            <>
              <span className="gtx-row-summary">{changedFiles} 个文件</span>
              {stats && <><span className="gtx-add">+{fmtCount(added)}</span><span className="gtx-del">−{fmtCount(removed)}</span></>}
            </>
          ) : (
            <span className="gtx-clean">{status ? '干净' : loading ? '读取中…' : '不可用'}</span>
          )}
          {changesOpen ? <ChevronDown size={13} className="gtx-row-chev" /> : <ChevronRight size={13} className="gtx-row-chev" />}
        </button>

        {/* 分支行（下拉） */}
        <div className="gtx-branch-wrap">
          <button type="button" className="gtx-row" disabled={disabled || !branches} aria-haspopup="dialog" aria-expanded={branchMenuOpen} onClick={() => setBranchMenuOpen((v) => !v)}>
            <GitBranch size={15} className="gtx-row-icon" />
            <span className="gtx-row-label gtx-branch-name" title={status?.branch ?? ''}>{status?.branch || '分支不可用'}</span>
            {(status?.ahead ?? 0) > 0 && <span className="gtx-badge up">↑{status!.ahead}</span>}
            {(status?.behind ?? 0) > 0 && <span className="gtx-badge down">↓{status!.behind}</span>}
            <span className="gtx-row-spacer" />
            <ChevronDown size={13} className={`gtx-row-chev ${branchMenuOpen ? 'open' : ''}`} />
          </button>
          {branchMenuOpen && branches && (
            <BranchMenu
              branches={branches}
              status={status}
              busy={disabled}
              onCheckout={(b) => void doCheckout(b)}
              onCreate={(b) => void doCreateBranch(b)}
              onClose={() => setBranchMenuOpen(false)}
              onOpenGraph={() => { setChangesOpen(true); setLogOpen(true); }}            />
          )}
        </div>

        {/* 展开体：变更清单 */}
        {changesOpen && (
          <div className="gtx-body" id={`${panelId}-changes`}>
            {!status ? (
              <div className="gtx-empty">{loading ? '正在读取文件状态…' : '无法展示更改，请刷新仓库状态。'}</div>
            ) : changedFiles === 0 ? (
              <div className="gtx-empty gtx-empty-clean"><CheckCircle2 size={22} /><strong>工作区干净</strong><span>没有未提交的文件更改</span></div>
            ) : (
              <>
                <GitFileGroup title="已暂存" files={stagedFiles} staged selected={sel} disabled={disabled} onToggle={toggleSelected} onStage={(paths) => void doStage(paths)} onUnstage={(paths) => void doUnstage(paths)} onInspect={inspectFile} />
                <GitFileGroup title="未暂存" files={unstagedFiles} selected={sel} disabled={disabled} onToggle={toggleSelected} onStage={(paths) => void doStage(paths)} onUnstage={(paths) => void doUnstage(paths)} onInspect={inspectFile} />
                <GitFileGroup title="未跟踪" files={untrackedFiles.map((path) => ({ path, index: '?', working: '?' }))} untracked selected={sel} disabled={disabled} onToggle={toggleSelected} onStage={(paths) => void doStage(paths)} onUnstage={(paths) => void doUnstage(paths)} onInspect={inspectFile} />
                <div className="gtx-body-toolbar">
                  <button type="button" className="gtx-btn" disabled={disabled || sel.size === 0} onClick={() => void doStage([...sel])}>
                    <Plus size={13} />暂存选中 ({sel.size})
                  </button>
                  <button type="button" className="gtx-btn danger" disabled={disabled || discardable.length === 0} onClick={() => void doDiscard()}>
                    放弃选中 ({discardable.length})
                  </button>
                </div>
              </>
            )}
            <button type="button" className="gtx-btn ghost log-toggle" disabled={!status} aria-expanded={logOpen} onClick={() => setLogOpen((v) => !v)}>
              <GitGraphIcon size={12} /> {logOpen ? '收起提交历史' : '查看提交历史'}
            </button>
            {logOpen && (
              <div className="gtx-log">
                {/* The graph carries the history now: it shows the same commits
                    with lanes, so a separate flat list would duplicate it. */}
                <GitGraph limit={60} />
              </div>
            )}
          </div>
        )}

      </div>
      <aside className="gtx-activity" aria-label="当前执行状态">
      <div className="gtx-card gtx-submit-card">
        <button type="button" className="gtx-row gtx-commit-toggle" aria-expanded={commitOpen} aria-controls={`${panelId}-commit`} onClick={() => setCommitOpen((previous) => !previous)}>
          <GitCommit size={15} className="gtx-row-icon" /><span className="gtx-row-label">提交或推送</span><span className="gtx-row-spacer" />
          {stagedFiles.length > 0 && <span className="gtx-row-summary">{stagedFiles.length} 个已暂存</span>}
          {commitOpen ? <ChevronDown size={13} className="gtx-row-chev" /> : <ChevronRight size={13} className="gtx-row-chev" />}
        </button>
        {commitOpen && (
          <div className="gtx-body gtx-commit-body" id={`${panelId}-commit`}>
            <label className="gtx-form-label" htmlFor={`${panelId}-message`}>提交说明</label>
            <textarea
              id={`${panelId}-message`} disabled={disabled}
              className="gtx-commit-input"
              placeholder="提交说明（Ctrl+Enter 提交）"
              rows={3}
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !event.repeat) { event.preventDefault(); void doCommit(); } }}
            />
            {!stagedFiles.length && <p className="gtx-form-hint">先暂存要提交的文件。说明会保留在这里。</p>}
            {status?.unborn && <p className="gtx-form-hint">此仓库尚无提交，暂存文件后可创建首次提交。</p>}
            <div className="gtx-commit-row">
              <button
                type="button"
                className="gtx-btn primary"
                disabled={disabled || !commitMsg.trim() || !stagedFiles.length || status?.hasConflicts}
                title={(status?.staged?.length ?? 0) === 0 ? '请先在「更改」里暂存文件' : 'Ctrl+Enter 提交'}
                onClick={() => void doCommit()}
              >
                {pending === '提交' ? <Loader2 size={13} className="spin" /> : <GitCommit size={13} />}提交{stagedFiles.length > 0 ? ` ${stagedFiles.length} 个文件` : ''}
              </button>
              <button type="button" className="gtx-btn gtx-push" disabled={disabled || !syncPlan.push} title={syncPlan.push ? `${syncPlan.publish ? '发布并追踪' : '推送到'} ${gitSyncTargetLabel(syncPlan.push)}` : syncPlan.pushReason} aria-describedby={`${panelId}-push-target`} onClick={() => void doPush()}>
                {pending === '推送' || pending === '发布分支' ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}{syncPlan.publish ? '发布分支' : '推送'}{pushAhead ? ` ${pushAhead}` : ''}
              </button>
              <button type="button" className="gtx-btn gtx-pull" disabled={disabled || !syncPlan.pull} title={syncPlan.pull ? `拉取自 ${gitSyncTargetLabel(syncPlan.pull)}` : syncPlan.pullReason} aria-describedby={`${panelId}-pull-target`} onClick={() => void doPull()}>
                {pending === '拉取' ? <Loader2 size={13} className="spin" /> : <ArrowDown size={13} />}拉取{pullBehind ? ` ${pullBehind}` : ''}
              </button>
            </div>
            <div className="gtx-sync-targets" aria-label="同步目标">
              <div id={`${panelId}-push-target`}><span>推送到</span><code title={gitSyncTargetLabel(syncPlan.push)}>{syncPlan.push ? gitSyncTargetLabel(syncPlan.push) : syncPlan.pushReason}</code></div>
              <div id={`${panelId}-pull-target`}><span>拉取自</span><code title={gitSyncTargetLabel(syncPlan.pull)}>{syncPlan.pull ? gitSyncTargetLabel(syncPlan.pull) : syncPlan.pullReason}</code></div>
            </div>
            {(syncPlan.remotes.length > 0 || chosenRemote) && <>
              <button type="button" className="gtx-sync-settings-toggle" aria-expanded={syncExpanded} aria-controls={`${panelId}-sync-settings`} onClick={() => updateSync({ expanded: !syncExpanded })}><Settings2 size={13} />同步设置<ChevronDown size={13} /></button>
              {syncExpanded && <div className="gtx-sync-settings" id={`${panelId}-sync-settings`}>
                <label htmlFor={`${panelId}-sync-remote`}>远程仓库</label>
                <select id={`${panelId}-sync-remote`} className="gtx-sync-remote" aria-label="同步远程仓库" disabled={disabled} value={chosenRemote} onChange={(event) => updateSync({ remote: event.target.value, expanded: true })}>
                  <option value="">{syncPlan.push || syncPlan.pull ? '按分支配置' : '选择远程仓库'}</option>
                  {chosenRemote && !syncPlan.remotes.includes(chosenRemote) && <option value={chosenRemote}>{chosenRemote}（已不可用）</option>}
                  {syncPlan.remotes.map((name) => <option key={name} value={name}>{name === '.' ? '本地仓库' : name}</option>)}
                </select>
                <label htmlFor={`${panelId}-pull-strategy`}>本次拉取</label>
                <select id={`${panelId}-pull-strategy`} className="gtx-pull-strategy" aria-label="拉取策略" disabled={disabled} value={pullStrategy} onChange={(event) => updateSync({ strategy: event.target.value as GitPullStrategy, expanded: true })}>
                  <option value="configured">按 Git 配置</option><option value="ff-only">仅快进</option><option value="merge">合并</option><option value="rebase">变基</option>
                </select>
              </div>}
            </>}
            {syncPlan.publish && <p className="gtx-form-hint">首次发布会为当前分支设置上述追踪目标。</p>}
            {forcePush && <p className="gtx-form-hint">推送将使用 force-with-lease。</p>}
          </div>
        )}
            {prOpen && (
              <form className="gtx-pr" id={`${panelId}-pr`} onSubmit={(event) => { event.preventDefault(); void doCreatePr(); }}>
                <h3>创建 Pull Request</h3>
                <label className="gtx-form-label" htmlFor={`${panelId}-pr-title`}>标题</label>
                <input id={`${panelId}-pr-title`} className="gtx-pr-input" autoFocus disabled={disabled} placeholder="概括这次更改" required value={prTitle} onChange={(event) => setPrTitle(event.target.value)} />
                <label className="gtx-form-label" htmlFor={`${panelId}-pr-description`}>描述<span>可选</span></label>
                <textarea id={`${panelId}-pr-description`} className="gtx-pr-input" disabled={disabled} placeholder="更改原因与验证方式" rows={3} value={prBody} onChange={(event) => setPrBody(event.target.value)} />
                <label className="gtx-pr-draft">
                  <input type="checkbox" disabled={disabled} checked={prDraft} onChange={(event) => setPrDraft(event.target.checked)} />先创建为草稿
                </label>
                <button type="submit" className="gtx-btn primary" disabled={disabled || !prTitle.trim()}>
                  {pending === '创建 PR' ? <Loader2 size={13} className="spin" /> : <GitPullRequest size={13} />}创建 PR
                </button>
                {prResult && (
                  <div className={`gtx-msg ${prResult.ok ? 'ok' : 'err'}`}>
                    {prResult.ok ? <>PR 已创建{prResult.url && <a href={prResult.url} onClick={(event) => { event.preventDefault(); void desktop.preview.openExternal(prResult.url!); }}>查看 Pull Request</a>}</> : prResult.error}
                  </div>
                )}
              </form>
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
            <span>执行步骤</span>
            <span className="gtx-progress-count">{progress?.label ?? ''}</span>
          </div>
          <div className="gtx-goal-progress" role="progressbar" aria-label="当前计划完成进度" aria-valuemin={0} aria-valuemax={progress?.total || 1} aria-valuenow={progress?.done ?? 0}><span style={{ width: `${progress?.total ? progress.done / progress.total * 100 : 0}%` }} /></div>
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
      </aside>
      </div>
    </div>
    <ConfirmDialog open={discardPaths !== null} busy={pending !== null} title="放弃未保存更改？" message={<>{discardPaths?.length ?? 0} 个文件的本地更改将被删除，此操作不可撤销。<span className="gtx-discard-paths">{discardPaths?.join('\n')}</span>{error && <span className="gtx-discard-error" role="alert">{error}</span>}</>} confirmLabel={pending ? '正在处理…' : '放弃更改'} danger onConfirm={() => void confirmDiscard()} onCancel={() => setDiscardPaths(null)} />
    </>
  );
}
