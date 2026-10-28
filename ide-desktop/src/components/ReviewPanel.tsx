import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FileCode2, FileImage, FileJson, FileText, Folder, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { GitFileStat, GitStatus } from '../lib/ipc';
import type { ChatItem } from '../types';
import { ReviewReport } from './ReviewReport';

/*
 * ReviewPanel — 审查：the AI review report, then the working-tree file list.
 *
 * Two independent things share this tab because they answer the same question
 * in different ways: "what is wrong with what I am about to commit". The AI
 * section is the newest review from the conversation (the CLI writes it into
 * session history, so it survives a reload); the file list below is the
 * mechanical +N −M per file.
 *
 * The file list is deliberately read-only: staging, discarding and committing
 * stay in the Git panel so this view cannot destroy work while the user is
 * reading it.
 */

type Filter = 'all' | 'unstaged' | 'staged' | 'untracked';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'unstaged', label: '未暂存' },
  { id: 'staged', label: '已暂存' },
  { id: 'untracked', label: '未跟踪' },
];

const STATUS_LABEL: Record<GitFileStat['status'], string> = {
  staged: '已暂存',
  unstaged: '未暂存',
  untracked: '未跟踪',
};

/** Icon by extension, so the list scans like a file tree. */
function FileIcon({ path }: { path: string }) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h'].includes(ext)) return <FileCode2 size={15} />;
  if (['json', 'jsonc', 'yaml', 'yml', 'toml'].includes(ext)) return <FileJson size={15} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) return <FileImage size={15} />;
  if (path.endsWith('/')) return <Folder size={15} />;
  return <FileText size={15} />;
}

/** Split "dir/sub/name.ext" so the name is prominent and the dir is muted. */
function splitPath(path: string): { dir: string; name: string } {
  const normalized = path.replace(/\\/g, '/');
  const at = normalized.lastIndexOf('/');
  if (at < 0) return { dir: '', name: normalized };
  return { dir: `${normalized.slice(0, at)}/`, name: normalized.slice(at + 1) };
}

export function ReviewPanel({
  workspaceRoot,
  onOpenFile,
  chat,
  onRunReview,
  reviewRunning,
}: {
  workspaceRoot: string;
  /** Open a file (optionally at a line) from a finding. */
  onOpenFile?: (path: string, line?: number) => void;
  /** The conversation, so the newest AI review can be shown without a second
   *  subscription. The CLI also writes it into session history. */
  chat?: ChatItem[];
  /** Start `/review`. Absent when the caller cannot send messages. */
  onRunReview?: () => void;
  reviewRunning?: boolean;
}) {
  const [files, setFiles] = useState<GitFileStat[]>([]);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [stats, st] = await Promise.all([
        desktop.git.fileStats(),
        desktop.git.status(),
      ]);
      if (stats.ok === false) {
        setError(stats.error ?? '无法读取文件变更');
        setFiles([]);
      } else {
        setFiles(Array.isArray(stats.files) ? stats.files : []);
      }
      setStatus(st ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, workspaceRoot]);

  // Newest AI review in the conversation. `findLast` rather than `find` so a
  // second /review replaces the first in this view instead of the tab going
  // stale — the transcript keeps both, this panel shows the current state.
  const latestReview = useMemo(
    () => [...(chat ?? [])].reverse().find((item): item is Extract<ChatItem, { kind: 'review' }> => item.kind === 'review'),
    [chat],
  );

  const visible = filter === 'all' ? files : files.filter((file) => file.status === filter);
  const totals = visible.reduce(
    (acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }),
    { added: 0, removed: 0 },
  );

  const filterLabel = FILTERS.find((f) => f.id === filter)?.label ?? '全部';

  return (
    <section className="review-panel" aria-label="审查">
      <div className="review-ai">
        <div className="review-ai-head">
          <Sparkles size={14} />
          <strong>AI 审查</strong>
          <span className="review-ai-hint">独立只读子会话，按 P0–P3 报出本次改动的问题</span>
          <button
            type="button"
            className="review-ai-run"
            onClick={() => onRunReview?.()}
            disabled={!onRunReview || reviewRunning}
            title={onRunReview ? '运行 /review（会消耗词元，需要几十秒）' : '当前无法发送消息'}
          >
            {reviewRunning ? '审查中…' : latestReview ? '重新审查' : '开始审查'}
          </button>
        </div>
        {latestReview
          ? <ReviewReport review={latestReview} onOpenFile={onOpenFile} />
          : (
            <p className="review-ai-empty">
              还没有审查过。点「开始审查」会以独立只读子会话检查未提交的改动；
              也可以用 /review base &lt;分支&gt; 或 /review commit &lt;sha&gt; 审查别的范围。
            </p>
          )}
      </div>

      <header className="review-head">
        <div className="review-filter">
          <button
            type="button"
            className="review-filter-button"
            onClick={() => setFilterOpen((v) => !v)}
            aria-expanded={filterOpen}
            aria-haspopup="listbox"
          >
            {filterLabel}
            <ChevronDown size={13} />
          </button>
          {filterOpen && (
            <ul className="review-filter-menu" role="listbox">
              {FILTERS.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.id === filter}
                    className={option.id === filter ? 'active' : undefined}
                    onClick={() => { setFilter(option.id); setFilterOpen(false); }}
                  >
                    {option.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="review-head-right">
          <span className="review-totals">
            <span className="review-add">+{totals.added}</span>
            <span className="review-del">−{totals.removed}</span>
          </span>
          <button
            type="button"
            className="review-refresh"
            onClick={() => void refresh()}
            disabled={loading}
            title="刷新"
          >
            <RefreshCw size={14} className={loading ? 'review-spin' : undefined} />
            刷新
          </button>
        </div>
      </header>

      {status && !status.ok && (
        <div className="review-error" role="alert">
          <AlertTriangle size={14} />
          <span>{status.error ?? '当前工作区不是 Git 仓库'}</span>
          <button type="button" className="review-retry" onClick={() => void refresh()} disabled={loading}>重试</button>
        </div>
      )}

      {error && !(status && !status.ok) && (
        <div className="review-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button type="button" className="review-retry" onClick={() => void refresh()} disabled={loading}>重试</button>
        </div>
      )}

      {loading && files.length === 0 && !error && (
        <div className="review-panel-loading" role="status" aria-busy="true">
          <Loader2 size={14} className="review-spin" />正在读取文件变更…
        </div>
      )}

      {!error && !loading && !(status && !status.ok) && visible.length === 0 && (
        <div className="review-empty">
          <FileText size={24} />
          <strong>没有{filter === 'all' ? '' : filterLabel}的文件变更</strong>
          <span>{filter === 'all' ? '工作区是干净的。' : '切换到「全部」查看其他变更。'}</span>
        </div>
      )}

      <ul className="review-list">
        {visible.map((file) => {
          const { dir, name } = splitPath(file.path);
          const open = expanded === file.path;
          return (
            <li key={file.path} className={`review-item ${open ? 'open' : ''}`}>
              <button
                type="button"
                className="review-item-head"
                onClick={() => setExpanded(open ? null : file.path)}
                aria-expanded={open}
                title={file.path}
              >
                <span className="review-item-chevron">
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </span>
                <span className="review-item-icon"><FileIcon path={file.path} /></span>
                <span className="review-item-name">
                  {name}
                  {dir && <span className="review-item-dir">{dir}</span>}
                </span>
                <span className={`review-item-status status-${file.status}`}>{STATUS_LABEL[file.status]}</span>
                <span className="review-item-stats">
                  <span className="review-add">+{file.added}</span>
                  <span className="review-del">−{file.removed}</span>
                </span>
              </button>
              {open && (
                <div className="review-item-body">
                  <div className="review-item-path"><code>{file.path}</code></div>
                  <div className="review-item-actions">
                    <button
                      type="button"
                      className="review-item-open"
                      disabled={!onOpenFile}
                      onClick={() => onOpenFile?.(file.path)}
                    >
                      在编辑器中打开
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
