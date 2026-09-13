import { useCallback, useEffect, useState } from 'react';
import { BarChart3, RefreshCw, FileCode2, AlertTriangle, FolderTree } from 'lucide-react';
import { desktop, type CodeCensus } from '../lib/ipc';
import { fuzzyRankItems } from '../lib/fuzzy';

/**
 * Iteration 9 — workspace code census panel.
 *
 * One streaming scan over the tree produces: totals, a per-language table
 * (with comment ratio bars), directory weights, largest files and the TODO
 * ledger. Language rows filter live through the iteration-2 fuzzy matcher —
 * the components in this batch reuse each other deliberately.
 */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

const LANG_COLORS = [
  '#2f6fed', '#c8753d', '#3f8f52', '#8a5cf0', '#b8860b',
  '#2f81f7', '#c0453c', '#5fae62', '#94a3b8', '#d0a132',
];

export function CodeStatsPanel({ onOpenFile }: { onOpenFile: (path: string, line?: number) => void }) {
  const [census, setCensus] = useState<CodeCensus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'languages' | 'dirs' | 'largest' | 'todos'>('languages');
  const [filter, setFilter] = useState('');
  const [progress, setProgress] = useState('');

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setProgress('扫描中…');
    try {
      const result = await desktop.stats.census({});
      if (result.error) setError(result.error);
      setCensus(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setProgress('');
    }
  }, []);

  useEffect(() => { void run(); }, [run]);

  const languages = census?.languages ?? [];
  const filteredLanguages = filter.trim()
    ? fuzzyRankItems(filter, languages.map((l) => ({ item: l, key: l.language }))).map((r) => r.item)
    : languages;
  const maxLines = Math.max(1, ...languages.map((l) => l.lines));

  return (
    <div className="census-panel">
      <div className="census-head">
        <span><BarChart3 size={13} /> 代码普查</span>
        <span className="census-head-meta">
          {loading ? progress : census && !census.error ? `${census.totalFiles} 文件 · ${census.elapsedMs} ms` : ''}
          <button className="icon-button" title="重新扫描" onClick={() => { void run(); }}><RefreshCw size={13} className={loading ? 'spin' : undefined} /></button>
        </span>
      </div>
      {error && <div className="hist-error">{error}</div>}
      {census && !census.error && (
        <>
          <div className="census-totals">
            <div className="census-kpi"><span className="census-kpi-value">{census.totalFiles.toLocaleString()}</span><span className="census-kpi-label">文件</span></div>
            <div className="census-kpi"><span className="census-kpi-value">{(census.totalLines ?? 0).toLocaleString()}</span><span className="census-kpi-label">总行数</span></div>
            <div className="census-kpi"><span className="census-kpi-value">{(census.codeLines ?? 0).toLocaleString()}</span><span className="census-kpi-label">代码行</span></div>
            <div className="census-kpi">
              <span className="census-kpi-value">{census.totalLines ? Math.round(((census.commentLines ?? 0) / census.totalLines) * 100) : 0}%</span>
              <span className="census-kpi-label">注释占比</span>
            </div>
            <div className="census-kpi"><span className="census-kpi-value">{formatBytes(census.totalBytes ?? 0)}</span><span className="census-kpi-label">体积</span></div>
            <div className="census-kpi"><span className={`census-kpi-value${(census.todoCount ?? 0) > 0 ? ' warn' : ''}`}><AlertTriangle size={11} style={{ display: 'inline', verticalAlign: -1 }} /> {census.todoCount ?? 0}</span><span className="census-kpi-label">TODO 标记</span></div>
          </div>
          <div className="census-tabs">
            {([
              ['languages', '语言'],
              ['dirs', '目录'],
              ['largest', '大文件'],
              ['todos', '待办'],
            ] as const).map(([id, label]) => (
              <button key={id} type="button" className={`census-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          <div className="census-body">
            {tab === 'languages' && (
              <>
                <input className="census-filter" placeholder="筛选语言…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                {filteredLanguages.map((lang, idx) => (
                  <div key={lang.language} className="census-row">
                    <span className="census-swatch" style={{ background: LANG_COLORS[idx % LANG_COLORS.length] }} />
                    <span className="census-name">{lang.language}</span>
                    <div className="census-bar"><div style={{ width: `${Math.round((lang.lines / maxLines) * 100)}%`, background: LANG_COLORS[idx % LANG_COLORS.length] }} /></div>
                    <span className="census-num">{lang.files}</span>
                    <span className="census-num wide">{lang.lines.toLocaleString()}</span>
                    <span className="census-num wide dim">{Math.round((lang.comment / Math.max(1, lang.code + lang.comment)) * 100)}% 注释</span>
                  </div>
                ))}
                {filteredLanguages.length === 0 && <div className="hist-snap-empty">无匹配语言</div>}
              </>
            )}
            {tab === 'dirs' && (census.directories ?? []).map((dir) => (
              <div key={dir.dir} className="census-row">
                <FolderTree size={12} className="census-icon" />
                <span className="census-name">{dir.dir}</span>
                <div className="census-bar"><div style={{ width: `${Math.round((dir.bytes / Math.max(1, ...(census.directories ?? []).map((d) => d.bytes))) * 100)}%` }} /></div>
                <span className="census-num">{dir.files}</span>
                <span className="census-num wide">{formatBytes(dir.bytes)}</span>
              </div>
            ))}
            {tab === 'largest' && (census.largestFiles ?? []).map((file) => (
              <button key={file.path} type="button" className="census-row clickable" onClick={() => onOpenFile(file.path)}>
                <FileCode2 size={12} className="census-icon" />
                <span className="census-name">{file.path}</span>
                <span className="census-num wide">{file.lines.toLocaleString()} 行</span>
                <span className="census-num wide">{formatBytes(file.bytes)}</span>
              </button>
            ))}
            {tab === 'todos' && (census.todos ?? []).map((todo, idx) => (
              <button key={`${todo.path}:${todo.line}:${idx}`} type="button" className="census-row clickable" onClick={() => onOpenFile(todo.path, todo.line)}>
                <span className="census-name mono">{todo.path}:{todo.line}</span>
                <span className="census-todo-text">{todo.text}</span>
              </button>
            ))}
            {tab === 'todos' && (census.todos ?? []).length === 0 && <div className="hist-snap-empty">没有 TODO/FIXME 标记</div>}
          </div>
          {(census.skippedLarge ?? 0) > 0 && (
            <div className="census-note">{census.skippedLarge} 个超过 2 MiB 的文件未统计</div>
          )}
        </>
      )}
    </div>
  );
}
