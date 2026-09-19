import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FileCode2, FileImage, FileJson, FileText, Folder, RefreshCw } from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { GitFileStat, GitStatus } from '../lib/ipc';

/*
 * ReviewPanel — 审查：the working-tree file list with per-file +N −M.
 *
 * The Git panel shows one workspace-wide total; a reviewer needs to see which
 * file the lines are in. Stats come from `git.fileStats` (numstat per file,
 * untracked files counted by content), and the staged/unstaged/untracked
 * filter mirrors the 未暂存 dropdown in the mock.
 *
 * Deliberately read-only: staging, discarding and committing stay in the Git
 * panel so this view cannot destroy work while the user is reading it.
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
}: {
  workspaceRoot: string;
  onOpenFile?: (path: string) => void;
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

  const visible = filter === 'all' ? files : files.filter((file) => file.status === filter);
  const totals = visible.reduce(
    (acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }),
    { added: 0, removed: 0 },
  );

  const filterLabel = FILTERS.find((f) => f.id === filter)?.label ?? '全部';

  return (
    <section className="review-panel" aria-label="审查">
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
        </div>
      )}

      {error && !(status && !status.ok) && (
        <div className="review-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {!error && !loading && visible.length === 0 && (
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
