import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Bot, ChevronRight, FileCode2, FileDiff, GitBranch,
  GitCommitHorizontal, ListTodo, Loader2, PanelRightClose, RefreshCw, X,
} from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { GitCommitDetail, GitFileDiffResult, GitFileStat, GitGraphCommit, GitStatus } from '../lib/ipc';
import type { AppState } from '../types';
import { countDiffRows, parseUnifiedDiff } from '../lib/gitDiffParse';
import { layoutGraph, laneColorIndex } from '../lib/gitGraph';
import { formatGoalElapsed, taskProgress } from '../lib/gitPanelFormat';
import { sessionChangeTotals } from '../lib/state';
import {
  canGoBack, currentEntry, goToIndex, initialStack, popLevel, pushLevel,
  type InspectorLevel, type InspectorStack,
} from '../lib/inspectorNav';
import { formatAgo } from '../lib/recentFiles';

/*
 * InspectorSidebar — the right column of the three-pane layout.
 *
 * This is a drill-down inspector, not a tab strip. The session's Git capsule
 * (top-right of the conversation) opens it, and every row that has more to
 * show pushes a deeper level: 更改 → file diff, 提交图谱 → commit → its files.
 * A breadcrumb plus 返回 walks back out, and the stack lives in lib/inspectorNav
 * so the navigation rules are testable.
 *
 * Deliberately read-only: staging, committing and discarding stay in the Git
 * workspace view, so browsing can never destroy work.
 */

const LANE_COLORS = ['#3b82f6', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#06b6d4'];
const LANE_WIDTH = 12;
const ROW_HEIGHT = 30;

function laneColor(lane: number): string {
  return LANE_COLORS[laneColorIndex(lane, LANE_COLORS.length)]!;
}

function shortPath(path: string): { dir: string; name: string } {
  const normalized = path.replace(/\\/g, '/');
  const at = normalized.lastIndexOf('/');
  if (at < 0) return { dir: '', name: normalized };
  return { dir: normalized.slice(0, at + 1), name: normalized.slice(at + 1) };
}

// ── Shared bits ──────────────────────────────────────────────────────────────

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="insp-error" role="alert">
      <AlertTriangle size={13} />
      <span>{message}</span>
    </div>
  );
}

function Empty({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="insp-empty">
      {icon}
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
    </div>
  );
}

/** One drill-down row: a chevron, a label, optional trailing detail. */
function DrillRow({
  icon, name, dir, detail, onClick, title,
}: {
  icon?: React.ReactNode;
  name: string;
  dir?: string;
  detail?: React.ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`insp-row ${onClick ? 'clickable' : ''}`} onClick={onClick} title={title}>
      {icon && <span className="insp-row-icon">{icon}</span>}
      <span className="insp-row-name">
        {name}
        {dir && <span className="insp-row-dir">{dir}</span>}
      </span>
      {detail && <span className="insp-row-detail">{detail}</span>}
      {onClick && <ChevronRight size={13} className="insp-row-chev" />}
    </Tag>
  );
}

// ── Level: overview ──────────────────────────────────────────────────────────

function OverviewLevel({ state, push, gitStatus, totals }: {
  state: AppState;
  push: (level: InspectorLevel) => void;
  gitStatus: GitStatus | null;
  totals: { added: number; removed: number };
}) {
  const board = state.taskBoard;
  const changed = gitStatus
    ? (gitStatus.staged?.length ?? 0) + (gitStatus.unstaged?.length ?? 0) + (gitStatus.untracked?.length ?? 0)
    : 0;
  const done = board ? board.tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length : 0;
  const goalElapsed = board?.startedAt ? formatGoalElapsed(Date.now() - board.startedAt) : null;

  return (
    <div className="insp-stack">
      <DrillRow
        icon={<FileDiff size={14} />}
        name="更改"
        detail={changed > 0
          ? <><span className="insp-add">+{totals.added}</span><span className="insp-del">−{totals.removed}</span></>
          : <span className="insp-muted">干净</span>}
        onClick={() => push({ kind: 'changes' })}
        title="查看逐文件变更"
      />
      <DrillRow
        icon={<GitBranch size={14} />}
        name={gitStatus?.branch ?? '—'}
        detail={(gitStatus?.ahead ?? 0) > 0 ? <span className="insp-badge">↑{gitStatus!.ahead}</span> : undefined}
        onClick={() => push({ kind: 'branches' })}
        title="查看分支"
      />
      <DrillRow
        icon={<GitCommitHorizontal size={14} />}
        name="提交图谱"
        onClick={() => push({ kind: 'graph' })}
        title="查看提交历史"
      />
      {(board || state.taskSummary) && (
        <DrillRow
          icon={<ListTodo size={14} />}
          name={board ? '目标' : '计划'}
          detail={board
            ? <span className="insp-muted">{done}/{board.tasks.length}{goalElapsed ? ` · ${goalElapsed}` : ''}</span>
            : <span className="insp-muted">{state.taskSummary?.title?.slice(0, 18) ?? ''}</span>}
          onClick={() => push({ kind: 'plan' })}
          title="查看计划"
        />
      )}
      <DrillRow
        icon={<Bot size={14} />}
        name="子智能体"
        onClick={() => push({ kind: 'subagents' })}
        title="查看子智能体运行记录"
      />
    </div>
  );
}

// ── Level: changes (per-file list) ───────────────────────────────────────────

function ChangesLevel({ push }: { push: (level: InspectorLevel) => void }) {
  const [files, setFiles] = useState<GitFileStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await desktop.git.fileStats();
      if (res.ok === false) { setError(res.error ?? '无法读取文件变更'); setFiles([]); }
      else setFiles(Array.isArray(res.files) ? res.files : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (error) return <ErrorNote message={error} />;
  if (loading && files.length === 0) {
    return <div className="insp-loading"><Loader2 size={14} className="insp-spin" />读取变更…</div>;
  }
  if (files.length === 0) {
    return <Empty icon={<FileDiff size={20} />} title="工作区是干净的" hint="没有未提交的文件变更。" />;
  }

  return (
    <div className="insp-stack">
      {files.map((file) => {
        const { dir, name } = shortPath(file.path);
        return (
          <DrillRow
            key={file.path}
            icon={<FileCode2 size={13} />}
            name={name}
            dir={dir}
            detail={<><span className="insp-add">+{file.added}</span><span className="insp-del">−{file.removed}</span></>}
            onClick={() => push({ kind: 'file', path: file.path, staged: file.status === 'staged' })}
            title={file.path}
          />
        );
      })}
    </div>
  );
}

// ── Level: one file's diff ───────────────────────────────────────────────────

function FileLevel({ path, staged, commitRef, onOpenFile }: {
  path: string;
  staged?: boolean;
  /**
   * Commit to scope the diff to. Deliberately NOT named `ref`: that is a
   * reserved React prop, and passing a string to it is treated as a legacy
   * string ref, which throws (React error #290).
   */
  commitRef?: string;
  onOpenFile?: (path: string) => void;
}) {
  const [data, setData] = useState<GitFileDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    desktop.git.fileDiff(path, staged, commitRef)
      .then((res) => { if (!cancelled) { if (res.ok === false) setError(res.error ?? '无法读取差异'); else setData(res); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, staged, commitRef]);

  const hunks = parseUnifiedDiff(data?.diff ?? '');
  const totals = countDiffRows(hunks);

  return (
    <div className="insp-diff">
      <div className="insp-diff-meta">
        <code title={path}>{path}</code>
        {commitRef && <span className="insp-tag" title={commitRef}>提交 {commitRef.slice(0, 7)}</span>}
        {data?.untracked && <span className="insp-tag">未跟踪</span>}
        {staged && <span className="insp-tag">已暂存</span>}
        <span className="insp-diff-totals">
          <span className="insp-add">+{totals.added}</span>
          <span className="insp-del">−{totals.removed}</span>
        </span>
      </div>

      {error && <ErrorNote message={error} />}
      {loading && !data && <div className="insp-loading"><Loader2 size={14} className="insp-spin" />读取差异…</div>}
      {!loading && !error && hunks.length === 0 && (
        <Empty icon={<FileDiff size={20} />} title="没有可显示的差异" hint="该文件与 HEAD 一致，或差异为空。" />
      )}

      {hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex} className="insp-hunk">
          <div className="insp-hunk-head">{hunk.header}</div>
          {hunk.rows.map((row, rowIndex) => (
            <div key={rowIndex} className={`insp-diff-row diff-${row.kind}`}>
              <span className="insp-diff-ln">{row.oldLine ?? ''}</span>
              <span className="insp-diff-ln">{row.newLine ?? ''}</span>
              <span className="insp-diff-text">{row.text || ' '}</span>
            </div>
          ))}
        </div>
      ))}

      {onOpenFile && (
        <button type="button" className="insp-open-file" onClick={() => onOpenFile(path)}>
          在编辑器中打开
        </button>
      )}
    </div>
  );
}

// ── Level: branches ──────────────────────────────────────────────────────────

function BranchesLevel({ onCheckedOut }: { onCheckedOut: () => void }) {
  const [branches, setBranches] = useState<{ current?: string; local?: string[]; remote?: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    desktop.git.branches()
      .then((res) => { if (res.ok === false) setError(res.error ?? '无法读取分支'); else setBranches(res); })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const checkout = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      const res = await desktop.git.checkout(name);
      if (res.ok === false) setError(res.error ?? '无法切换分支');
      else { onCheckedOut(); setBranches(await desktop.git.branches()); }
    } finally {
      setBusy(null);
    }
  };

  if (error && !branches) return <ErrorNote message={error} />;
  if (!branches) return <div className="insp-loading"><Loader2 size={14} className="insp-spin" />读取分支…</div>;

  return (
    <div className="insp-stack">
      {error && <ErrorNote message={error} />}
      {(branches.local ?? []).map((name) => (
        <DrillRow
          key={name}
          icon={busy === name ? <Loader2 size={13} className="insp-spin" /> : <GitBranch size={13} />}
          name={name}
          detail={name === branches.current ? <span className="insp-tag">当前</span> : undefined}
          // The current branch has nothing to check out; clicking it is a no-op
          // rather than a pointless git call.
          onClick={name === branches.current ? undefined : () => void checkout(name)}
          title={name === branches.current ? '当前分支' : `切换到 ${name}`}
        />
      ))}
      {(branches.remote ?? []).length > 0 && (
        <>
          <div className="insp-subhead">远程</div>
          {(branches.remote ?? []).map((name) => (
            <DrillRow key={name} icon={<GitBranch size={13} />} name={name} title={name} />
          ))}
        </>
      )}
    </div>
  );
}

// ── Level: commit graph ──────────────────────────────────────────────────────

function GraphLevel({ push }: { push: (level: InspectorLevel) => void }) {
  const [commits, setCommits] = useState<GitGraphCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    desktop.git.graph(60)
      .then((res) => { if (cancelled) return; if (res.ok === false) setError(res.error ?? '无法读取提交历史'); else setCommits(res.commits ?? []); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (loading) return <div className="insp-loading"><Loader2 size={14} className="insp-spin" />读取提交历史…</div>;
  if (commits.length === 0) return <Empty icon={<GitCommitHorizontal size={20} />} title="还没有提交记录" />;

  const { rows, maxLanes } = layoutGraph(commits.map((c) => ({ hash: c.hash, parents: c.parents })));
  const byHash = new Map(commits.map((c) => [c.hash, c]));

  return (
    <ul className="insp-graph">
      {rows.map((row) => {
        const commit = byHash.get(row.hash);
        if (!commit) return null;
        const cx = row.lane * LANE_WIDTH + LANE_WIDTH / 2;
        return (
          <li key={row.hash} className="insp-graph-row" style={{ height: ROW_HEIGHT }}>
            <svg className="insp-graph-gutter" width={Math.max(1, maxLanes) * LANE_WIDTH} height={ROW_HEIGHT} aria-hidden="true">
              {row.edges.map((edge, i) => {
                const toX = edge.toLane * LANE_WIDTH + LANE_WIDTH / 2;
                const path = edge.fromLane === edge.toLane
                  ? `M ${cx} ${ROW_HEIGHT / 2} L ${toX} ${ROW_HEIGHT}`
                  : `M ${cx} ${ROW_HEIGHT / 2} C ${cx} ${ROW_HEIGHT * 0.75}, ${toX} ${ROW_HEIGHT * 0.75}, ${toX} ${ROW_HEIGHT}`;
                return <path key={i} d={path} stroke={laneColor(edge.toLane)} strokeWidth={1.5} fill="none" />;
              })}
              <circle cx={cx} cy={ROW_HEIGHT / 2} r={row.isMerge ? 4 : 3} fill={laneColor(row.lane)} />
            </svg>
            <button
              type="button"
              className="insp-graph-body"
              onClick={() => push({ kind: 'commit', hash: commit.hash })}
              title={`${commit.message}\n${commit.shortHash} · ${commit.author}`}
            >
              <span className="insp-graph-message">{commit.message}</span>
              <span className="insp-graph-meta">
                <code>{commit.shortHash}</code>
                <span>{commit.author}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── Level: one commit ────────────────────────────────────────────────────────

function CommitLevel({ hash, push }: { hash: string; push: (level: InspectorLevel) => void }) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    desktop.git.commitDetail(hash)
      .then((res) => { if (cancelled) return; if (res.ok === false) setError(res.error ?? '无法读取提交详情'); else setDetail(res.commit ?? null); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [hash]);

  if (error) return <ErrorNote message={error} />;
  if (loading) return <div className="insp-loading"><Loader2 size={14} className="insp-spin" />读取提交详情…</div>;
  if (!detail) return <Empty icon={<GitCommitHorizontal size={20} />} title="找不到该提交" />;

  const totals = detail.files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 },
  );

  return (
    <div className="insp-commit">
      <div className="insp-commit-head">
        <span className="insp-commit-subject">{detail.message}</span>
        <span className="insp-commit-meta">
          <code>{detail.shortHash}</code>
          <span>{detail.author}</span>
          <span>{formatAgo(new Date(detail.date).getTime())}</span>
        </span>
        {detail.body && <pre className="insp-commit-body">{detail.body}</pre>}
        <span className="insp-diff-totals">
          {detail.files.length} 个文件
          <span className="insp-add">+{totals.added}</span>
          <span className="insp-del">−{totals.removed}</span>
        </span>
      </div>

      <div className="insp-stack">
        {detail.files.map((file) => {
          const { dir, name } = shortPath(file.path);
          return (
            <DrillRow
              key={file.path}
              icon={<FileCode2 size={13} />}
              name={name}
              dir={dir}
              detail={<><span className="insp-add">+{file.added}</span><span className="insp-del">−{file.removed}</span></>}
              // Drill into the file at this commit: the diff is scoped to that
              // commit, which is what "what did this change" means.
              onClick={() => push({ kind: 'file', path: file.path, ref: detail.hash })}
              title={file.path}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Level: plan ──────────────────────────────────────────────────────────────

function PlanLevel({ state }: { state: AppState }) {
  const board = state.taskBoard;
  if (!board) {
    const turns = state.chat.filter((c): c is Extract<typeof state.chat[number], { kind: 'turn' }> => c.kind === 'turn');
    const steps = turns.flatMap((t) => t.steps);
    if (steps.length === 0) {
      return <Empty icon={<ListTodo size={20} />} title={state.taskSummary?.title ?? '还没有计划'} hint="发送一个任务后这里会显示步骤。" />;
    }
    return (
      <div className="insp-stack">
        {steps.map((step) => (
          <DrillRow
            key={step.id}
            icon={step.status === 'running'
              ? <Loader2 size={13} className="insp-spin" />
              : step.ok ? <span className="insp-dot ok" /> : <span className="insp-dot" />}
            name={step.tool}
            detail={step.durationMs != null ? <span className="insp-muted">{(step.durationMs / 1000).toFixed(1)}s</span> : undefined}
          />
        ))}
      </div>
    );
  }

  const progress = taskProgress(board.tasks).label;
  return (
    <div className="insp-plan">
      {board.goal && <div className="insp-plan-goal" title={board.goal}>{board.goal}</div>}
      <div className="insp-plan-progress">
        <span>进程</span>
        <span className="insp-row-spacer" />
        <span>{progress}</span>
      </div>
      <div className="insp-stack">
        {board.tasks.map((task) => (
          <DrillRow
            key={task.id}
            icon={task.status === 'in_progress'
              ? <Loader2 size={13} className="insp-spin" />
              : task.status === 'done' || task.status === 'skipped'
                ? <span className="insp-dot ok" />
                : <span className="insp-dot" />}
            name={task.title}
            detail={task.status === 'done' ? <span className="insp-tag">完成</span>
              : task.status === 'blocked' ? <span className="insp-tag warn">阻塞</span>
              : undefined}
          />
        ))}
      </div>
    </div>
  );
}

// ── Level: subagents ─────────────────────────────────────────────────────────

function SubagentsLevel({ sessionId }: { sessionId?: string }) {
  const [running, setRunning] = useState<Array<{ id: string; goal: string; expert: string }>>([]);
  const [finished, setFinished] = useState<Array<{ id: string; goal: string; expert: string; status: string; answer?: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => desktop.subagents.list(sessionId)
      .then((res) => { if (!cancelled) { setRunning(res.running ?? []); setFinished(res.finished ?? []); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    void load();
    const timer = window.setInterval(load, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [sessionId]);

  if (error) return <ErrorNote message={error} />;
  if (running.length === 0 && finished.length === 0) {
    return <Empty icon={<Bot size={20} />} title="还没有子智能体" hint="主智能体派发子任务后这里会显示运行记录。" />;
  }

  return (
    <div className="insp-stack">
      {running.length > 0 && <div className="insp-subhead">正在运行 · {running.length}</div>}
      {running.map((run) => (
        <DrillRow key={`r-${run.id}`} icon={<Loader2 size={13} className="insp-spin" />} name={run.goal || run.id} detail={<code>{run.expert}</code>} />
      ))}
      {finished.length > 0 && <div className="insp-subhead">已结束 · {finished.length}</div>}
      {finished.map((run) => (
        <DrillRow
          key={`f-${run.id}`}
          icon={run.status === 'failed'
            ? <X size={13} className="insp-failed" />
            : run.status === 'interrupted' ? <AlertTriangle size={13} className="insp-warn" /> : <span className="insp-dot ok" />}
          name={run.goal || run.id}
          detail={<code>{run.expert}</code>}
          title={run.answer}
        />
      ))}
    </div>
  );
}

// ── The sidebar ──────────────────────────────────────────────────────────────

export function InspectorSidebar({
  state,
  open,
  width,
  initialLevel,
  onClose,
  onWidthChange,
  onOpenFile,
}: {
  state: AppState;
  open: boolean;
  width: number;
  /** Level to open on; the capsule decides (changes / graph / plan …). */
  initialLevel?: InspectorLevel;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  onOpenFile?: (path: string) => void;
}) {
  const [stack, setStack] = useState<InspectorStack>(() => initialStack());
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [totals, setTotals] = useState({ added: 0, removed: 0 });
  // Drag state lives in a ref, not useState: the move handler must call the
  // parent's onWidthChange directly. Calling a parent setState from inside a
  // state updater is the "update scheduled from inside an update function"
  // error (React #290), which crashed the whole window on the first mouse move.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const push = useCallback((level: InspectorLevel) => setStack((s) => pushLevel(s, level)), []);

  // Opening the inspector on a requested level restarts the stack there, so a
  // capsule click lands on that view rather than on whatever was left open.
  useEffect(() => {
    if (open && initialLevel) setStack(initialStack());
  }, [open, initialLevel]);

  // Reset when the conversation changes: a stack pointing at a file from the
  // previous session would show a path that is no longer meaningful.
  useEffect(() => {
    setStack(initialStack());
  }, [state.activeSessionId]);

  // Live git summary for the overview level.
  const refreshStatus = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([desktop.git.status(), desktop.git.diffStats()]);
      setGitStatus(s.ok ? s : null);
      if (d.ok) setTotals({ added: d.added ?? 0, removed: d.removed ?? 0 });
    } catch { /* the overview just shows less */ }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshStatus();
    const timer = window.setInterval(refreshStatus, 8000);
    return () => window.clearInterval(timer);
  }, [open, refreshStatus]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      // Backspace walks up a level, matching how inspectors usually behave.
      else if (event.key === 'Backspace' && !(event.target as HTMLElement)?.closest('input, textarea')) {
        event.preventDefault();
        setStack((s) => popLevel(s));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      // Guard before touching the parent: an unguarded handler would resize on
      // every mouse move over the app, not just during a drag.
      if (!drag) return;
      const next = drag.startWidth - (event.clientX - drag.startX);
      onWidthChange(Math.max(320, Math.min(900, next)));
    };
    const onUp = () => { dragRef.current = null; document.body.style.userSelect = ''; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [onWidthChange]);

  if (!open) return null;

  const current = currentEntry(stack);
  const sessionTotals = sessionChangeTotals(state.chat);
  const changedFiles = gitStatus
    ? (gitStatus.staged?.length ?? 0) + (gitStatus.unstaged?.length ?? 0) + (gitStatus.untracked?.length ?? 0)
    : 0;

  return (
    <aside className="inspector" style={{ width }} role="dialog" aria-label="检查器">
      <button
        type="button"
        className="inspector-resize"
        aria-label="调整检查器宽度"
        onPointerDown={(event) => {
          event.preventDefault();
          dragRef.current = { startX: event.clientX, startWidth: width };
          document.body.style.userSelect = 'none';
        }}
      />

      <header className="inspector-head">
        {canGoBack(stack) ? (
          <button type="button" className="inspector-back" onClick={() => setStack((s) => popLevel(s))} title="返回上一级 (Backspace)">
            <ArrowLeft size={15} />
          </button>
        ) : (
          <span className="inspector-head-icon"><GitBranch size={15} /></span>
        )}
        <nav className="inspector-crumbs" aria-label="层级">
          {stack.entries.map((entry, index) => (
            <span key={entry.key} className="inspector-crumb-wrap">
              {index > 0 && <ChevronRight size={12} className="inspector-crumb-sep" />}
              <button
                type="button"
                className={`inspector-crumb ${index === stack.entries.length - 1 ? 'current' : ''}`}
                onClick={() => setStack((s) => goToIndex(s, index))}
                disabled={index === stack.entries.length - 1}
              >
                {entry.label}
              </button>
            </span>
          ))}
        </nav>
        <button type="button" className="inspector-close" onClick={onClose} aria-label="关闭检查器" title="关闭">
          <PanelRightClose size={16} />
        </button>
      </header>

      {/* Summary strip: mirrors the capsule so the numbers stay visible while
          the user is deep in a file diff. */}
      <div className="inspector-summary">
        <span className="inspector-summary-branch" title={gitStatus?.branch ?? undefined}>
          <GitBranch size={12} /> {gitStatus?.branch ?? '—'}
        </span>
        <span className="insp-row-spacer" />
        {changedFiles > 0 ? (
          <>
            <span className="insp-add">+{totals.added}</span>
            <span className="insp-del">−{totals.removed}</span>
          </>
        ) : sessionTotals ? (
          <>
            <span className="insp-add">+{sessionTotals.added}</span>
            <span className="insp-del">−{sessionTotals.removed}</span>
          </>
        ) : (
          <span className="insp-muted">干净</span>
        )}
      </div>

      <div className="inspector-body">
        {current.level.kind === 'overview' && (
          <OverviewLevel state={state} push={push} gitStatus={gitStatus} totals={totals} />
        )}
        {current.level.kind === 'changes' && <ChangesLevel push={push} />}
        {current.level.kind === 'file' && (
          <FileLevel
            path={current.level.path}
            staged={current.level.staged}
            commitRef={current.level.ref}
            onOpenFile={onOpenFile}
          />
        )}
        {current.level.kind === 'branches' && <BranchesLevel onCheckedOut={() => void refreshStatus()} />}
        {current.level.kind === 'graph' && <GraphLevel push={push} />}
        {current.level.kind === 'commit' && <CommitLevel hash={current.level.hash} push={push} />}
        {current.level.kind === 'plan' && <PlanLevel state={state} />}
        {current.level.kind === 'subagents' && <SubagentsLevel sessionId={state.activeSessionId ?? undefined} />}
      </div>
    </aside>
  );
}
