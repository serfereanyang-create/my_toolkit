import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrainCircuit, ChevronDown, ChevronRight, FileText, FolderGit2, RefreshCw, Clock, Search } from 'lucide-react';
import { desktop, type GlobalMemorySnapshot, type ProjectMemorySummary } from '../lib/ipc';

/*
 * MemoryPanel — 「记忆」视图。
 *
 * Two sources, deliberately kept apart:
 *  1. 全局记忆 (~/.zcode/cli/memories/global): every file the agent has ever
 *     edited, across every session and every project. Written by the CLI, read
 *     here. This is what makes a new conversation start informed instead of
 *     amnesiac.
 *  2. 项目记忆 (~/.zcode/cli/memories/projects/<id>/memory): the per-project
 *     notes the CLI keeps for one workspace.
 *
 * Nothing here is editable: memory is a record of what happened, not a form.
 */

function formatWhen(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The ledger stores in-workspace paths relative to their workspace. */
function absolutePath(workspace: string, path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')) return path;
  const base = workspace.replace(/[\\/]+$/, '');
  return `${base}/${path}`;
}

function shortWorkspace(workspace: string): string {
  const normalised = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalised.split('/').filter(Boolean);
  return parts.length <= 2 ? normalised : `…/${parts.slice(-2).join('/')}`;
}

export function MemoryPanel({ onOpenFile }: { onOpenFile?: (path: string) => void }) {
  const [snapshot, setSnapshot] = useState<GlobalMemorySnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectMemorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [showIndex, setShowIndex] = useState(false);
  const [note, setNote] = useState<{ name: string; content: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [global, listed] = await Promise.allSettled([desktop.memory.global(), desktop.memory.listProjects()]);
      if (global.status === 'fulfilled' && global.value.ok) {
        setSnapshot(global.value);
        setError(null);
      } else {
        setSnapshot(null);
        setError(global.status === 'fulfilled' ? global.value.error || '读取全局记忆失败' : String(global.reason));
      }
      setProjects(listed.status === 'fulfilled' && listed.value.ok ? listed.value.projects : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const projectsView = useMemo(() => {
    const all = snapshot?.projects ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all
      .map((project) => ({
        ...project,
        files: project.files.filter((file) => file.path.toLowerCase().includes(needle)),
      }))
      .filter((project) => project.files.length > 0 || project.project.toLowerCase().includes(needle));
  }, [snapshot, query]);

  const recent = useMemo(() => (snapshot?.records ?? []).slice(-24).reverse(), [snapshot]);
  const totalEdits = snapshot?.totalEdits ?? 0;
  const fileCount = (snapshot?.projects ?? []).reduce((sum, project) => sum + project.files.length, 0);

  async function openNote(project: ProjectMemorySummary, fileName: string) {
    const result = await desktop.memory.read(project.id, fileName);
    if (result.ok) setNote({ name: `${project.label} / ${fileName}`, content: result.content });
  }

  return (
    <div className="gtx-panel mem-panel" aria-label="记忆">
      <header className="gtx-page-header">
        <div>
          <span className="gtx-eyebrow"><BrainCircuit size={14} />跨会话 · 跨项目</span>
          <h1>记忆</h1>
          <p title={snapshot?.root}>
            {loading && !snapshot ? '正在读取记忆'
              : totalEdits === 0 ? '还没有编辑记录'
              : `${totalEdits} 次编辑 · ${fileCount} 个文件 · ${(snapshot?.projects ?? []).length} 个项目`}
            <span>·</span>{snapshot?.updatedAt ? `更新于 ${formatWhen(new Date(snapshot.updatedAt).toISOString())}` : '—'}
          </p>
        </div>
        <button type="button" className="gtx-btn" title="刷新" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />刷新
        </button>
      </header>

      {error && <div className="gtx-error" role="alert"><span>{error}</span></div>}

      {totalEdits === 0 ? (
        <div className="gtx-repo-empty">
          <BrainCircuit size={26} />
          <h2>还没有任何编辑记录</h2>
          <p>智能体每次写文件都会被记进全局记忆：哪个项目、哪个文件、什么时候。这样新开一个会话也知道你改过什么。</p>
          <p className="gtx-repo-empty-note">记录写在 ~/.zcode/cli/memories/global，跨会话、跨项目，删掉会话也不会丢。</p>
        </div>
      ) : (
        <>
          <div className="mem-toolbar">
            <label className="mem-search">
              <Search size={13} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="按文件或项目筛选"
                aria-label="筛选记忆"
              />
            </label>
            <button type="button" className="gtx-btn ghost" onClick={() => setShowIndex((previous) => !previous)}>
              {showIndex ? <ChevronDown size={14} /> : <ChevronRight size={14} />}MEMORY.md 原文
            </button>
          </div>

          {showIndex && (
            <pre className="mem-index" aria-label="MEMORY.md 原文">{snapshot?.markdown || '（MEMORY.md 还不存在）'}</pre>
          )}

          <section className="mem-section">
            <h2 className="mem-heading">编辑过的项目</h2>
            {projectsView.length === 0 && <p className="gtx-empty">没有匹配「{query}」的记录。</p>}
            {projectsView.map((project) => {
              const open = openProject === project.workspace || Boolean(query.trim());
              return (
                <div className="mem-project" key={project.workspace}>
                  <button
                    type="button"
                    className="mem-project-head"
                    aria-expanded={open}
                    onClick={() => setOpenProject(open && !query.trim() ? null : project.workspace)}
                  >
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <FolderGit2 size={14} />
                    <span className="mem-project-name">{project.project}</span>
                    <span className="mem-project-path" title={project.workspace}>{shortWorkspace(project.workspace)}</span>
                    <span className="mem-project-meta">{project.edits} 次 · {project.files.length} 个文件 · {formatWhen(project.lastAt)}</span>
                  </button>
                  {open && (
                    <ul className="mem-files">
                      {project.files.map((file) => (
                        <li key={file.path}>
                          <button
                            type="button"
                            className="mem-file"
                            title={`${file.path}\n最后编辑 ${formatWhen(file.at)}${file.count > 1 ? `\n共 ${file.count} 次` : ''}`}
                            onClick={() => onOpenFile?.(absolutePath(project.workspace, file.path))}
                            disabled={!onOpenFile}
                          >
                            <FileText size={13} />
                            <span className="mem-file-path">{file.path}</span>
                            {file.created && !file.deleted && <span className="mem-tag">新建</span>}
                            {file.renamed && <span className="mem-tag">改名</span>}
                            {file.deleted && <span className="mem-tag danger">已删</span>}
                            {file.count > 1 && <span className="mem-file-count">{file.count}×</span>}
                            <span className="mem-file-time">{formatWhen(file.at)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </section>

          {recent.length > 0 && (
            <section className="mem-section">
              <h2 className="mem-heading"><Clock size={13} />最近的编辑</h2>
              <ul className="mem-timeline">
                {recent.map((record, index) => (
                  <li key={`${record.at}-${record.path}-${index}`}>
                    <span className="mem-time">{formatWhen(record.at)}</span>
                    <span className="mem-timeline-project">{record.project}</span>
                    <span className="mem-timeline-path">
                      {record.action === 'rename' && record.from ? `${record.from} → ${record.path}`
                        : record.action === 'delete' ? `已删除 ${record.path}` : record.path}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {projects.length > 0 && (
        <section className="mem-section">
          <h2 className="mem-heading">项目记忆</h2>
          <p className="mem-hint">每个工作区自己的笔记，和上面的全局编辑记录分开保存。</p>
          {projects.map((project) => (
            <div className="mem-note-group" key={project.id}>
              <div className="mem-note-group-head">
                <FolderGit2 size={14} />
                <span className="mem-note-group-name">{project.label}</span>
                <span className="mem-note-group-meta">{project.files.length} 个文件 · {formatWhen(new Date(project.updatedAt).toISOString())}</span>
              </div>
              <ul className="mem-note-files">
                {project.files.map((file) => (
                  <li key={file.path}>
                    <button type="button" className="mem-note-file" onClick={() => void openNote(project, file.name)}>
                      <FileText size={13} />
                      <span className="mem-note-file-path">{file.name}</span>
                      <span className="mem-note-file-time">{formatSize(file.size)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {note && (
        <div className="mem-note" role="dialog" aria-label={note.name}>
          <header>
            <span>{note.name}</span>
            <button type="button" className="gtx-btn ghost" onClick={() => setNote(null)}>关闭</button>
          </header>
          <pre>{note.content}</pre>
        </div>
      )}
    </div>
  );
}
